import path from "node:path";
import { WorkspaceSecurityError } from "../workspace/path-security.js";

export interface ParsedCommand {
  executable: string;
  args: string[];
}

const BLOCKED_EXECUTABLES = new Set(["sudo", "su", "shutdown", "reboot", "mkfs", "dd"]);

function hasPathEscape(value: string): boolean {
  return value === ".." || value.startsWith(`..${path.sep}`) || value.startsWith("../") || value.includes("/../") || value.includes("\\..\\");
}

/**
 * Small shell-free tokenizer. CodeRelay intentionally rejects shell operators
 * instead of trying to reproduce a full shell parser.
 */
export function parseCommand(command: string): ParsedCommand {
  if (!command.trim() || command.includes("\0")) {
    throw new WorkspaceSecurityError("Command is empty or contains a null byte.");
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of command.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (";&|<>`$".includes(character)) {
      throw new WorkspaceSecurityError("Shell operators and command substitution are blocked.");
    }
    current += character;
  }

  if (escaping || quote) throw new WorkspaceSecurityError("Unclosed quote or escape in command.");
  if (current) tokens.push(current);
  if (!tokens[0]) throw new WorkspaceSecurityError("Command is empty.");
  return { executable: tokens[0], args: tokens.slice(1) };
}

export function validateCommand(command: string, workspaceRoot: string): ParsedCommand {
  const parsed = parseCommand(command);
  if (parsed.executable.startsWith("~/" ) || hasPathEscape(parsed.executable)) {
    throw new WorkspaceSecurityError("The executable may not escape the workspace.");
  }
  if (path.isAbsolute(parsed.executable)) {
    const absoluteExecutable = path.resolve(workspaceRoot, parsed.executable);
    const executableRelative = path.relative(workspaceRoot, absoluteExecutable);
    if (executableRelative.startsWith("..") || path.isAbsolute(executableRelative)) {
      throw new WorkspaceSecurityError("The executable may not reference a path outside the workspace.");
    }
  }
  const executableName = path.basename(parsed.executable).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(executableName)) {
    throw new WorkspaceSecurityError(`Command is blocked: ${executableName}`);
  }

  const normalized = `${executableName} ${parsed.args.join(" ")}`.toLowerCase();
  if (executableName === "git" && /(^|\s)push(\s|$)/.test(normalized)) {
    throw new WorkspaceSecurityError("git push is disabled in the MVP.");
  }
  if (executableName === "git" && /reset\s+--hard/.test(normalized)) {
    throw new WorkspaceSecurityError("git reset --hard is disabled in the MVP.");
  }
  if (executableName === "git" && /clean\s+-[^\s]*f/.test(normalized)) {
    throw new WorkspaceSecurityError("git clean -fd is disabled in the MVP.");
  }
  if (executableName === "git" && /checkout\s+--\s+\.?$/.test(normalized)) {
    throw new WorkspaceSecurityError("git checkout -- . is disabled in the MVP.");
  }
  if (executableName === "rm" && parsed.args.some((arg) => /^-/.test(arg) && arg.includes("r"))) {
    throw new WorkspaceSecurityError("Recursive rm is disabled in the MVP.");
  }

  for (const argument of parsed.args) {
    if (argument.startsWith("~/") || hasPathEscape(argument)) {
      throw new WorkspaceSecurityError("Command arguments may not escape the workspace.");
    }
    if (path.isAbsolute(argument)) {
      const absolute = path.resolve(workspaceRoot, argument);
      const relative = path.relative(workspaceRoot, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new WorkspaceSecurityError("Command arguments may not reference paths outside the workspace.");
      }
    }
  }

  return parsed;
}
