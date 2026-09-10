import { CloudflaredTunnelProvider } from "./cloudflared.js";
import { hasOpenAiConfiguration, OpenAiTunnelProvider } from "./openai.js";
import type { TunnelProvider, TunnelStartContext } from "./provider.js";

export type TransportPreference = "auto" | "openai" | "cloudflare";

export async function selectTransport(
  preference: TransportPreference,
  context: TunnelStartContext
): Promise<TunnelProvider> {
  const cloudflare = new CloudflaredTunnelProvider();
  if (preference === "cloudflare") return cloudflare;

  const openai = new OpenAiTunnelProvider();
  if (preference === "openai") {
    if (!await openai.isAvailable(context)) {
      throw new Error("OpenAI Secure MCP Tunnel is not available. Set CONTROL_PLANE_API_KEY, configure a tunnel ID, and install tunnel-client.");
    }
    return openai;
  }

  if (hasOpenAiConfiguration(context) && await openai.isAvailable(context)) return openai;
  return cloudflare;
}
