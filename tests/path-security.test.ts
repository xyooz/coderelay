import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, WorkspaceSecurityError } from "../src/workspace/path-security.js";

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coderelay-test-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export const answer = 42;\n");
  await writeFile(path.join(root, ".env"), "SECRET=blocked\n");
  return root;
}

describe("workspace path security", () => {
  it("allows ordinary files inside the workspace", async () => {
    const root = await makeWorkspace();
    const canonicalRoot = await realpath(root);
    await expect(resolveWorkspacePath(root, "src/main.ts", { mustExist: true })).resolves.toBe(path.join(canonicalRoot, "src", "main.ts"));
  });

  it("rejects traversal and absolute outside paths", async () => {
    const root = await makeWorkspace();
    await expect(resolveWorkspacePath(root, "../../.ssh/id_rsa")).rejects.toBeInstanceOf(WorkspaceSecurityError);
    await expect(resolveWorkspacePath(root, "/etc/passwd")).rejects.toBeInstanceOf(WorkspaceSecurityError);
  });

  it("blocks sensitive files", async () => {
    const root = await makeWorkspace();
    await expect(resolveWorkspacePath(root, ".env", { mustExist: true })).rejects.toThrow("Sensitive files");
  });

  it("rejects symlink escapes", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), "coderelay-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "linked"));
    await expect(resolveWorkspacePath(root, "linked/secret.txt", { mustExist: true })).rejects.toBeInstanceOf(WorkspaceSecurityError);
  });

  it("keeps nested new file paths inside the workspace", async () => {
    const root = await makeWorkspace();
    const canonicalRoot = await realpath(root);
    await expect(resolveWorkspacePath(root, "src/new/note.md")).resolves.toBe(path.join(canonicalRoot, "src", "new", "note.md"));
  });
});
