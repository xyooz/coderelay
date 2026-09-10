import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { CODERELAY_HOME, instanceLogPath } from "../runtime/state.js";
import { terminateProcess } from "../runtime/process.js";
import { resolveInstalledCloudflared, type CloudflaredRuntime } from "./download.js";
import type { TunnelProcess, TunnelProvider, TunnelStartContext } from "./provider.js";

type LogDirectoryResolver = (instanceName: string) => string;

export const CLOUDFLARE_TUNNEL_DOCS = "https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/";
export const CLOUDFLARE_TUNNEL_DASHBOARD = "https://dash.cloudflare.com/";
export const CLOUDFLARE_REMOTE_TUNNEL_DOCS = "https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/";

/**
 * Accept either the opaque token copied from the Cloudflare dashboard or the
 * connector command shown by the dashboard. The input is never logged.
 */
export function parseCloudflareTunnelToken(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const commandMatch = value.match(/(?:^|\s)(?:--token|--token=|TUNNEL_TOKEN=)(?:\s+|=)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/u);
  const token = commandMatch?.[1] ?? commandMatch?.[2] ?? commandMatch?.[3] ?? value;
  if (!token || /\s/u.test(token) || token.startsWith("--")) return null;
  return token;
}

export function listCloudflareTunnels(executablePath: string): string[] {
  const result = spawnSync(executablePath, ["tunnel", "list"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  return `${result.stdout ?? ""}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^id\s+name/i.test(line) && !/^[-\s]+$/u.test(line));
}

function cloudflaredDirectory(): string {
  return process.env.CLOUDFLARED_CONFIG_DIR
    ? path.resolve(process.env.CLOUDFLARED_CONFIG_DIR)
    : path.join(os.homedir(), ".cloudflared");
}

export function resolveCloudflareConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    return fsSync.existsSync(resolved) ? resolved : null;
  }
  const directory = cloudflaredDirectory();
  for (const candidate of ["config.yml", "config.yaml"]) {
    const filePath = path.join(directory, candidate);
    if (fsSync.existsSync(filePath)) return filePath;
  }
  return null;
}

function resolveCredentialsFile(tunnel: string, explicitPath?: string): string | null {
  if (explicitPath) return path.resolve(explicitPath);
  const normalized = tunnel.trim();
  if (!/^[a-zA-Z0-9-]+$/u.test(normalized)) return null;
  const candidate = path.join(cloudflaredDirectory(), `${normalized}.json`);
  return fsSync.existsSync(candidate) ? candidate : null;
}

function safeYamlValue(value: string, label: string): string {
  if (!value || /[\r\n]/u.test(value)) throw new Error(`Cloudflare ${label} is invalid.`);
  return JSON.stringify(value);
}

async function ensureNamedConfig(context: TunnelStartContext, tunnel: string): Promise<string> {
  const configured = resolveCloudflareConfigPath(context.cloudflareConfigPath);
  if (configured) return configured;

  const credentialsFile = resolveCredentialsFile(tunnel, context.cloudflareCredentialsFile);
  if (!credentialsFile) {
    throw new Error(`No Cloudflare named tunnel config or credentials were found. Create a locally-managed tunnel first: ${CLOUDFLARE_TUNNEL_DOCS}`);
  }
  const directory = path.join(CODERELAY_HOME, "cloudflare");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const configPath = path.join(directory, `named-${tunnel.replace(/[^a-zA-Z0-9_-]+/gu, "-")}.yml`);
  const contents = [
    `tunnel: ${safeYamlValue(tunnel, "tunnel name")}`,
    `credentials-file: ${safeYamlValue(credentialsFile, "credentials file")}`,
    "ingress:",
    `  - hostname: ${safeYamlValue(context.cloudflareHostname ?? "", "hostname")}`,
    `    service: http://127.0.0.1:${context.localPort}`,
    "  - service: http_status:404",
    ""
  ].join("\n");
  await fs.writeFile(configPath, contents, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return configPath;
}

export function cloudflareNamedConfiguration(context?: TunnelStartContext): boolean {
  if (!context?.cloudflareHostname || !/^[a-zA-Z0-9.-]+$/u.test(context.cloudflareHostname)) return false;
  const management = context.cloudflareManagement ?? (context.cloudflareTunnelToken ? "remote" : "local");
  if (management === "remote") return Boolean(context.cloudflareTunnelToken);
  if (!context.cloudflareTunnel) return false;
  return Boolean(resolveCloudflareConfigPath(context.cloudflareConfigPath) || resolveCredentialsFile(context.cloudflareTunnel, context.cloudflareCredentialsFile));
}

export class CloudflareNamedTunnelProvider implements TunnelProvider {
  readonly name = "cloudflare-named" as const;

  constructor(private readonly logDirectoryResolver: LogDirectoryResolver = instanceLogPath) {}

  async runtime(): Promise<CloudflaredRuntime | null> {
    return await resolveInstalledCloudflared();
  }

  async isAvailable(context?: TunnelStartContext): Promise<boolean> {
    return Boolean(await this.runtime()) && cloudflareNamedConfiguration(context);
  }

  async start(context: TunnelStartContext): Promise<TunnelProcess> {
    const tunnel = context.cloudflareTunnel?.trim();
    const hostname = context.cloudflareHostname?.trim();
    if (!hostname || !/^[a-zA-Z0-9.-]+$/u.test(hostname)) throw new Error("Cloudflare Named Tunnel requires a valid hostname.");
    const management = context.cloudflareManagement ?? (context.cloudflareTunnelToken ? "remote" : "local");
    if (management === "remote" && !context.cloudflareTunnelToken) {
      throw new Error(`Cloudflare remotely-managed Named Tunnel requires a tunnel token. Configure it with coderelay setup: ${CLOUDFLARE_REMOTE_TUNNEL_DOCS}`);
    }
    if (management === "local" && !tunnel) {
      throw new Error(`Cloudflare locally-managed Named Tunnel requires a tunnel name or ID. Create one locally: ${CLOUDFLARE_TUNNEL_DOCS}`);
    }

    const executable = await this.runtime();
    if (!executable) {
      const docs = management === "remote" ? CLOUDFLARE_REMOTE_TUNNEL_DOCS : CLOUDFLARE_TUNNEL_DOCS;
      throw new Error(`cloudflared was not found on PATH. Install it and retry: ${docs}`);
    }
    let args: string[];
    let environment = process.env;
    if (management === "remote") {
      // Cloudflare accepts TUNNEL_TOKEN for remotely-managed connectors. Keep
      // the secret out of argv, RuntimeState, status, and CodeRelay logs.
      const token = context.cloudflareTunnelToken;
      if (!token) throw new Error(`Cloudflare remotely-managed Named Tunnel requires a tunnel token. Configure it with coderelay setup: ${CLOUDFLARE_REMOTE_TUNNEL_DOCS}`);
      args = ["tunnel", "--no-autoupdate", "run"];
      environment = { ...process.env, TUNNEL_TOKEN: token };
    } else {
      const localTunnel = tunnel;
      if (!localTunnel) throw new Error(`Cloudflare locally-managed Named Tunnel requires a tunnel name or ID. Create one locally: ${CLOUDFLARE_TUNNEL_DOCS}`);
      const configPath = await ensureNamedConfig(context, localTunnel);
      args = ["tunnel", "--config", configPath, "--no-autoupdate", "run", localTunnel];
    }
    const logDirectory = this.logDirectoryResolver(context.instanceName);
    await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const logPath = path.join(logDirectory, `cloudflared-named-${Date.now()}.log`);
    const logFd = fsSync.openSync(logPath, "a");
    const child = spawn(executable.path, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: environment
    });
    fsSync.closeSync(logFd);
    child.unref();
    if (!child.pid) throw new Error("cloudflared did not expose a process id.");
    const baseUrl = `https://${hostname}`;
    return {
      provider: "cloudflare-named",
      pid: child.pid,
      baseUrl,
      healthUrl: baseUrl,
      logPath,
      executablePath: executable.path,
      executableSource: executable.source,
      executableVersion: executable.version
    };
  }

  async healthCheck(process: TunnelProcess): Promise<boolean> {
    if (!process.healthUrl) return false;
    try {
      const response = await fetch(new URL("/health", process.healthUrl), { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(process: TunnelProcess): Promise<void> {
    await terminateProcess(process.pid);
  }
}
