import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive } from "../src/runtime/state.js";
import { CloudflareNamedTunnelProvider } from "../src/tunnel/cloudflare-named.js";

async function readEventually(filePath: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return await readFile(filePath, "utf8");
}

describe("Cloudflare remotely-managed Named Tunnel", () => {
  it("starts without putting the token in argv or the CodeRelay log", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-cloudflare-provider-"));
    const executable = path.join(directory, "cloudflared");
    const logDirectory = path.join(directory, "logs");
    const argsFile = path.join(directory, "child.json");
    const previousPath = process.env.PATH;
    const previousArgsFile = process.env.CODERELAY_TEST_CLOUDFLARE_ARGS_FILE;
    const token = "eyJhbGciOiJIUzI1NiJ9.remote-token.signature";
    let tunnelProcess: Awaited<ReturnType<CloudflareNamedTunnelProvider["start"]>> | undefined;

    try {
      await writeFile(executable, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("cloudflared test 0.0.0");
  process.exit(0);
}
if (process.env.CODERELAY_TEST_CLOUDFLARE_ARGS_FILE) {
  writeFileSync(process.env.CODERELAY_TEST_CLOUDFLARE_ARGS_FILE, JSON.stringify({ args, token: process.env.TUNNEL_TOKEN ?? null }));
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await chmod(executable, 0o755);
      process.env.PATH = directory;
      process.env.CODERELAY_TEST_CLOUDFLARE_ARGS_FILE = argsFile;

      const provider = new CloudflareNamedTunnelProvider(() => logDirectory);
      tunnelProcess = await provider.start({
        localPort: 7676,
        localEndpoint: "http://127.0.0.1:7676/mcp/test",
        workspace: "/tmp/project",
        instanceName: "project",
        cloudflareManagement: "remote",
        cloudflareTunnelToken: token,
        cloudflareHostname: "coderelay.example.com"
      });

      expect(tunnelProcess.provider).toBe("cloudflare-named");
      expect(tunnelProcess.baseUrl).toBe("https://coderelay.example.com");
      const child = JSON.parse(await readEventually(argsFile)) as { args: string[]; token: string | null };
      expect(child.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
      expect(child.args).not.toContain(token);
      expect(child.token).toBe(token);
      expect(await readFile(tunnelProcess.logPath, "utf8")).not.toContain(token);
    } finally {
      if (tunnelProcess) {
        await new CloudflareNamedTunnelProvider(() => logDirectory).stop(tunnelProcess);
        expect(isProcessAlive(tunnelProcess.pid)).toBe(false);
      }
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousArgsFile === undefined) delete process.env.CODERELAY_TEST_CLOUDFLARE_ARGS_FILE;
      else process.env.CODERELAY_TEST_CLOUDFLARE_ARGS_FILE = previousArgsFile;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a remotely-managed tunnel without a token", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-cloudflare-missing-token-"));
    const executable = path.join(directory, "cloudflared");
    const previousPath = process.env.PATH;
    try {
      await writeFile(executable, `#!${process.execPath}
if (process.argv.includes("--version")) process.exit(0);
setInterval(() => {}, 1000);
`);
      await chmod(executable, 0o755);
      process.env.PATH = directory;
      await expect(new CloudflareNamedTunnelProvider(() => path.join(directory, "logs")).start({
        localPort: 7676,
        localEndpoint: "http://127.0.0.1:7676/mcp/test",
        workspace: "/tmp/project",
        instanceName: "project",
        cloudflareManagement: "remote",
        cloudflareHostname: "coderelay.example.com"
      })).rejects.toThrow("tunnel token");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
