import { parseCommand } from "../mcp/command-security.js";
import {
  normalizeCommandRequest,
  type CommandRequestInput,
  type NormalizedCommandRequest
} from "./model.js";

export function parseCommandRequest(input: CommandRequestInput): NormalizedCommandRequest {
  if ((input.command === undefined) === (input.commands === undefined)) {
    throw new Error("Provide exactly one of command or commands.");
  }
  if (typeof input.command === "string") {
    const parsed = parseCommand(input.command);
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error("timeoutMs must be an integer between 1000 and 120000.");
    }
    return {
      commands: [{ program: parsed.executable, args: parsed.args }],
      stopOnError: input.stopOnError ?? true,
      timeoutMs,
      legacy: true,
      legacyCommand: input.command
    };
  }
  return normalizeCommandRequest(input);
}
