import { spawn } from "node:child_process";
import type { ParsedCommand } from "../mcp/command-security.js";

export interface ExecutionResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SequentialExecutionResult {
  results: ExecutionResult[];
  stopped_on_error: boolean;
}

function appendOutput(current: string, chunk: Buffer, maxBytes: number): { value: string; truncated: boolean } {
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return { value: current, truncated: true };
  const buffer = chunk.subarray(0, remaining);
  return { value: current + buffer.toString("utf8"), truncated: buffer.length < chunk.length };
}

export async function runCommand(
  workspaceRoot: string,
  command: ParsedCommand,
  timeoutMs: number,
  maxOutputBytes = 100_000
): Promise<ExecutionResult> {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command.executable, command.args, {
      cwd: workspaceRoot,
      shell: false,
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const result = appendOutput(stdout, chunk, maxOutputBytes);
      stdout = result.value;
      truncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = appendOutput(stderr, chunk, maxOutputBytes);
      stderr = result.value;
      truncated ||= result.truncated;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        exit_code: exitCode,
        signal,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        stdout,
        stderr,
        truncated
      });
    });
  });
}

export async function runSequential(
  workspaceRoot: string,
  commands: ParsedCommand[],
  timeoutMs: number,
  stopOnError: boolean,
  maxOutputBytes = 100_000
): Promise<SequentialExecutionResult> {
  const results: ExecutionResult[] = [];
  let stoppedOnError = false;
  for (const command of commands) {
    const result = await runCommand(workspaceRoot, command, timeoutMs, maxOutputBytes);
    results.push(result);
    if (stopOnError && (result.timed_out || result.exit_code !== 0)) {
      stoppedOnError = true;
      break;
    }
  }
  return { results, stopped_on_error: stoppedOnError };
}

