import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { validateCommand, type ParsedCommand } from "./command-security.js";
import { WorkspaceSessionManager } from "./session.js";
import { WorkspaceRegistry, type RegisteredWorkspace, type WorkspaceDescriptor } from "../workspace/registry.js";
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
  registry: WorkspaceRegistry;
  sessions: WorkspaceSessionManager;
  sessionId: string;
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

type WorkspaceResolutionSource = "explicit" | "session";

interface WorkspaceResolution {
  workspace: RegisteredWorkspace;
  source: WorkspaceResolutionSource;
}

async function resolveWorkspace(context: ToolContext, explicitWorkspace?: string): Promise<WorkspaceResolution> {
  if (explicitWorkspace !== undefined) {
    return { workspace: await context.registry.requireUsable(explicitWorkspace), source: "explicit" };
  }

  const workspaceId = context.sessions.current(context.sessionId);
  if (workspaceId) {
    return { workspace: await context.registry.requireUsable(workspaceId), source: "session" };
  }

  const available = (await context.registry.list()).map((entry) => entry.name);
  const suffix = available.length ? ` Available workspaces: ${available.join(", ")}.` : " No workspaces are registered yet.";
  throw new Error(`No workspace context is attached to this MCP request. Pass workspace="<registered name>" for this call or call use_workspace first.${suffix}`);
}

async function requireWorkspace(context: ToolContext, explicitWorkspace?: string): Promise<RegisteredWorkspace> {
  return (await resolveWorkspace(context, explicitWorkspace)).workspace;
}

function scopedDescription(description: string): string {
  return `${description} Pass the optional workspace argument using a registered workspace name or id. Explicit workspace takes precedence over the MCP session cache; if neither is available, the call is rejected. The session cache is the default for this logical task context; an explicit registered workspace may be used when the user requests work in another project. Paths outside the selected workspace are inaccessible.`;
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
      const lines = text.split(/\r?\n/u);
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

    child.stdout.on("data", (chunk: Buffer) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendOutput(stderr, chunk); });
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

function workspaceSummary(descriptor: WorkspaceDescriptor): Record<string, unknown> {
  return {
    id: descriptor.id,
    name: descriptor.name,
    root: descriptor.root,
    exists: descriptor.exists,
    agents_md: Boolean(descriptor.agents.md),
    agents_override_md: Boolean(descriptor.agents.overrideMd)
  };
}

function formatCurrentWorkspace(descriptor: WorkspaceDescriptor): string {
  return JSON.stringify({
    ...workspaceSummary(descriptor),
    chat_binding: descriptor.name,
    instruction: `Use workspace="${descriptor.name}" as the default for this logical task context. To work in another registered workspace, pass workspace explicitly on that call; each call remains isolated.`,
    agents: {
      md: descriptor.agents.md,
      override_md: descriptor.agents.overrideMd
    }
  }, null, 2);
}

