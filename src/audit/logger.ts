import fs from "node:fs/promises";
import path from "node:path";
import type { StructuredCommand } from "../command/model.js";

export interface AuditRecord {
  timestamp: string;
  workspace: string;
  command?: StructuredCommand;
  commands?: StructuredCommand[];
  risk: {
    level: string;
    categories: string[];
    reasons: string[];
  };
  policy: {
    mode: string;
    decision: string;
    rule: string;
  };
  approval: {
    required: boolean;
    source: string;
    request_id?: string;
  };
  execution?: {
    exit_code: number | null;
    signal: string | null;
    duration_ms: number;
    timed_out: boolean;
    command_count?: number;
  };
}

export function auditLogPath(home: string): string {
  return path.join(home, "audit.log");
}

function looksLikeSecretFlag(value: string): boolean {
  return /^(?:--?|\/)(?:api[-_]?key|token|secret|password|passwd|pass|authorization|auth)(?:=|$)/iu.test(value);
}

function redactCommand(command: StructuredCommand): StructuredCommand {
  let redactNext = false;
  const args = command.args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    if (looksLikeSecretFlag(argument)) {
      if (!argument.includes("=")) redactNext = true;
      return argument.includes("=") ? `${argument.slice(0, argument.indexOf("="))}=<redacted>` : argument;
    }
    if (/^[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*=/iu.test(argument)) {
      return `${argument.slice(0, argument.indexOf("="))}=<redacted>`;
    }
    return argument;
  });
  return { program: command.program, args };
}

export function sanitizeAuditRecord(record: AuditRecord): AuditRecord {
  return {
    ...record,
    command: record.command ? redactCommand(record.command) : undefined,
    commands: record.commands?.map(redactCommand)
  };
}

export class AuditLogger {
  readonly filePath: string;

  constructor(readonly home: string) {
    this.filePath = auditLogPath(home);
  }

  async append(record: AuditRecord): Promise<void> {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.chmod(this.home, 0o700).catch(() => undefined);
    const safe = sanitizeAuditRecord(record);
    await fs.appendFile(this.filePath, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    await fs.chmod(this.filePath, 0o600);
  }
}

