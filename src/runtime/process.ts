import fs from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "./state.js";

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(start = 7676, host = "127.0.0.1"): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available port found in ${start}-${start + 99}.`);
}

export function spawnDetachedProcess(
  command: string,
  args: string[],
  logPath: string,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env
): ChildProcess {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env
  });
  fs.closeSync(logFd);
  child.unref();
  return child;
}

export async function waitForHttp(url: string, timeoutMs = 10_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : "not reachable"}`);
}

export async function terminateProcess(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have exited between the liveness check and kill.
    }
  }
}

export function currentEntryPoint(): string {
  const entryPoint = fileURLToPath(import.meta.url);
  return entryPoint
    .replace(`${path.sep}runtime${path.sep}process.js`, `${path.sep}index.js`)
    .replace(`${path.sep}runtime${path.sep}process.ts`, `${path.sep}index.ts`);
}
