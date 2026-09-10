import type { RegisteredWorkspace } from "../workspace/registry.js";
import type { CommandPolicyMode, StructuredCommand } from "../command/model.js";
import type { RiskAssessment } from "../risk/analyzer.js";
import { PolicyStore, type PolicyRule } from "./store.js";

export type PolicyDecision = "allow" | "approval_required" | "deny";

export interface PolicyEvaluation {
  mode: CommandPolicyMode;
  decision: PolicyDecision;
  rule: string;
  approvalRequired: boolean;
  approvalSource: "policy" | "user" | "none";
}

const SAFE_CATEGORIES = new Set(["inspect"]);
const TRUSTED_CATEGORIES = new Set(["inspect", "workspace-write", "workspace-exec"]);

function categoriesAllowed(categories: string[], allowed: Set<string>): boolean {
  return categories.every((category) => allowed.has(category));
}

export class PolicyEngine {
  constructor(private readonly store: PolicyStore) {}

  async evaluate(
    workspace: RegisteredWorkspace,
    commands: StructuredCommand[],
    assessments: RiskAssessment[],
    mode: CommandPolicyMode,
    trusted: boolean,
    approvedOnce: boolean
  ): Promise<PolicyEvaluation> {
    if (assessments.some((assessment) => assessment.hardDeny)) {
      return { mode, decision: "deny", rule: "hard-deny", approvalRequired: false, approvalSource: "policy" };
    }

    const rules = await Promise.all(commands.map((command) => this.store.findMatchingRule(workspace, command)));
    if (rules.every(Boolean)) {
      return { mode, decision: "allow", rule: "workspace-rule", approvalRequired: false, approvalSource: "policy" };
    }
    if (approvedOnce) {
      return { mode, decision: "allow", rule: "user-approved-once", approvalRequired: false, approvalSource: "user" };
    }

    const requiresApproval = assessments.some((assessment) => {
      if (mode === "safe") return !categoriesAllowed(assessment.categories, SAFE_CATEGORIES);
      if (mode === "workspace") {
        const highRisk = assessment.level === "high" || assessment.level === "critical";
        return trusted
          ? highRisk || !categoriesAllowed(assessment.categories, TRUSTED_CATEGORIES)
          : !categoriesAllowed(assessment.categories, SAFE_CATEGORIES);
      }
      return false;
    });
    if (requiresApproval) {
      return {
        mode,
        decision: "approval_required",
        rule: mode === "safe" ? "safe-mode" : mode === "workspace" && !trusted ? "untrusted-workspace" : "sensitive-operation",
        approvalRequired: true,
        approvalSource: "none"
      };
    }
    return {
      mode,
      decision: "allow",
      rule: mode === "unrestricted" ? "unrestricted-mode" : "trusted-workspace-exec",
      approvalRequired: false,
      approvalSource: "policy"
    };
  }

  async listRules(): Promise<PolicyRule[]> {
    return await this.store.listRules();
  }
}
