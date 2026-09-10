import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entryPoint = path.join(projectRoot, "dist", "index.js");

interface LaunchedProcess {
  child: ChildProcess;
  waitForOutput(text: string, timeoutMs?: number): Promise<string>;
  exit: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

interface TraceEvent {
  rpcMethod: string | null;
  toolName: string | null;
  explicitWorkspace: string | null;
  incomingSessionId: string | null;
  outgoingSessionId: string | null;
  transportSessionId: string | null;
  internalSessionId: string | null;
  route: string;
  workspaceBindingBefore: string | null;
  workspaceBindingAfter: string | null;
  sessionWorkspace: string | null;
  resolvedWorkspace: string | null;
  resolutionSource: string;
}

function launchCli(args: string[], coderelayHome: string, extraEnv: Record<string, string> = {}): LaunchedProcess {
  const child = spawn(process.execPath, [entryPoint, ...args], {
    cwd: projectRoot,
    env: { ...process.env, CODERELAY_HOME: coderelayHome, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

  return {
    child,
    waitForOutput: async (text, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stdout.includes(text)) return stdout;
        if (child.exitCode !== null) throw new Error(`CLI exited before output ${text}:\n${stdout}\n${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${text}:\n${stdout}\n${stderr}`);
    },
    exit
  };
}

async function waitForTraceEvent(
  logPath: string,
  predicate: (event: TraceEvent) => boolean,
  timeoutMs = 5_000
): Promise<TraceEvent> {
  const prefix = "[CodeRelay MCP trace] ";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = (await readFile(logPath, "utf8"))
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(prefix))
        .map((line) => JSON.parse(line.slice(prefix.length)) as TraceEvent);
      const match = events.find(predicate);
      if (match) return match;
    } catch {
      // The detached server may not have created or flushed its log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for an MCP trace event in ${logPath}`);
}

async function waitForPath(filePath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function parseSse(body: string): Record<string, any> {
  const dataLine = body.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`MCP response did not contain an SSE data line: ${body}`);
  return JSON.parse(dataLine.slice("data: ".length)) as Record<string, any>;
}

interface McpSession {
  endpoint: string;
  sessionId: string;
  nextId: number;
}

async function initializeSession(endpoint: string): Promise<{ session: McpSession; payload: Record<string, any> }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "coderelay-e2e", version: "0.2.0" } }
    })
  });
  if (!response.ok) throw new Error(`MCP initialize HTTP ${response.status}: ${await response.text()}`);
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialize did not return a session id.");
  return { session: { endpoint, sessionId, nextId: 2 }, payload: parseSse(await response.text()) };
}

async function mcpCall(session: McpSession, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(session.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session.sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: session.nextId++, method, params })
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  return parseSse(await response.text());
}

async function initializedNotification(session: McpSession): Promise<void> {
  const response = await fetch(session.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session.sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  });
  if (response.status !== 202 && response.status !== 200) throw new Error(`MCP initialized notification HTTP ${response.status}`);
}

function toolText(payload: Record<string, any>): string {
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  const result = payload.result;
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? "MCP tool failed");
  return (result?.content ?? []).map((item: { text?: string }) => item.text ?? "").join("\n");
}

function toolError(payload: Record<string, any>): string {
  const result = payload.result;
  expect(result?.isError).toBe(true);
  return (result?.content ?? []).map((item: { text?: string }) => item.text ?? "").join("\n");
}

