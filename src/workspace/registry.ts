import fs from "node:fs/promises";
import path from "node:path";
import { CODERELAY_HOME, defaultInstanceName, normalizeInstanceName } from "../runtime/state.js";

const REGISTRY_VERSION = 1;
const MAX_AGENTS_BYTES = 64_000;

export interface RegisteredWorkspace {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentsFile {
  path: string;
  content: string;
}

export interface WorkspaceDescriptor extends RegisteredWorkspace {
  exists: boolean;
  agents: {
    md: WorkspaceAgentsFile | null;
    overrideMd: WorkspaceAgentsFile | null;
  };
}

interface RegistryFile {
  version: number;
  workspaces: RegisteredWorkspace[];
}

function registryPath(home: string): string {
  return path.join(home, "workspaces.json");
}

function normalizeEntry(raw: RegisteredWorkspace): RegisteredWorkspace {
  const name = normalizeInstanceName(raw.name);
  return {
    id: normalizeInstanceName(raw.id || name),
    name,
    root: path.resolve(raw.root),
    addedAt: raw.addedAt || new Date(0).toISOString(),
    updatedAt: raw.updatedAt || raw.addedAt || new Date(0).toISOString()
  };
}

async function readAgentsFile(root: string, fileName: string): Promise<WorkspaceAgentsFile | null> {
  const filePath = path.join(root, fileName);
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return null;
    if (stats.size > MAX_AGENTS_BYTES) {
      return { path: fileName, content: `[${fileName} is larger than ${MAX_AGENTS_BYTES} bytes and was not loaded.]` };
    }
    return { path: fileName, content: await fs.readFile(filePath, "utf8") };
  } catch {
    return null;
  }
}

/** Persistent, non-secret registry for the workspaces served by one daemon. */
export class WorkspaceRegistry {
  readonly filePath: string;

  constructor(readonly home = CODERELAY_HOME) {
    this.filePath = registryPath(home);
  }

  async list(): Promise<RegisteredWorkspace[]> {
    let parsed: Partial<RegistryFile>;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<RegistryFile>;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces.map((entry) => normalizeEntry(entry)).sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(nameOrId: string): Promise<RegisteredWorkspace | null> {
    const normalized = normalizeInstanceName(nameOrId);
    return (await this.list()).find((entry) => entry.name === normalized || entry.id === normalized) ?? null;
  }

  async add(inputPath: string, requestedName?: string): Promise<RegisteredWorkspace> {
    const root = await fs.realpath(path.resolve(inputPath));
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);

    const entries = await this.list();
    const existing = entries.find((entry) => entry.root === root);
    if (existing) {
      if (requestedName && normalizeInstanceName(requestedName) !== existing.name) {
        throw new Error(`Workspace is already registered as ${existing.name}.`);
      }
      return existing;
    }

    const baseName = normalizeInstanceName(requestedName ?? defaultInstanceName(root));
    const occupied = new Set(entries.map((entry) => entry.name));
    let name = baseName;
    let suffix = 2;
    while (occupied.has(name)) {
      name = `${baseName}-${suffix}`;
      suffix += 1;
    }
    const now = new Date().toISOString();
    const entry: RegisteredWorkspace = { id: name, name, root, addedAt: now, updatedAt: now };
    await this.write([...entries, entry]);
    return entry;
  }

  async remove(nameOrId: string): Promise<RegisteredWorkspace> {
    const entry = await this.get(nameOrId);
    if (!entry) throw new Error(`Workspace is not registered: ${nameOrId}`);
    return await this.removeEntry(entry);
  }

  /** Remove exactly this registry entry after its external authorization is revoked. */
  async removeEntry(entry: RegisteredWorkspace): Promise<RegisteredWorkspace> {
    const remaining = (await this.list()).filter((candidate) => candidate.id !== entry.id);
    await this.write(remaining);
    return entry;
  }

  async describe(entry: RegisteredWorkspace): Promise<WorkspaceDescriptor> {
    let exists = false;
    try {
      const currentRoot = await fs.realpath(entry.root);
      const stats = await fs.stat(currentRoot);
      exists = stats.isDirectory() && currentRoot === entry.root;
    } catch {
      exists = false;
    }
    return {
      ...entry,
      exists,
      agents: {
        md: exists ? await readAgentsFile(entry.root, "AGENTS.md") : null,
        overrideMd: exists ? await readAgentsFile(entry.root, "AGENTS.override.md") : null
      }
    };
  }

  async describeAll(): Promise<WorkspaceDescriptor[]> {
    return await Promise.all((await this.list()).map((entry) => this.describe(entry)));
  }

  /** Re-check the recorded canonical root before a session can use it. */
  async requireUsable(nameOrId: string): Promise<RegisteredWorkspace> {
    const entry = await this.get(nameOrId);
    if (!entry) throw new Error(`Workspace is not registered: ${nameOrId}`);
    const descriptor = await this.describe(entry);
    if (!descriptor.exists) {
      throw new Error(`Workspace ${entry.name} is unavailable or its canonical path changed: ${entry.root}`);
    }
    return entry;
  }

  private async write(workspaces: RegisteredWorkspace[]): Promise<void> {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    const payload: RegistryFile = { version: REGISTRY_VERSION, workspaces };
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}
