import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  readDaemonConfig,
  readOpenAiApiKeySync,
  resolveTransportConfig,
  writeDaemonConfig,
  writeOpenAiApiKey,
  type DaemonConfig,
  type TransportPreference
} from "../runtime/state.js";
import { resolveTunnelClient } from "../tunnel/openai.js";
import { resolveInstalledCloudflared } from "../tunnel/download.js";
import { listCloudflareTunnels } from "../tunnel/cloudflare-named.js";

export const OPENAI_TUNNEL_DOCS = "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels";
export const OPENAI_TUNNEL_SETTINGS = "https://platform.openai.com/settings/organization/tunnels";
export const OPENAI_API_KEYS = "https://platform.openai.com/api-keys";
export const CLOUDFLARE_TUNNEL_DOCS = "https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/";

export function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function transportName(value: TransportPreference): string {
  switch (value) {
    case "openai": return "OpenAI Secure MCP Tunnel";
    case "cloudflare-named": return "Cloudflare Named Tunnel";
    case "cloudflare-quick": return "Cloudflare Quick Tunnel";
    case "local": return "Local only";
    default: return "Automatic selection";
  }
}

function mergeTransport(config: DaemonConfig, preferred: TransportPreference): DaemonConfig {
  return {
    ...config,
    transport: {
      preferred,
      fallback: preferred === "openai" || preferred === "cloudflare-named"
        ? "cloudflare-quick"
        : preferred
    }
  };
}

async function ask(reader: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await reader.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue || "";
}

