import { CloudflaredTunnelProvider } from "./cloudflared.js";
import { CloudflareNamedTunnelProvider } from "./cloudflare-named.js";
import { hasOpenAiConfiguration, OpenAiTunnelProvider } from "./openai.js";
import type { TunnelProvider, TunnelStartContext } from "./provider.js";
import type { TransportPreference } from "../runtime/state.js";

export type { TransportPreference } from "../runtime/state.js";

export async function selectTransport(
  preference: TransportPreference,
  context: TunnelStartContext
): Promise<TunnelProvider> {
  const cloudflare = new CloudflaredTunnelProvider();
  if (preference === "cloudflare-quick") return cloudflare;
  if (preference === "local") throw new Error("Local transport does not create a tunnel.");

  const named = new CloudflareNamedTunnelProvider();
  if (preference === "cloudflare-named") {
    if (!await named.isAvailable(context)) {
      throw new Error("Cloudflare Named Tunnel is not configured. Provide a remotely-managed tunnel token and hostname, or configure a locally-managed tunnel, then retry.");
    }
    return named;
  }

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
