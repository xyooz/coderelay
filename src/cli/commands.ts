import { appendFile } from "node:fs/promises";
import path from "node:path";
import { detectWorkspace } from "../workspace/detect.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { runMcpServer } from "../mcp/server.js";
import { CloudflaredTunnelProvider } from "../tunnel/cloudflared.js";
import { CloudflareNamedTunnelProvider } from "../tunnel/cloudflare-named.js";
import { OpenAiTunnelProvider, resolveTunnelClient } from "../tunnel/openai.js";
import { selectTransport, type TransportPreference } from "../tunnel/selection.js";
import { waitForHealth, type HealthProbe } from "../tunnel/readiness.js";
import type { TunnelProcess, TunnelProvider, TunnelStartContext } from "../tunnel/provider.js";
import {
  CLOUDFLARE_REMOTE_TUNNEL_DOCS,
  CLOUDFLARE_TUNNEL_DOCS,
  OPENAI_TUNNEL_DOCS,
  OPENAI_TUNNEL_SETTINGS,
  setupCommand
} from "./setup.js";
import {
  CODERELAY_HOME,
  DAEMON_LOG_PATH,
  defaultInstanceName,
  ensureDaemonStateDirectories,
  isProcessAlive,
  readCloudflareTunnelTokenSync,
  readDaemonConfig,
  readDaemonRuntimeState,
  readOpenAiApiKeySync,
  resolveConfiguredOpenAiTunnelId,
  resolveTransportConfig,
  removeDaemonRuntimeState,
  writeDaemonRuntimeState,
  type DaemonConfig,
  type RuntimeState,
  type TransportProviderName
} from "../runtime/state.js";
import {
  commandExists,
  currentEntryPoint,
  findAvailablePort,
  randomToken,
  spawnDetachedProcess,
  terminateProcess,
  waitForHttp
} from "../runtime/process.js";

const DAEMON_NAME = "daemon";

export interface StartOptions {
  workspace?: string;
  name?: string;
  tunnelId?: string;
  port?: number;
  transport?: TransportPreference | "cloudflare";
  tunnel?: boolean;
}

export interface ServeOptions {
  registryHome?: string;
  instanceName: string;
  host: string;
  port: number;
  token: string;
}

