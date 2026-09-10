#!/usr/bin/env node

import { access, constants, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const coderelayEntryPoint = path.join(projectRoot, "dist", "index.js");
const tunnelIdPattern = /^tunnel_[0-9a-f]{32}$/u;

function printUsage() {
  console.log(`CodeRelay OpenAI Secure MCP Tunnel PoC

Prerequisites:
  CONTROL_PLANE_TUNNEL_ID=tunnel_...
  CONTROL_PLANE_API_KEY=sk-...        # runtime key, not an admin key
  tunnel-client on PATH or --tunnel-client /path/to/tunnel-client

Usage:
  node experiments/openai-secure-mcp/run.mjs [--workspace <path>] [--tunnel-id <id>]
`);
}

function parseArgs(argv) {
  const options = { workspace: process.cwd(), tunnelId: process.env.CONTROL_PLANE_TUNNEL_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    }
    if (argument === "--workspace") {
      options.workspace = path.resolve(argv[++index] ?? "");
      continue;
    }
    if (argument === "--tunnel-id") {
      options.tunnelId = argv[++index];
      continue;
    }
    if (argument === "--tunnel-client") {
      options.tunnelClient = path.resolve(argv[++index] ?? "");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveTunnelClient(explicitPath) {
  if (explicitPath) {
    if (await isExecutable(explicitPath)) return explicitPath;
    throw new Error(`tunnel-client is not executable: ${explicitPath}`);
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error("tunnel-client was not found. Install it from OpenAI Platform Tunnels or pass --tunnel-client.");
}

function spawnLogged(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });
  return { child, getOutput: () => output };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForCodeRelayEndpoint(started, timeoutMs = 30_000) {
  const endpointPattern = /http:\/\/127\.0\.0\.1:\d+\/mcp\/[^\s]+/u;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = started.getOutput().match(endpointPattern)?.[0];
    if (endpoint) return endpoint;
    if (started.child.exitCode !== null) {
      throw new Error(`CodeRelay exited before printing a local MCP endpoint (exit ${started.child.exitCode}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for CodeRelay's local MCP endpoint.");
}

async function waitForTunnelReady(healthUrlFile, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let healthUrl = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`tunnel-client exited before becoming ready (exit ${child.exitCode}).`);
    }
    try {
      healthUrl = (await readFile(healthUrlFile, "utf8")).trim().replace(/\/$/u, "");
      if (healthUrl) {
        const response = await fetch(`${healthUrl}/readyz`, { signal: AbortSignal.timeout(3_000) });
        if (response.ok) return healthUrl;
      }
    } catch {
      // The client may need time to start its health listener and connect to OpenAI.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("tunnel-client did not become ready within 60 seconds. Check its output and /ui.");
}

async function stopCodeRelay(runtimeHome) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [coderelayEntryPoint, "stop"], {
      cwd: projectRoot,
      env: { ...process.env, CODERELAY_HOME: runtimeHome },
      stdio: "inherit"
    });
    child.once("error", resolve);
    child.once("close", resolve);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.tunnelId || !tunnelIdPattern.test(options.tunnelId)) {
    throw new Error("Provide CONTROL_PLANE_TUNNEL_ID or --tunnel-id with tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
  if (!process.env.CONTROL_PLANE_API_KEY) {
    throw new Error("CONTROL_PLANE_API_KEY is required and must be a runtime key with Tunnels Read + Use.");
  }
  const tunnelClient = await resolveTunnelClient(options.tunnelClient);

  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), "coderelay-openai-poc-"));
  const healthUrlFile = path.join(runtimeHome, "tunnel-client-health.url");
  let tunnelProcess;
  let stopping = false;

  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (tunnelProcess && tunnelProcess.exitCode === null) tunnelProcess.kill("SIGTERM");
    await stopCodeRelay(runtimeHome);
    await rm(runtimeHome, { recursive: true, force: true });
  };
  process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

  try {
    console.log(`Starting CodeRelay locally for ${options.workspace}`);
    const coderelay = spawnLogged(process.execPath, [coderelayEntryPoint, "start", "--workspace", options.workspace, "--no-tunnel"], {
      cwd: projectRoot,
      env: { ...process.env, CODERELAY_HOME: runtimeHome }
    });
    const endpoint = await waitForCodeRelayEndpoint(coderelay);

    console.log(`\nLocal MCP endpoint: ${endpoint}`);
    console.log("Starting OpenAI Secure MCP Tunnel client...");
    const tunnel = spawnLogged(tunnelClient, [
      "run",
      "--control-plane.tunnel-id",
      options.tunnelId,
      "--mcp-server-url",
      endpoint,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      healthUrlFile
    ], {
      cwd: projectRoot,
      env: { ...process.env, CONTROL_PLANE_TUNNEL_ID: options.tunnelId }
    });
    tunnelProcess = tunnel.child;

    const healthUrl = await waitForTunnelReady(healthUrlFile, tunnelProcess);
    console.log("\nSecure MCP Tunnel is ready.");
    console.log(`Local tunnel UI: ${healthUrl}/ui`);
    console.log("\nIn ChatGPT:");
    console.log("1. Open Settings → Apps / Connectors → Create app in developer mode.");
    console.log("2. Choose Connection: Tunnel.");
    console.log(`3. Select or paste tunnel ID: ${options.tunnelId}`);
    console.log("4. Keep this process running while testing the CodeRelay tools.");

    const result = await waitForExit(tunnelProcess);
    if (result.code !== 0 && result.signal !== "SIGTERM") {
      throw new Error(`tunnel-client exited with code ${result.code ?? "unknown"}.`);
    }
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`OpenAI Secure MCP PoC error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
