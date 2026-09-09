import { appendFile } from "node:fs/promises";
import path from "node:path";
import { detectWorkspace } from "../workspace/detect.js";
import { runMcpServer } from "../mcp/server.js";
import { CloudflaredTunnelProvider } from "../tunnel/cloudflared.js";
import { OpenAiTunnelProvider, resolveTunnelClient } from "../tunnel/openai.js";
import { selectTransport, type TransportPreference } from "../tunnel/selection.js";
import { waitForHealth, type HealthProbe } from "../tunnel/readiness.js";
import type { TunnelProcess, TunnelProvider, TunnelStartContext } from "../tunnel/provider.js";
import {
  defaultInstanceName,
  ensureGlobalStateDirectories,
  findRuntimeStateForWorkspace,
  instanceLogPath,
  isProcessAlive,
  listInstanceRecords,
  listRuntimeStates,
  normalizeInstanceName,
  readRuntimeState,
  readWorkspaceConfig,
  removeInstanceRecord,
  removeRuntimeState,
  writeInstanceRecord,
  writeRuntimeState,
  writeWorkspaceConfig,
  type RuntimeState,
  type WorkspaceConfig,
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

export interface StartOptions {
  workspace?: string;
  name?: string;
  port?: number;
  transport?: TransportPreference;
  tunnel?: boolean;
}

interface ServeOptions {
  workspace: string;
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
  if (entryPoint.endsWith(".ts")) {
    return { command: process.execPath, args: ["--import", "tsx/esm", entryPoint, ...args] };
  }
  return { command: process.execPath, args: [entryPoint, ...args] };
}

function configuredTransport(config: WorkspaceConfig | null): TransportPreference {
  if (config?.transport) return config.transport;
  return "auto";
}

async function resolveInstanceName(workspace: string, requestedName: string | undefined, config: WorkspaceConfig | null): Promise<string> {
  const configuredName = !requestedName ? config?.instanceName : undefined;
  const baseName = normalizeInstanceName(requestedName ?? configuredName ?? defaultInstanceName(workspace));
  const records = await listInstanceRecords();
  const states = await listRuntimeStates();
  const occupied = new Set([
    ...records.filter((record) => path.resolve(record.workspace) !== path.resolve(workspace)).map((record) => record.instanceName),
    ...states.filter((state) => path.resolve(state.workspace) !== path.resolve(workspace)).map((state) => state.instanceName)
  ]);
  if (!occupied.has(baseName)) return baseName;

  let suffix = 2;
  while (occupied.has(`${baseName}-${suffix}`)) suffix += 1;
  return `${baseName}-${suffix}`;
}

async function ensureNoStaleRuntime(workspace: string, instanceName: string): Promise<void> {
  const state = (await readRuntimeState(instanceName)) ?? await findRuntimeStateForWorkspace(workspace);
  if (!state) return;
  if (isProcessAlive(state.pid)) {
    throw new Error(`CodeRelay instance ${state.instanceName} is already running for ${state.workspace}. Run coderelay status ${state.instanceName} or coderelay stop ${state.instanceName} first.`);
  }
  await removeRuntimeState(state.instanceName);
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
        await logTransportEvent(
          tunnel.logPath,
          `transport health-check provider=${provider.name} attempt=${probe.attempt} delay_ms=${probe.delayMs} healthy=${probe.healthy} elapsed_ms=${probe.elapsedMs} retry=${retryNumber}`
        );
      }
    }
  );
  await logTransportEvent(
    tunnel.logPath,
    `transport health-check finished provider=${provider.name} ready=${result.ready} attempts=${result.attempts} elapsed_ms=${result.elapsedMs} retry=${retryNumber}`
  );
  return result.ready;
}

function transportState(state: RuntimeState): NonNullable<RuntimeState["transportState"]> {
  if (state.transportState) return state.transportState;
  return state.transportPid ? "ready" : "disabled";
}

async function refreshTransportState(state: RuntimeState, processAlive: boolean, transportHealthy: boolean): Promise<NonNullable<RuntimeState["transportState"]>> {
  const nextState = state.transportProvider === "disabled"
    ? "disabled"
    : processAlive && transportHealthy
      ? "ready"
      : transportState(state) === "starting"
        ? "starting"
        : "degraded";
  if (state.transportState !== nextState) {
    state.transportState = nextState;
    await writeRuntimeState(state);
  }
  return nextState;
}

