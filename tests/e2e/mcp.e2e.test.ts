import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function launchCli(args: string[], coderelayHome: string): LaunchedProcess {
  const child = spawn(process.execPath, [entryPoint, ...args], {
    cwd: projectRoot,
    env: { ...process.env, CODERELAY_HOME: coderelayHome },
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

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
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

async function mcpCall(endpoint: string, method: string, params: Record<string, unknown>, id: number): Promise<Record<string, any>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  return parseSse(await response.text());
}

function toolText(payload: Record<string, any>): string {
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  const result = payload.result;
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? "MCP tool failed");
  return (result?.content ?? []).map((item: { text?: string }) => item.text ?? "").join("\n");
}

describe("CodeRelay first-run MCP flow", () => {
  it("starts, initializes MCP, edits code, shows diff, and stops", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-workspace-"));
    const coderelayHome = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-home-"));

    try {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ name: "coderelay-e2e-fixture", version: "1.0.0" }, null, 2)}\n`);
      await writeFile(path.join(workspace, "src", "math.js"), "export function add(a, b) { return a + b; }\n");
      await run("git", ["init", "-q"], workspace);
      await run("git", ["add", "."], workspace);
      await run("git", ["-c", "user.name=CodeRelay E2E", "-c", "user.email=coderelay-e2e@example.com", "commit", "-qm", "initial"], workspace);

      const start = launchCli(["start", "--workspace", workspace, "--no-tunnel"], coderelayHome);
      const output = await start.waitForOutput("Your CodeRelay endpoint is ready:");
      const startExit = await start.exit;
      expect(startExit.code).toBe(0);
      const endpoint = output.match(/http:\/\/127\.0\.0\.1:\d+\/mcp\/[^\s]+/u)?.[0];
      expect(endpoint).toBeTruthy();
      const instanceName = path.basename(workspace);
      const runtimePath = path.join(coderelayHome, "instances", instanceName, "runtime.json");
      await waitForPath(runtimePath);

      const status = launchCli(["status"], coderelayHome);
      const statusExit = await status.exit;
      expect(statusExit.code).toBe(0);
      expect(statusExit.stdout).toContain("Instance:");
      expect(statusExit.stdout).toContain("Transport: disabled");
      expect(statusExit.stdout).toContain("Transport state: disabled");
      expect(statusExit.stdout).toContain("Local MCP process: healthy");
      expect(statusExit.stdout).toContain("Local MCP /health: healthy");

      const initialized = await mcpCall(endpoint!, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "coderelay-e2e", version: "0.1.0" }
      }, 1);
      expect(initialized.result?.serverInfo?.name).toBe("coderelay");

      const listed = await mcpCall(endpoint!, "tools/list", {}, 2);
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "list_files", "read_file", "search_code", "write_file", "edit_file", "run_command", "git_diff"
      ]);
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === "read_file").description).toContain("Active CodeRelay instance");
      expect(listed.result.tools.find((tool: { name: string }) => tool.name === "read_file").description).toContain(workspace);

      const read = await mcpCall(endpoint!, "tools/call", { name: "read_file", arguments: { path: "package.json" } }, 3);
      expect(toolText(read)).toContain("coderelay-e2e-fixture");

      const written = await mcpCall(endpoint!, "tools/call", { name: "write_file", arguments: { path: "src/notes.txt", content: "created by e2e\n" } }, 4);
      expect(toolText(written)).toContain("Wrote src/notes.txt");

      const edited = await mcpCall(endpoint!, "tools/call", {
        name: "edit_file",
        arguments: { path: "src/math.js", old_text: "return a + b", new_text: "return a + b + 0" }
      }, 5);
      expect(toolText(edited)).toContain("Edited src/math.js");

      const command = await mcpCall(endpoint!, "tools/call", { name: "run_command", arguments: { command: "node -p 6*7" } }, 6);
      expect(toolText(command)).toContain("42");

      const diff = await mcpCall(endpoint!, "tools/call", { name: "git_diff", arguments: {} }, 7);
      expect(toolText(diff)).toContain("return a + b + 0");

      const stop = launchCli(["stop"], coderelayHome);
      const stopExit = await stop.exit;
      expect(stopExit.code).toBe(0);
      await expect(readFile(runtimePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(coderelayHome, { recursive: true, force: true });
    }
  }, 60_000);

  it("runs two isolated instances with independent runtime state", async () => {
    const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-first-"));
    const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-second-"));
    const coderelayHome = await mkdtemp(path.join(os.tmpdir(), "coderelay-e2e-home-"));

    try {
      const first = launchCli([firstWorkspace, "--name", "project-a", "--no-tunnel"], coderelayHome);
      expect((await first.waitForOutput("Instance: project-a")).includes(firstWorkspace)).toBe(true);
      expect((await first.exit).code).toBe(0);

      const second = launchCli([secondWorkspace, "--name", "project-b", "--no-tunnel"], coderelayHome);
      expect((await second.waitForOutput("Instance: project-b")).includes(secondWorkspace)).toBe(true);
      expect((await second.exit).code).toBe(0);

      const list = launchCli(["list"], coderelayHome);
      const listExit = await list.exit;
      expect(listExit.code).toBe(0);
      expect(listExit.stdout).toContain("project-a");
      expect(listExit.stdout).toContain("project-b");
      expect(listExit.stdout).toContain("project-a\t");
      expect(listExit.stdout).toContain("project-b\t");

      const stopFirst = launchCli(["stop", "project-a"], coderelayHome);
      expect((await stopFirst.exit).code).toBe(0);
      const statusSecond = launchCli(["status", "project-b"], coderelayHome);
      expect((await statusSecond.exit).stdout).toContain("Instance: project-b");

      const stopSecond = launchCli(["stop", "project-b"], coderelayHome);
      expect((await stopSecond.exit).code).toBe(0);
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
      await rm(coderelayHome, { recursive: true, force: true });
    }
  }, 60_000);
});