async function currentWorkspaceDescriptor(context: ToolContext, explicitWorkspace?: string): Promise<WorkspaceDescriptor> {
  return await context.registry.describe((await resolveWorkspace(context, explicitWorkspace)).workspace);
}

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "coderelay", version: "0.2.0" });

  server.registerTool(
    "list_workspaces",
    {
      description: "List the workspaces registered with this CodeRelay daemon. This does not change the current MCP session binding.",
      inputSchema: z.object({})
    },
    async () => guarded(async () => JSON.stringify((await context.registry.describeAll()).map(workspaceSummary), null, 2), (value) => value)
  );

  server.registerTool(
    "use_workspace",
    {
      description: "Select one registered workspace as the default for this logical task context and cache it for stable MCP sessions. Pass the workspace name or id returned by list_workspaces; arbitrary paths are not accepted. Later calls may pass another registered workspace explicitly when the user requests cross-project work.",
      inputSchema: z.object({ name: z.string().min(1) })
    },
    async ({ name }) => guarded(async () => {
      const workspace = await context.registry.requireUsable(name);
      context.sessions.bind(context.sessionId, workspace);
      return formatCurrentWorkspace(await context.registry.describe(workspace));
    }, (value) => value)
  );

  server.registerTool(
    "current_workspace",
    {
      description: "Show workspace context, including read-only AGENTS.md context. Pass workspace explicitly when the MCP transport session may have changed; otherwise the session cache is used.",
      inputSchema: z.object({ workspace: z.string().min(1).optional() })
    },
    async ({ workspace }) => guarded(async () => formatCurrentWorkspace(await currentWorkspaceDescriptor(context, workspace)), (value) => value)
  );

  server.registerTool(
    "list_files",
    {
      description: scopedDescription("List files and directories inside the selected CodeRelay workspace."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), path: z.string().default("."), depth: z.number().int().min(0).max(20).default(3), include_hidden: z.boolean().default(false) })
    },
    async ({ workspace, path: requestedPath, depth, include_hidden }) => guarded(async () => listFiles((await requireWorkspace(context, workspace)).root, requestedPath, depth, include_hidden), (files) => files.length ? files.join("\n") : "(empty)")
  );

  server.registerTool(
    "read_file",
    {
      description: scopedDescription("Read a UTF-8 text file inside the selected workspace. Sensitive files are blocked."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), path: z.string(), max_bytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(MAX_FILE_BYTES) })
    },
    async ({ workspace, path: requestedPath, max_bytes }) => guarded(async () => readFile((await requireWorkspace(context, workspace)).root, requestedPath, max_bytes), (content) => content)
  );

  server.registerTool(
    "search_code",
    {
      description: scopedDescription("Search text in files inside the selected workspace without reading blocked sensitive files."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), query: z.string(), path: z.string().default("."), max_results: z.number().int().min(1).max(200).default(50), case_sensitive: z.boolean().default(false) })
    },
    async ({ workspace, query, path: requestedPath, max_results, case_sensitive }) => guarded(async () => searchCode((await requireWorkspace(context, workspace)).root, query, requestedPath, max_results, case_sensitive), (matches) => matches.length ? matches.join("\n") : "No matches.")
  );

  server.registerTool(
    "write_file",
    {
      description: scopedDescription("Create or replace a UTF-8 text file inside the selected workspace."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), path: z.string(), content: z.string() })
    },
    async ({ workspace, path: requestedPath, content }) => guarded(async () => writeFile((await requireWorkspace(context, workspace)).root, requestedPath, content), (message) => message)
  );

  server.registerTool(
    "edit_file",
    {
      description: scopedDescription("Replace an exact text fragment in a file inside the selected workspace."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().default(false) })
    },
    async ({ workspace, path: requestedPath, old_text, new_text, replace_all }) => guarded(async () => editFile((await requireWorkspace(context, workspace)).root, requestedPath, old_text, new_text, replace_all), (message) => message)
  );

  server.registerTool(
    "run_command",
    {
      description: scopedDescription("Run a shell-free command from the selected workspace. Dangerous commands and workspace escapes are blocked."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), command: z.string(), timeout_ms: z.number().int().min(1_000).max(120_000).default(120_000) })
    },
    async ({ workspace, command, timeout_ms }) => guarded(async () => {
      const workspaceRoot = (await requireWorkspace(context, workspace)).root;
      const parsed = validateCommand(command, workspaceRoot);
      return formatCommandResult(command, await executeCommand(workspaceRoot, parsed, timeout_ms));
    }, (message) => message)
  );

  server.registerTool(
    "git_diff",
    {
      description: scopedDescription("Show the current Git diff for the selected workspace."),
      inputSchema: z.object({ workspace: z.string().min(1).optional(), path: z.string().optional(), cached: z.boolean().default(false) })
    },
    async ({ workspace, path: requestedPath, cached }) => guarded(async () => {
      const workspaceRoot = (await requireWorkspace(context, workspace)).root;
      const args = ["diff"];
      if (cached) args.push("--cached");
      if (requestedPath) {
        const absolutePath = await resolveWorkspacePath(workspaceRoot, requestedPath, { mustExist: true, allowDirectory: true });
        args.push("--", toWorkspaceRelativePath(workspaceRoot, absolutePath));
      }
      const parsed: ParsedCommand = { executable: "git", args };
      return formatCommandResult(`git ${args.join(" ")}`, await executeCommand(workspaceRoot, parsed));
    }, (message) => message)
  );

  return server;
}

export function isBlockedPathError(error: unknown): boolean {
  return error instanceof WorkspaceSecurityError;
}
