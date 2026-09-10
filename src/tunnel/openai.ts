import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { instanceLogPath } from "../runtime/state.js";
import { terminateProcess } from "../runtime/process.js";
import type { TunnelProcess, TunnelProvider, TunnelStartContext } from "./provider.js";

const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/u;
type LogDirectoryResolver = (instanceName: string) => string;

function candidateNames(): string[] {
  return process.platform === "win32" ? ["tunnel-client.exe", "tunnel-client"] : ["tunnel-client"];
}

function isRunnable(filePath: string): boolean {
  try {
    const stats = fsSync.statSync(filePath);
    fsSync.accessSync(filePath, process.platform === "win32" ? fsSync.constants.F_OK : fsSync.constants.X_OK);
    return stats.isFile();
  } catch {
    return false;
  }
}

function works(filePath: string): boolean {
  if (!isRunnable(filePath)) return false;
  return spawnSync(filePath, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
}

function version(filePath: string): string {
  const result = spawnSync(filePath, ["--version"], { encoding: "utf8", windowsHide: true });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/u)[0] || "unknown";
}

export function resolveTunnelClient(explicitPath = process.env.CODERELAY_TUNNEL_CLIENT): string | null {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : (process.env.PATH ?? "").split(path.delimiter).flatMap((directory) => candidateNames().map((name) => path.join(directory, name)));
  return candidates.find((candidate) => works(candidate)) ?? null;
}

export function openAiTunnelId(context?: TunnelStartContext): string | undefined {
  return context?.openaiTunnelId ?? process.env.CONTROL_PLANE_TUNNEL_ID;
}

export function hasOpenAiConfiguration(context?: TunnelStartContext): boolean {
  return Boolean(openAiTunnelId(context) && process.env.CONTROL_PLANE_API_KEY);
}

function requireTunnelId(context: TunnelStartContext): string {
  const tunnelId = openAiTunnelId(context);
  if (!tunnelId || !TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new Error("OpenAI Secure MCP Tunnel requires CONTROL_PLANE_TUNNEL_ID or a valid configured tunnel ID.");
  }
  return tunnelId;
}

function requireApiKey(): void {
  if (!process.env.CONTROL_PLANE_API_KEY) {
    throw new Error("OpenAI Secure MCP Tunnel requires CONTROL_PLANE_API_KEY with Tunnels Read + Use.");
  }
}

async function waitForHealthUrl(filePath: string, pid: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pid && !isAlive(pid)) throw new Error(`tunnel-client exited before exposing its health URL. Check the transport log.`);
    const value = await fs.readFile(filePath, "utf8").catch(() => "");
    const healthUrl = value.trim().replace(/\/$/u, "");
    if (healthUrl) return healthUrl;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for tunnel-client health URL. Check the transport log and tunnel-client /ui.");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class OpenAiTunnelProvider implements TunnelProvider {
  readonly name = "openai" as const;

  constructor(private readonly logDirectoryResolver: LogDirectoryResolver = instanceLogPath) {}

  async isAvailable(context?: TunnelStartContext): Promise<boolean> {
    if (!openAiTunnelId(context) || !process.env.CONTROL_PLANE_API_KEY) return false;
    return resolveTunnelClient() !== null;
  }

  async start(context: TunnelStartContext): Promise<TunnelProcess> {
    const tunnelId = requireTunnelId(context);
    requireApiKey();
    const executable = resolveTunnelClient();
    if (!executable) {
      throw new Error("tunnel-client was not found. Install it from OpenAI Platform Tunnels or set CODERELAY_TUNNEL_CLIENT.");
    }

    const logDirectory = this.logDirectoryResolver(context.instanceName);
    await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const logPath = path.join(logDirectory, `tunnel-client-${Date.now()}.log`);
    const healthUrlFile = path.join(logDirectory, `tunnel-client-health-${Date.now()}.url`);
    const logFd = fsSync.openSync(logPath, "a");
    const child = spawn(executable, [
      "run",
      "--control-plane.tunnel-id",
      tunnelId,
      "--mcp-server-url",
      context.localEndpoint,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      healthUrlFile
    ], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, CONTROL_PLANE_TUNNEL_ID: tunnelId }
    });
    fsSync.closeSync(logFd);
    child.unref();
    if (!child.pid) throw new Error("tunnel-client did not expose a process id.");

    const healthUrl = await waitForHealthUrl(healthUrlFile, child.pid);
    return {
      provider: "openai",
      pid: child.pid,
      healthUrl,
      tunnelId,
      logPath,
      executablePath: executable,
      executableSource: "path",
      executableVersion: version(executable)
    };
  }

  async healthCheck(process: TunnelProcess): Promise<boolean> {
    if (!process.healthUrl) return false;
    try {
      const response = await fetch(`${process.healthUrl}/readyz`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(process: TunnelProcess): Promise<void> {
    await terminateProcess(process.pid);
  }
}
