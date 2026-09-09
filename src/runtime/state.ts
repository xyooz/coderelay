import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface WorkspaceConfig {
  workspace: string;
  host: string;
  port: number;
  safeMode: boolean;
  instanceName?: string;
  transport?: "auto" | "openai" | "cloudflare";
  openaiTunnelId?: string;
  /** @deprecated Kept so older .coderelay/config.json files can be read. */
  tunnelProvider?: "cloudflared";
}

export type TransportProviderName = "openai" | "cloudflare";

export interface RuntimeState {
  instanceName: string;
  pid: number;
  transportPid: number;
  transportState?: "disabled" | "starting" | "ready" | "degraded";
  workspace: string;
  host: string;
  port: number;
  token: string;
  transportProvider: TransportProviderName | "disabled";
  transportExecutable?: string;
  transportBaseUrl?: string;
  transportHealthUrl?: string;
  openaiTunnelId?: string;
  endpoint: string;
  startedAt: string;
  serverLog: string;
  transportLog: string;
}

export interface InstanceRecord {
  instanceName: string;
  workspace: string;
  transport: "auto" | "openai" | "cloudflare";
  openaiTunnelId?: string;
  updatedAt: string;
}

export const CODERELAY_HOME = process.env.CODERELAY_HOME
  ? path.resolve(process.env.CODERELAY_HOME)
  : path.join(os.homedir(), ".coderelay");
export const INSTANCES_PATH = path.join(CODERELAY_HOME, "instances");
/** @deprecated Use instanceRuntimePath() for new state. */
export const RUNTIME_PATH = path.join(CODERELAY_HOME, "runtime.json");
/** @deprecated Use instanceLogPath() for new state. */
export const LOG_PATH = path.join(CODERELAY_HOME, "logs");

export function normalizeInstanceName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Instance name must contain at least one letter or number.");
  }
  return normalized.slice(0, 80);
}

export function defaultInstanceName(workspace: string): string {
  return normalizeInstanceName(path.basename(path.resolve(workspace)) || "workspace");
}

export function instanceDirectory(instanceName: string): string {
  return path.join(INSTANCES_PATH, normalizeInstanceName(instanceName));
}

export function instanceRuntimePath(instanceName: string): string {
  return path.join(instanceDirectory(instanceName), "runtime.json");
}

export function instanceRecordPath(instanceName: string): string {
  return path.join(instanceDirectory(instanceName), "instance.json");
}

export function instanceLogPath(instanceName: string): string {
  return path.join(instanceDirectory(instanceName), "logs");
}

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function ensureGlobalStateDirectories(): Promise<void> {
  await ensureDirectory(INSTANCES_PATH);
}

export async function ensureInstanceStateDirectories(instanceName: string): Promise<void> {
  await ensureDirectory(instanceDirectory(instanceName));
  await ensureDirectory(instanceLogPath(instanceName));
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
    const parsed = JSON.parse(await fs.readFile(path.join(workspace, ".coderelay", "config.json"), "utf8")) as WorkspaceConfig;
    return {
      ...parsed,
      // The old tunnelProvider field described the implementation, not a user preference.
      // Migrate it to auto so an existing project can use OpenAI Secure MCP Tunnel when configured.
      transport: parsed.transport ?? "auto"
    };
  } catch {
    return null;
  }
}

