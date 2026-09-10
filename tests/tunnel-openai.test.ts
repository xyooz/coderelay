import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpenAiTunnelId } from "../src/cli/commands.js";
import { isProcessAlive } from "../src/runtime/state.js";
import { hasOpenAiConfiguration, OpenAiTunnelProvider, resolveTunnelClient } from "../src/tunnel/openai.js";
import { selectTransport } from "../src/tunnel/selection.js";

const context = {
  localPort: 7676,
  localEndpoint: "http://127.0.0.1:7676/mcp/test",
  workspace: "/tmp/project-a",
  instanceName: "project-a",
  openaiTunnelId: "tunnel_0123456789abcdef0123456789abcdef"
};

describe("OpenAI Secure MCP transport", () => {
  it("resolves tunnel-client from an explicit executable path without reading the API key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-tunnel-client-"));
    const executable = path.join(directory, "tunnel-client");
    const previousKey = process.env.CONTROL_PLANE_API_KEY;
    try {
      await writeFile(executable, "#!/bin/sh\nprintf 'tunnel-client test\\n'\n");
      await chmod(executable, 0o755);
      process.env.CONTROL_PLANE_API_KEY = "test-key";
      expect(resolveTunnelClient(executable)).toBe(executable);
      expect(new OpenAiTunnelProvider()).toBeTruthy();
    } finally {
      if (previousKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = previousKey;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects Cloudflare when OpenAI credentials are not configured", async () => {
    const previousKey = process.env.CONTROL_PLANE_API_KEY;
    const previousId = process.env.CONTROL_PLANE_TUNNEL_ID;
    try {
      delete process.env.CONTROL_PLANE_API_KEY;
      delete process.env.CONTROL_PLANE_TUNNEL_ID;
      const provider = await selectTransport("auto", context);
      expect(provider.name).toBe("cloudflare");
    } finally {
      if (previousKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = previousKey;
      if (previousId === undefined) delete process.env.CONTROL_PLANE_TUNNEL_ID;
      else process.env.CONTROL_PLANE_TUNNEL_ID = previousId;
    }
  });

  it("resolves workspace tunnel bindings before the global environment fallback", () => {
    expect(resolveOpenAiTunnelId("tunnel_cli", { openaiTunnelId: "tunnel_config" }, "tunnel_env")).toBe("tunnel_cli");
    expect(resolveOpenAiTunnelId(undefined, { openaiTunnelId: "tunnel_config" }, "tunnel_env")).toBe("tunnel_config");
    expect(resolveOpenAiTunnelId(undefined, null, "tunnel_env")).toBe("tunnel_env");
    expect(resolveOpenAiTunnelId(undefined, null, undefined)).toBeUndefined();
  });

  it("only reports complete OpenAI configuration when both tunnel ID and API key exist", () => {
    const previousKey = process.env.CONTROL_PLANE_API_KEY;
    try {
      delete process.env.CONTROL_PLANE_API_KEY;
      expect(hasOpenAiConfiguration(context)).toBe(false);
      process.env.CONTROL_PLANE_API_KEY = "test-runtime-key";
      expect(hasOpenAiConfiguration(context)).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = previousKey;
    }
  });

  it("starts the official client with an isolated instance log and checks /readyz", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-tunnel-client-process-"));
    const executable = path.join(directory, "fake-tunnel-client.mjs");
    const logDirectory = path.join(directory, "logs");
    const previousClient = process.env.CODERELAY_TUNNEL_CLIENT;
    const previousKey = process.env.CONTROL_PLANE_API_KEY;
    const previousId = process.env.CONTROL_PLANE_TUNNEL_ID;
    const previousArgsFile = process.env.CODERELAY_TEST_ARGS_FILE;
    const argsFile = path.join(directory, "args.json");
    let tunnelProcess: Awaited<ReturnType<OpenAiTunnelProvider["start"]>> | undefined;
    try {
      await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("tunnel-client test 0.0.0");
  process.exit(0);
}
const urlFile = args[args.indexOf("--health.url-file") + 1];
if (process.env.CODERELAY_TEST_ARGS_FILE) writeFileSync(process.env.CODERELAY_TEST_ARGS_FILE, JSON.stringify(args));
writeFileSync(urlFile, "http://127.0.0.1:65535");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`);
      await chmod(executable, 0o755);
      process.env.CODERELAY_TUNNEL_CLIENT = executable;
      process.env.CONTROL_PLANE_API_KEY = "test-runtime-key";
      process.env.CONTROL_PLANE_TUNNEL_ID = context.openaiTunnelId;
      process.env.CODERELAY_TEST_ARGS_FILE = argsFile;
      const previousFetch = globalThis.fetch;
      let requestedUrl = "";
      globalThis.fetch = async (input) => {
        requestedUrl = String(input);
        return new Response("ready", { status: 200 });
      };

      try {
        const provider = new OpenAiTunnelProvider(() => logDirectory);
        tunnelProcess = await provider.start(context);

        expect(tunnelProcess.provider).toBe("openai");
        expect(tunnelProcess.tunnelId).toBe(context.openaiTunnelId);
        const clientArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
        expect(clientArgs).toContain("--control-plane.tunnel-id");
        expect(clientArgs).toContain(context.openaiTunnelId);
        expect(clientArgs).not.toContain("test-runtime-key");
        expect(await provider.healthCheck(tunnelProcess)).toBe(true);
        expect(requestedUrl).toBe("http://127.0.0.1:65535/readyz");
        expect(tunnelProcess.logPath.startsWith(logDirectory)).toBe(true);
        expect(await stat(tunnelProcess.logPath)).toBeTruthy();
        const log = await readFile(tunnelProcess.logPath, "utf8");
        expect(log).toBeTypeOf("string");
      } finally {
        globalThis.fetch = previousFetch;
      }
    } finally {
      if (tunnelProcess) {
        await new OpenAiTunnelProvider(() => logDirectory).stop(tunnelProcess);
        expect(isProcessAlive(tunnelProcess.pid)).toBe(false);
      }
      if (previousClient === undefined) delete process.env.CODERELAY_TUNNEL_CLIENT;
      else process.env.CODERELAY_TUNNEL_CLIENT = previousClient;
      if (previousArgsFile === undefined) delete process.env.CODERELAY_TEST_ARGS_FILE;
      else process.env.CODERELAY_TEST_ARGS_FILE = previousArgsFile;
      if (previousKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = previousKey;
      if (previousId === undefined) delete process.env.CONTROL_PLANE_TUNNEL_ID;
      else process.env.CONTROL_PLANE_TUNNEL_ID = previousId;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
