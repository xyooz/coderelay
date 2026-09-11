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
    const entries = await registry.describeAll();
    const current = new Map(entries.filter((entry) => entry.exists).map((entry) => [entry.id, entry]));
    let cleared = 0;
    for (const [sessionId, binding] of this.bindings) {
      const entry = current.get(binding.workspaceId);
      if (!entry || entry.addedAt !== binding.workspaceAddedAt) {
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
