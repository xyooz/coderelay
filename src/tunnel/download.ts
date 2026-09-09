import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CODERELAY_HOME } from "../runtime/state.js";

/**
 * Pinned to an official Cloudflare release. The SHA256 values are the
 * GitHub release asset digests for the downloaded archives/binaries.
 */
export const CLOUDFLARED_RELEASE = "2026.8.3";

export interface CloudflaredRuntime {
  path: string;
  source: "path" | "cache" | "download";
  version: string;
}

export interface CloudflaredAsset {
  archiveName: string;
  binaryName: string;
  sha256: string;
  url: string;
  extract: boolean;
}

const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE}`;

const ASSETS: Record<string, CloudflaredAsset> = {
  "darwin-arm64": {
    archiveName: "cloudflared-darwin-arm64.tgz",
    binaryName: "cloudflared",
    sha256: "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
    url: `${RELEASE_BASE}/cloudflared-darwin-arm64.tgz`,
    extract: true
  },
  "darwin-x64": {
    archiveName: "cloudflared-darwin-amd64.tgz",
    binaryName: "cloudflared",
    sha256: "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99",
    url: `${RELEASE_BASE}/cloudflared-darwin-amd64.tgz`,
    extract: true
  },
  "linux-x64": {
    archiveName: "cloudflared-linux-amd64",
    binaryName: "cloudflared",
    sha256: "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
    url: `${RELEASE_BASE}/cloudflared-linux-amd64`,
    extract: false
  },
  "linux-arm64": {
    archiveName: "cloudflared-linux-arm64",
    binaryName: "cloudflared",
    sha256: "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391",
    url: `${RELEASE_BASE}/cloudflared-linux-arm64`,
    extract: false
  },
  "win32-x64": {
    archiveName: "cloudflared-windows-amd64.exe",
    binaryName: "cloudflared.exe",
    sha256: "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae",
    url: `${RELEASE_BASE}/cloudflared-windows-amd64.exe`,
    extract: false
  }
};

export function getCloudflaredAsset(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): CloudflaredAsset {
  const key = `${platform}-${architecture === "amd64" ? "x64" : architecture}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(`Automatic cloudflared download is not supported on ${platform}/${architecture}. Install cloudflared manually and retry.`);
  }
  return asset;
}

export function cachedCloudflaredPath(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): string {
  const asset = getCloudflaredAsset(platform, architecture);
  return path.join(CODERELAY_HOME, "bin", asset.binaryName);
}

function candidateNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["cloudflared.exe", "cloudflared"] : ["cloudflared"];
}

function isRunnable(filePath: string): boolean {
  try {
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile()) return false;
    fsSync.accessSync(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableWorks(filePath: string): boolean {
  if (!isRunnable(filePath)) return false;
  const result = spawnSync(filePath, ["--version"], { stdio: "ignore", windowsHide: true });
  return result.status === 0;
}

function findOnPath(): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of candidateNames(process.platform)) {
      const candidate = path.join(directory, name);
      if (executableWorks(candidate)) return candidate;
    }
  }
  return null;
}

function readVersion(filePath: string): string {
  const result = spawnSync(filePath, ["--version"], { encoding: "utf8", windowsHide: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output.split(/\r?\n/u)[0] || "unknown";
}

export async function resolveInstalledCloudflared(): Promise<CloudflaredRuntime | null> {
  const pathExecutable = findOnPath();
  if (pathExecutable) return { path: pathExecutable, source: "path", version: readVersion(pathExecutable) };

  let cachedPath: string;
  try {
    cachedPath = cachedCloudflaredPath();
  } catch {
    return null;
  }
  if (executableWorks(cachedPath)) return { path: cachedPath, source: "cache", version: readVersion(cachedPath) };
  return null;
}

export async function ensureCloudflared(): Promise<CloudflaredRuntime> {
  const installed = await resolveInstalledCloudflared();
  if (installed) return installed;
  return await downloadCloudflared();
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await fs.readFile(filePath);
  hash.update(file);
  return hash.digest("hex");
}

async function downloadCloudflared(): Promise<CloudflaredRuntime> {
  const asset = getCloudflaredAsset();
  const binDirectory = path.join(CODERELAY_HOME, "bin");
  await fs.mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await fs.mkdtemp(path.join(CODERELAY_HOME, ".cloudflared-download-"));
  const archivePath = path.join(temporaryDirectory, asset.archiveName);
  const targetPath = path.join(binDirectory, asset.binaryName);

  try {
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
    await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });

    const actualSha256 = await sha256(archivePath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(`cloudflared checksum mismatch. Expected ${asset.sha256}, received ${actualSha256}.`);
    }

    let binaryPath = archivePath;
    if (asset.extract) {
      execFileSync("tar", ["-xzf", archivePath, "-C", temporaryDirectory], { stdio: "ignore" });
      binaryPath = path.join(temporaryDirectory, asset.binaryName);
    }

    await fs.chmod(binaryPath, 0o755);
    if (!isRunnable(binaryPath)) throw new Error("Downloaded cloudflared binary was not extracted correctly.");
    await fs.rm(targetPath, { force: true });
    await fs.rename(binaryPath, targetPath);
    await fs.chmod(targetPath, 0o755);

    if (!executableWorks(targetPath)) throw new Error("Downloaded cloudflared binary failed its version check.");
    return { path: targetPath, source: "download", version: readVersion(targetPath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nInstall cloudflared manually if the automatic download cannot be completed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
