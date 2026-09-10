import fs from "node:fs/promises";
import fsSync from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { CommandPolicyMode } from "../command/model.js";

export interface WorkspaceConfig {
  workspace: string;
  host: string;
  port: number;
  safeMode: boolean;
  instanceName?: string;
  transport?: TransportPreference | "cloudflare";
  openaiTunnelId?: string;
  /** @deprecated Kept so older .coderelay/config.json files can be read. */
  tunnelProvider?: "cloudflared";
}

export type TransportPreference = "auto" | "openai" | "cloudflare-named" | "cloudflare-quick" | "local";
export type TransportProviderName = Exclude<TransportPreference, "auto">;

export interface TransportConfig {
  preferred: TransportPreference;
  fallback?: TransportPreference;
}

export interface OpenAiConfig {
  tunnelId?: string;
}

export interface CloudflareConfig {
  management?: "remote" | "local";
  tunnel?: string;
  hostname?: string;
  configPath?: string;
  credentialsFile?: string;
}

export interface CredentialsFile {
  mcp?: {
    endpointToken?: string;
  };
  openai?: {
    apiKey?: string;
  };
  cloudflare?: {
    tunnelToken?: string;
  };
}

export type ApiKeySource = "environment" | "credentials" | "missing";

export interface ApiKeyResolution {
  value?: string;
  source: ApiKeySource;
}

export type CloudflareTokenSource = "environment" | "credentials" | "missing";

export interface CloudflareTokenResolution {
  value?: string;
  source: CloudflareTokenSource;
}

const MCP_ENDPOINT_TOKEN_BYTES = 24;
const MCP_ENDPOINT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

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
  transportPreference?: TransportPreference;
  transportFallbackReason?: string;
  transportExecutable?: string;
  transportBaseUrl?: string;
  transportHealthUrl?: string;
  openaiTunnelId?: string;
  publicBaseUrl?: string;
  mcpEndpoint?: string;
  endpoint: string;
  startedAt: string;
  serverLog: string;
  transportLog: string;
}

export interface InstanceRecord {
  instanceName: string;
  workspace: string;
  transport: TransportPreference | "cloudflare";
  openaiTunnelId?: string;
  updatedAt: string;
}

export interface DaemonConfig {
  /** New structured transport settings. A string is accepted for legacy configs. */
  transport?: TransportConfig | TransportPreference | "cloudflare";
  openai?: OpenAiConfig;
  cloudflare?: CloudflareConfig;
  /** @deprecated Migrate to openai.tunnelId. */
  openaiTunnelId?: string;
  commandPolicy?: { mode?: CommandPolicyMode };
  host?: string;
  port?: number;
}

export const CODERELAY_HOME = process.env.CODERELAY_HOME
  ? path.resolve(process.env.CODERELAY_HOME)
  : path.join(os.homedir(), ".coderelay");
export const INSTANCES_PATH = path.join(CODERELAY_HOME, "instances");
export const DAEMON_PATH = path.join(CODERELAY_HOME, "daemon");
export const DAEMON_RUNTIME_PATH = path.join(DAEMON_PATH, "runtime.json");
export const DAEMON_LOG_PATH = path.join(DAEMON_PATH, "logs");
export const DAEMON_CONFIG_PATH = path.join(CODERELAY_HOME, "config.json");
export const CREDENTIALS_PATH = path.join(CODERELAY_HOME, "credentials.json");
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

async function ensureDirectory(directory: string, mode = 0o700): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.chmod(directory, mode).catch(() => undefined);
}

export async function ensureGlobalStateDirectories(): Promise<void> {
  await ensureDirectory(CODERELAY_HOME, 0o700);
  await ensureDirectory(INSTANCES_PATH);
  await ensureDirectory(DAEMON_PATH);
}

export async function ensureDaemonStateDirectories(): Promise<void> {
  await ensureDirectory(CODERELAY_HOME, 0o700);
  await ensureDirectory(DAEMON_PATH);
  await ensureDirectory(DAEMON_LOG_PATH);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath), 0o700);
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporaryPath, 0o600);
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function writeDaemonConfig(config: DaemonConfig): Promise<void> {
  await writePrivateJson(DAEMON_CONFIG_PATH, config);
}

