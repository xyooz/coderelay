import { WorkspaceRegistry, type RegisteredWorkspace } from "../workspace/registry.js";

/** The only mutable workspace selection is scoped to one MCP session. */
interface WorkspaceSessionBinding {
  workspaceId: string;
  workspaceAddedAt: string;
}

export class WorkspaceSessionManager {
  private readonly bindings = new Map<string, WorkspaceSessionBinding>();

  bind(sessionId: string, workspace: RegisteredWorkspace): void {
    this.bindings.set(sessionId, { workspaceId: workspace.id, workspaceAddedAt: workspace.addedAt });
  }

  current(sessionId: string): string | undefined {
    return this.bindings.get(sessionId)?.workspaceId;
  }

  clear(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  clearAll(): void {
    this.bindings.clear();
  }

  clearWorkspace(workspace: RegisteredWorkspace | string): number {
    const workspaceId = typeof workspace === "string" ? workspace : workspace.id;
    let cleared = 0;
    for (const [sessionId, binding] of this.bindings) {
      if (binding.workspaceId === workspaceId || (typeof workspace !== "string" && binding.workspaceId === workspace.name)) {
        this.bindings.delete(sessionId);
        cleared += 1;
      }
    }
    return cleared;
  }

  /** Drop bindings revoked by the local CLI, including remove-and-re-register cycles. */
  async prune(registry: WorkspaceRegistry): Promise<number> {
    const referencedWorkspaceIds = new Set([...this.bindings.values()].map((binding) => binding.workspaceId));
    if (referencedWorkspaceIds.size === 0) return 0;

    const entries = await registry.list();
    const current = new Map(entries.filter((entry) => referencedWorkspaceIds.has(entry.id)).map((entry) => [entry.id, entry]));
    const usable = new Map<string, boolean>();
    let cleared = 0;
    for (const [sessionId, binding] of this.bindings) {
      const entry = current.get(binding.workspaceId);
      if (!entry || entry.addedAt !== binding.workspaceAddedAt) {
        this.bindings.delete(sessionId);
        cleared += 1;
        continue;
      }
      let entryUsable = usable.get(entry.id);
      if (entryUsable === undefined) {
        entryUsable = await registry.isUsable(entry);
        usable.set(entry.id, entryUsable);
      }
      if (!entryUsable) {
        this.bindings.delete(sessionId);
        cleared += 1;
      }
    }
    return cleared;
  }

  size(): number {
    return this.bindings.size;
  }
}