async function askSecret(question: string, reader?: ReturnType<typeof createInterface>): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const reader = createInterface({ input, output });
    try {
      return (await reader.question(`${question}: `)).trim();
    } finally {
      reader.close();
    }
  }

  // readline owns stdin while the surrounding setup flow is active. Pause it
  // before switching to raw mode so the key is never echoed or buffered twice.
  reader?.pause();
  output.write(`${question}: `);
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          input.setRawMode?.(false);
          input.off("data", onData);
          reader?.resume();
          output.write("\n");
          reject(new Error("Input cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          input.setRawMode?.(false);
          input.off("data", onData);
          reader?.resume();
          output.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function saveOpenAiSetup(reader: ReturnType<typeof createInterface>, config: DaemonConfig): Promise<DaemonConfig> {
  const currentId = config.openai?.tunnelId;
  const tunnelId = await ask(reader, "OpenAI tunnel ID", currentId ?? process.env.CONTROL_PLANE_TUNNEL_ID);
  if (!/^tunnel_[0-9a-f]{32}$/u.test(tunnelId)) {
    throw new Error("Tunnel ID must look like tunnel_ followed by 32 hexadecimal characters.");
  }

  const apiKey = readOpenAiApiKeySync();
  if (apiKey.source === "missing") {
    console.log(`Create a key with Tunnels Read + Use at ${OPENAI_API_KEYS}`);
    const entered = await askSecret("OpenAI API key (leave blank to configure it later)", reader);
    if (entered) {
      const shouldSave = (await ask(reader, "Save this key in ~/.coderelay/credentials.json?", "Y")).toLowerCase();
      if (shouldSave !== "n" && shouldSave !== "no") await writeOpenAiApiKey(entered);
    }
  } else {
    console.log(`API key: configured (${apiKey.source === "environment" ? "CONTROL_PLANE_API_KEY" : "local credentials file"})`);
  }

  return {
    ...mergeTransport(config, "openai"),
    openai: { ...(config.openai ?? {}), tunnelId },
    openaiTunnelId: undefined
  };
}

async function saveNamedSetup(reader: ReturnType<typeof createInterface>, config: DaemonConfig): Promise<DaemonConfig> {
  const tunnel = await ask(reader, "Cloudflare tunnel name or ID", config.cloudflare?.tunnel);
  const hostname = await ask(reader, "Public hostname", config.cloudflare?.hostname);
  if (!tunnel || !hostname || !/^[a-zA-Z0-9.-]+$/u.test(hostname)) {
    throw new Error("Cloudflare Named Tunnel requires a tunnel name/ID and a valid hostname.");
  }
  const cloudflared = await resolveInstalledCloudflared();
  if (!cloudflared) {
    console.log(`! cloudflared is not installed on PATH. See ${CLOUDFLARE_TUNNEL_DOCS}`);
  } else {
    const tunnels = listCloudflareTunnels(cloudflared.path);
    if (tunnels.length > 0) console.log(`Found existing Cloudflare tunnel entries: ${tunnels.slice(0, 5).join(", ")}`);
  }
  return {
    ...mergeTransport(config, "cloudflare-named"),
    cloudflare: { ...(config.cloudflare ?? {}), tunnel, hostname }
  };
}

export async function setupCommand(): Promise<void> {
  if (!isInteractiveTerminal()) {
    throw new Error("coderelay setup requires an interactive terminal. Use config.json and environment variables in scripts.");
  }
  const current = await readDaemonConfig() ?? {};
  const reader = createInterface({ input, output });
  try {
    console.log("CodeRelay setup\n");
    console.log("Choose a secure connection:");
    console.log("  1) Cloudflare Quick Tunnel (zero configuration)");
    console.log("  2) OpenAI Secure MCP Tunnel");
    console.log("  3) Cloudflare Named Tunnel (bring your own tunnel)");
    console.log("  4) Local only");
    const selected = await ask(reader, "Selection", "1");
    let next: DaemonConfig;
    if (selected === "2") next = await saveOpenAiSetup(reader, current);
    else if (selected === "3") next = await saveNamedSetup(reader, current);
    else if (selected === "4") next = mergeTransport(current, "local");
    else if (selected === "1") next = mergeTransport(current, "cloudflare-quick");
    else throw new Error("Choose 1, 2, 3, or 4.");
    await writeDaemonConfig(next);
    console.log(`\nSaved transport preference: ${transportName(resolveTransportConfig(next).preferred)}`);
    if (resolveTransportConfig(next).preferred === "openai") {
      console.log(`Manage the tunnel in ChatGPT/OpenAI: ${OPENAI_TUNNEL_SETTINGS}`);
      if (!resolveTunnelClient()) console.log(`Install tunnel-client or set CODERELAY_TUNNEL_CLIENT. See ${OPENAI_TUNNEL_DOCS}`);
    }
    console.log("Run coderelay to start CodeRelay.");
  } finally {
    reader.close();
  }
}

export async function authOpenAiCommand(): Promise<void> {
  if (!isInteractiveTerminal()) throw new Error("coderelay auth openai requires an interactive terminal.");
  const reader = createInterface({ input, output });
  try {
    const existing = readOpenAiApiKeySync();
    if (existing.source === "environment") {
      console.log("CONTROL_PLANE_API_KEY is already set; it takes precedence over the local credentials file.");
    }
    const apiKey = await askSecret("OpenAI API key", reader);
    if (!apiKey) throw new Error(`An API key is required. Create one at ${OPENAI_API_KEYS}`);
    await writeOpenAiApiKey(apiKey);
    console.log("Saved OpenAI API key to ~/.coderelay/credentials.json (mode 0600).");
  } finally {
    reader.close();
  }
}

export function authStatusCommand(): void {
  const resolution = readOpenAiApiKeySync();
  console.log(`OpenAI API key: ${resolution.source === "missing" ? "missing" : "configured"}`);
  console.log(`Source: ${resolution.source === "environment" ? "CONTROL_PLANE_API_KEY" : resolution.source === "credentials" ? "~/.coderelay/credentials.json" : "none"}`);
  if (resolution.source === "missing") console.log(`Create one at ${OPENAI_API_KEYS}`);
}

export async function authLogoutCommand(): Promise<void> {
  const { removeOpenAiApiKey } = await import("../runtime/state.js");
  await removeOpenAiApiKey();
  console.log("Removed the locally stored OpenAI API key. CONTROL_PLANE_API_KEY, if set, is still used.");
}

export async function configTransportCommand(preferred: TransportPreference): Promise<void> {
  if (!["auto", "openai", "cloudflare-named", "cloudflare-quick", "local"].includes(preferred)) {
    throw new Error(`Unknown transport ${String(preferred)}.`);
  }
  const current = await readDaemonConfig() ?? {};
  await writeDaemonConfig(mergeTransport(current, preferred));
  console.log(`Saved transport preference: ${transportName(preferred)}`);
}
