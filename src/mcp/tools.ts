import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { validateCommand, type ParsedCommand } from "./command-security.js";
import {
  resolveWorkspacePath,
  toWorkspaceRelativePath,
  WorkspaceSecurityError
} from "../workspace/path-security.js";
import { isSensitiveRelativePath } from "../workspace/sensitive-files.js";

const MAX_FILE_BYTES = 512_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 100_000;
const MAX_LIST_RESULTS = 2_000;

export interface ToolContext {
  workspaceRoot: string;
}

type ToolResponse = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function success(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

function failure(error: unknown): ToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guarded<T>(operation: () => Promise<T>, format: (value: T) => string): Promise<ToolResponse> {
  try {
    return success(format(await operation()));
  } catch (error) {
    return failure(error);
  }
}

function isHidden(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith(".") && segment !== ".");
}

async function collectFiles(
  workspaceRoot: string,
  absoluteDirectory: string,
  relativeDirectory: string,
  includeHidden: boolean,
  depth: number,
  results: string[]
): Promise<void> {
  if (results.length >= MAX_LIST_RESULTS) return;
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (results.length >= MAX_LIST_RESULTS) return;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if ((!includeHidden && isHidden(relativePath)) || isSensitiveRelativePath(relativePath)) continue;
    const absolutePath = path.join(absoluteDirectory, entry.name);

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      results.push(`${relativePath}/`);
      if (depth > 0) await collectFiles(workspaceRoot, absolutePath, relativePath, includeHidden, depth - 1, results);
      continue;
    }
    if (entry.isFile()) results.push(relativePath);
  }
}

async function listFiles(
  workspaceRoot: string,
  requestedPath: string,
  depth: number,
  includeHidden: boolean
): Promise<string[]> {
  const absolutePath = await resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist: true, allowDirectory: true });
  const stats = await fs.stat(absolutePath);
  if (stats.isFile()) return [toWorkspaceRelativePath(workspaceRoot, absolutePath)];
  const rootRelative = toWorkspaceRelativePath(workspaceRoot, absolutePath);
  const results: string[] = [];
  await collectFiles(workspaceRoot, absolutePath, rootRelative === "." ? "" : rootRelative, includeHidden, depth, results);
  return results;
}

async function readFile(workspaceRoot: string, requestedPath: string, maxBytes: number): Promise<string> {
  const absolutePath = await resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist: true });
  const stats = await fs.stat(absolutePath);
  if (stats.size > maxBytes) throw new Error(`File is ${stats.size} bytes; max allowed is ${maxBytes}.`);
  return await fs.readFile(absolutePath, "utf8");
}

async function searchCode(
  workspaceRoot: string,
  query: string,
  requestedPath: string,
  maxResults: number,
  caseSensitive: boolean
): Promise<string[]> {
  if (!query) throw new Error("query must not be empty.");
  const absolutePath = await resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist: true, allowDirectory: true });
  const stats = await fs.stat(absolutePath);
  const files: string[] = [];

  if (stats.isFile()) {
    files.push(absolutePath);
  } else {
    const listed: string[] = [];
    const relativeRoot = toWorkspaceRelativePath(workspaceRoot, absolutePath);
    await collectFiles(workspaceRoot, absolutePath, relativeRoot === "." ? "" : relativeRoot, false, 100, listed);
    for (const relative of listed.filter((entry) => !entry.endsWith("/"))) files.push(path.join(workspaceRoot, relative));
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: string[] = [];
  for (const absoluteFile of files) {
    if (matches.length >= maxResults) break;
    try {
      const fileStats = await fs.stat(absoluteFile);
      if (fileStats.size > MAX_SEARCH_FILE_BYTES) continue;
      const buffer = await fs.readFile(absoluteFile);
      if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) continue;
      const text = buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      const relative = toWorkspaceRelativePath(workspaceRoot, absoluteFile);
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
        if (haystack.includes(needle)) matches.push(`${relative}:${index + 1}: ${lines[index].slice(0, 1_000)}`);
      }
    } catch {
      // Files can disappear during a search; skip them and continue.
    }
  }
  return matches;
}

async function writeFile(workspaceRoot: string, requestedPath: string, content: string): Promise<string> {
  const absolutePath = await resolveWorkspacePath(workspaceRoot, requestedPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return `Wrote ${toWorkspaceRelativePath(workspaceRoot, absolutePath)} (${Buffer.byteLength(content, "utf8")} bytes).`;
}

async function editFile(
  workspaceRoot: string,
  requestedPath: string,
  oldText: string,
  newText: string,
  replaceAll: boolean
): Promise<string> {
  if (!oldText) throw new Error("old_text must not be empty.");
  const absolutePath = await resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist: true });
  const content = await fs.readFile(absolutePath, "utf8");
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) throw new Error("old_text was not found.");
  if (!replaceAll && occurrences !== 1) {
    throw new Error(`old_text occurs ${occurrences} times; pass replace_all=true to replace every occurrence.`);
  }
  const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  await fs.writeFile(absolutePath, next, "utf8");
  return `Edited ${toWorkspaceRelativePath(workspaceRoot, absolutePath)} (${replaceAll ? occurrences : 1} replacement).`;
}