function endpointFor(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/u, "")}/mcp/${token}`;
}

function localBaseUrl(host: string, port: number): string {
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

function serverChildCommand(args: string[]): { command: string; args: string[] } {
  const entryPoint = currentEntryPoint();
  if (entryPoint.endsWith(".ts")) return { command: process.execPath, args: ["--import", "tsx/esm", entryPoint, ...args] };
  return { command: process.execPath, args: [entryPoint, ...args] };
}

function configuredTransport(config: DaemonConfig | null): TransportPreference {
  return resolveTransportConfig(config).preferred;
}

export function resolveOpenAiTunnelId(
  explicitTunnelId: string | undefined,
  config: Pick<DaemonConfig, "openai" | "openaiTunnelId"> | null,
  environmentTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID
): string | undefined {
  return explicitTunnelId ?? resolveConfiguredOpenAiTunnelId(config) ?? environmentTunnelId;
}

async function logTransportEvent(logPath: string, message: string): Promise<void> {
  if (!logPath) return;
  await appendFile(logPath, `[CodeRelay ${new Date().toISOString()}] ${message}\n`).catch(() => undefined);
}

async function waitForTransport(provider: TunnelProvider, tunnel: TunnelProcess, retryNumber: number): Promise<boolean> {
  await logTransportEvent(tunnel.logPath, `transport started provider=${provider.name} tunnel_id=${tunnel.tunnelId ?? ""} retry=${retryNumber}`);
  const result = await waitForHealth(
    () => provider.healthCheck(tunnel),
    {
      onProbe: async (probe: HealthProbe) => {
        await logTransportEvent(tunnel.logPath, `transport health-check provider=${provider.name} attempt=${probe.attempt} delay_ms=${probe.delayMs} healthy=${probe.healthy} elapsed_ms=${probe.elapsedMs} retry=${retryNumber}`);
      }
    }
  );
  await logTransportEvent(tunnel.logPath, `transport health-check finished provider=${provider.name} ready=${result.ready} attempts=${result.attempts} elapsed_ms=${result.elapsedMs} retry=${retryNumber}`);
  return result.ready;
}

function providerFor(name: TransportProviderName): TunnelProvider {
  if (name === "openai") return new OpenAiTunnelProvider(() => DAEMON_LOG_PATH);
  if (name === "cloudflare-named") return new CloudflareNamedTunnelProvider(() => DAEMON_LOG_PATH);
  return new CloudflaredTunnelProvider(() => DAEMON_LOG_PATH);
}

function providerNameForPreference(preference: TransportPreference): RuntimeState["transportProvider"] {
  if (preference === "openai" || preference === "cloudflare-named" || preference === "cloudflare-quick") return preference;
  return "disabled";
}

function processFromState(state: RuntimeState): TunnelProcess {
  return {
    provider: state.transportProvider === "disabled" ? "local" : state.transportProvider,
    pid: state.transportPid,
    baseUrl: state.transportBaseUrl,
    healthUrl: state.transportHealthUrl,
    tunnelId: state.openaiTunnelId,
    logPath: state.transportLog,
    executablePath: state.transportExecutable ?? "",
    executableSource: "path",
    executableVersion: "unknown"
  };
}

function currentTransportState(state: RuntimeState): NonNullable<RuntimeState["transportState"]> {
  return state.transportState ?? (state.transportPid ? "ready" : "disabled");
}

async function refreshTransportState(state: RuntimeState, processAlive: boolean, transportHealthy: boolean): Promise<NonNullable<RuntimeState["transportState"]>> {
  const nextState = state.transportProvider === "disabled" || state.transportProvider === "local"
    ? "disabled"
    : processAlive && transportHealthy
      ? "ready"
      : currentTransportState(state) === "starting"
        ? "starting"
        : "degraded";
  if (state.transportState !== nextState) {
    state.transportState = nextState;
    await writeDaemonRuntimeState(state);
  }
  return nextState;
}

async function ensureDaemonIsStopped(): Promise<void> {
  const previous = await readDaemonRuntimeState();
  if (!previous) return;
  if (isProcessAlive(previous.pid)) {
    throw new Error(`CodeRelay daemon is already running. Run coderelay status or coderelay stop first.`);
  }
  await removeDaemonRuntimeState();
}

function printProjectDetection(info: Awaited<ReturnType<typeof detectWorkspace>>): void {
  console.log("Detected project:");
  console.log(info.isGitRepository ? "  ✓ Git repository" : "  ! Git repository not detected");
  for (const technology of info.technologies) console.log(`  ✓ ${technology}`);
  if (info.technologies.length === 0 && info.markers.length > 0) console.log(`  ✓ ${info.markers.join(", ")}`);
}

function printReadyMessage(state: RuntimeState, workspaceCount: number): void {
  console.log(`  ✓ CodeRelay daemon: ${state.instanceName}`);
  console.log(`  ✓ Registered workspaces: ${workspaceCount}`);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (state.transportProvider === "openai") {
    console.log(state.transportState === "ready" ? "Secure connection ready" : "Local MCP is ready; the Secure connection is still warming up.");
    console.log("Transport: OpenAI Secure MCP Tunnel");
    console.log(`Tunnel ID: ${state.openaiTunnelId ?? "not available"}`);
    console.log("ChatGPT app: CodeRelay");
    console.log("In ChatGPT, call list_workspaces and then use_workspace for this chat.");
    console.log("Keep this process running while using the ChatGPT app.");
  } else if (state.transportProvider === "cloudflare-quick" || state.transportProvider === "cloudflare-named") {
    console.log(state.transportState === "degraded" ? "Local MCP is ready; the public endpoint is still warming up." : "Secure connection ready");
    console.log(`Transport: ${state.transportProvider === "cloudflare-named" ? "Cloudflare Named Tunnel" : "Cloudflare Quick Tunnel"}`);
    if (state.transportProvider === "cloudflare-named") {
      const hostname = state.publicBaseUrl ? new URL(state.publicBaseUrl).hostname : "not available";
      console.log(`Public hostname: ${hostname}`);
    }
    console.log(`Public MCP endpoint: ${state.mcpEndpoint ?? state.endpoint}`);
    console.log("\nChatGPT:");
    console.log("Settings → Apps / Connectors → create or select CodeRelay");
    console.log("Use the endpoint above when ChatGPT asks for the MCP server URL.");
  } else {
    console.log("Transport: Local only");
    console.log("Local MCP server ready");
    console.log(state.endpoint);
    console.log("\nTunnel disabled; this endpoint is local-only.");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\nRun coderelay workspaces to view registered projects.");
  console.log("Run coderelay doctor if anything looks wrong.");
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  const registry = new WorkspaceRegistry(CODERELAY_HOME);
  let entries = await registry.list();
  const requestedWorkspace = options.workspace ?? (options.name ? process.cwd() : undefined);
  if (requestedWorkspace) {
    const info = await detectWorkspace(requestedWorkspace);
    const entry = await registry.add(info.root, options.name);
    entries = await registry.list();
    printProjectDetection(info);
    console.log(`  ✓ Workspace registered: ${entry.name}`);
  } else if (entries.length === 0) {
    const info = await detectWorkspace(process.cwd());
    const entry = await registry.add(info.root);
    entries = await registry.list();
    printProjectDetection(info);
    console.log(`  ✓ Workspace registered: ${entry.name}`);
  }

  let previousConfig = await readDaemonConfig();
  if (!options.transport && options.tunnel !== false && !previousConfig?.transport && process.stdin.isTTY && process.stdout.isTTY) {
    await setupCommand();
    previousConfig = await readDaemonConfig();
  }

  const host = previousConfig?.host ?? "127.0.0.1";
  const preferredPort = options.port ?? previousConfig?.port ?? 7676;
  const port = await findAvailablePort(preferredPort, host);
  const configured = resolveTransportConfig(previousConfig);
  const preference: TransportPreference = options.transport === "cloudflare" ? "cloudflare-quick" : options.transport ?? configured.preferred;
  const fallbackPreference = configured.fallback;
  const useTunnel = options.tunnel !== false && preference !== "local";
  const openaiTunnelId = resolveOpenAiTunnelId(options.tunnelId, previousConfig);

  // CLI transport and tunnel-id flags intentionally affect only this run.
  await ensureDaemonIsStopped();
  await ensureDaemonStateDirectories();
  const token = randomToken();
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const serverLog = path.join(DAEMON_LOG_PATH, `server-${timestamp}.log`);
  const serverCommand = serverChildCommand([
    "serve",
    "--registry-home", CODERELAY_HOME,
    "--instance-name", DAEMON_NAME,
    "--host", host,
    "--port", String(port),
    "--token", token
  ]);
  const serverProcess = spawnDetachedProcess(serverCommand.command, serverCommand.args, serverLog, CODERELAY_HOME);
  const serverPid = serverProcess.pid;
  if (!serverPid) throw new Error("Could not start the local MCP daemon.");

  const localBase = localBaseUrl(host, port);
  const localEndpoint = endpointFor(localBase, token);
  const localOnly = !useTunnel;
  const state: RuntimeState = {
    instanceName: DAEMON_NAME,
    pid: serverPid,
    transportPid: 0,
    transportState: localOnly ? "disabled" : "starting",
    workspace: "<multiple registered workspaces>",
    host,
    port,
    token,
    transportProvider: localOnly ? (preference === "local" ? "local" : "disabled") : "disabled",
    transportPreference: preference,
    openaiTunnelId,
    publicBaseUrl: undefined,
    mcpEndpoint: localEndpoint,
    endpoint: localEndpoint,
    startedAt: new Date().toISOString(),
    serverLog,
    transportLog: ""
  };

  let localReady = false;
  let transportProcess: TunnelProcess | undefined;
  try {
    await waitForHttp(`${localBase}/health`);
    localReady = true;
    console.log("  ✓ MCP daemon started");
    await writeDaemonRuntimeState(state);

    if (useTunnel) {
      const context: TunnelStartContext = {
        localPort: port,
        localEndpoint,
        workspace: CODERELAY_HOME,
        instanceName: DAEMON_NAME,
        openaiTunnelId,
        cloudflareManagement: previousConfig?.cloudflare?.management,
        cloudflareTunnelToken: readCloudflareTunnelTokenSync().value,
        cloudflareTunnel: previousConfig?.cloudflare?.tunnel,
        cloudflareHostname: previousConfig?.cloudflare?.hostname,
        cloudflareConfigPath: previousConfig?.cloudflare?.configPath,
        cloudflareCredentialsFile: previousConfig?.cloudflare?.credentialsFile
      };
      const candidatePreferences: TransportPreference[] = [preference];
      if (fallbackPreference && fallbackPreference !== preference && fallbackPreference !== "local") candidatePreferences.push(fallbackPreference);
      let fallbackReason: string | undefined;

      for (const [candidateIndex, candidatePreference] of candidatePreferences.entries()) {
        let provider: TunnelProvider;
        try {
          provider = providerFor((await selectTransport(candidatePreference, context)).name);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          fallbackReason = reason;
          state.transportProvider = providerNameForPreference(candidatePreference);
          console.log(`  ! ${candidatePreference} transport unavailable: ${reason}`);
          if (candidateIndex < candidatePreferences.length - 1) {
            console.log(`  ! Falling back to ${candidatePreferences[candidateIndex + 1]}.`);
            continue;
          }
          state.transportState = "degraded";
          state.transportFallbackReason = reason;
          await writeDaemonRuntimeState(state);
          continue;
        }

        state.transportProvider = provider.name;
        state.transportState = "starting";
        state.transportFallbackReason = fallbackReason;
        await writeDaemonRuntimeState(state);
        const maxRetries = provider.name === "cloudflare-quick" ? 1 : 0;
        let ready = false;

        for (let retryNumber = 0; retryNumber <= maxRetries; retryNumber += 1) {
          try {
            transportProcess = await provider.start(context);
            state.transportPid = transportProcess.pid;
            state.transportExecutable = transportProcess.executablePath;
            state.transportBaseUrl = transportProcess.baseUrl;
            state.transportHealthUrl = transportProcess.healthUrl;
            state.openaiTunnelId = transportProcess.tunnelId ?? state.openaiTunnelId;
            state.publicBaseUrl = transportProcess.baseUrl;
            state.mcpEndpoint = transportProcess.baseUrl ? endpointFor(transportProcess.baseUrl, token) : `openai://tunnel/${state.openaiTunnelId ?? "unknown"}`;
            state.endpoint = state.mcpEndpoint;
            state.transportLog = transportProcess.logPath;
            await writeDaemonRuntimeState(state);

            ready = await waitForTransport(provider, transportProcess, retryNumber);
            if (ready) {
              state.transportState = "ready";
              await writeDaemonRuntimeState(state);
              console.log("  ✓ Secure connection ready");
              break;
            }

            if (retryNumber < maxRetries) {
              await logTransportEvent(transportProcess.logPath, "stopping transport after readiness timeout; retrying once");
              await provider.stop(transportProcess);
              transportProcess = undefined;
              state.transportPid = 0;
              state.transportState = "degraded";
              await writeDaemonRuntimeState(state);
              console.log("  ! Secure endpoint is still warming up; retrying the Cloudflare Quick Tunnel once.");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await logTransportEvent(state.transportLog, `transport startup failed provider=${provider.name}: ${message}`);
            if (transportProcess) await provider.stop(transportProcess).catch(() => undefined);
            transportProcess = undefined;
            state.transportPid = 0;
            state.transportState = "degraded";
            state.transportFallbackReason = message;
            await writeDaemonRuntimeState(state);
            console.log(`  ! ${provider.name} transport did not start: ${message}`);
            fallbackReason = message;
            break;
          }
        }

        if (ready) break;
        if (candidateIndex < candidatePreferences.length - 1) {
          if (transportProcess) {
            await logTransportEvent(transportProcess.logPath, `stopping unavailable ${provider.name} transport before fallback`);
            await provider.stop(transportProcess).catch(() => undefined);
            transportProcess = undefined;
          }
          console.log(`  ! ${provider.name} is unavailable; falling back to ${candidatePreferences[candidateIndex + 1]}.`);
          state.transportPid = 0;
          state.transportState = "starting";
          state.transportFallbackReason = fallbackReason;
          await writeDaemonRuntimeState(state);
          continue;
        }
        state.transportState = "degraded";
        await writeDaemonRuntimeState(state);
      }
    } else {
      console.log("  ! Tunnel disabled; endpoint is local-only");
    }

    state.transportPid = transportProcess?.pid ?? state.transportPid;
    state.transportLog = transportProcess?.logPath ?? state.transportLog;
    if (!useTunnel && preference !== "local") state.transportProvider = "disabled";
    await writeDaemonRuntimeState(state);
    printReadyMessage(state, entries.length);
  } catch (error) {
    if (transportProcess) await providerFor(transportProcess.provider).stop(transportProcess).catch(() => undefined);
    if (localReady) await terminateProcess(serverPid);
    await removeDaemonRuntimeState();
    throw error;
  }
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  await runMcpServer({
    registryHome: options.registryHome ?? CODERELAY_HOME,
    instanceName: options.instanceName,
    host: options.host,
    port: options.port,
    token: options.token
  });
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function transportProcessLabel(provider: RuntimeState["transportProvider"]): string {
  if (provider === "openai") return "tunnel-client";
  if (provider === "local" || provider === "disabled") return "transport";
  return "cloudflared";
}

