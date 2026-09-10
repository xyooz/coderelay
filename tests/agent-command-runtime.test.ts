import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCommandRuntime } from "../src/command/runtime.js";
import { parseCommandRequest } from "../src/command/parser.js";
import { ApprovalManager } from "../src/approval/manager.js";
import { AuditLogger } from "../src/audit/logger.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { PolicyStore } from "../src/policy/store.js";
import { analyzeCommand } from "../src/risk/analyzer.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

async function setupWorkspace(): Promise<{ home: string; workspace: string; registry: WorkspaceRegistry; entry: Awaited<ReturnType<WorkspaceRegistry["add"]>> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "coderelay-command-runtime-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-command-runtime-workspace-"));
  const registry = new WorkspaceRegistry(home);
  const entry = await registry.add(workspace, "project-a");
  return { home, workspace, registry, entry };
}

describe("Agent Command Runtime", () => {
  it("auto-allows inspect commands and keeps legacy strings shell-free", async () => {
    const setup = await setupWorkspace();
    try {
      const runtime = new AgentCommandRuntime({ home: setup.home, mode: "safe" });
      const result = await runtime.run(setup.entry, { command: "pwd" });
      expect(result.status).toBe("success");
      expect(result.risk.level).toBe("low");
      expect(result.risk.categories).toContain("inspect");
      expect(result.execution?.exit_code).toBe(0);
      await expect(runtime.run(setup.entry, { command: "pwd && ls" })).rejects.toThrow("Shell operators");
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });

  it("requires real local approval, then supports once and workspace scopes", async () => {
    const setup = await setupWorkspace();
    try {
      const runtime = new AgentCommandRuntime({ home: setup.home, mode: "safe" });
      const input = { command: { program: "node", args: ["-e", "process.stdout.write('approved')"] } };
      const pending = await runtime.run(setup.entry, input);
      expect(pending.status).toBe("approval_required");
      expect(pending.approval.request_id).toMatch(/^apr_/u);

      const approvals = new ApprovalManager(setup.home);
      await approvals.approveOnce(pending.approval.request_id!);
      const once = await runtime.run(setup.entry, input);
      expect(once.status).toBe("success");
      expect(once.approval.source).toBe("user");
      expect(once.output?.stdout).toBe("approved");

      const secondPending = await runtime.run(setup.entry, input);
      expect(secondPending.status).toBe("approval_required");
      const policyStore = new PolicyStore(setup.home);
      await policyStore.addWorkspaceRule(setup.entry, (await approvals.get(secondPending.approval.request_id!))!.commands);
      await approvals.remove(secondPending.approval.request_id!);
      const workspaceApproval = await runtime.run(setup.entry, input);
      expect(workspaceApproval.status).toBe("success");
      expect(workspaceApproval.approval.source).toBe("policy");

      const policyStats = await stat(policyStore.filePath);
      expect(policyStats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });

  it("applies trust, classifies network writes, and preserves hard deny", async () => {
    const setup = await setupWorkspace();
    try {
      const store = new PolicyStore(setup.home);
      const workspaceRuntime = new AgentCommandRuntime({ home: setup.home, mode: "workspace" });
      const command = { command: { program: "node", args: ["-e", "process.stdout.write('trusted')"] } };
      expect((await workspaceRuntime.run(setup.entry, command)).status).toBe("approval_required");
      await store.trust(setup.entry);
      expect((await workspaceRuntime.run(setup.entry, command)).status).toBe("success");

      const pushRisk = analyzeCommand({ program: "git", args: ["push"] });
      expect(pushRisk.categories).toEqual(expect.arrayContaining(["network", "external-write"]));
      const policy = new PolicyEngine(store);
      const pushDecision = await policy.evaluate(setup.entry, [{ program: "git", args: ["push"] }], [pushRisk], "unrestricted", true, false);
      expect(pushDecision.decision).toBe("allow");

      const hardDenied = await new AgentCommandRuntime({ home: setup.home, mode: "unrestricted" }).run(setup.entry, {
        command: { program: "rm", args: ["-rf", "/"] }
      });
      expect(hardDenied.status).toBe("denied");
      expect(hardDenied.policy.rule).toBe("hard-deny");
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });

  it("runs structured sequences, stops on failure, handles timeout, and truncates output", async () => {
    const setup = await setupWorkspace();
    try {
      const runtime = new AgentCommandRuntime({ home: setup.home, mode: "workspace", maxOutputBytes: 128 });
      const store = new PolicyStore(setup.home);
      await store.trust(setup.entry);
      const sequence = await runtime.run(setup.entry, {
        commands: [
          { program: "node", args: ["-e", "process.stdout.write('first')"] },
          { program: "node", args: ["-e", "process.exit(3)"] },
          { program: "node", args: ["-e", "process.stdout.write('should-not-run')"] }
        ],
        stopOnError: true
      });
      expect(sequence.status).toBe("success");
      expect(sequence.stopped_on_error).toBe(true);
      expect(sequence.results).toHaveLength(2);
      expect(sequence.results?.[1]?.exit_code).toBe(3);

      const timeout = await runtime.run(setup.entry, {
        command: { program: "node", args: ["-e", "setTimeout(() => {}, 5000)"] },
        timeoutMs: 1_000
      });
      expect(timeout.status).toBe("success");
      expect(timeout.execution?.timed_out).toBe(true);

      const output = await runtime.run(setup.entry, {
        command: { program: "node", args: ["-e", "process.stdout.write('x'.repeat(10000))"] }
      });
      expect(output.output?.truncated).toBe(true);
      expect(Buffer.byteLength(output.output?.stdout ?? "", "utf8")).toBeLessThanOrEqual(128);
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });

  it("persists policy and approval state atomically without putting inline secrets in audit", async () => {
    const setup = await setupWorkspace();
    try {
      const store = new PolicyStore(setup.home);
      await expect(store.addWorkspaceRule(setup.entry, [{ program: "curl", args: ["--token", "secret-api-key"] }])).rejects.toThrow("Inline credentials");
      const audit = new AuditLogger(setup.home);
      await audit.append({
        timestamp: new Date().toISOString(),
        workspace: setup.entry.name,
        command: { program: "curl", args: ["--token", "secret-api-key", "API_KEY=another-secret"] },
        risk: { level: "high", categories: ["network"], reasons: ["network"] },
        policy: { mode: "safe", decision: "deny", rule: "safe-mode" },
        approval: { required: false, source: "policy" }
      });
      const auditText = await readFile(audit.filePath, "utf8");
      expect(auditText).not.toContain("secret-api-key");
      expect(auditText).not.toContain("another-secret");
      expect(auditText).toContain("<redacted>");
      expect((await stat(audit.filePath)).mode & 0o777).toBe(0o600);
      expect(parseCommandRequest({ command: { program: "node", args: [] } }).commands).toEqual([{ program: "node", args: [] }]);
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });
});