export async function readDaemonConfig(): Promise<DaemonConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(DAEMON_CONFIG_PATH, "utf8")) as DaemonConfig;
    return normalizeDaemonConfig(parsed);
  } catch {
    return null;
  }
}

function normalizeTransport(value: unknown): TransportPreference {
  if (value === "openai" || value === "cloudflare-named" || value === "cloudflare-quick" || value === "local" || value === "auto") return value;
  if (value === "cloudflare") return "cloudflare-quick";
  return "auto";
}

export function normalizeDaemonConfig(raw: DaemonConfig): DaemonConfig {
  const rawTransport = raw.transport;
  const preferred = typeof rawTransport === "object" && rawTransport !== null
    ? normalizeTransport(rawTransport.preferred)
    : normalizeTransport(rawTransport);
  const fallback = typeof rawTransport === "object" && rawTransport !== null && rawTransport.fallback !== undefined
    ? normalizeTransport(rawTransport.fallback)
    : preferred === "openai" || preferred === "cloudflare-named" ? "cloudflare-quick" : undefined;
  const cloudflare = raw.cloudflare
    ? {
        ...raw.cloudflare,
        ...(raw.cloudflare.management
          ? {}
          : raw.cloudflare.tunnel || raw.cloudflare.configPath || raw.cloudflare.credentialsFile
            ? { management: "local" as const }
            : {})
      }
    : undefined;
  return {
    ...raw,
    transport: { preferred, ...(fallback ? { fallback } : {}) },
    openai: raw.openai ?? (raw.openaiTunnelId ? { tunnelId: raw.openaiTunnelId } : undefined),
    cloudflare
  };
}

export function resolveTransportConfig(config: DaemonConfig | null): TransportConfig {
  const normalized = config ? normalizeDaemonConfig(config) : null;
  const transport = normalized?.transport;
  if (transport && typeof transport === "object") return transport;
  const preferred = normalizeTransport(transport);
  return {
    preferred,
    ...(preferred === "openai" || preferred === "cloudflare-named" ? { fallback: "cloudflare-quick" as const } : {})
  };
}

export function resolveConfiguredOpenAiTunnelId(config: Pick<DaemonConfig, "openai" | "openaiTunnelId"> | null): string | undefined {
  return config?.openai?.tunnelId ?? config?.openaiTunnelId;
}

export function readCloudflareTunnelTokenSync(
  environmentValue = process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.TUNNEL_TOKEN,
  credentialsPath = CREDENTIALS_PATH
): CloudflareTokenResolution {
  if (environmentValue) return { value: environmentValue, source: "environment" };
  try {
    const parsed = JSON.parse(fsSync.readFileSync(credentialsPath, "utf8")) as CredentialsFile;
    if (parsed.cloudflare?.tunnelToken) return { value: parsed.cloudflare.tunnelToken, source: "credentials" };
  } catch {
    // A missing or malformed credentials file is equivalent to missing auth.
  }
  return { source: "missing" };
}

export function readOpenAiApiKeySync(environmentValue = process.env.CONTROL_PLANE_API_KEY, credentialsPath = CREDENTIALS_PATH): ApiKeyResolution {
  if (environmentValue) return { value: environmentValue, source: "environment" };
  try {
    const parsed = JSON.parse(fsSync.readFileSync(credentialsPath, "utf8")) as CredentialsFile;
    if (parsed.openai?.apiKey) return { value: parsed.openai.apiKey, source: "credentials" };
  } catch {
    // A missing or malformed credentials file is equivalent to missing auth.
  }
  return { source: "missing" };
}

export async function readCredentials(credentialsPath = CREDENTIALS_PATH): Promise<CredentialsFile | null> {
  try {
    return JSON.parse(await fs.readFile(credentialsPath, "utf8")) as CredentialsFile;
  } catch {
    return null;
  }
}

export async function writeCredentials(credentials: CredentialsFile, credentialsPath = CREDENTIALS_PATH): Promise<void> {
  await writePrivateJson(credentialsPath, credentials);
}

export async function writeOpenAiApiKey(apiKey: string, credentialsPath = CREDENTIALS_PATH): Promise<void> {
  const current = await readCredentials(credentialsPath);
  await writeCredentials({ ...current, openai: { ...(current?.openai ?? {}), apiKey } }, credentialsPath);
}