export async function stopCommand(): Promise<void> {
  const state = await readDaemonRuntimeState();
  if (!state) {
    console.log("CodeRelay daemon is not running.");
    return;
  }
  if (state.transportPid && state.transportProvider !== "disabled" && state.transportProvider !== "local") await providerFor(state.transportProvider).stop(processFromState(state));
  await terminateProcess(state.pid);
  await removeDaemonRuntimeState();
  console.log("Stopped CodeRelay daemon.");
}

export async function statusCommand(): Promise<void> {
  const state = await readDaemonRuntimeState();
  const registry = new WorkspaceRegistry(CODERELAY_HOME);
  const workspaces = await registry.list();
  const config = await readDaemonConfig();
  const transportConfig = resolveTransportConfig(config);
  const apiKey = readOpenAiApiKeySync();
  if (!state) {
    console.log(`CodeRelay daemon is not running. Registered workspaces: ${workspaces.length}.`);
    console.log(`Transport preference: ${transportConfig.preferred}`);
    if (transportConfig.preferred === "openai") {
      console.log(`OpenAI API key: ${apiKey.source === "missing" ? "missing" : "configured"} (${apiKey.source})`);
      console.log(`OpenAI tunnel ID: ${resolveOpenAiTunnelId(undefined, config) ?? "not configured"}`);
      console.log(`tunnel-client process: ${resolveTunnelClient() ? "available; daemon stopped" : "unavailable"}`);
    } else if (transportConfig.preferred === "cloudflare-named" || transportConfig.preferred === "cloudflare-quick") {
      const cloudflared = await new CloudflaredTunnelProvider(() => DAEMON_LOG_PATH).runtime();
      console.log(`cloudflared process: ${cloudflared ? "available; daemon stopped" : "unavailable"}`);
    }
    return;
  }
  const serverAlive = isProcessAlive(state.pid);
  const localReachable = await health(`${localBaseUrl(state.host, state.port)}/health`);
  let transportAlive = false;
  let transportReachable = false;
  if (state.transportPid && state.transportProvider !== "disabled" && state.transportProvider !== "local") {
    transportAlive = isProcessAlive(state.transportPid);
    transportReachable = await providerFor(state.transportProvider).healthCheck(processFromState(state));
  }
  const stateLabel = await refreshTransportState(state, transportAlive, transportReachable);
  console.log(`CodeRelay daemon ${serverAlive && localReachable ? "running" : "not healthy"}`);
  console.log(`Registered workspaces: ${workspaces.length}`);
  console.log(`Transport preference: ${state.transportPreference ?? transportConfig.preferred}`);
  console.log(`Transport active: ${state.transportProvider}`);
  console.log(`Transport state: ${stateLabel}`);
  console.log(`Local MCP process: ${serverAlive ? "healthy" : "unavailable"}`);
  console.log(`Local MCP /health: ${localReachable ? "healthy" : "unavailable"}`);
  console.log(`${transportProcessLabel(state.transportProvider)} process: ${state.transportProvider === "disabled" || state.transportProvider === "local" ? "disabled" : transportAlive ? "healthy" : "unavailable"}`);
  console.log(`${state.transportProvider === "openai" ? "OpenAI tunnel /readyz" : "Public tunnel /health"}: ${state.transportProvider === "disabled" || state.transportProvider === "local" ? "disabled" : transportReachable ? "healthy" : "unavailable"}`);
  if (state.transportProvider === "openai") {
    console.log(`OpenAI tunnel ID: ${state.openaiTunnelId ?? resolveOpenAiTunnelId(undefined, config) ?? "not configured"}`);
    console.log(`OpenAI API key: ${apiKey.source === "missing" ? "missing" : "configured"} (${apiKey.source})`);
    console.log("ChatGPT app: CodeRelay");
  } else if (state.transportProvider === "cloudflare-named") {
    const hostname = state.publicBaseUrl ? new URL(state.publicBaseUrl).hostname : config?.cloudflare?.hostname ?? "not configured";
    console.log(`Public hostname: ${hostname}`);
    console.log(`Public MCP endpoint: ${state.mcpEndpoint ?? state.endpoint}`);
  } else if (state.transportProvider === "cloudflare-quick") {
    console.log(`Public MCP endpoint: ${state.mcpEndpoint ?? state.endpoint}`);
  } else {
    console.log(`Local MCP endpoint: ${state.mcpEndpoint ?? state.endpoint}`);
  }
  if (state.transportFallbackReason) console.log(`Fallback reason: ${state.transportFallbackReason}`);
  if (state.transportExecutable) console.log(`Transport runtime: ${state.transportExecutable}`);
  console.log(`Started: ${state.startedAt}`);
}

