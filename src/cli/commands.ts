import path from "node:path";
import { detectWorkspace } from "../workspace/detect.js";
import { runMcpServer } from "../mcp/server.js";
import { CloudflaredTunnelProvider } from "../tunnel/cloudflared.js";
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

async function waitForTunnel(provider: CloudflaredTunnelProvider, baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await provider.healthCheck(baseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Tunnel was created but its health endpoint is not reachable: ${baseUrl}/health`);
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

  try {
    const localHealthUrl = `${localBaseUrl(host, port)}/health`;
    await waitForHttp(localHealthUrl);
    console.log("  ✓ MCP server started");

    let tunnelBaseUrl = localBaseUrl(host, port);
    let endpoint = endpointFor(tunnelBaseUrl, token);
    let tunnelLog = "";

    if (useTunnel) {
      const provider = new CloudflaredTunnelProvider();
      const tunnel = await provider.start(port);
      tunnelPid = tunnel.pid;
      tunnelExecutable = tunnel.executablePath;
      tunnelBaseUrl = tunnel.baseUrl;
      tunnelLog = tunnel.logPath;
      await waitForTunnel(provider, tunnelBaseUrl);
      endpoint = endpointFor(tunnelBaseUrl, token);
      console.log(`  ✓ Tunnel runtime: ${tunnelExecutable} (${tunnel.executableSource})`);
      console.log("  ✓ Secure connection established");
    } else {
      console.log("  ! Tunnel disabled; endpoint is local-only");
    }

    const state: RuntimeState = {
      pid: serverPid,
      tunnelPid,
      workspace: workspaceInfo.root,
      host,
      port,
      token,
      tunnelProvider: "cloudflared",
      tunnelExecutable: tunnelExecutable || undefined,
      tunnelBaseUrl,
      endpoint,
      startedAt: new Date().toISOString(),
      serverLog,
      tunnelLog
    };
    await writeRuntimeState(state);

    console.log(`  ✓ Workspace config: ${configPath}`);
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Your CodeRelay endpoint is ready:");
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
  console.log(`CodeRelay ${serverAlive && serverReachable ? "running" : "not healthy"}`);
  console.log(`Workspace: ${state.workspace}`);
  console.log(`MCP endpoint: ${state.endpoint}`);
  if (state.tunnelExecutable) console.log(`Tunnel runtime: ${state.tunnelExecutable}`);
  console.log(`Server: ${serverAlive && serverReachable ? "healthy" : "unavailable"}`);
  console.log(`Tunnel: ${tunnelAlive && tunnelReachable ? "healthy" : "unavailable"}`);
  console.log(`Started: ${state.startedAt}`);
}

export async function doctorCommand(workspacePath = process.cwd()): Promise<void> {
  const state = await readRuntimeState();
  const workspace = state?.workspace ?? path.resolve(workspacePath);
  const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
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
    checks.push({ label: "MCP server reachable", ok: await health(`${localBaseUrl(state.host, state.port)}/health`), detail: `Check ${state.serverLog}` });
    const provider = new CloudflaredTunnelProvider();
    const runtime = state.tunnelExecutable ? { path: state.tunnelExecutable } : await provider.runtime();
    if (state.tunnelPid) {
      checks.push({ label: runtime ? `Tunnel runtime: ${runtime.path}` : "Tunnel runtime", ok: runtime !== null, detail: "CodeRelay will download a verified runtime on the next start." });
      checks.push({ label: "HTTPS endpoint reachable", ok: state.tunnelBaseUrl.startsWith("https://") && await provider.healthCheck(state.tunnelBaseUrl), detail: `Check ${state.tunnelLog || "tunnel status"}` });
    } else {
      checks.push({ label: "Tunnel runtime (disabled)", ok: true });
      checks.push({ label: "Public tunnel (disabled)", ok: true });
    }
  } else {
    checks.push({ label: "CodeRelay runtime", ok: false, detail: "Run coderelay start first." });
  }

  console.log("CodeRelay Doctor\n");
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.label}`);
    if (!check.ok && check.detail) console.log(`  Suggested fix: ${check.detail}`);
  }
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
