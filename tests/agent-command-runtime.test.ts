import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      expect(result.policy.rule).toBe("safe-inspect");
      const workspaceInspect = await new AgentCommandRuntime({ home: setup.home, mode: "workspace" }).run(setup.entry, { command: "pwd" });
      expect(workspaceInspect.status).toBe("success");
      expect(workspaceInspect.policy.rule).toBe("workspace-inspect");
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
      await writeFile(path.join(setup.workspace, "trusted.js"), "process.stdout.write('trusted')\n");
      const command = { command: { program: "node", args: ["trusted.js"] } };
      expect((await workspaceRuntime.run(setup.entry, command)).status).toBe("approval_required");
      expect((await workspaceRuntime.run(setup.entry, command)).policy.rule).toBe("workspace-approval-required");
      await store.trust(setup.entry);
      const trustedResult = await workspaceRuntime.run(setup.entry, command);
      expect(trustedResult.status).toBe("success");
      expect(trustedResult.policy.rule).toBe("trusted-workspace-exec");

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

  it("keeps legacy and structured commands on the same validation, risk, and policy path", async () => {
    const setup = await setupWorkspace();
    try {
      const runtime = new AgentCommandRuntime({ home: setup.home, mode: "safe" });
      const compare = async (legacy: string, structured: { program: string; args: string[] }) => {
        const legacyResult = await runtime.run(setup.entry, { command: legacy });
        const structuredResult = await runtime.run(setup.entry, { command: structured });
        expect({
          status: legacyResult.status,
          risk: legacyResult.risk,
          policy: legacyResult.policy
        }).toEqual({
          status: structuredResult.status,
          risk: structuredResult.risk,
          policy: structuredResult.policy
        });
      };

      await compare("git push origin main", { program: "git", args: ["push", "origin", "main"] });
      await compare("rm -rf dist", { program: "rm", args: ["-rf", "dist"] });

      const unrestricted = new AgentCommandRuntime({ home: setup.home, mode: "unrestricted" });
      const hardDenied = async (legacy: string, structured: { program: string; args: string[] }) => {
        const legacyResult = await unrestricted.run(setup.entry, { command: legacy });
        const structuredResult = await unrestricted.run(setup.entry, { command: structured });
        expect(legacyResult).toMatchObject({ status: "denied", policy: { rule: "hard-deny" } });
        expect(structuredResult).toMatchObject({ status: "denied", policy: { rule: "hard-deny" } });
        expect(legacyResult.risk).toEqual(structuredResult.risk);
      };
      await hardDenied("rm -rf /", { program: "rm", args: ["-rf", "/"] });
      await hardDenied("rm -rf /*", { program: "rm", args: ["-rf", "/*"] });
      await hardDenied("rm -rf ~", { program: "rm", args: ["-rf", "~"] });
      await hardDenied("rm -rf ~/", { program: "rm", args: ["-rf", "~/"] });
      await hardDenied("shutdown now", { program: "shutdown", args: ["now"] });
      await hardDenied("reboot", { program: "reboot", args: [] });
      await hardDenied("mkfs /dev/disk0", { program: "mkfs", args: ["/dev/disk0"] });
      await hardDenied("dd if=/dev/zero of=/dev/disk0", { program: "dd", args: ["if=/dev/zero", "of=/dev/disk0"] });

      const rejected = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          await run();
          return "<unexpected success>";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const rejectedCommands: Array<[string, { program: string; args: string[] }]> = [
        ["rm -rf ../xxx", { program: "rm", args: ["-rf", "../xxx"] }],
        ["bash -c 'echo unsafe'", { program: "bash", args: ["-c", "echo unsafe"] }],
        ["sh --command 'echo unsafe'", { program: "sh", args: ["--command", "echo unsafe"] }],
        ["cat /etc/passwd", { program: "cat", args: ["/etc/passwd"] }]
      ];
      for (const [legacy, structured] of rejectedCommands) {
        const legacyError = await rejected(() => runtime.run(setup.entry, { command: legacy }));
        const structuredError = await rejected(() => runtime.run(setup.entry, { command: structured }));
        expect(legacyError).toBe(structuredError);
        expect(legacyError).not.toBe("<unexpected success>");
      }

      for (const command of [
        { program: "git", args: ["reset", "--hard"] },
        { program: "git", args: ["clean", "-fd"] }
      ]) {
        const risk = analyzeCommand(command);
        expect(risk.level).toBe("high");
        expect(risk.categories).toEqual(expect.arrayContaining(["workspace-write", "destructive"]));
      }
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });

  it("does not let project config widen policy and treats inline interpreters as high risk", async () => {
    const setup = await setupWorkspace();
    try {
      await mkdir(path.join(setup.workspace, ".coderelay"), { recursive: true });
      await writeFile(path.join(setup.workspace, ".coderelay", "config.json"), JSON.stringify({ commandPolicy: { mode: "unrestricted" } }));
      const store = new PolicyStore(setup.home);
      await store.trust(setup.entry);
      const inline = { command: { program: "node", args: ["-e", "process.stdout.write('inline')"] } };

      const safeResult = await new AgentCommandRuntime({ home: setup.home, mode: "safe" }).run(setup.entry, inline);
      expect(safeResult.status).toBe("approval_required");
      expect(safeResult.risk.level).toBe("high");

      const workspaceResult = await new AgentCommandRuntime({ home: setup.home, mode: "workspace" }).run(setup.entry, inline);
      expect(workspaceResult.status).toBe("approval_required");
      expect(workspaceResult.policy.rule).toBe("workspace-approval-required");

      for (const command of [
        { program: "node", args: ["--eval", "1 + 1"] },
        { program: "python", args: ["-c", "print(1)"] },
        { program: "ruby", args: ["-e", "puts 1"] },
        { program: "perl", args: ["-e", "print 1"] }
      ]) {
        const risk = analyzeCommand(command);
        expect(risk.level).toBe("high");
        expect(risk.categories).toContain("workspace-exec");
      }

      expect(analyzeCommand({ program: "node", args: ["trusted.js"] }).level).toBe("medium");
    } finally {
      await rm(setup.home, { recursive: true, force: true });
      await rm(setup.workspace, { recursive: true, force: true });
    }
  });

  it("requires exact workspace approval rules and checks hard-deny first", async () => {
    const setup = await setupWorkspace();
    try {
      const store = new PolicyStore(setup.home);
      const policy = new PolicyEngine(store);
      const evaluate = (command: { program: string; args: string[] }, mode: "safe" | "unrestricted" = "safe") =>
        policy.evaluate(setup.entry, [command], [analyzeCommand(command)], mode, true, false);

      const approvedPush = { program: "git", args: ["push", "origin", "main"] };
      expect((await evaluate(approvedPush)).decision).toBe("approval_required");
      await store.addWorkspaceRule(setup.entry, [approvedPush]);
      expect((await evaluate(approvedPush)).decision).toBe("allow");

      const forcePush = { program: "git", args: ["push", "origin", "main", "--force"] };
      expect((await evaluate(forcePush)).decision).toBe("approval_required");

      const approvedCurl = { program: "curl", args: ["https://example.com"] };
      await store.addWorkspaceRule(setup.entry, [approvedCurl]);
      const curlWithData = { program: "curl", args: ["https://example.com", "--data", "payload"] };
      expect((await evaluate(curlWithData)).decision).toBe("approval_required");

      const approvedNpm = { program: "npm", args: ["test"] };
      await store.addWorkspaceRule(setup.entry, [approvedNpm]);
      const npmWithExtraArgs = { program: "npm", args: ["test", "--", "--runInBand"] };
      expect((await evaluate(npmWithExtraArgs)).decision).toBe("approval_required");

      const hardDenied = { program: "rm", args: ["-rf", "/"] };
      await store.addWorkspaceRule(setup.entry, [hardDenied]);
      const hardDecision = await evaluate(hardDenied, "unrestricted");
      expect(hardDecision.decision).toBe("deny");
      expect(hardDecision.rule).toBe("hard-deny");

      const rules = await store.listRules();
      expect(rules.find((rule) => rule.program === "git" && rule.args.join(" ") === "push origin main")).toMatchObject({
        args: ["push", "origin", "main"],
        match: "exact"
      });
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
      await writeFile(path.join(setup.workspace, "first.js"), "process.stdout.write('first')\n");
      await writeFile(path.join(setup.workspace, "fail.js"), "process.exit(3)\n");
      await writeFile(path.join(setup.workspace, "should-not-run.js"), "process.stdout.write('should-not-run')\n");
      await writeFile(path.join(setup.workspace, "timeout.js"), "setTimeout(() => {}, 5000)\n");
      await writeFile(path.join(setup.workspace, "output.js"), "process.stdout.write('x'.repeat(10000))\n");
      const sequence = await runtime.run(setup.entry, {
        commands: [
          { program: "node", args: ["first.js"] },
          { program: "node", args: ["fail.js"] },
          { program: "node", args: ["should-not-run.js"] }
        ],
        stopOnError: true
      });
      expect(sequence.status).toBe("success");
      expect(sequence.stopped_on_error).toBe(true);
      expect(sequence.results).toHaveLength(2);
      expect(sequence.results?.[1]?.exit_code).toBe(3);

      const timeout = await runtime.run(setup.entry, {
        command: { program: "node", args: ["timeout.js"] },
        timeoutMs: 1_000
      });
      expect(timeout.status).toBe("success");
      expect(timeout.execution?.timed_out).toBe(true);

      const output = await runtime.run(setup.entry, {
        command: { program: "node", args: ["output.js"] }
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
        policy: { mode: "safe", decision: "deny", rule: "safe-approval-required" },
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