function displayPath(workspace: string): string {
  const home = process.env.HOME;
  return home && workspace.startsWith(`${home}/`) ? `~/${workspace.slice(home.length + 1)}` : workspace;
}

export async function workspacesCommand(): Promise<void> {
  const registry = new WorkspaceRegistry(CODERELAY_HOME);
  const entries = await registry.describeAll();
  console.log("NAME\tWORKSPACE\tSTATUS\tAGENTS");
  for (const entry of entries) {
    const agents = [entry.agents.md ? "AGENTS.md" : "", entry.agents.overrideMd ? "AGENTS.override.md" : ""].filter(Boolean).join(",") || "-";
    console.log(`${entry.name}\t${displayPath(entry.root)}\t${entry.exists ? "ready" : "unavailable"}\t${agents}`);
  }
  if (entries.length === 0) console.log("(none)");
}

export async function listCommand(): Promise<void> {
  await workspacesCommand();
}

export async function addWorkspaceCommand(workspace: string, name?: string): Promise<void> {
  const registry = new WorkspaceRegistry(CODERELAY_HOME);
  const info = await detectWorkspace(workspace);
  const entry = await registry.add(info.root, name);
  console.log(`Registered workspace ${entry.name}: ${entry.root}`);
  console.log(`Registry: ${registry.filePath}`);
}