function processFromState(state: RuntimeState): TunnelProcess {
  return {
    provider: state.transportProvider === "openai" ? "openai" : "cloudflare",
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

function providerFor(name: TransportProviderName): TunnelProvider {
  return name === "openai" ? new OpenAiTunnelProvider() : new CloudflaredTunnelProvider();
}

function printProjectDetection(info: Awaited<ReturnType<typeof detectWorkspace>>): void {
  console.log("Detected project:");
  console.log(info.isGitRepository ? "  ✓ Git repository" : "  ! Git repository not detected");
  for (const technology of info.technologies) console.log(`  ✓ ${technology}`);
  if (info.technologies.length === 0 && info.markers.length > 0) console.log(`  ✓ ${info.markers.join(", ")}`);
}

function printReadyMessage(state: RuntimeState, configPath: string): void {
  console.log(`  ✓ Instance: ${state.instanceName}`);
  console.log(`  ✓ Workspace config: ${configPath}`);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (state.transportProvider === "openai") {
    console.log(state.transportState === "ready" ? "Your CodeRelay Secure MCP Tunnel is ready:" : "Your local CodeRelay server is ready; the Secure MCP Tunnel is still warming up:");
    console.log("Transport: OpenAI Secure MCP Tunnel");
    console.log(`Tunnel ID: ${state.openaiTunnelId ?? "not available"}`);
    console.log(`ChatGPT app: CodeRelay — ${state.instanceName}`);
    console.log("Keep this process running while using the ChatGPT app.");
  } else if (state.transportProvider === "cloudflare") {
    console.log(state.transportState === "degraded" ? "Your local CodeRelay server is ready; the public endpoint is still warming up:" : "Your CodeRelay endpoint is ready:");
    console.log(state.endpoint);
    console.log("\nChatGPT:");
    console.log("Settings → Plugins → + → Custom MCP");
    console.log("Paste the endpoint above.");
  } else {
    console.log("Your CodeRelay endpoint is ready:");
    console.log(state.endpoint);
    console.log("\nTunnel disabled; this endpoint is local-only.");
  }
  console.log('\nThen ask: "Inspect this repository and run its tests."');
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\nRun coderelay doctor ${state.instanceName} if anything looks wrong.`);
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  const workspaceInfo = await detectWorkspace(options.workspace ?? process.cwd());
  const previousConfig = await readWorkspaceConfig(workspaceInfo.root);
  const instanceName = await resolveInstanceName(workspaceInfo.root, options.name, previousConfig);
  await ensureNoStaleRuntime(workspaceInfo.root, instanceName);
  const previousRecord = (await listInstanceRecords()).find((record) => path.resolve(record.workspace) === path.resolve(workspaceInfo.root) && record.instanceName !== instanceName);
  if (previousRecord) await removeInstanceRecord(previousRecord.instanceName);

  const host = previousConfig?.host ?? "127.0.0.1";
  const preferredPort = options.port ?? previousConfig?.port ?? 7676;
  const port = await findAvailablePort(preferredPort, host);
  const useTunnel = options.tunnel !== false;
  const preference = options.transport ?? configuredTransport(previousConfig);
  const openaiTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID ?? previousConfig?.openaiTunnelId;
  const config: WorkspaceConfig = {
    workspace: workspaceInfo.root,
    host,
    port,
    safeMode: true,
    instanceName,
    transport: preference,
    openaiTunnelId
  };
  const configPath = await writeWorkspaceConfig(config);
  await ensureGlobalStateDirectories();
  await writeInstanceRecord({ instanceName, workspace: workspaceInfo.root, transport: preference, openaiTunnelId, updatedAt: new Date().toISOString() });

  printProjectDetection(workspaceInfo);
  console.log(`  ✓ Instance: ${instanceName}`);
  console.log(`  ✓ Workspace: ${workspaceInfo.root}`);
  console.log(`  ✓ Node.js ${process.versions.node}`);

  const token = randomToken();
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const logDirectory = instanceLogPath(instanceName);
  const serverLog = path.join(logDirectory, `server-${timestamp}.log`);
  const serverCommand = serverChildCommand([
    "serve",
    "--workspace", workspaceInfo.root,
    "--instance-name", instanceName,
    "--host", host,
    "--port", String(port),
    "--token", token
  ]);
  const serverProcess = spawnDetachedProcess(serverCommand.command, serverCommand.args, serverLog, workspaceInfo.root);
  const serverPid = serverProcess.pid;
  if (!serverPid) throw new Error("Could not start the local MCP server.");

  const localBase = localBaseUrl(host, port);
  const localEndpoint = endpointFor(localBase, token);
  const state: RuntimeState = {
    instanceName,
    pid: serverPid,
    transportPid: 0,
    transportState: useTunnel ? "starting" : "disabled",
    workspace: workspaceInfo.root,
    host,
    port,
    token,
    transportProvider: "disabled",
    openaiTunnelId,
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
    console.log("  ✓ MCP server started");
    await writeRuntimeState(state);

    if (useTunnel) {
      const context: TunnelStartContext = {
        localPort: port,
        localEndpoint,
        workspace: workspaceInfo.root,
        instanceName,
        openaiTunnelId
      };
      const selected = await selectTransport(preference, context);
      const candidates: TunnelProvider[] = [selected];
      if (preference === "auto" && selected.name === "openai") candidates.push(new CloudflaredTunnelProvider());

      for (const [candidateIndex, provider] of candidates.entries()) {
        state.transportProvider = provider.name;
        state.transportState = "starting";
        await writeRuntimeState(state);
        const maxRetries = provider.name === "cloudflare" ? 1 : 0;
        let ready = false;

        for (let retryNumber = 0; retryNumber <= maxRetries; retryNumber += 1) {
          try {
            transportProcess = await provider.start(context);
            state.transportPid = transportProcess.pid;
            state.transportExecutable = transportProcess.executablePath;
            state.transportBaseUrl = transportProcess.baseUrl;
            state.transportHealthUrl = transportProcess.healthUrl;
            state.openaiTunnelId = transportProcess.tunnelId ?? state.openaiTunnelId;
            state.endpoint = transportProcess.baseUrl ? endpointFor(transportProcess.baseUrl, token) : `openai://tunnel/${state.openaiTunnelId ?? "unknown"}`;
            state.transportLog = transportProcess.logPath;
            await writeRuntimeState(state);

            ready = await waitForTransport(provider, transportProcess, retryNumber);
            if (ready) {
              state.transportState = "ready";
              await writeRuntimeState(state);
              console.log("  ✓ Secure connection ready");
              break;
            }

            if (retryNumber < maxRetries) {
              await logTransportEvent(transportProcess.logPath, "stopping transport after readiness timeout; retrying once");
              await provider.stop(transportProcess);
              transportProcess = undefined;
              state.transportPid = 0;
              state.transportState = "degraded";
              await writeRuntimeState(state);
              console.log("  ! Secure endpoint is still warming up; retrying the Cloudflare tunnel once.");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await logTransportEvent(state.transportLog, `transport startup failed provider=${provider.name}: ${message}`);
            if (transportProcess) await provider.stop(transportProcess).catch(() => undefined);
            transportProcess = undefined;
            state.transportPid = 0;
            state.transportState = "degraded";
            await writeRuntimeState(state);
            console.log(`  ! ${provider.name} transport did not start: ${message}`);
            break;
          }
        }

        if (ready) break;
        if (candidateIndex < candidates.length - 1) {
          console.log("  ! OpenAI Secure MCP Tunnel is unavailable; falling back to Cloudflare Quick Tunnel.");
          state.transportPid = 0;
          state.transportState = "starting";
          await writeRuntimeState(state);
          continue;
        }
        state.transportState = "degraded";
        await writeRuntimeState(state);
      }
    } else {
      console.log("  ! Tunnel disabled; endpoint is local-only");
    }

    state.transportPid = transportProcess?.pid ?? state.transportPid;
    state.transportLog = transportProcess?.logPath ?? state.transportLog;
    if (!useTunnel) state.transportProvider = "disabled";
    await writeRuntimeState(state);
    printReadyMessage(state, configPath);
  } catch (error) {
    if (transportProcess) await providerFor(transportProcess.provider).stop(transportProcess).catch(() => undefined);
    if (localReady) await terminateProcess(serverPid);
    await removeRuntimeState(instanceName);
    throw error;
  }
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  await runMcpServer({
    workspaceRoot: path.resolve(options.workspace),
    instanceName: options.instanceName,
    host: options.host,
    port: options.port,
    token: options.token
  });
}

