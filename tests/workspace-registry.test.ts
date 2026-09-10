import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

describe("WorkspaceRegistry", () => {
  it("persists canonical roots, resolves name collisions, and exposes AGENTS context", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "coderelay-registry-home-"));
    const parent = await mkdtemp(path.join(os.tmpdir(), "coderelay-registry-projects-"));
    const first = path.join(parent, "project");
    const second = path.join(parent, "other");
    try {
      await writeFile(path.join(parent, ".keep"), "");
      await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(first), mkdir(second)]));
      await writeFile(path.join(first, "AGENTS.md"), "Run the focused tests first.\n");
      await writeFile(path.join(first, "AGENTS.override.md"), "Prefer the local test fixture.\n");

      const registry = new WorkspaceRegistry(home);
      const firstEntry = await registry.add(first);
      const secondEntry = await registry.add(second, firstEntry.name);
      expect(firstEntry.name).toBe("project");
      expect(secondEntry.name).toBe("project-2");
      expect(JSON.parse(await readFile(registry.filePath, "utf8")).workspaces).toHaveLength(2);

      const descriptor = await registry.describe(firstEntry);
      expect(descriptor.root).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(first)));
      expect(descriptor.agents.md?.content).toContain("focused tests");
      expect(descriptor.agents.overrideMd?.content).toContain("local test fixture");

      const reloaded = new WorkspaceRegistry(home);
      expect((await reloaded.list()).map((entry) => entry.name)).toEqual(["project", "project-2"]);
      await reloaded.remove("project-2");
      expect((await reloaded.list()).map((entry) => entry.name)).toEqual(["project"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects a registered root whose canonical path changes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "coderelay-registry-home-"));
    const parent = await mkdtemp(path.join(os.tmpdir(), "coderelay-registry-projects-"));
    const workspace = path.join(parent, "workspace");
    const moved = path.join(parent, "moved");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
      const registry = new WorkspaceRegistry(home);
      const entry = await registry.add(workspace);
      await import("node:fs/promises").then(({ rename }) => rename(workspace, moved));
      await expect(registry.requireUsable(entry.name)).rejects.toThrow("canonical path changed");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not treat a symlink as a new workspace root", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "coderelay-registry-home-"));
    const parent = await mkdtemp(path.join(os.tmpdir(), "coderelay-registry-projects-"));
    const workspace = path.join(parent, "workspace");
    const alias = path.join(parent, "alias");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
      await symlink(workspace, alias);
      const registry = new WorkspaceRegistry(home);
      const first = await registry.add(workspace);
      const second = await registry.add(alias);
      expect(second.id).toBe(first.id);
      expect((await registry.list())).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });
});

