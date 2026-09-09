import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { LOG_PATH } from "../runtime/state.js";
import { terminateProcess } from "../runtime/process.js";
import type { TunnelProcess, TunnelProvider } from "./provider.js";

const CLOUDFLARED_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;

export class CloudflaredTunnelProvider implements TunnelProvider {
  readonly name = "cloudflared" as const;

  async isAvailable(): Promise<boolean> {
    const result = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  }

  async start(localPort: number): Promise<TunnelProcess> {
    if (!(await this.isAvailable())) {
      throw new Error("cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.");
    }

    await fs.mkdir(LOG_PATH, { recursive: true });
    const logPath = path.join(LOG_PATH, `cloudflared-${Date.now()}.log`);
    const logFd = fsSync.openSync(logPath, "a");
    const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env
    });
    fsSync.closeSync(logFd);
    child.unref();

    const baseUrl = await this.waitForUrl(logPath, child.pid ?? 0);
    if (!child.pid) throw new Error("cloudflared did not expose a process id.");
    return { pid: child.pid, baseUrl, logPath };
  }

  async healthCheck(baseUrl: string): Promise<boolean> {
    try {
      const response = await fetch(new URL("/health", baseUrl));
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(pid: number): Promise<void> {
    await terminateProcess(pid);
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