async function stateFor(instanceName: string | undefined, workspacePath = process.cwd()): Promise<RuntimeState | null> {
  if (instanceName) return (await readRuntimeState(instanceName)) ?? await findRuntimeStateForWorkspace(instanceName);
  return await findRuntimeStateForWorkspace(workspacePath) ?? await readRuntimeState();
}

export async function stopCommand(instanceName?: string, workspacePath = process.cwd()): Promise<void> {
  const state = await stateFor(instanceName, workspacePath);
  if (!state) {
    console.log("CodeRelay is not running.");
    return;
  }
  if (state.transportPid) await providerFor(state.transportProvider === "openai" ? "openai" : "cloudflare").stop(processFromState(state));
  await terminateProcess(state.pid);
  await removeRuntimeState(state.instanceName);
  console.log(`Stopped CodeRelay instance ${state.instanceName} for ${state.workspace}.`);
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
  return provider === "openai" ? "tunnel-client" : "cloudflared";
}

export async function statusCommand(instanceName?: string): Promise<void> {
  const state = await stateFor(instanceName);
  if (!state) {
    console.log("CodeRelay instance is not running.");
    return;
  }
  const serverAlive = isProcessAlive(state.pid);
  const localReachable = await health(`${localBaseUrl(state.host, state.port)}/health`);
  let transportAlive = false;
  let transportReachable = false;
  if (state.transportPid && state.transportProvider !== "disabled") {
    transportAlive = isProcessAlive(state.transportPid);
    transportReachable = await providerFor(state.transportProvider).healthCheck(processFromState(state));
  }
  const stateLabel = await refreshTransportState(state, transportAlive, transportReachable);
  console.log(`CodeRelay ${serverAlive && localReachable ? "running" : "not healthy"}`);
  console.log(`Instance: ${state.instanceName}`);
  console.log(`Workspace: ${state.workspace}`);
  console.log(`Transport: ${state.transportProvider}`);
  console.log(`Transport state: ${stateLabel}`);
  console.log(`Local MCP process: ${serverAlive ? "healthy" : "unavailable"}`);
  console.log(`Local MCP /health: ${localReachable ? "healthy" : "unavailable"}`);
  console.log(`${transportProcessLabel(state.transportProvider)} process: ${state.transportProvider === "disabled" ? "disabled" : transportAlive ? "healthy" : "unavailable"}`);
  console.log(`${state.transportProvider === "openai" ? "OpenAI tunnel /readyz" : "Public tunnel /health"}: ${state.transportProvider === "disabled" ? "disabled" : transportReachable ? "healthy" : "unavailable"}`);
  if (state.openaiTunnelId) console.log(`OpenAI tunnel ID: ${state.openaiTunnelId}`);
  if (state.transportExecutable) console.log(`Transport runtime: ${state.transportExecutable}`);
  console.log(`Started: ${state.startedAt}`);
}

