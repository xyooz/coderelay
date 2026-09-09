import { appendFile } from "node:fs/promises";
import path from "node:path";
import { detectWorkspace } from "../workspace/detect.js";
import { runMcpServer } from "../mcp/server.js";
import { CloudflaredTunnelProvider } from "../tunnel/cloudflared.js";
import { waitForHealth, type HealthProbe } from "../tunnel/readiness.js";
import {
  ensureGlobalStateDirectories,
  isProcessAlive,
  readRuntimeState,
  readWorkspaceConfig,
  removeRuntimeState,
  writeRuntimeState,
  writeWorkspaceConfig,
  type RuntimeState,
  type WorkspaceConfig,
  LOG_PATH
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

interface StartOptions {
  workspace?: string;
  port?: number;
  tunnel?: boolean;
}

interface ServeOptions {
  workspace: string;
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

async function ensureNoStaleRuntime(): Promise<void> {
  const state = await readRuntimeState();
  if (!state) return;
  if (isProcessAlive(state.pid)) {
    throw new Error(`CodeRelay is already running for ${state.workspace}. Run coderelay status or coderelay stop first.`);
  }
  await removeRuntimeState();
}

async function logTunnelEvent(logPath: string, message: string): Promise<void> {
  await appendFile(logPath, `[CodeRelay ${new Date().toISOString()}] ${message}\n`).catch(() => undefined);
}

async function waitForTunnel(
  provider: CloudflaredTunnelProvider,
  baseUrl: string,
  logPath: string,
  retryNumber: number
): Promise<boolean> {
  await logTunnelEvent(logPath, `tunnel URL created: ${baseUrl} (retry=${retryNumber})`);
  const result = await waitForHealth(
    () => provider.healthCheck(baseUrl),
    {
      onProbe: async (probe: HealthProbe) => {
        await logTunnelEvent(
          logPath,
          `public health-check attempt=${probe.attempt} delay_ms=${probe.delayMs} healthy=${probe.healthy} elapsed_ms=${probe.elapsedMs} retry=${retryNumber}`
        );
      }
    }
  );
  await logTunnelEvent(
    logPath,
    `public health-check finished ready=${result.ready} attempts=${result.attempts} elapsed_ms=${result.elapsedMs} retry=${retryNumber}`
  );
  return result.ready;
}

function transportState(state: RuntimeState): NonNullable<RuntimeState["transportState"]> {
  if (state.transportState) return state.transportState;
  return state.tunnelPid ? "ready" : "disabled";
}

async function refreshTransportState(state: RuntimeState, processAlive: boolean, publicHealthy: boolean): Promise<NonNullable<RuntimeState["transportState"]>> {
  const nextState = !state.tunnelPid
    ? "disabled"
    : processAlive && publicHealthy
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

function printProjectDetection(info: Awaited<ReturnType<typeof detectWorkspace>>): void {
  console.log("Detected project:");
  console.log(info.isGitRepository ? "  ✓ Git repository" : "  ! Git repository not detected");
  for (const technology of info.technologies) console.log(`  ✓ ${technology}`);
  if (info.technologies.length === 0 && info.markers.length > 0) {
    console.log(`  ✓ ${info.markers.join(", ")}`);
  }
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  await ensureNoStaleRuntime();
  const workspaceInfo = await detectWorkspace(options.workspace ?? process.cwd());
  const previousConfig = await readWorkspaceConfig(workspaceInfo.root);
  const host = previousConfig?.host ?? "127.0.0.1";
  const preferredPort = options.port ?? previousConfig?.port ?? 7676;
  const port = await findAvailablePort(preferredPort, host);
  const useTunnel = options.tunnel !== false;
  const config: WorkspaceConfig = {
    workspace: workspaceInfo.root,
    host,
    port,
    safeMode: true,
    tunnelProvider: "cloudflared"
  };
  const configPath = await writeWorkspaceConfig(config);
  await ensureGlobalStateDirectories();

  printProjectDetection(workspaceInfo);
  console.log(`  ✓ Workspace: ${workspaceInfo.root}`);
  console.log(`  ✓ Node.js ${process.versions.node}`);

  const token = randomToken();
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const serverLog = path.join(LOG_PATH, `server-${timestamp}.log`);
  const serverCommand = serverChildCommand([
    "serve",
    "--workspace",
    workspaceInfo.root,
    "--host",
    host,
    "--port",
    String(port),
    "--token",
    token
  ]);
  const serverProcess = spawnDetachedProcess(serverCommand.command, serverCommand.args, serverLog, workspaceInfo.root);
  const serverPid = serverProcess.pid;
  if (!serverPid) throw new Error("Could not start the local MCP server.");
  let tunnelPid = 0;
  let tunnelExecutable = "";
  let tunnelProvider: CloudflaredTunnelProvider | undefined;
  const state: RuntimeState = {
    pid: serverPid,
    tunnelPid,
    transportState: useTunnel ? "starting" : "disabled",
    workspace: workspaceInfo.root,
    host,
    port,
    token,
    tunnelProvider: "cloudflared",
    tunnelExecutable: undefined,
    tunnelBaseUrl: localBaseUrl(host, port),
    endpoint: endpointFor(localBaseUrl(host, port), token),
    startedAt: new Date().toISOString(),
    serverLog,
    tunnelLog: ""
  };

  try {
    const localHealthUrl = `${localBaseUrl(host, port)}/health`;
    await waitForHttp(localHealthUrl);
    console.log("  ✓ MCP server started");

    let tunnelBaseUrl = localBaseUrl(host, port);
    let endpoint = endpointFor(tunnelBaseUrl, token);
    let tunnelLog = "";

    if (useTunnel) {
      tunnelProvider = new CloudflaredTunnelProvider();
      for (let retryNumber = 0; retryNumber <= 1; retryNumber += 1) {
        const tunnel = await tunnelProvider.start(port);
        tunnelPid = tunnel.pid;
        tunnelExecutable = tunnel.executablePath;
        tunnelBaseUrl = tunnel.baseUrl;
        tunnelLog = tunnel.logPath;
        endpoint = endpointFor(tunnelBaseUrl, token);
        state.tunnelPid = tunnelPid;
        state.tunnelExecutable = tunnelExecutable;
        state.tunnelBaseUrl = tunnelBaseUrl;
        state.endpoint = endpoint;
        state.tunnelLog = tunnelLog;
        state.transportState = "starting";
        await writeRuntimeState(state);

        const ready = await waitForTunnel(tunnelProvider, tunnelBaseUrl, tunnelLog, retryNumber);
        if (ready) {
          state.transportState = "ready";
          await writeRuntimeState(state);
          console.log("  ✓ Secure connection ready");
          break;
        }

        if (retryNumber === 0) {
          await logTunnelEvent(tunnelLog, "stopping first tunnel after readiness timeout; retrying once");
          await tunnelProvider.stop(tunnelPid);
          tunnelPid = 0;
          state.tunnelPid = 0;
          state.transportState = "degraded";
          await writeRuntimeState(state);
          console.log("  ! Secure endpoint is still warming up; retrying the tunnel once.");
          continue;
        }

        state.transportState = "degraded";
        await writeRuntimeState(state);
        console.log("  ! Secure endpoint is still warming up.");
        console.log("    Local MCP is healthy.");
        console.log("    Run coderelay doctor while the tunnel continues to connect.");
      }
    } else {
      console.log("  ! Tunnel disabled; endpoint is local-only");
    }

    state.tunnelPid = tunnelPid;
    state.tunnelExecutable = tunnelExecutable || undefined;
    state.tunnelBaseUrl = tunnelBaseUrl;
    state.endpoint = endpoint;
    state.tunnelLog = tunnelLog;
    if (!useTunnel) state.transportState = "disabled";
    await writeRuntimeState(state);

    console.log(`  ✓ Workspace config: ${configPath}`);
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(
      transportState(state) === "degraded"
        ? "Your local CodeRelay server is ready; the public endpoint is still warming up:"
        : "Your CodeRelay endpoint is ready:"
    );
    console.log(endpoint);
    console.log("\nChatGPT:");
    console.log("Settings → Plugins → + → Custom MCP");
    console.log("Paste the endpoint above.");
    console.log('\nThen ask: "Inspect this repository and run its tests."');
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("\nRun coderelay doctor if anything looks wrong.");
  } catch (error) {
    await terminateProcess(tunnelPid);
    await terminateProcess(serverPid);
    await removeRuntimeState();
    throw error;
  }
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  await runMcpServer({
    workspaceRoot: path.resolve(options.workspace),
    host: options.host,
    port: options.port,
    token: options.token
  });
}

export async function stopCommand(): Promise<void> {
  const state = await readRuntimeState();
  if (!state) {
    console.log("CodeRelay is not running.");
    return;
  }
  await terminateProcess(state.tunnelPid);
  await terminateProcess(state.pid);
  await removeRuntimeState();
  console.log(`Stopped CodeRelay for ${state.workspace}.`);
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

export async function statusCommand(): Promise<void> {
  const state = await readRuntimeState();
  if (!state) {
    console.log("CodeRelay is not running.");
    return;
  }
  const serverAlive = isProcessAlive(state.pid);
  const tunnelAlive = !state.tunnelPid || isProcessAlive(state.tunnelPid);
  const serverReachable = await health(`${localBaseUrl(state.host, state.port)}/health`);
  const tunnelReachable = state.tunnelBaseUrl.startsWith("https://") ? await health(`${state.tunnelBaseUrl}/health`) : true;
  const stateLabel = await refreshTransportState(state, tunnelAlive, tunnelReachable);
  console.log(`CodeRelay ${serverAlive && serverReachable ? "running" : "not healthy"}`);
  console.log(`Workspace: ${state.workspace}`);
  console.log(`MCP endpoint: ${state.endpoint}`);
  console.log(`Transport: ${state.tunnelPid ? "cloudflared" : "disabled"}`);
  console.log(`Transport state: ${stateLabel}`);
  console.log(`Local MCP process: ${serverAlive ? "healthy" : "unavailable"}`);
  console.log(`Local MCP /health: ${serverReachable ? "healthy" : "unavailable"}`);
  console.log(`cloudflared process: ${state.tunnelPid ? (tunnelAlive ? "healthy" : "unavailable") : "disabled"}`);
  console.log(`Public tunnel /health: ${state.tunnelPid ? (tunnelReachable ? "healthy" : "unavailable") : "disabled"}`);
  if (state.tunnelExecutable) console.log(`Transport runtime: ${state.tunnelExecutable}`);
  console.log(`Started: ${state.startedAt}`);
}

export async function doctorCommand(workspacePath = process.cwd()): Promise<void> {
  const state = await readRuntimeState();
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
    const provider = new CloudflaredTunnelProvider();
    let publicHealthOk = false;
    const runtime = state.tunnelExecutable ? { path: state.tunnelExecutable } : await provider.runtime();
    if (state.tunnelPid) {
      const tunnelProcessOk = isProcessAlive(state.tunnelPid);
      publicHealthOk = state.tunnelBaseUrl.startsWith("https://") && await provider.healthCheck(state.tunnelBaseUrl);
      await refreshTransportState(state, tunnelProcessOk, publicHealthOk);
      checks.push({ label: runtime ? `cloudflared runtime: ${runtime.path}` : "cloudflared runtime", ok: runtime !== null, detail: "CodeRelay will download a verified runtime on the next start." });
      checks.push({ label: "cloudflared process", ok: tunnelProcessOk, detail: `Check ${state.tunnelLog || "tunnel status"}` });
      checks.push({ label: "Public tunnel /health", ok: publicHealthOk, detail: `Check ${state.tunnelLog || "tunnel status"}` });
    } else {
      checks.push({ label: "cloudflared process (disabled)", ok: true });
      checks.push({ label: "Public tunnel /health (disabled)", ok: true });
    }

    if (state.tunnelPid && localProcessOk && localHealthOk && !publicHealthOk) {
      diagnosis = "Your local CodeRelay server is healthy.\nThe problem is between the Cloudflare edge and the local tunnel.";
    }
  } else {
    checks.push({ label: "CodeRelay runtime", ok: false, detail: "Run coderelay start first." });
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

export async function restartCommand(options: StartOptions = {}): Promise<void> {
  await stopCommand();
  await startCommand(options);
}
