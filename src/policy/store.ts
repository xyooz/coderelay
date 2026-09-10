import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { RegisteredWorkspace } from "../workspace/registry.js";
import type { StructuredCommand } from "../command/model.js";
import { assertNoInlineSecrets, commandFingerprint } from "../command/model.js";

export interface PolicyRule {
  id: string;
  workspace: string;
  program: string;
  args: string[];
  match: "exact";
  decision: "allow";
  scope: "workspace";
  createdAt: string;
}

interface PolicyFile {
  version: 1;
  trustedWorkspaces: string[];
  rules: PolicyRule[];
}

export function policyDirectory(home: string): string {
  return path.join(home, "policies");
}

export function policyFilePath(home: string): string {
  return path.join(policyDirectory(home), "policies.json");
}

function emptyPolicyFile(): PolicyFile {
  return { version: 1, trustedWorkspaces: [], rules: [] };
}

function normalizeRule(raw: unknown): PolicyRule | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<PolicyRule> & { argsPrefix?: unknown; match?: unknown };
  if (typeof value.id !== "string" || typeof value.workspace !== "string" || typeof value.program !== "string") return null;

  // Older policy files used argsPrefix. Read it for compatibility, but always
  // normalize the in-memory and rewritten rule to exact argument matching.
  const args = Array.isArray(value.args)
    ? value.args
    : Array.isArray(value.argsPrefix)
      ? value.argsPrefix
      : null;
  if (!args || args.some((argument) => typeof argument !== "string")) return null;
  return {
    id: value.id,
    workspace: value.workspace,
    program: value.program,
    args: [...args],
    match: "exact",
    decision: "allow",
    scope: "workspace",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString()
  };
}

function normalizePolicyFile(raw: unknown): PolicyFile {
  if (!raw || typeof raw !== "object") return emptyPolicyFile();
  const value = raw as Partial<PolicyFile>;
  const trustedWorkspaces = Array.isArray(value.trustedWorkspaces)
    ? value.trustedWorkspaces.filter((entry): entry is string => typeof entry === "string")
    : [];
  const rules = Array.isArray(value.rules)
    ? value.rules.map(normalizeRule).filter((rule): rule is PolicyRule => Boolean(rule))
    : [];
  return { version: 1, trustedWorkspaces: [...new Set(trustedWorkspaces)], rules };
}

export class PolicyStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(readonly home: string) {
    this.directory = policyDirectory(home);
    this.filePath = policyFilePath(home);
  }

  async read(): Promise<PolicyFile> {
    try {
      return normalizePolicyFile(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch {
      return emptyPolicyFile();
    }
  }

  async listRules(): Promise<PolicyRule[]> {
    return (await this.read()).rules;
  }

  async isTrusted(workspace: RegisteredWorkspace): Promise<boolean> {
    const data = await this.read();
    return data.trustedWorkspaces.includes(workspace.id) || data.trustedWorkspaces.includes(workspace.name);
  }

  async trust(workspace: RegisteredWorkspace): Promise<void> {
    const data = await this.read();
    if (!data.trustedWorkspaces.includes(workspace.id)) data.trustedWorkspaces.push(workspace.id);
    await this.write(data);
  }

  async untrust(workspace: RegisteredWorkspace): Promise<void> {
    const data = await this.read();
    data.trustedWorkspaces = data.trustedWorkspaces.filter((entry) => entry !== workspace.id && entry !== workspace.name);
    await this.write(data);
  }

  async addWorkspaceRule(workspace: RegisteredWorkspace, commands: StructuredCommand[]): Promise<PolicyRule[]> {
    assertNoInlineSecrets(commands);
    const data = await this.read();
    const created: PolicyRule[] = [];
    for (const command of commands) {
      const duplicate = data.rules.find((rule) => rule.workspace === workspace.id && rule.program === command.program && sameArgs(rule.args, command.args));
      if (duplicate) {
        created.push(duplicate);
        continue;
      }
      const rule: PolicyRule = {
        id: `pol_${randomBytes(10).toString("hex")}`,
        workspace: workspace.id,
        program: command.program,
        args: [...command.args],
        match: "exact",
        decision: "allow",
        scope: "workspace",
        createdAt: new Date().toISOString()
      };
      data.rules.push(rule);
      created.push(rule);
    }
    await this.write(data);
    return created;
  }

  async removeRule(id: string): Promise<PolicyRule | null> {
    const data = await this.read();
    const rule = data.rules.find((candidate) => candidate.id === id) ?? null;
    if (!rule) return null;
    data.rules = data.rules.filter((candidate) => candidate.id !== id);
    await this.write(data);
    return rule;
  }

  async findMatchingRule(workspace: RegisteredWorkspace, command: StructuredCommand): Promise<PolicyRule | null> {
    const data = await this.read();
    return data.rules.find((rule) =>
      (rule.workspace === workspace.id || rule.workspace === workspace.name)
      && rule.program === command.program
      && sameArgs(rule.args, command.args)
    ) ?? null;
  }

  private async write(data: PolicyFile): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700).catch(() => undefined);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }
}

function sameArgs(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((argument, index) => argument === actual[index]);
}

export function policyRuleFingerprint(rule: PolicyRule): string {
  return commandFingerprint([{ program: rule.program, args: rule.args }], rule.workspace, true, 0);
}