export async function removeWorkspaceCommand(name: string): Promise<void> {
  const registry = new WorkspaceRegistry(CODERELAY_HOME);
  const entry = await registry.remove(name);
  console.log(`Removed workspace ${entry.name}.`);
}

export async function doctorCommand(): Promise<void> {
  const registry = new WorkspaceRegistry(CODERELAY_HOME);
  const state = await readDaemonRuntimeState();
  const config = await readDaemonConfig();
  const transportConfig = resolveTransportConfig(config);
  const entries = await registry.describeAll();
  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
  let diagnosis: string | undefined;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push({ label: `Node.js ${process.versions.node}`, ok: nodeMajor >= 20, detail: "Node.js 20 or newer is required." });
  checks.push({ label: "Git available", ok: commandExists("git"), detail: "Install Git and retry." });
  checks.push({ label: `Workspace registry (${entries.length} registered)`, ok: entries.every((entry) => entry.exists), detail: "Run coderelay workspaces to inspect unavailable roots." });

  const configuredOpenAi = transportConfig.preferred === "openai" || state?.transportProvider === "openai";
  const configuredNamed = transportConfig.preferred === "cloudflare-named" || state?.transportProvider === "cloudflare-named";
  if (configuredOpenAi) {
    const apiKey = readOpenAiApiKeySync();
    checks.push({ label: `OpenAI API key (${apiKey.source})`, ok: apiKey.source !== "missing", detail: "Set CONTROL_PLANE_API_KEY or run coderelay auth openai." });
    checks.push({ label: "OpenAI tunnel ID", ok: Boolean(resolveOpenAiTunnelId(undefined, config)), detail: `Configure it with coderelay setup or ${OPENAI_TUNNEL_SETTINGS}` });
    checks.push({ label: "tunnel-client runtime", ok: resolveTunnelClient() !== null, detail: `Install tunnel-client or set CODERELAY_TUNNEL_CLIENT. See ${OPENAI_TUNNEL_DOCS}` });
  }
  if (configuredNamed) {
    const cloudflareToken = readCloudflareTunnelTokenSync();
    const cloudflareManagement = config?.cloudflare?.management ?? (cloudflareToken.value ? "remote" : "local");
    const namedContext: TunnelStartContext = {
      localPort: 0,
      localEndpoint: "",
      workspace: CODERELAY_HOME,
      instanceName: DAEMON_NAME,
      cloudflareManagement,
      cloudflareTunnelToken: cloudflareToken.value,
      cloudflareTunnel: config?.cloudflare?.tunnel,
      cloudflareHostname: config?.cloudflare?.hostname,
      cloudflareConfigPath: config?.cloudflare?.configPath,
      cloudflareCredentialsFile: config?.cloudflare?.credentialsFile
    };
    const named = new CloudflareNamedTunnelProvider(() => DAEMON_LOG_PATH);
    if (cloudflareManagement === "remote") {
      checks.push({ label: `Cloudflare tunnel token (${cloudflareToken.source})`, ok: cloudflareToken.source !== "missing", detail: `Run coderelay setup or set CLOUDFLARE_TUNNEL_TOKEN. See ${CLOUDFLARE_REMOTE_TUNNEL_DOCS}` });
      checks.push({ label: "Cloudflare public hostname", ok: Boolean(config?.cloudflare?.hostname && /^[a-zA-Z0-9.-]+$/u.test(config.cloudflare.hostname)), detail: "Run coderelay setup and enter the hostname configured as the Published Application." });
      checks.push({ label: "cloudflared runtime", ok: (await named.runtime()) !== null, detail: `Install cloudflared and run the connector. See ${CLOUDFLARE_REMOTE_TUNNEL_DOCS}` });
    } else {
      checks.push({ label: "Cloudflare locally-managed tunnel config", ok: await named.isAvailable(namedContext), detail: `Authenticate a locally-managed tunnel and configure it with coderelay setup. See ${CLOUDFLARE_TUNNEL_DOCS}` });
    }
  }

  if (state) {
    const localProcessOk = isProcessAlive(state.pid);
    const localHealthOk = await health(`${localBaseUrl(state.host, state.port)}/health`);
    checks.push({ label: "Local MCP process", ok: localProcessOk, detail: `Check ${state.serverLog}` });
    checks.push({ label: "Local MCP /health", ok: localHealthOk, detail: `Check ${state.serverLog}` });
    if (state.transportProvider === "disabled" || state.transportProvider === "local") {
      checks.push({ label: "Transport process (disabled)", ok: true });
      checks.push({ label: "Public endpoint (disabled)", ok: true });
    } else {
      const runtimeOk = state.transportProvider === "openai"
        ? resolveTunnelClient() !== null
        : (state.transportProvider === "cloudflare-named"
          ? (await new CloudflareNamedTunnelProvider(() => DAEMON_LOG_PATH).runtime()) !== null
          : (await new CloudflaredTunnelProvider(() => DAEMON_LOG_PATH).runtime()) !== null);
      const provider = providerFor(state.transportProvider);
      const transportProcessOk = isProcessAlive(state.transportPid);
      const transportHealthy = state.transportPid > 0 && await provider.healthCheck(processFromState(state));
      const cloudflareDetail = state.transportProvider === "cloudflare-named" && config?.cloudflare?.management === "remote"
        ? `Install cloudflared and run the connector. See ${CLOUDFLARE_REMOTE_TUNNEL_DOCS}`
        : `Install cloudflared or use a Quick Tunnel. See ${CLOUDFLARE_TUNNEL_DOCS}`;
      checks.push({ label: state.transportProvider === "openai" ? "tunnel-client runtime" : "cloudflared runtime", ok: runtimeOk, detail: state.transportProvider === "openai" ? `Install tunnel-client or set CODERELAY_TUNNEL_CLIENT. See ${OPENAI_TUNNEL_DOCS}` : cloudflareDetail });
      checks.push({ label: `${transportProcessLabel(state.transportProvider)} process`, ok: transportProcessOk, detail: `Check ${state.transportLog || "transport status"}` });
      checks.push({ label: state.transportProvider === "openai" ? "OpenAI tunnel /readyz" : "Public tunnel /health", ok: transportHealthy, detail: `Check ${state.transportLog || "transport status"}` });
      await refreshTransportState(state, transportProcessOk, transportHealthy);
      if (localProcessOk && localHealthOk && !transportHealthy) {
        diagnosis = state.transportProvider === "openai"
          ? "Your local CodeRelay daemon is healthy.\nThe problem is between tunnel-client and the OpenAI control plane."
          : "Your local CodeRelay daemon is healthy.\nThe problem is between the Cloudflare edge and the local tunnel.";
      }
    }
  } else {
    checks.push({ label: "CodeRelay daemon", ok: false, detail: "Run coderelay to start the daemon." });
  }

  console.log("CodeRelay Doctor\n");
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label}`);
    if (!check.ok && check.detail) console.log(`  Suggested fix: ${check.detail}`);
  }
  if (diagnosis) console.log(`\nDiagnosis:\n${diagnosis}`);
  console.log(checks.every((check) => check.ok) ? "\nEverything looks good." : "\nSome checks need attention.");
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

export async function configShowCommand(): Promise<void> {
  const config = await readDaemonConfig();
  console.log(config ? JSON.stringify(config, null, 2) : "No CodeRelay daemon configuration found.");
}

export async function restartCommand(options: StartOptions = {}): Promise<void> {
  await stopCommand();
  await startCommand(options);
}
