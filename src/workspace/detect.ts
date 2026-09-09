import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_MARKERS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts"
];

export interface WorkspaceInfo {
  root: string;
  isGitRepository: boolean;
  markers: string[];
  technologies: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectWorkspace(inputPath = process.cwd()): Promise<WorkspaceInfo> {
  const root = path.resolve(inputPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);

  const markers = (await Promise.all(PROJECT_MARKERS.map(async (marker) => (await exists(path.join(root, marker)) ? marker : null))))
    .filter((marker): marker is string => marker !== null);

  const technologies: string[] = [];
  if (markers.includes("package.json")) {
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const dependencies = new Set([
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.devDependencies ?? {})
      ]);
      if (dependencies.has("typescript")) technologies.push("TypeScript");
      if (dependencies.has("vite")) technologies.push("Vite");
      if (dependencies.has("vue")) technologies.push("Vue");
      if (dependencies.has("react")) technologies.push("React");
      if (dependencies.has("next")) technologies.push("Next.js");
      if (dependencies.has("express")) technologies.push("Express");
    } catch {
      // Project detection is intentionally best-effort and never blocks startup.
    }
  }
  if (markers.includes("Cargo.toml")) technologies.push("Rust");
  if (markers.includes("pyproject.toml")) technologies.push("Python");
  if (markers.includes("go.mod")) technologies.push("Go");
  if (markers.includes("pom.xml") || markers.includes("build.gradle") || markers.includes("build.gradle.kts")) {
    technologies.push("Java");
  }

  return {
    root,
    isGitRepository: await exists(path.join(root, ".git")),
    markers,
    technologies: [...new Set(technologies)]
  };
}