export async function writeInstanceRecord(record: InstanceRecord): Promise<void> {
  await ensureInstanceStateDirectories(record.instanceName);
  await fs.writeFile(instanceRecordPath(record.instanceName), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function removeInstanceRecord(instanceName: string): Promise<void> {
  try {
    await fs.unlink(instanceRecordPath(instanceName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readInstanceRecord(filePath: string): Promise<InstanceRecord | null> {
  try {
    const record = JSON.parse(await fs.readFile(filePath, "utf8")) as InstanceRecord;
    return {
      ...record,
      instanceName: normalizeInstanceName(record.instanceName),
      workspace: path.resolve(record.workspace),
      transport: record.transport ?? "auto"
    };
  } catch {
    return null;
  }
}

export async function listInstanceRecords(): Promise<InstanceRecord[]> {
  const entries = await fs.readdir(INSTANCES_PATH, { withFileTypes: true }).catch(() => []);
  const records: InstanceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readInstanceRecord(path.join(INSTANCES_PATH, entry.name, "instance.json"));
    if (record) records.push(record);
  }
  return records.sort((left, right) => left.instanceName.localeCompare(right.instanceName));
}

export async function findInstanceRecordForWorkspace(workspace: string): Promise<InstanceRecord | null> {
  const resolvedWorkspace = path.resolve(workspace);
  const records = await listInstanceRecords();
  return records.find((record) => record.workspace === resolvedWorkspace) ?? null;
}

export async function writeRuntimeState(state: RuntimeState): Promise<void> {
  await ensureInstanceStateDirectories(state.instanceName);
  const runtimePath = instanceRuntimePath(state.instanceName);
  const temporaryPath = `${runtimePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, runtimePath);
}

function normalizeRuntimeState(raw: Partial<RuntimeState> & { tunnelPid?: number; tunnelProvider?: "cloudflared"; tunnelExecutable?: string; tunnelBaseUrl?: string; tunnelLog?: string }): RuntimeState {
  const instanceName = raw.instanceName ?? defaultInstanceName(raw.workspace ?? "workspace");
  return {
    instanceName,
    pid: raw.pid ?? 0,
    transportPid: raw.transportPid ?? raw.tunnelPid ?? 0,
    transportState: raw.transportState ?? ((raw.transportPid ?? raw.tunnelPid ?? 0) ? "ready" : "disabled"),
    workspace: raw.workspace ?? process.cwd(),
    host: raw.host ?? "127.0.0.1",
    port: raw.port ?? 0,
    token: raw.token ?? "",
    transportProvider: raw.transportProvider ?? (raw.tunnelProvider ? "cloudflare" : "disabled"),
    transportExecutable: raw.transportExecutable ?? raw.tunnelExecutable,
    transportBaseUrl: raw.transportBaseUrl ?? raw.tunnelBaseUrl,
    transportHealthUrl: raw.transportHealthUrl,
    openaiTunnelId: raw.openaiTunnelId,
    endpoint: raw.endpoint ?? "",
    startedAt: raw.startedAt ?? new Date(0).toISOString(),
    serverLog: raw.serverLog ?? "",
    transportLog: raw.transportLog ?? raw.tunnelLog ?? ""
  };
}

async function readRuntimeFile(runtimePath: string): Promise<RuntimeState | null> {
  try {
    return normalizeRuntimeState(JSON.parse(await fs.readFile(runtimePath, "utf8")) as Partial<RuntimeState>);
  } catch {
    return null;
  }
}

export async function readRuntimeState(instanceName?: string): Promise<RuntimeState | null> {
  if (instanceName) return await readRuntimeFile(instanceRuntimePath(instanceName));
  const legacy = await readRuntimeFile(RUNTIME_PATH);
  if (legacy) return legacy;
  const states = await listRuntimeStates();
  return states.length === 1 ? states[0] : null;
}

export async function listRuntimeStates(): Promise<RuntimeState[]> {
  const states: RuntimeState[] = [];
  const entries = await fs.readdir(INSTANCES_PATH, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readRuntimeFile(path.join(INSTANCES_PATH, entry.name, "runtime.json"));
    if (state) states.push(state);
  }
  const legacy = await readRuntimeFile(RUNTIME_PATH);
  if (legacy && !states.some((state) => state.instanceName === legacy.instanceName)) states.push(legacy);
  return states.sort((left, right) => left.instanceName.localeCompare(right.instanceName));
}

export async function findRuntimeStateForWorkspace(workspace: string): Promise<RuntimeState | null> {
  const resolvedWorkspace = path.resolve(workspace);
  const states = await listRuntimeStates();
  return states.find((state) => path.resolve(state.workspace) === resolvedWorkspace) ?? null;
}

export async function removeRuntimeState(instanceName?: string): Promise<void> {
  const runtimePath = instanceName ? instanceRuntimePath(instanceName) : RUNTIME_PATH;
  try {
    await fs.unlink(runtimePath);
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