export async function writeCloudflareTunnelToken(token: string, credentialsPath = CREDENTIALS_PATH): Promise<void> {
  const current = await readCredentials(credentialsPath);
  await writeCredentials({ ...current, cloudflare: { ...(current?.cloudflare ?? {}), tunnelToken: token } }, credentialsPath);
}

export function generateMcpEndpointToken(): string {
  return randomBytes(MCP_ENDPOINT_TOKEN_BYTES).toString("base64url");
}

export function readMcpEndpointTokenSync(credentialsPath = CREDENTIALS_PATH): string | undefined {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(credentialsPath, "utf8")) as CredentialsFile;
    const token = parsed.mcp?.endpointToken;
    return token && MCP_ENDPOINT_TOKEN_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export async function writeMcpEndpointToken(token: string, credentialsPath = CREDENTIALS_PATH): Promise<void> {
  if (!MCP_ENDPOINT_TOKEN_PATTERN.test(token)) throw new Error("MCP endpoint token has an invalid format.");
  const current = await readCredentials(credentialsPath);
  await writeCredentials({ ...current, mcp: { ...(current?.mcp ?? {}), endpointToken: token } }, credentialsPath);
}

export async function getOrCreateMcpEndpointToken(credentialsPath = CREDENTIALS_PATH): Promise<string> {
  const existing = readMcpEndpointTokenSync(credentialsPath);
  if (existing) return existing;
  const token = generateMcpEndpointToken();
  await writeMcpEndpointToken(token, credentialsPath);
  return token;
}

export async function rotateMcpEndpointToken(credentialsPath = CREDENTIALS_PATH): Promise<string> {
  const token = generateMcpEndpointToken();
  await writeMcpEndpointToken(token, credentialsPath);
  return token;
}

export async function removeOpenAiApiKey(credentialsPath = CREDENTIALS_PATH): Promise<void> {
  const current = await readCredentials(credentialsPath);
  if (!current?.openai) return;
  const next = { ...current };
  delete next.openai;
  if (Object.keys(next).length === 0) {
    await fs.unlink(credentialsPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return;
  }
  await writeCredentials(next, credentialsPath);
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

export async function writeDaemonRuntimeState(state: RuntimeState): Promise<void> {
  await ensureDaemonStateDirectories();
  const temporaryPath = `${DAEMON_RUNTIME_PATH}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, DAEMON_RUNTIME_PATH);
}

function normalizeRuntimeState(raw: Partial<RuntimeState> & { tunnelPid?: number; tunnelProvider?: "cloudflared"; tunnelExecutable?: string; tunnelBaseUrl?: string; tunnelLog?: string }): RuntimeState {
  const instanceName = raw.instanceName ?? defaultInstanceName(raw.workspace ?? "workspace");
  const rawProvider = raw.transportProvider as string | undefined;
  const transportProvider: RuntimeState["transportProvider"] = rawProvider === "cloudflare"
    ? "cloudflare-quick"
    : rawProvider === "openai" || rawProvider === "cloudflare-named" || rawProvider === "cloudflare-quick" || rawProvider === "local" || rawProvider === "disabled"
      ? rawProvider
      : raw.tunnelProvider
        ? "cloudflare-quick"
        : "disabled";
  return {
    instanceName,
    pid: raw.pid ?? 0,
    transportPid: raw.transportPid ?? raw.tunnelPid ?? 0,
    transportState: raw.transportState ?? ((raw.transportPid ?? raw.tunnelPid ?? 0) ? "ready" : "disabled"),
    workspace: raw.workspace ?? process.cwd(),
    host: raw.host ?? "127.0.0.1",
    port: raw.port ?? 0,
    token: raw.token ?? "",
    transportProvider,
    transportExecutable: raw.transportExecutable ?? raw.tunnelExecutable,
    transportBaseUrl: raw.transportBaseUrl ?? raw.tunnelBaseUrl,
    transportHealthUrl: raw.transportHealthUrl,
    openaiTunnelId: raw.openaiTunnelId,
    publicBaseUrl: raw.publicBaseUrl,
    mcpEndpoint: raw.mcpEndpoint ?? raw.endpoint ?? "",
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

export async function readDaemonRuntimeState(): Promise<RuntimeState | null> {
  return await readRuntimeFile(DAEMON_RUNTIME_PATH);
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

export async function removeDaemonRuntimeState(): Promise<void> {
  try {
    await fs.unlink(DAEMON_RUNTIME_PATH);
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
