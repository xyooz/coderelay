import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandPolicyMode, StructuredCommand } from "../command/model.js";
import { assertNoInlineSecrets, commandFingerprint } from "../command/model.js";
import type { RiskAssessment, RiskLevel, RiskCategory } from "../risk/analyzer.js";
import type { RegisteredWorkspace } from "../workspace/registry.js";

export interface ApprovalRisk {
  level: RiskLevel;
  categories: RiskCategory[];
  reasons: string[];
  hardDeny: boolean;
}

export interface ApprovalRequest {
  request_id: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  workspace: string;
  commands: StructuredCommand[];
  stop_on_error: boolean;
  timeout_ms: number;
  risk: ApprovalRisk;
  mode: CommandPolicyMode;
  approved_once?: boolean;
  approved_at?: string;
}

interface ApprovalFile {
  version: 1;
  requests: ApprovalRequest[];
}

export function approvalFilePath(home: string): string {
  return path.join(home, "policies", "approvals.json");
}

function isFresh(request: ApprovalRequest): boolean {
  return Date.parse(request.expires_at) > Date.now();
}

function emptyFile(): ApprovalFile {
  return { version: 1, requests: [] };
}

export class ApprovalManager {
  readonly filePath: string;

  constructor(readonly home: string, private readonly ttlMs = 15 * 60 * 1_000) {
    this.filePath = approvalFilePath(home);
  }

  async list(): Promise<ApprovalRequest[]> {
    const file = await this.read();
    const fresh = file.requests.filter(isFresh);
    if (fresh.length !== file.requests.length) await this.write({ version: 1, requests: fresh });
    return fresh;
  }

  async get(requestId: string): Promise<ApprovalRequest | null> {
    return (await this.list()).find((request) => request.request_id === requestId) ?? null;
  }

  async create(input: {
    workspace: string;
    commands: StructuredCommand[];
    stopOnError: boolean;
    timeoutMs: number;
    risk: ApprovalRisk;
    mode: CommandPolicyMode;
  }): Promise<ApprovalRequest> {
    assertNoInlineSecrets(input.commands);
    const fingerprint = commandFingerprint(input.commands, input.workspace, input.stopOnError, input.timeoutMs);
    const existing = (await this.list()).find((request) => request.fingerprint === fingerprint && !request.approved_once);
    if (existing) return existing;

    const now = new Date();
    const request: ApprovalRequest = {
      request_id: `apr_${randomBytes(10).toString("hex")}`,
      fingerprint,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
      workspace: input.workspace,
      commands: input.commands.map((command) => ({ program: command.program, args: [...command.args] })),
      stop_on_error: input.stopOnError,
      timeout_ms: input.timeoutMs,
      risk: input.risk,
      mode: input.mode
    };
    const file = await this.read();
    file.requests = file.requests.filter(isFresh);
    file.requests.push(request);
    await this.write(file);
    return request;
  }

  async approveOnce(requestId: string): Promise<ApprovalRequest> {
    const file = await this.read();
    const request = file.requests.find((candidate) => candidate.request_id === requestId && isFresh(candidate));
    if (!request) throw new Error(`Approval request not found or expired: ${requestId}`);
    request.approved_once = true;
    request.approved_at = new Date().toISOString();
    await this.write(file);
    return request;
  }

  async hasApprovedOnce(fingerprint: string): Promise<boolean> {
    return (await this.list()).some((request) => request.fingerprint === fingerprint && request.approved_once === true && isFresh(request));
  }

  async consumeApprovedOnce(fingerprint: string): Promise<ApprovalRequest | null> {
    const file = await this.read();
    const index = file.requests.findIndex((request) => request.fingerprint === fingerprint && request.approved_once && isFresh(request));
    if (index < 0) return null;
    const [request] = file.requests.splice(index, 1);
    await this.write(file);
    return request ?? null;
  }

  /** Remove every pending approval that belongs to one workspace. */
  async removeWorkspace(workspace: RegisteredWorkspace): Promise<number> {
    const file = await this.read();
    const identifiers = new Set([workspace.id, workspace.name]);
    const remaining = file.requests.filter((request) => !identifiers.has(request.workspace));
    const removed = file.requests.length - remaining.length;
    if (removed > 0) await this.write({ version: 1, requests: remaining });
    return removed;
  }

  async remove(requestId: string): Promise<ApprovalRequest | null> {
    const file = await this.read();
    const index = file.requests.findIndex((request) => request.request_id === requestId);
    if (index < 0) return null;
    const [removed] = file.requests.splice(index, 1);
    await this.write(file);
    return removed ?? null;
  }

  private async read(): Promise<ApprovalFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<ApprovalFile>;
      return {
        version: 1,
        requests: Array.isArray(raw.requests) ? raw.requests.filter((request): request is ApprovalRequest => Boolean(request && typeof request === "object" && typeof (request as ApprovalRequest).request_id === "string")) : []
      };
    } catch {
      return emptyFile();
    }
  }

  private async write(file: ApprovalFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => undefined);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}

export function riskForApproval(assessments: RiskAssessment[]): ApprovalRisk {
  const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const level = assessments.reduce((current, assessment) => order[assessment.level] > order[current] ? assessment.level : current, "low" as RiskLevel);
  return {
    level,
    categories: [...new Set(assessments.flatMap((assessment) => assessment.categories))],
    reasons: [...new Set(assessments.flatMap((assessment) => assessment.reasons))],
    hardDeny: assessments.some((assessment) => assessment.hardDeny)
  };
}
