import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { isSensitiveRelativePath } from "./sensitive-files.js";

export class WorkspaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSecurityError";
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function nearestExistingParent(candidate: string): Promise<{ path: string; missingTail: string[] }> {
  let current = candidate;
  const missingTail: string[] = [];
  while (true) {
    try {
      await fs.lstat(current);
      return { path: current, missingTail };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolvePathOptions {
  mustExist?: boolean;
  allowDirectory?: boolean;
}

/**
 * Resolve a user-supplied path and prove that its real path remains in the
 * workspace. Existing symlinks and symlinked parent directories are checked.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  options: ResolvePathOptions = {}
): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new WorkspaceSecurityError("Path is empty or contains a null byte.");
  }

  const root = await fs.realpath(workspaceRoot);
  const candidate = path.resolve(root, requestedPath);

  if (!isInside(root, candidate)) {
    throw new WorkspaceSecurityError("Path must stay inside the workspace.");
  }

  let target: string;
  try {
    target = await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.mustExist) {
      throw new WorkspaceSecurityError(`Path does not exist: ${requestedPath}`);
    }

    const parent = await nearestExistingParent(candidate);
    const realParent = await fs.realpath(parent.path);
    if (!isInside(root, realParent)) {
      throw new WorkspaceSecurityError("Path resolves through a symlink outside the workspace.");
    }
    target = path.join(realParent, ...parent.missingTail);
  }

  if (!isInside(root, target)) {
    throw new WorkspaceSecurityError("Path resolves outside the workspace.");
  }

  const relativePath = path.relative(root, target);
  if (isSensitiveRelativePath(relativePath)) {
    throw new WorkspaceSecurityError("Sensitive files are blocked by default.");
  }

  if (options.mustExist) {
    const stats = await fs.stat(target);
    if (!options.allowDirectory && !stats.isFile()) {
      throw new WorkspaceSecurityError("The requested path is not a regular file.");
    }
  }

  return target;
}

export function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const canonicalRoot = fsSync.realpathSync.native(workspaceRoot);
  return path.relative(canonicalRoot, absolutePath).split(path.sep).join("/") || ".";
}
