# OpenAI Secure MCP Tunnel PoC

This experiment connects CodeRelay's existing local MCP server to ChatGPT through OpenAI's Secure MCP Tunnel. The production branch now also manages `tunnel-client` as a transport provider; this harness remains useful for isolating the official client and for reproducing control-plane issues.

The flow is:

```text
CodeRelay local MCP
        │ http://127.0.0.1/.../mcp/<token>
        ▼
tunnel-client
        │ outbound HTTPS
        ▼
OpenAI Secure MCP Tunnel
        │
        ▼
ChatGPT developer-mode app → Connection: Tunnel
```

## Prerequisites

1. Create or select an OpenAI-hosted tunnel in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) and copy its `tunnel_id`.
2. Install the supported `tunnel-client` binary from Platform Tunnels.
3. Create a restricted runtime key with Tunnels **Read** + **Use**. Do not use an admin key for the long-running client.
4. Make sure the tunnel is associated with the ChatGPT workspace where the developer-mode app will be created.
5. Build CodeRelay from the repository root.

The current shell must contain the credentials below. The API key is never passed as a CLI argument or written into the PoC files.

```bash
export CONTROL_PLANE_TUNNEL_ID="tunnel_0123456789abcdef0123456789abcdef"
export CONTROL_PLANE_API_KEY="sk-..."
```

## Run

From the CodeRelay repository root:

```bash
npm run build
node experiments/openai-secure-mcp/run.mjs --workspace /absolute/path/to/your/repository
```

The harness will:

1. start CodeRelay with `--no-tunnel` in an isolated temporary runtime directory;
2. capture the tokenized local MCP endpoint;
3. start `tunnel-client` with `--mcp-server-url` pointing at that endpoint;
4. wait for the client's `/readyz` health check; and
5. print the ChatGPT Tunnel connection steps.

For a nonstandard binary location:

```bash
node experiments/openai-secure-mcp/run.mjs \
  --workspace /absolute/path/to/your/repository \
  --tunnel-client /absolute/path/to/tunnel-client
```

Leave the command running while ChatGPT discovers the tunnel and calls the MCP tools. Press `Ctrl-C` to stop both the OpenAI tunnel client and the temporary CodeRelay runtime.

## ChatGPT verification

In ChatGPT web, create a developer-mode app and choose **Connection: Tunnel**. Select the tunnel or paste the same `tunnel_id`, then scan the tools. Verify the existing CodeRelay tools with a read-only request first, followed by an explicitly confirmed edit request.

If the tunnel is not listed, check that the tunnel is associated with the target ChatGPT workspace and that the connector operator has Tunnels **Read** + **Use**. If the client is not ready, inspect its terminal output and the local `/ui` page printed by the harness.

## Scope boundary

The harness does not create OpenAI tunnels, API keys, or ChatGPT apps. It does not add MCP tools or implement the Secure MCP Tunnel protocol. CodeRelay starts the official `tunnel-client` and keeps the API key in the process environment only. The stable Cloudflare Quick Tunnel path remains available as the automatic fallback.
