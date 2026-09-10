import type { RegisteredWorkspace } from "../workspace/registry.js";
import { validateCommand, validateStructuredCommand, type ParsedCommand } from "../mcp/command-security.js";
import { parseCommandRequest } from "./parser.js";
import { assertNoInlineSecrets, commandFingerprint, commandDisplay, type CommandPolicyMode, type CommandRequestInput, type NormalizedCommandRequest, type StructuredCommand } from "./model.js";
import { aggregateRisk, analyzeCommand, type RiskAssessment } from "../risk/analyzer.js";
import { ApprovalManager, riskForApproval, type ApprovalRequest } from "../approval/manager.js";
import { AuditLogger, type AuditRecord } from "../audit/logger.js";
import { PolicyEngine, type PolicyEvaluation } from "../policy/engine.js";
import { PolicyStore } from "../policy/store.js";
import { runSequential, type ExecutionResult } from "../executor/runner.js";
import { readWorkspaceConfig } from "../runtime/state.js";

export interface AgentCommandResult {
  status: "success" | "approval_required" | "denied";
  workspace: string;
  command?: StructuredCommand;
  commands?: StructuredCommand[];
  stop_on_error?: boolean;
  stopped_on_error?: boolean;
  risk: {
    level: string;
    categories: string[];
    reasons: string[];
  };
  policy: {
    mode: CommandPolicyMode;
    decision: string;
    rule: string;
  };
  approval: {
    required: boolean;
    source: string;
    request_id?: string;
    scope_options?: ["once", "workspace"];
  };
  execution?: {
    exit_code: number | null;
    signal: string | null;
    duration_ms: number;
    timed_out: boolean;
  };
  output?: {
    stdout: string;
    stderr: string;
    truncated: boolean;
  };
  results?: Array<ExecutionResult & { command: StructuredCommand }>;
}

export interface AgentCommandRuntimeOptions {
  home: string;
  mode?: CommandPolicyMode;
  maxOutputBytes?: number;
}

function policyShape(evaluation: PolicyEvaluation): AgentCommandResult["policy"] {
  return { mode: evaluation.mode, decision: evaluation.decision, rule: evaluation.rule };
}

function riskShape(assessment: ReturnType<typeof aggregateRisk>): AgentCommandResult["risk"] {
  return {
    level: assessment.level,
    categories: assessment.categories,
    reasons: assessment.reasons
  };
}

function commandShape(normalized: NormalizedCommandRequest): Pick<AgentCommandResult, "command" | "commands" | "stop_on_error"> {
  return normalized.commands.length === 1
    ? { command: normalized.commands[0], stop_on_error: normalized.stopOnError }
    : { commands: normalized.commands, stop_on_error: normalized.stopOnError };
}

export class AgentCommandRuntime {
  readonly policyStore: PolicyStore;
  readonly approvals: ApprovalManager;
  readonly audit: AuditLogger;
  readonly policy: PolicyEngine;

  constructor(private readonly options: AgentCommandRuntimeOptions) {
    this.policyStore = new PolicyStore(options.home);
    this.approvals = new ApprovalManager(options.home);
    this.audit = new AuditLogger(options.home);
    this.policy = new PolicyEngine(this.policyStore);
  }

  async run(workspace: RegisteredWorkspace, input: CommandRequestInput): Promise<AgentCommandResult> {
    let normalized: NormalizedCommandRequest | undefined;
    try {
      normalized = parseCommandRequest(input);
      assertNoInlineSecrets(normalized.commands);
      const assessments = normalized.commands.map(analyzeCommand);
      const aggregate = aggregateRisk(assessments);
      const projectConfig = await readWorkspaceConfig(workspace.root);
      const mode = projectConfig?.commandPolicy?.mode ?? this.options.mode ?? "safe";
      const trusted = await this.policyStore.isTrusted(workspace);
      const fingerprint = commandFingerprint(normalized.commands, workspace.id, normalized.stopOnError, normalized.timeoutMs);
      const approvedOnce = await this.approvals.hasApprovedOnce(fingerprint);
      const evaluation = await this.policy.evaluate(workspace, normalized.commands, assessments, mode, trusted, approvedOnce);
      const base = {
        workspace: workspace.name,
        ...commandShape(normalized),
        risk: riskShape(aggregate),
        policy: policyShape(evaluation)
      };

      if (evaluation.decision === "deny") {
        const result: AgentCommandResult = {
          status: "denied",
          ...base,
          approval: { required: false, source: evaluation.approvalSource }
        };
        await this.recordDecision(workspace.name, normalized, aggregate, evaluation, result.approval);
        return result;
      }

      if (evaluation.decision === "approval_required") {
        const request = await this.approvals.create({
          workspace: workspace.id,
          commands: normalized.commands,
          stopOnError: normalized.stopOnError,
          timeoutMs: normalized.timeoutMs,
          risk: riskForApproval(assessments),
          mode
        });
        const approval = { required: true, source: "none", request_id: request.request_id, scope_options: ["once", "workspace"] as ["once", "workspace"] };
        const result: AgentCommandResult = { status: "approval_required", ...base, approval };
        await this.recordDecision(workspace.name, normalized, aggregate, evaluation, approval);
        return result;
      }

      if (approvedOnce) await this.approvals.consumeApprovedOnce(fingerprint);
      const parsed = this.validateCommands(normalized, workspace.root);
      const execution = await runSequential(workspace.root, parsed, normalized.timeoutMs, normalized.stopOnError, this.options.maxOutputBytes ?? 100_000);
      const result = this.successResult(workspace.name, normalized, aggregate, evaluation, execution.results, execution.stopped_on_error);
      await this.recordExecution(workspace.name, normalized, aggregate, evaluation, execution.results, result.approval);
      return result;
    } catch (error) {
      if (normalized) {
        const aggregate = aggregateRisk(normalized.commands.map(analyzeCommand));
        const evaluation: PolicyEvaluation = {
          mode: this.options.mode ?? "safe",
          decision: "deny",
          rule: "command-validation",
          approvalRequired: false,
          approvalSource: "policy"
        };
        await this.recordDecision(workspace.name, normalized, aggregate, evaluation, { required: false, source: "policy" });
      }
      throw error;
    }
  }

