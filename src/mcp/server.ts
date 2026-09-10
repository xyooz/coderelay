import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { WorkspaceSessionManager } from "./session.js";
import { inspectMcpRequest, mcpTraceEnabled, waitForMcpResponse, writeMcpTrace, type McpRequestInfo, type McpTraceEvent } from "./tracing.js";
import { createMcpServer } from "./tools.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { CODERELAY_HOME } from "../runtime/state.js";

export interface ServeOptions {
  /** Registry location used by the single daemon. */
  registryHome?: string;
  /** Kept for the hidden serve command's old shape; workspace routing is registry-based now. */
  workspaceRoot?: string;
  instanceName: string;
  host: string;
  port: number;
  token: string;
}

export interface RunningServer {
  server: http.Server;
  endpointPath: string;
  close: () => Promise<void>;
}

interface SessionEntry {
  internalId: string;
  transport: WebStandardStreamableHTTPServerTransport;
  product: McpServer;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function isAllowedOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sessionNotFound(): Response {
  return Response.json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null
  }, { status: 404 });
}

/**
 * Stateful Streamable HTTP routing. The MCP SDK's convenience handler is
 * intentionally per-request; CodeRelay needs a transport instance per MCP
 * session so workspace selection survives tools/call requests.
 */
class StatefulMcpHandler {
  private readonly entries = new Map<string, SessionEntry>();
  private closed = false;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly sessions: WorkspaceSessionManager
  ) {}

  async fetch(request: Request): Promise<Response> {
    const requestInfo = await inspectMcpRequest(request);
    if (this.closed) {
      const response = sessionNotFound();
      await this.writeTrace(request, requestInfo, {
        internalSessionId: null,
        route: "closed",
        workspaceBindingBefore: null,
        workspaceBindingAfter: null,
        transportSessionId: null,
        outgoingSessionId: response.headers.get("mcp-session-id")
      });
      return response;
    }

    const externalId = request.headers.get("mcp-session-id");
    if (externalId) {
      const entry = this.entries.get(externalId);
      if (!entry) {
        const response = sessionNotFound();
        await this.writeTrace(request, requestInfo, {
          internalSessionId: null,
          route: "missing",
          workspaceBindingBefore: null,
          workspaceBindingAfter: null,
          transportSessionId: null,
          outgoingSessionId: response.headers.get("mcp-session-id")
        });
        return response;
      }

      const bindingBefore = this.sessions.current(entry.internalId);
      const response = await entry.transport.handleRequest(request);
      await waitForMcpResponse(response);
      await this.writeTrace(request, requestInfo, {
        internalSessionId: entry.internalId,
        route: "existing",
        workspaceBindingBefore: bindingBefore ?? null,
        workspaceBindingAfter: this.sessions.current(entry.internalId) ?? null,
        transportSessionId: entry.transport.sessionId ?? null,
        outgoingSessionId: response.headers.get("mcp-session-id")
      });
      return response;
    }

    return await this.createSession(request, requestInfo);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      this.sessions.clear(entry.internalId);
      await entry.product.close().catch(() => undefined);
      await entry.transport.close().catch(() => undefined);
    }
    this.sessions.clearAll();
  }

  sessionCount(): number {
    return this.entries.size;
  }

  private async createSession(request: Request, requestInfo: McpRequestInfo): Promise<Response> {
    const internalId = randomUUID();
    let externalId: string | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        externalId = sessionId;
        const product = entry?.product;
        if (product) this.entries.set(sessionId, entry);
      },
      onsessionclosed: (sessionId) => {
        if (sessionId) this.removeSession(sessionId, internalId);
      }
    });
    const product = createMcpServer({ registry: this.registry, sessions: this.sessions, sessionId: internalId });
    const entry: SessionEntry = { internalId, transport, product };
    transport.onclose = () => {
      if (externalId) this.removeSession(externalId, internalId);
    };

    try {
      await product.connect(transport);
      const response = await transport.handleRequest(request);
      await waitForMcpResponse(response);
      // The initialization callback runs before handleRequest resolves. Keep
      // this defensive registration for SDK versions that defer the callback.
      if (transport.sessionId && !this.entries.has(transport.sessionId)) this.entries.set(transport.sessionId, entry);
      await this.writeTrace(request, requestInfo, {
        internalSessionId: internalId,
        route: "new",
        workspaceBindingBefore: null,
        workspaceBindingAfter: this.sessions.current(internalId) ?? null,
        transportSessionId: transport.sessionId ?? null,
        outgoingSessionId: response.headers.get("mcp-session-id")
      });
      return response;
    } catch (error) {
      this.sessions.clear(internalId);
      await product.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  private removeSession(externalId: string, internalId: string): void {
    this.entries.delete(externalId);
    this.sessions.clear(internalId);
  }

  private async writeTrace(
    request: Request,
    requestInfo: McpRequestInfo,
    state: Omit<McpTraceEvent, "httpMethod" | "rpcMethod" | "toolName" | "incomingSessionId" | "explicitWorkspace" | "sessionWorkspace" | "resolvedWorkspace" | "resolutionSource">
  ): Promise<void> {
    if (!mcpTraceEnabled()) return;
    const sessionWorkspace = state.workspaceBindingBefore;
    const resolutionSource = requestInfo.explicitWorkspace
      ? "explicit"
      : sessionWorkspace
        ? "session"
        : "none";
    const resolvedEntry = requestInfo.explicitWorkspace
      ? await this.registry.get(requestInfo.explicitWorkspace)
      : sessionWorkspace
        ? await this.registry.get(sessionWorkspace)
        : null;
    writeMcpTrace({
      httpMethod: request.method,
      rpcMethod: requestInfo.rpcMethod,
      toolName: requestInfo.toolName,
      incomingSessionId: request.headers.get("mcp-session-id"),
      explicitWorkspace: requestInfo.explicitWorkspace,
      sessionWorkspace,
      resolvedWorkspace: resolvedEntry?.name ?? null,
      resolutionSource,
      ...state
    });
  }
}

/** Start one loopback MCP endpoint protected by an unguessable URL path. */
export async function startMcpServer(options: ServeOptions): Promise<RunningServer> {
  const endpointPath = `/mcp/${options.token}`;
  const registry = new WorkspaceRegistry(options.registryHome ?? CODERELAY_HOME);
  const sessions = new WorkspaceSessionManager();
  const handler = new StatefulMcpHandler(registry, sessions);
  const nodeHandler = toNodeHandler(handler);

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      void registry.list().then((workspaces) => writeJson(response, 200, {
        ok: true,
        name: "coderelay",
        version: "0.2.0",
        instance: options.instanceName,
        workspaces: workspaces.length,
        sessions: handler.sessionCount()
      })).catch((error: unknown) => writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    if (requestUrl.pathname !== endpointPath) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (!isAllowedOrigin(request)) {
      writeJson(response, 403, { error: "Origin is not allowed" });
      return;
    }

    void nodeHandler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  return {
    server,
    endpointPath,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export async function runMcpServer(options: ServeOptions): Promise<void> {
  const running = await startMcpServer(options);
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("uncaughtException", (error) => {
    console.error(error);
    void shutdown();
  });
  console.error(`CodeRelay daemon listening on http://${options.host}:${options.port}${running.endpointPath}`);
}
