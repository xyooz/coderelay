import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (packageJson.bin?.coderelay !== "dist/index.js") {
  throw new Error("package.json bin.coderelay must point to dist/index.js");
}

const entryPoint = fs.readFileSync("dist/index.js", "utf8");
if (!entryPoint.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/index.js is missing its Node.js shebang");
}

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), "coderelay-npm-cache") }
});
const packResult = JSON.parse(output)[0];
const files = new Set(packResult.files.map((file) => file.path));
for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js"]) {
  if (!files.has(required)) throw new Error(`npm pack is missing ${required}`);
}

console.log(`Package check passed: ${packageJson.name}@${packageJson.version}`);
console.log(`npm pack files: ${packResult.files.length}`);
console.log(`packed size: ${packResult.size} bytes`);
