import type { RegisteredWorkspace } from "../workspace/registry.js";

/** The only mutable workspace selection is scoped to one MCP session. */
export class WorkspaceSessionManager {
  private readonly bindings = new Map<string, string>();

  bind(sessionId: string, workspace: RegisteredWorkspace): void {
    this.bindings.set(sessionId, workspace.id);
  }

  current(sessionId: string): string | undefined {
    return this.bindings.get(sessionId);
  }

  clear(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  clearAll(): void {
    this.bindings.clear();
  }

  size(): number {
    return this.bindings.size;
  }
}

