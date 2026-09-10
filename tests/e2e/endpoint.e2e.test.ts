import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function stopDaemon(coderelayHome: string): Promise<void> {
  const stop = launchCli(["stop"], coderelayHome);
  await stop.exit;
}

async function readRuntime(coderelayHome: string): Promise<{ token: string; endpoint: string; serverLog: string }> {
  return JSON.parse(await readFile(path.join(coderelayHome, "daemon", "runtime.json"), "utf8")) as { token: string; endpoint: string; serverLog: string };
}

async function initialize(endpoint: string): Promise<Response> {
  return await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "endpoint-e2e", version: "0.2.0" } }
    })
  });
}

describe("CodeRelay persistent MCP endpoint token", () => {
  it("preserves the token across restart and transport changes, then invalidates the old endpoint on rotation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-endpoint-workspace-"));
    const coderelayHome = await mkdtemp(path.join(os.tmpdir(), "coderelay-endpoint-home-"));
    const port = 24_000 + Math.floor(Math.random() * 1_000);
    let daemonStarted = false;

    try {
      await writeFile(path.join(workspace, "README.md"), "endpoint test\n");
      const add = launchCli(["add", workspace, "--name", "endpoint-test"], coderelayHome);
      expect((await add.exit).code).toBe(0);

      const firstStart = launchCli(["start", "--port", String(port), "--no-tunnel"], coderelayHome, { CODERELAY_MCP_TRACE: "1" });
      await firstStart.waitForOutput("Local MCP server ready");
      expect((await firstStart.exit).code).toBe(0);
      daemonStarted = true;
      const first = await readRuntime(coderelayHome);
      const credentialsPath = path.join(coderelayHome, "credentials.json");
      const firstCredentials = JSON.parse(await readFile(credentialsPath, "utf8")) as { mcp?: { endpointToken?: string } };
      expect(firstCredentials.mcp?.endpointToken).toBe(first.token);
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
      expect(first.endpoint).toContain(`/mcp/${first.token}`);
      expect((await initialize(first.endpoint)).status).toBe(200);

      const restart = launchCli(["restart", "--port", String(port), "--no-tunnel"], coderelayHome);
      await restart.waitForOutput("Local MCP server ready");
      expect((await restart.exit).code).toBe(0);
      const afterRestart = await readRuntime(coderelayHome);
      expect(afterRestart.token).toBe(first.token);
      expect(afterRestart.endpoint).toContain(`/mcp/${first.token}`);

      const transportChange = launchCli(["restart", "--port", String(port), "--transport", "local"], coderelayHome);
      await transportChange.waitForOutput("Local MCP server ready");
      expect((await transportChange.exit).code).toBe(0);
      const afterTransportChange = await readRuntime(coderelayHome);
      expect(afterTransportChange.token).toBe(first.token);

      const oldEndpoint = afterTransportChange.endpoint;
      const rotate = launchCli(["endpoint", "rotate"], coderelayHome);
      await rotate.waitForOutput("Local MCP server ready");
      expect((await rotate.exit).code).toBe(0);
      const afterRotate = await readRuntime(coderelayHome);
      expect(afterRotate.token).not.toBe(first.token);
      expect(afterRotate.endpoint).not.toBe(oldEndpoint);

      const oldResponse = await initialize(oldEndpoint);
      expect(oldResponse.status).toBe(404);
      const newResponse = await initialize(afterRotate.endpoint);
      expect(newResponse.status).toBe(200);

      const log = await readFile(first.serverLog, "utf8");
      expect(log).not.toContain(first.token);
      const rotatedLog = await readFile(afterRotate.serverLog, "utf8");
      expect(rotatedLog).not.toContain(afterRotate.token);
      const endpointOutput = launchCli(["endpoint"], coderelayHome);
      expect((await endpointOutput.waitForOutput("MCP endpoint:")).trim()).toContain(afterRotate.endpoint);
      expect((await endpointOutput.exit).code).toBe(0);
    } finally {
      if (daemonStarted) await stopDaemon(coderelayHome);
      await rm(workspace, { recursive: true, force: true });
      await rm(coderelayHome, { recursive: true, force: true });
    }
  }, 30_000);
});