function displayPath(workspace: string): string {
  const home = process.env.HOME;
  return home && workspace.startsWith(`${home}/`) ? `~/${workspace.slice(home.length + 1)}` : workspace;
}

export async function listCommand(): Promise<void> {
  const records = await listInstanceRecords();
  const states = await listRuntimeStates();
  const byName = new Map(states.map((state) => [state.instanceName, state]));
  const names = new Set([...records.map((record) => record.instanceName), ...states.map((state) => state.instanceName)]);
  console.log("NAME\tWORKSPACE\tTRANSPORT\tSTATUS");
  for (const name of [...names].sort()) {
    const state = byName.get(name);
    const record = records.find((item) => item.instanceName === name);
    const transport = state?.transportProvider ?? record?.transport ?? "auto";
    const status = state ? `${state.transportState ?? "starting"}` : "stopped";
    console.log(`${name}\t${displayPath(state?.workspace ?? record?.workspace ?? "")}\t${transport}\t${status}`);
  }
}

export async function doctorCommand(workspacePath = process.cwd(), instanceName?: string): Promise<void> {
  const state = await stateFor(instanceName, workspacePath);
  const workspace = state?.workspace ?? path.resolve(workspacePath);
  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
  let diagnosis: string | undefined;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push({ label: `Node.js ${process.versions.node}`, ok: nodeMajor >= 22, detail: "Node.js 22 or newer is required." });
  checks.push({ label: "Git available", ok: commandExists("git"), detail: "Install Git and retry." });
  try {
    const info = await detectWorkspace(workspace);
    checks.push({ label: `Workspace exists (${info.root})`, ok: true });
    checks.push({ label: "Git repository detected", ok: info.isGitRepository, detail: "Run doctor from a Git repository or pass --workspace." });
  } catch (error) {
    checks.push({ label: "Workspace exists", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  if (state) {
    const localProcessOk = isProcessAlive(state.pid);
    const localHealthOk = await health(`${localBaseUrl(state.host, state.port)}/health`);
    checks.push({ label: "Local MCP process", ok: localProcessOk, detail: `Check ${state.serverLog}` });
    checks.push({ label: "Local MCP /health", ok: localHealthOk, detail: `Check ${state.serverLog}` });
    if (state.transportProvider === "disabled") {
      checks.push({ label: "Transport process (disabled)", ok: true });
      checks.push({ label: "Transport readiness (disabled)", ok: true });
    } else {
      const runtimeOk = state.transportProvider === "openai"
        ? resolveTunnelClient() !== null
        : (await new CloudflaredTunnelProvider().runtime()) !== null;
      const provider = providerFor(state.transportProvider);
      const transportProcessOk = isProcessAlive(state.transportPid);
      const transportHealthy = state.transportPid > 0 && await provider.healthCheck(processFromState(state));
      checks.push({
        label: state.transportProvider === "openai" ? "tunnel-client runtime" : "cloudflared runtime",
        ok: runtimeOk,
        detail: state.transportProvider === "openai" ? "Install tunnel-client or set CODERELAY_TUNNEL_CLIENT." : "CodeRelay will download a verified runtime on the next start."
      });
      checks.push({ label: `${transportProcessLabel(state.transportProvider)} process`, ok: transportProcessOk, detail: `Check ${state.transportLog || "transport status"}` });
      checks.push({ label: state.transportProvider === "openai" ? "OpenAI tunnel /readyz" : "Public tunnel /health", ok: transportHealthy, detail: `Check ${state.transportLog || "transport status"}` });
      await refreshTransportState(state, transportProcessOk, transportHealthy);
      if (localProcessOk && localHealthOk && !transportHealthy) {
        diagnosis = state.transportProvider === "openai"
          ? "Your local CodeRelay server is healthy.\nThe problem is between tunnel-client and the OpenAI control plane."
          : "Your local CodeRelay server is healthy.\nThe problem is between the Cloudflare edge and the local tunnel.";
      }
    }
  } else {
    checks.push({ label: "CodeRelay instance", ok: false, detail: "Run coderelay first." });
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

export async function configShowCommand(workspacePath = process.cwd()): Promise<void> {
  const workspace = path.resolve(workspacePath);
  const config = await readWorkspaceConfig(workspace);
  if (!config) {
    console.log(`No CodeRelay config found in ${workspace}.`);
    return;
  }
  console.log(JSON.stringify(config, null, 2));
}

export async function restartCommand(instanceName?: string, options: StartOptions = {}): Promise<void> {
  const state = await stateFor(instanceName, options.workspace ?? process.cwd());
  const record = instanceName ? (await listInstanceRecords()).find((item) => item.instanceName === instanceName) : undefined;
  const workspace = options.workspace ?? state?.workspace ?? record?.workspace ?? process.cwd();
  await stopCommand(instanceName, workspace);
  await startCommand({ ...options, workspace, name: options.name ?? state?.instanceName ?? record?.instanceName ?? instanceName });
}
