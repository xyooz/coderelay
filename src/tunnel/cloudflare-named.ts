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
  if (!context?.cloudflareTunnel || !context.cloudflareHostname) return false;
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
    if (!tunnel) throw new Error(`Cloudflare Named Tunnel requires a tunnel name or ID. Create one locally: ${CLOUDFLARE_TUNNEL_DOCS}`);
    if (!hostname || !/^[a-zA-Z0-9.-]+$/u.test(hostname)) throw new Error("Cloudflare Named Tunnel requires a valid hostname.");

    const executable = await this.runtime();
    if (!executable) throw new Error(`cloudflared was not found on PATH. Install it and authenticate a named tunnel: ${CLOUDFLARE_TUNNEL_DOCS}`);
    const configPath = await ensureNamedConfig(context, tunnel);
    const logDirectory = this.logDirectoryResolver(context.instanceName);
    await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const logPath = path.join(logDirectory, `cloudflared-named-${Date.now()}.log`);
    const logFd = fsSync.openSync(logPath, "a");
    const child = spawn(executable.path, ["tunnel", "--config", configPath, "--no-autoupdate", "run", tunnel], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env
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
