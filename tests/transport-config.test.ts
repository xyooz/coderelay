import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeDaemonConfig,
  readOpenAiApiKeySync,
  removeOpenAiApiKey,
  resolveTransportConfig,
  writeOpenAiApiKey,
  type DaemonConfig
} from "../src/runtime/state.js";
import { cloudflareNamedConfiguration } from "../src/tunnel/cloudflare-named.js";
import { selectTransport } from "../src/tunnel/selection.js";

describe("transport configuration", () => {
  it("normalizes legacy Cloudflare settings and supplies an explicit Quick fallback", () => {
    const config = normalizeDaemonConfig({ transport: "openai", openaiTunnelId: "tunnel_config" });
    expect(resolveTransportConfig(config)).toEqual({ preferred: "openai", fallback: "cloudflare-quick" });
    expect(config.openai?.tunnelId).toBe("tunnel_config");

    const legacy = normalizeDaemonConfig({ transport: "cloudflare" } as DaemonConfig);
    expect(resolveTransportConfig(legacy)).toEqual({ preferred: "cloudflare-quick" });
  });

  it("stores OpenAI credentials with private file permissions and removes only the local key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-credentials-"));
    const credentialsPath = path.join(directory, "credentials.json");
    try {
      await writeOpenAiApiKey("secret-value", credentialsPath);
      expect(readOpenAiApiKeySync(undefined, credentialsPath)).toEqual({ value: "secret-value", source: "credentials" });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(credentialsPath, "utf8")).not.toContain("CONTROL_PLANE_API_KEY");
      await removeOpenAiApiKey(credentialsPath);
      await expect(stat(credentialsPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("always prefers the environment key over credentials", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-credentials-"));
    const credentialsPath = path.join(directory, "credentials.json");
    try {
      await writeOpenAiApiKey("file-value", credentialsPath);
      expect(readOpenAiApiKeySync("environment-value", credentialsPath)).toEqual({ value: "environment-value", source: "environment" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects local and Quick transports without requiring an OpenAI key", async () => {
    const context = {
      localPort: 7676,
      localEndpoint: "http://127.0.0.1:7676/mcp/test",
      workspace: "/tmp/project",
      instanceName: "project"
    };
    expect(await selectTransport("cloudflare-quick", context)).toMatchObject({ name: "cloudflare-quick" });
    await expect(selectTransport("local", context)).rejects.toThrow("Local transport");
  });

  it("requires a named tunnel and hostname before starting Cloudflare Named Tunnel", () => {
    expect(cloudflareNamedConfiguration()).toBe(false);
    expect(cloudflareNamedConfiguration({
      localPort: 7676,
      localEndpoint: "http://127.0.0.1:7676/mcp/test",
      workspace: "/tmp/project",
      instanceName: "project",
      cloudflareTunnel: "coderelay",
      cloudflareHostname: "coderelay.example.com"
    })).toBe(false);
  });
});
