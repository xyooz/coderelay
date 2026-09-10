# CodeRelay

**Turn ChatGPT into a local coding agent in 30 seconds.**

No Cloudflare account or API key is required when CodeRelay uses the default Cloudflare Quick Tunnel.

```bash
cd your-project
# One-time install (or use `npx coderelay` without installing globally)
npm install --global coderelay
coderelay
```

CodeRelay binds one isolated instance to the current workspace. When OpenAI Secure MCP Tunnel is configured, it starts the official `tunnel-client` automatically; otherwise it uses a Cloudflare Quick Tunnel. Then ask ChatGPT:

> Analyze this project and tell me how it is structured.

CodeRelay gives ChatGPT a small, safe toolset for your current repository:

- List and search code
- Read, create, and edit files
- Run tests and builds
- Inspect Git diffs
- Stay inside the workspace

## Requirements

- Node.js 20 or newer
- Git
- Internet access on first start so CodeRelay can download its tunnel runtime

CodeRelay prefers OpenAI Secure MCP Tunnel when `CONTROL_PLANE_TUNNEL_ID`, `CONTROL_PLANE_API_KEY`, and `tunnel-client` are available. The API key is read only from the environment and is never written to the project or runtime state. Install the official client from OpenAI Platform Tunnels or set `CODERELAY_TUNNEL_CLIENT` to its path.

For OpenAI Secure MCP Tunnel, bind a tunnel to a workspace once, then run CodeRelay normally:

```bash
export CONTROL_PLANE_API_KEY="sk-..." # restricted runtime key with Tunnels Read + Use
cd ~/Projects/a
coderelay --tunnel-id "tunnel_..."

# Later runs in this workspace only need:
coderelay
```

The tunnel ID is saved in `.coderelay/config.json` for this workspace. `--tunnel-id` overrides the saved value; `CONTROL_PLANE_TUNNEL_ID` is used only when neither is set. The API key is never written to disk.

If OpenAI Secure MCP Tunnel is not configured, CodeRelay falls back to a Cloudflare Quick Tunnel. It does not require a Cloudflare account, API key, `sudo`, or a package manager. If `cloudflared` is already on `PATH`, CodeRelay uses it; otherwise it downloads a verified platform binary into `~/.coderelay/bin/` and reuses it on later starts.

## Commands

```bash
coderelay              # same as coderelay start
coderelay start
coderelay ~/Projects/a
coderelay --name attendance-client
coderelay --tunnel-id tunnel_...
coderelay --transport openai
coderelay --transport cloudflare
coderelay list
coderelay status project-a
coderelay stop project-a
coderelay restart project-a
coderelay stop
coderelay status
coderelay doctor
coderelay restart
coderelay config show
```

The public Quick Tunnel may need a short warm-up after its URL is created. CodeRelay waits with bounded exponential backoff and retries the tunnel once if the public health check remains unavailable. During that time, the local MCP server stays running; use `coderelay status` or `coderelay doctor` to distinguish the local server, the `cloudflared` process, and the public endpoint.

The first run stores non-sensitive project settings in `.coderelay/config.json`. Runtime state and logs are isolated per instance:

```text
~/.coderelay/instances/<instance-name>/runtime.json
~/.coderelay/instances/<instance-name>/logs/
```

For local development or security checks without a tunnel:

```bash
coderelay start --no-tunnel
```

## Security defaults

CodeRelay binds the MCP server to `127.0.0.1`, uses a random token in the endpoint path, and rejects browser origins that do not match the request host.

File access is canonicalized and constrained to the workspace. Symlink escapes are rejected. Sensitive files are blocked by default, including:

```text
.env, .env.*, *.pem, *.key, id_rsa, id_ed25519, credentials, .aws/, .ssh/
```

Commands run without a shell, so pipes, redirects, command substitution, and shell chaining are rejected. The MVP also blocks `sudo`, `su`, shutdown/reboot tools, recursive `rm`, `git push`, `git reset --hard`, `git clean -fd`, and `git checkout -- .`.

This is a local developer tool, not a complete authorization framework. Review the endpoint and the model's proposed changes before accepting destructive edits.

## Generated state

The current workspace receives:

```text
.coderelay/config.json
```

Runtime state and logs live outside the repository. Multiple workspaces can run concurrently because each instance has its own MCP port, process state, logs, and transport.

The workspace `.coderelay/` directory is ignored by Git.

## How it works

```text
ChatGPT
   │
   │ MCP
   ▼
CodeRelay — project-a
   │
   ├── Read / Edit
   ├── Search
   ├── Test / Build
   └── Git Diff
   │
   ▼
Your Repository
```

```text
Local server:     127.0.0.1
Transport:        OpenAI Secure MCP Tunnel or Cloudflare Quick Tunnel
Workspace access: one isolated workspace per instance
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run pack:check
```

The MCP server is built with the official MCP TypeScript SDK and served over Streamable HTTP. The first release intentionally avoids GUI, multi-agent routing, memory, indexing, and cloud account features.

## License

MIT