function appendOutput(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) return current;
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
  return current + chunk.toString("utf8").slice(0, remaining);
}

export async function executeCommand(
  workspaceRoot: string,
  parsed: ParsedCommand,
  timeoutMs = 120_000
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(parsed.executable, parsed.args, {
      cwd: workspaceRoot,
      shell: false,
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error(`Command timed out after ${timeoutMs / 1_000} seconds.`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
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
      if (!settled) {
        settled = true;
        resolve({ exitCode, signal, stdout, stderr });
      }
    });
  });
}

function formatCommandResult(command: string, result: Awaited<ReturnType<typeof executeCommand>>): string {
  const sections = [`$ ${command}`, `exit_code: ${result.exitCode ?? "null"}`];
  if (result.signal) sections.push(`signal: ${result.signal}`);
  sections.push(`stdout:\n${result.stdout || "(empty)"}`);
  sections.push(`stderr:\n${result.stderr || "(empty)"}`);
  return sections.join("\n\n");
}

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "coderelay", version: "0.1.0" });

  server.registerTool(
    "list_files",
    {
      description: "List files and directories inside the CodeRelay workspace.",
      inputSchema: z.object({
        path: z.string().default("."),
        depth: z.number().int().min(0).max(20).default(3),
        include_hidden: z.boolean().default(false)
      })
    },
    async ({ path: requestedPath, depth, include_hidden }) => guarded(
      () => listFiles(context.workspaceRoot, requestedPath, depth, include_hidden),
      (files) => files.length ? files.join("\n") : "(empty)"
    )
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 text file inside the CodeRelay workspace. Sensitive files are blocked.",
      inputSchema: z.object({
        path: z.string(),
        max_bytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(MAX_FILE_BYTES)
      })
    },
    async ({ path: requestedPath, max_bytes }) => guarded(
      () => readFile(context.workspaceRoot, requestedPath, max_bytes),
      (content) => content
    )
  );

  server.registerTool(
    "search_code",
    {
      description: "Search text in workspace files without reading blocked sensitive files.",
      inputSchema: z.object({
        query: z.string(),
        path: z.string().default("."),
        max_results: z.number().int().min(1).max(200).default(50),
        case_sensitive: z.boolean().default(false)
      })
    },
    async ({ query, path: requestedPath, max_results, case_sensitive }) => guarded(
      () => searchCode(context.workspaceRoot, query, requestedPath, max_results, case_sensitive),
      (matches) => matches.length ? matches.join("\n") : "No matches."
    )
  );

  server.registerTool(
    "write_file",
    {
      description: "Create or replace a UTF-8 text file inside the workspace.",
      inputSchema: z.object({ path: z.string(), content: z.string() })
    },
    async ({ path: requestedPath, content }) => guarded(
      () => writeFile(context.workspaceRoot, requestedPath, content),
      (message) => message
    )
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace an exact text fragment in a workspace file.",
      inputSchema: z.object({
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
        replace_all: z.boolean().default(false)
      })
    },
    async ({ path: requestedPath, old_text, new_text, replace_all }) => guarded(
      () => editFile(context.workspaceRoot, requestedPath, old_text, new_text, replace_all),
      (message) => message
    )
  );

  server.registerTool(
    "run_command",
    {
      description: "Run a shell-free command from the workspace. Dangerous commands and workspace escapes are blocked.",
      inputSchema: z.object({
        command: z.string(),
        timeout_ms: z.number().int().min(1_000).max(120_000).default(120_000)
      })
    },
    async ({ command, timeout_ms }) => guarded(
      async () => {
        const parsed = validateCommand(command, context.workspaceRoot);
        const result = await executeCommand(context.workspaceRoot, parsed, timeout_ms);
        return formatCommandResult(command, result);
      },
      (message) => message
    )
  );

  server.registerTool(
    "git_diff",
    {
      description: "Show the current Git diff for the workspace.",
      inputSchema: z.object({ path: z.string().optional(), cached: z.boolean().default(false) })
    },
    async ({ path: requestedPath, cached }) => guarded(
      async () => {
        const args = ["diff"];
        if (cached) args.push("--cached");
        if (requestedPath) {
          const absolutePath = await resolveWorkspacePath(context.workspaceRoot, requestedPath, { mustExist: true, allowDirectory: true });
          args.push("--", toWorkspaceRelativePath(context.workspaceRoot, absolutePath));
        }
        const parsed: ParsedCommand = { executable: "git", args };
        return formatCommandResult(`git ${args.join(" ")}`, await executeCommand(context.workspaceRoot, parsed));
      },
      (message) => message
    )
  );

  return server;
}

export function isBlockedPathError(error: unknown): boolean {
  return error instanceof WorkspaceSecurityError;
}
