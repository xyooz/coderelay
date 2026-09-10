export type CommandPolicyMode = "safe" | "workspace" | "unrestricted";

export interface StructuredCommand {
  program: string;
  args: string[];
}

export type CommandInput = string | StructuredCommand;

export interface CommandRequestInput {
  command?: CommandInput;
  commands?: StructuredCommand[];
  stopOnError?: boolean;
  timeoutMs?: number;
}

export interface NormalizedCommandRequest {
  commands: StructuredCommand[];
  stopOnError: boolean;
  timeoutMs: number;
  legacy: boolean;
  legacyCommand?: string;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;

function assertCommandString(value: string, label: string): void {
  if (!value.trim() || value.includes("\0")) throw new Error(`${label} must be non-empty and contain no null bytes.`);
}

export function normalizeStructuredCommand(value: StructuredCommand): StructuredCommand {
  assertCommandString(value.program, "command.program");
  if (/\s/u.test(value.program)) throw new Error("command.program must be one executable name or path without whitespace.");
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("command.args must be an array of strings without null bytes.");
  }
  return { program: value.program, args: [...value.args] };
}

export function normalizeCommandRequest(input: CommandRequestInput): NormalizedCommandRequest {
  const hasSingle = input.command !== undefined;
  const hasSequence = input.commands !== undefined;
  if (hasSingle === hasSequence) throw new Error("Provide exactly one of command or commands.");

  if (typeof input.command === "string") throw new Error("Legacy command strings must be parsed before normalization.");
  const commands = hasSequence
    ? (input.commands ?? []).map(normalizeStructuredCommand)
    : [normalizeStructuredCommand(input.command as StructuredCommand)];
  if (commands.length === 0) throw new Error("commands must contain at least one structured command.");
  const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_COMMAND_TIMEOUT_MS}.`);
  }

  return {
    commands,
    stopOnError: input.stopOnError ?? true,
    timeoutMs,
    legacy: typeof input.command === "string"
  };
}

export function commandFingerprint(commands: StructuredCommand[], workspace: string, stopOnError: boolean, timeoutMs: number): string {
  return JSON.stringify({ workspace, commands, stopOnError, timeoutMs });
}

export function commandDisplay(command: StructuredCommand): string {
  return [command.program, ...command.args].join(" ");
}

export function hasInlineSecret(command: StructuredCommand): boolean {
  const secretFlag = /^(?:--?|\/)(?:api[-_]?key|token|secret|password|passwd|pass|authorization|auth)(?:=|$)/iu;
  const assignment = /^[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*=/iu;
  return command.args.some((arg, index) => secretFlag.test(arg) || assignment.test(arg) || (index > 0 && secretFlag.test(command.args[index - 1] ?? "")));
}

export function assertNoInlineSecrets(commands: StructuredCommand[]): void {
  if (commands.some(hasInlineSecret)) {
    throw new Error("Inline credentials are not accepted in commands. Use environment variables or a project credential helper.");
  }
}
