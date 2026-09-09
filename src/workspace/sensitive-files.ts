import path from "node:path";

const SENSITIVE_EXACT = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials"
]);

const SENSITIVE_DIRECTORIES = new Set([".aws", ".ssh"]);

/** Return true when a workspace-relative path should never be exposed. */
export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/").filter(Boolean);

  return segments.some((segment) => {
    if (SENSITIVE_DIRECTORIES.has(segment)) return true;
    if (SENSITIVE_EXACT.has(segment)) return true;
    if (segment.startsWith(".env.")) return true;
    if (segment.endsWith(".pem") || segment.endsWith(".key")) return true;
    return false;
  });
}
