import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface WorkspaceConfig {
  workspace: string;
  host: string;
  port: number;
  safeMode: boolean;
  tunnelProvider: "cloudflared";
}

export interface RuntimeState {
  pid: number;
  tunnelPid: number;
  transportState?: "disabled" | "starting" | "ready" | "degraded";
  workspace: string;
  host: string;
  port: number;
  token: string;
  tunnelProvider: "cloudflared";
  tunnelExecutable?: string;
  tunnelBaseUrl: string;
  endpoint: string;
  startedAt: string;
  serverLog: string;
  tunnelLog: string;
}

export const CODERELAY_HOME = process.env.CODERELAY_HOME
  ? path.resolve(process.env.CODERELAY_HOME)
  : path.join(os.homedir(), ".coderelay");
export const RUNTIME_PATH = path.join(CODERELAY_HOME, "runtime.json");
export const LOG_PATH = path.join(CODERELAY_HOME, "logs");

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function ensureGlobalStateDirectories(): Promise<void> {
  await ensureDirectory(LOG_PATH);
}

export async function writeWorkspaceConfig(config: WorkspaceConfig): Promise<string> {
  const configDirectory = path.join(config.workspace, ".coderelay");
  await ensureDirectory(configDirectory);
  const configPath = path.join(configDirectory, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

export async function readWorkspaceConfig(workspace: string): Promise<WorkspaceConfig | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspace, ".coderelay", "config.json"), "utf8")) as WorkspaceConfig;
  } catch {
    return null;
  }
}

export async function writeRuntimeState(state: RuntimeState): Promise<void> {
  await ensureGlobalStateDirectories();
  const temporaryPath = `${RUNTIME_PATH}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, RUNTIME_PATH);
}

export async function readRuntimeState(): Promise<RuntimeState | null> {
  try {
    return JSON.parse(await fs.readFile(RUNTIME_PATH, "utf8")) as RuntimeState;
  } catch {
    return null;
  }
}

export async function removeRuntimeState(): Promise<void> {
  try {
    await fs.unlink(RUNTIME_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
