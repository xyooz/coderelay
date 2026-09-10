export interface McpRequestInfo {
  rpcMethod: string | null;
  toolName: string | null;
  explicitWorkspace: string | null;
}

export interface McpTraceEvent extends McpRequestInfo {
  httpMethod: string;
  incomingSessionId: string | null;
  transportSessionId: string | null;
  internalSessionId: string | null;
  route: "new" | "existing" | "missing" | "closed";
  workspaceBindingBefore: string | null;
  workspaceBindingAfter: string | null;
  sessionWorkspace: string | null;
  resolvedWorkspace: string | null;
  resolutionSource: "explicit" | "session" | "none";
  outgoingSessionId: string | null;
}

const TRACE_PREFIX = "[CodeRelay MCP trace]";

export function mcpTraceEnabled(): boolean {
  return process.env.CODERELAY_MCP_TRACE === "1";
}

/**
 * Inspect a cloned request body so the original stream remains available to
 * the MCP transport. This is intentionally best-effort: tracing must never
 * affect request routing or reject an otherwise valid MCP request.
 */
export async function inspectMcpRequest(request: Request): Promise<McpRequestInfo> {
  if (!mcpTraceEnabled() || request.method !== "POST") {
    return { rpcMethod: null, toolName: null, explicitWorkspace: null };
  }

  try {
    const body = await request.clone().json() as unknown;
    const message = Array.isArray(body) ? body[0] : body;
    if (!message || typeof message !== "object") return { rpcMethod: null, toolName: null, explicitWorkspace: null };

    const record = message as Record<string, unknown>;
    const rpcMethod = typeof record.method === "string" ? record.method : null;
    const params = record.params;
    const toolName = rpcMethod === "tools/call" && params && typeof params === "object"
      && typeof (params as Record<string, unknown>).name === "string"
      ? (params as Record<string, unknown>).name as string
      : null;
    const argumentsValue = params && typeof params === "object"
      ? (params as Record<string, unknown>).arguments
      : undefined;
    const argumentsRecord = argumentsValue && typeof argumentsValue === "object"
      ? argumentsValue as Record<string, unknown>
      : null;
    const explicitWorkspace = argumentsRecord && typeof argumentsRecord.workspace === "string"
      ? argumentsRecord.workspace
      : toolName === "use_workspace" && argumentsRecord && typeof argumentsRecord.name === "string"
        ? argumentsRecord.name
        : null;
    return { rpcMethod, toolName, explicitWorkspace };
  } catch {
    return { rpcMethod: null, toolName: null, explicitWorkspace: null };
  }
}

export function writeMcpTrace(event: McpTraceEvent): void {
  if (!mcpTraceEnabled()) return;
  console.error(`${TRACE_PREFIX} ${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}`);
}

/**
 * Streamable HTTP responses can resolve before the SDK finishes executing a
 * tool and writing its response event. Consume a clone only while tracing so
 * binding-after reflects the completed request without consuming the body
 * that must still be returned to the MCP client.
 */
export async function waitForMcpResponse(response: Response): Promise<void> {
  if (!mcpTraceEnabled() || !response.body) return;
  try {
    await response.clone().arrayBuffer();
  } catch {
    // Tracing must never change the response delivered to the MCP client.
  }
}