describe("CodeRelay workspace-session router", () => {
  it("preserves a workspace binding across requests using the initialize response session id", async () => {
    const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-attendance-"));
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-docseek-"));
    const coderelayHome = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-home-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-outside-"));

    try {
      await mkdir(path.join(firstWorkspace, "src"));
      await mkdir(path.join(secondWorkspace, "src"));
      await writeFile(path.join(firstWorkspace, "src", "project.txt"), "attendance workspace\n");
      await writeFile(path.join(secondWorkspace, "src", "project.txt"), "docseek workspace\n");
      await writeFile(path.join(secondWorkspace, "secret.txt"), "must stay in docseek\n");
      await writeFile(path.join(firstWorkspace, "AGENTS.md"), "Run attendance tests before editing.\n");
      await writeFile(path.join(firstWorkspace, "AGENTS.override.md"), "Use the attendance fixture.\n");
      await writeFile(path.join(outside, "escape.txt"), "outside\n");
      await symlink(secondWorkspace, path.join(firstWorkspace, "linked-docseek"));

      const addFirst = launchCli(["add", firstWorkspace, "--name", "attendance"], coderelayHome);
      expect((await addFirst.exit).code).toBe(0);
      const addSecond = launchCli(["add", secondWorkspace, "--name", "docseek"], coderelayHome);
      expect((await addSecond.exit).code).toBe(0);

      const testPort = 20_000 + Math.floor(Math.random() * 5_000);
      const start = launchCli(["start", "--port", String(testPort), "--no-tunnel"], coderelayHome, { CODERELAY_MCP_TRACE: "1" });
      const output = await start.waitForOutput("Local MCP server ready");
      expect((await start.exit).code).toBe(0);
      const endpoint = output.match(/http:\/\/127\.0\.0\.1:\d+\/mcp\/[^\s]+/u)?.[0];
      expect(endpoint).toBeTruthy();
      await waitForPath(path.join(coderelayHome, "daemon", "runtime.json"));

      const status = launchCli(["status"], coderelayHome);
      const statusExit = await status.exit;
      expect(statusExit.code).toBe(0);
      expect(statusExit.stdout).toContain("CodeRelay daemon running");
      expect(statusExit.stdout).toContain("Registered workspaces: 2");
      expect(statusExit.stdout).toContain("Transport state: disabled");
      expect(statusExit.stdout).toContain("Local MCP process: healthy");

      const first = await initializeSession(endpoint!);
      const second = await initializeSession(endpoint!);
      expect(first.payload.result?.serverInfo?.name).toBe("coderelay");
      await initializedNotification(first.session);
      await initializedNotification(second.session);

      const listed = await mcpCall(first.session, "tools/list", {});
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "list_workspaces", "use_workspace", "current_workspace", "list_files", "read_file", "search_code", "write_file", "edit_file", "run_command", "git_diff"
      ]);

      const unbound = await mcpCall(first.session, "tools/call", { name: "read_file", arguments: { path: "src/project.txt" } });
      expect(toolError(unbound)).toContain("use_workspace");

      const workspaces = JSON.parse(toolText(await mcpCall(first.session, "tools/call", { name: "list_workspaces", arguments: {} })));
      expect(workspaces.map((workspace: { name: string }) => workspace.name)).toEqual(["attendance", "docseek"]);

      const firstBinding = JSON.parse(toolText(await mcpCall(first.session, "tools/call", { name: "use_workspace", arguments: { name: "attendance" } })));
      expect(firstBinding.chat_binding).toBe("attendance");
      expect(firstBinding.instruction).toContain('workspace="attendance"');
      await mcpCall(second.session, "tools/call", { name: "use_workspace", arguments: { name: "docseek" } });

      const explicitCrossSessionRead = await mcpCall(second.session, "tools/call", {
        name: "read_file",
        arguments: { workspace: "attendance", path: "src/project.txt" }
      });
      expect(toolText(explicitCrossSessionRead)).toContain("attendance workspace");
      const explicitCurrent = JSON.parse(toolText(await mcpCall(second.session, "tools/call", {
        name: "current_workspace",
        arguments: { workspace: "attendance" }
      })));
      expect(explicitCurrent.name).toBe("attendance");
      const cachedSecond = JSON.parse(toolText(await mcpCall(second.session, "tools/call", {
        name: "current_workspace",
        arguments: {}
      })));
      expect(cachedSecond.name).toBe("docseek");

      const [firstRead, secondRead] = await Promise.all([
        mcpCall(first.session, "tools/call", { name: "read_file", arguments: { path: "src/project.txt" } }),
        mcpCall(second.session, "tools/call", { name: "read_file", arguments: { path: "src/project.txt" } })
      ]);
      expect(toolText(firstRead)).toContain("attendance workspace");
      expect(toolText(secondRead)).toContain("docseek workspace");

      const current = JSON.parse(toolText(await mcpCall(first.session, "tools/call", { name: "current_workspace", arguments: {} })));
      expect(current.name).toBe("attendance");
      expect(current.agents.md.content).toContain("attendance tests");
      expect(current.agents.override_md.content).toContain("attendance fixture");

      expect(toolText(await mcpCall(first.session, "tools/call", { name: "write_file", arguments: { path: "src/only-a.txt", content: "A\n" } }))).toContain("Wrote src/only-a.txt");
      expect(toolText(await mcpCall(second.session, "tools/call", { name: "write_file", arguments: { path: "src/only-b.txt", content: "B\n" } }))).toContain("Wrote src/only-b.txt");
      await expect(readFile(path.join(firstWorkspace, "src", "only-b.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(path.join(secondWorkspace, "src", "only-a.txt"), "utf8")).rejects.toThrow();

      const traversal = await mcpCall(first.session, "tools/call", { name: "read_file", arguments: { workspace: "attendance", path: "../coderelay-e2e-docseek-unknown/secret.txt" } });
      expect(toolError(traversal)).toContain("inside the workspace");
      const symlinkEscape = await mcpCall(first.session, "tools/call", { name: "read_file", arguments: { workspace: "attendance", path: "linked-docseek/secret.txt" } });
      expect(toolError(symlinkEscape)).toContain("outside the workspace");
      const invalidWorkspace = await mcpCall(first.session, "tools/call", {
        name: "read_file",
        arguments: { workspace: secondWorkspace, path: "src/project.txt" }
      });
      expect(toolError(invalidWorkspace)).toContain("Workspace is not registered");

      await mcpCall(first.session, "tools/call", { name: "use_workspace", arguments: { name: "docseek" } });
      const switched = JSON.parse(toolText(await mcpCall(first.session, "tools/call", { name: "current_workspace", arguments: {} })));
      expect(switched.name).toBe("docseek");
      expect(toolText(await mcpCall(first.session, "tools/call", { name: "read_file", arguments: { path: "secret.txt" } }))).toContain("must stay in docseek");

      const runtime = JSON.parse(await readFile(path.join(coderelayHome, "daemon", "runtime.json"), "utf8")) as { serverLog: string };
      const initializeTrace = await waitForTraceEvent(runtime.serverLog, (event) => event.rpcMethod === "initialize" && event.route === "new");
      expect(initializeTrace.incomingSessionId).toBeNull();
      expect(initializeTrace.outgoingSessionId).toBe(first.session.sessionId);
      expect(initializeTrace.transportSessionId).toBe(first.session.sessionId);

      const useWorkspaceTrace = await waitForTraceEvent(runtime.serverLog, (event) =>
        event.toolName === "use_workspace"
        && event.incomingSessionId === first.session.sessionId
        && event.workspaceBindingAfter === "attendance"
      );
      const currentWorkspaceTrace = await waitForTraceEvent(runtime.serverLog, (event) =>
        event.toolName === "current_workspace"
        && event.incomingSessionId === first.session.sessionId
        && event.workspaceBindingAfter === "attendance"
      );
      expect(useWorkspaceTrace.route).toBe("existing");
      expect(useWorkspaceTrace.workspaceBindingBefore).toBeNull();
      expect(useWorkspaceTrace.explicitWorkspace).toBe("attendance");
      expect(useWorkspaceTrace.sessionWorkspace).toBeNull();
      expect(useWorkspaceTrace.resolvedWorkspace).toBe("attendance");
      expect(useWorkspaceTrace.resolutionSource).toBe("explicit");
      expect(currentWorkspaceTrace.route).toBe("existing");
      expect(currentWorkspaceTrace.workspaceBindingBefore).toBe("attendance");
      expect(currentWorkspaceTrace.internalSessionId).toBe(useWorkspaceTrace.internalSessionId);
      expect(currentWorkspaceTrace.transportSessionId).toBe(first.session.sessionId);

      const explicitTrace = await waitForTraceEvent(runtime.serverLog, (event) =>
        event.toolName === "read_file"
        && event.incomingSessionId === second.session.sessionId
        && event.explicitWorkspace === "attendance"
        && event.resolutionSource === "explicit"
      );
      expect(explicitTrace.sessionWorkspace).toBe("docseek");
      expect(explicitTrace.resolvedWorkspace).toBe("attendance");

      const stop = launchCli(["stop"], coderelayHome);
      expect((await stop.exit).code).toBe(0);
      await expect(readFile(path.join(coderelayHome, "daemon", "runtime.json"), "utf8")).rejects.toThrow();

      const persisted = launchCli(["workspaces"], coderelayHome);
      const persistedExit = await persisted.exit;
      expect(persistedExit.code).toBe(0);
      expect(persistedExit.stdout).toContain("attendance");
      expect(persistedExit.stdout).toContain("docseek");
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
      await rm(coderelayHome, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 90_000);
});
