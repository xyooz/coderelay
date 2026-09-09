import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { instanceLogPath } from "../runtime/state.js";
import { terminateProcess } from "../runtime/process.js";
import { ensureCloudflared, resolveInstalledCloudflared, type CloudflaredRuntime } from "./download.js";
import type { TunnelProcess, TunnelProvider, TunnelStartContext } from "./provider.js";

const CLOUDFLARED_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;

export class CloudflaredTunnelProvider implements TunnelProvider {
  readonly name = "cloudflare" as const;

  async isAvailable(): Promise<boolean> {
    return (await resolveInstalledCloudflared()) !== null;
  }

  async runtime(): Promise<CloudflaredRuntime | null> {
    return await resolveInstalledCloudflared();
  }

  async start(context: TunnelStartContext): Promise<TunnelProcess> {
    const executable = await ensureCloudflared();

    const logDirectory = instanceLogPath(context.instanceName);
    await fs.mkdir(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `cloudflared-${Date.now()}.log`);
    const logFd = fsSync.openSync(logPath, "a");
    const child = spawn(executable.path, ["tunnel", "--url", `http://127.0.0.1:${context.localPort}`, "--no-autoupdate"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env
    });
    fsSync.closeSync(logFd);
    child.unref();

    const baseUrl = await this.waitForUrl(logPath, child.pid ?? 0);
    if (!child.pid) throw new Error("cloudflared did not expose a process id.");
    return {
      provider: "cloudflare",
      pid: child.pid,
      baseUrl,
      logPath,
      executablePath: executable.path,
      executableSource: executable.source,
      executableVersion: executable.version
    };
  }

  async healthCheck(process: TunnelProcess): Promise<boolean> {
    if (!process.baseUrl) return false;
    try {
      const response = await fetch(new URL("/health", process.baseUrl), {
        signal: AbortSignal.timeout(5_000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(process: TunnelProcess): Promise<void> {
    await terminateProcess(process.pid);
  }

  private async waitForUrl(logPath: string, pid: number, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const log = await fs.readFile(logPath, "utf8").catch(() => "");
      const match = log.match(CLOUDFLARED_URL);
      if (match) return match[0];
      if (pid && !this.isAlive(pid)) {
        throw new Error(`cloudflared exited before creating a tunnel. See ${logPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for cloudflared. See ${logPath}.`);
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
