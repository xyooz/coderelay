import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeDaemonConfig,
  readCloudflareTunnelTokenSync,
  readOpenAiApiKeySync,
  removeOpenAiApiKey,
  resolveTransportConfig,
  writeCloudflareTunnelToken,
  writeOpenAiApiKey,
  type DaemonConfig
} from "../src/runtime/state.js";
import { cloudflareNamedConfiguration, parseCloudflareTunnelToken } from "../src/tunnel/cloudflare-named.js";
import { selectTransport } from "../src/tunnel/selection.js";
import { saveOpenAiSetup } from "../src/cli/setup.js";

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

  it("parses Cloudflare connector commands and stores the token separately with private permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-cloudflare-credentials-"));
    const credentialsPath = path.join(directory, "credentials.json");
    const token = "eyJhbGciOiJIUzI1NiJ9.test-token.signature";
    try {
      expect(parseCloudflareTunnelToken(token)).toBe(token);
      expect(parseCloudflareTunnelToken(`cloudflared tunnel run --token ${token}`)).toBe(token);
      expect(parseCloudflareTunnelToken(`TUNNEL_TOKEN='${token}'`)).toBe(token);
      expect(parseCloudflareTunnelToken("cloudflared tunnel run --token")).toBeNull();

      await writeCloudflareTunnelToken(token, credentialsPath);
      expect(readCloudflareTunnelTokenSync(undefined, credentialsPath)).toEqual({ value: token, source: "credentials" });
      expect(readCloudflareTunnelTokenSync("environment-token", credentialsPath)).toEqual({ value: "environment-token", source: "environment" });
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
      const contents = await readFile(credentialsPath, "utf8");
      expect(contents).toContain(token);
      expect(contents).not.toContain("cloudflared tunnel run");
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

  it("lets setup save an environment API key when the user accepts the default", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coderelay-setup-credentials-"));
    const credentialsPath = path.join(directory, "credentials.json");
    const previousKey = process.env.CONTROL_PLANE_API_KEY;
    const answers = ["tunnel_0123456789abcdef0123456789abcdef", "Y"];
    try {
      process.env.CONTROL_PLANE_API_KEY = "environment-key";
      const reader = {
        question: async () => answers.shift() ?? ""
      } as unknown as Parameters<typeof saveOpenAiSetup>[0];
      await saveOpenAiSetup(reader, {}, credentialsPath);
      expect(readOpenAiApiKeySync(undefined, credentialsPath)).toEqual({ value: "environment-key", source: "environment" });
      expect(JSON.parse(await readFile(credentialsPath, "utf8"))).toMatchObject({ openai: { apiKey: "environment-key" } });
    } finally {
      if (previousKey === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = previousKey;
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
    expect(cloudflareNamedConfiguration({
      localPort: 7676,
      localEndpoint: "http://127.0.0.1:7676/mcp/test",
      workspace: "/tmp/project",
      instanceName: "project",
      cloudflareManagement: "remote",
      cloudflareTunnelToken: "remote-token",
      cloudflareHostname: "coderelay.example.com"
    })).toBe(true);
  });
});
