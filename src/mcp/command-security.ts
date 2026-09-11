import path from "node:path";
import { WorkspaceSecurityError } from "../workspace/path-security.js";
import type { StructuredCommand } from "../command/model.js";

export interface ParsedCommand {
  executable: string;
  args: string[];
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "fish", "ksh", "csh"]);

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
  return validateParsedCommand(parsed, workspaceRoot);
}

/**
 * Validate a structured command without treating ordinary arguments as shell
 * syntax. The command is still launched with shell:false. Legacy strings are
 * tokenized into the same ParsedCommand shape and use this same validator.
 */
export function validateStructuredCommand(command: StructuredCommand, workspaceRoot: string): ParsedCommand {
  if (!command.program.trim() || command.program.includes("\0")) {
    throw new WorkspaceSecurityError("command.program is empty or contains a null byte.");
  }
  if (/\s/u.test(command.program)) throw new WorkspaceSecurityError("command.program must not contain whitespace.");
  if (command.args.some((argument) => argument.includes("\0"))) {
    throw new WorkspaceSecurityError("Command arguments may not contain null bytes.");
  }
  return validateParsedCommand({ executable: command.program, args: command.args }, workspaceRoot);
}

function validateParsedCommand(parsed: ParsedCommand, workspaceRoot: string): ParsedCommand {
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

  if (SHELL_EXECUTABLES.has(executableName) && parsed.args.some((argument) => argument === "-c" || argument === "--command" || argument === "-lc")) {
    throw new WorkspaceSecurityError("Shell interpreters with -c/--command are blocked; use structured commands instead.");
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
