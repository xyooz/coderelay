import http from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "./tools.js";

export interface ServeOptions {
  workspaceRoot: string;
  host: string;
  port: number;
  token: string;
}

export interface RunningServer {
  server: http.Server;
  endpointPath: string;
  close: () => Promise<void>;
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

/** Start one loopback MCP endpoint protected by an unguessable URL path. */
export async function startMcpServer(options: ServeOptions): Promise<RunningServer> {
  const endpointPath = `/mcp/${options.token}`;
  const handler = createMcpHandler(() => createMcpServer({ workspaceRoot: options.workspaceRoot }));
  const nodeHandler = toNodeHandler(handler);

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      writeJson(response, 200, { ok: true, name: "coderelay", version: "0.1.0" });
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
  console.error(`CodeRelay MCP server listening on http://${options.host}:${options.port}${running.endpointPath}`);
}
