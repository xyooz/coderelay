import { mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/approval/manager.js";
import { WorkspaceSessionManager } from "../src/mcp/session.js";
import { PolicyStore } from "../src/policy/store.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

async function setup(): Promise<{ home: string; workspace: string; registry: WorkspaceRegistry; entry: Awaited<ReturnType<WorkspaceRegistry["add"]>> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "coderelay-workspace-management-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "coderelay-workspace-management-root-"));
  const registry = new WorkspaceRegistry(home);
  const entry = await registry.add(workspace, "project-a");
  return { home, workspace, registry, entry };
}

describe("workspace management", () => {
  it("does not register the same canonical root twice", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "coderelay-workspace-management-home-"));
    const parent = await mkdtemp(path.join(os.tmpdir(), "coderelay-workspace-management-parent-"));
    const workspace = path.join(parent, "project");
    const alias = path.join(parent, "alias");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
      await symlink(workspace, alias);
      const registry = new WorkspaceRegistry(home);
      const first = await registry.add(workspace, "project-a");
      const duplicate = await registry.add(alias);
      expect(duplicate.id).toBe(first.id);
      expect(await registry.list()).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("revokes trust, rules, and approvals before a re-registration can reuse the name", async () => {
    const setupState = await setup();
    try {
      const policy = new PolicyStore(setupState.home);
      await policy.trust(setupState.entry);
      await policy.addWorkspaceRule(setupState.entry, [{ program: "git", args: ["push", "origin", "main"] }]);

      const approvals = new ApprovalManager(setupState.home);
      await approvals.create({
        workspace: setupState.entry.id,
        commands: [{ program: "rm", args: ["-rf", "dist"] }],
        stopOnError: true,
        timeoutMs: 30_000,
        risk: { level: "high", categories: ["destructive"], reasons: ["test"], hardDeny: false },
        mode: "safe"
      });

      const policyCleanup = await policy.removeWorkspace(setupState.entry);
      const approvalsRemoved = await approvals.removeWorkspace(setupState.entry);
      expect(policyCleanup).toEqual({ trustRemoved: true, rulesRemoved: 1 });
      expect(approvalsRemoved).toBe(1);
      await setupState.registry.removeEntry(setupState.entry);

      await writeFile(path.join(setupState.workspace, "must-survive.txt"), "still here\n");
      await expect(stat(path.join(setupState.workspace, "must-survive.txt"))).resolves.toBeTruthy();

      const reRegistered = await setupState.registry.add(setupState.workspace, "project-a");
      expect(await policy.isTrusted(reRegistered)).toBe(false);
      expect(await policy.listRules()).toEqual([]);
      expect(await approvals.list()).toEqual([]);
    } finally {
      await rm(setupState.home, { recursive: true, force: true });
      await rm(setupState.workspace, { recursive: true, force: true });
    }
  });

  it("prunes session bindings when a registered root disappears or changes", async () => {
    const setupState = await setup();
    const moved = `${setupState.workspace}-moved`;
    try {
      const sessions = new WorkspaceSessionManager();
      sessions.bind("session-a", setupState.entry);
      await rename(setupState.workspace, moved);
      expect(await sessions.prune(setupState.registry)).toBe(1);
      expect(sessions.current("session-a")).toBeUndefined();
    } finally {
      await rm(setupState.home, { recursive: true, force: true });
      await rm(setupState.workspace, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
    }
  });
});