  private validateCommands(normalized: NormalizedCommandRequest, workspaceRoot: string): ParsedCommand[] {
    if (normalized.legacy) {
      const first = normalized.commands[0];
      return [validateCommand(normalized.legacyCommand ?? commandDisplay(first), workspaceRoot)];
    }
    return normalized.commands.map((command) => validateStructuredCommand(command, workspaceRoot));
  }

  private successResult(
    workspace: string,
    normalized: NormalizedCommandRequest,
    aggregate: ReturnType<typeof aggregateRisk>,
    evaluation: PolicyEvaluation,
    executions: ExecutionResult[],
    stoppedOnError: boolean
  ): AgentCommandResult {
    const base = {
      workspace,
      ...commandShape(normalized),
      risk: riskShape(aggregate),
      policy: policyShape(evaluation),
      approval: { required: false, source: evaluation.approvalSource }
    };
    if (executions.length === 1 && normalized.commands.length === 1) {
      const execution = executions[0];
      return {
        status: "success",
        ...base,
        execution: {
          exit_code: execution.exit_code,
          signal: execution.signal,
          duration_ms: execution.duration_ms,
          timed_out: execution.timed_out
        },
        output: { stdout: execution.stdout, stderr: execution.stderr, truncated: execution.truncated }
      };
    }
    return {
      status: "success",
      ...base,
      stopped_on_error: stoppedOnError,
      results: executions.map((execution, index) => ({ ...execution, command: normalized.commands[index] }))
    };
  }

  private async recordDecision(
    workspace: string,
    normalized: NormalizedCommandRequest,
    aggregate: ReturnType<typeof aggregateRisk>,
    evaluation: PolicyEvaluation,
    approval: AgentCommandResult["approval"]
  ): Promise<void> {
    await this.audit.append({
      timestamp: new Date().toISOString(),
      workspace,
      ...commandAuditShape(normalized),
      risk: riskShape(aggregate),
      policy: policyShape(evaluation),
      approval: {
        required: approval.required,
        source: approval.source,
        ...(approval.request_id ? { request_id: approval.request_id } : {})
      }
    });
  }

  private async recordExecution(
    workspace: string,
    normalized: NormalizedCommandRequest,
    aggregate: ReturnType<typeof aggregateRisk>,
    evaluation: PolicyEvaluation,
    executions: ExecutionResult[],
    approval: AgentCommandResult["approval"]
  ): Promise<void> {
    const duration = executions.reduce((sum, execution) => sum + execution.duration_ms, 0);
    const last = executions[executions.length - 1];
    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      workspace,
      ...commandAuditShape(normalized),
      risk: riskShape(aggregate),
      policy: policyShape(evaluation),
      approval: {
        required: approval.required,
        source: approval.source,
        ...(approval.request_id ? { request_id: approval.request_id } : {})
      },
      execution: {
        exit_code: last?.exit_code ?? null,
        signal: last?.signal ?? null,
        duration_ms: duration,
        timed_out: executions.some((execution) => execution.timed_out),
        command_count: executions.length
      }
    };
    await this.audit.append(record);
  }
}

function commandAuditShape(normalized: NormalizedCommandRequest): Pick<AuditRecord, "command" | "commands"> {
  return normalized.commands.length === 1
    ? { command: normalized.commands[0] }
    : { commands: normalized.commands };
}
