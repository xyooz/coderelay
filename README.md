# CodeRelay

**Turn ChatGPT into a local coding agent in 30 seconds.**

CodeRelay runs one local daemon, one secure tunnel, and serves multiple registered workspaces. Each ChatGPT MCP session selects its own workspace, so two chats can work on two projects without sharing a global “current project”.

```bash
npx coderelay
```

Or install it globally:

```bash
npm install --global coderelay
coderelay
```

## Quick start

Register projects once:

```bash
coderelay add ~/Projects/attendance
coderelay add ~/Projects/docseek
coderelay workspaces
```

Start the single daemon:

```bash
coderelay
```

Connect the one CodeRelay MCP app in ChatGPT. In each chat, ask CodeRelay to call `list_workspaces`, then `use_workspace` with the project name. The workspace selection belongs to that MCP session only.

The common tools are:

- `list_files`, `read_file`, and `search_code`
- `write_file` and `edit_file`
- `run_command`
- `git_diff`

Before using a file or command tool, a session must select a registered workspace. `use_workspace` accepts a registry name, never an arbitrary path.

## Secure transport

CodeRelay automatically prefers the official OpenAI Secure MCP Tunnel when all of these are available:

- `CONTROL_PLANE_API_KEY` in the environment
- a configured tunnel ID
- the official `tunnel-client` executable

The API key is read only from the environment. It is never written to the registry, project, or runtime state.

Configure a tunnel ID once for the daemon:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
coderelay --tunnel-id "tunnel_..."
```

When OpenAI transport is unavailable in automatic mode, CodeRelay falls back to a Cloudflare Quick Tunnel. No Cloudflare account or API key is required. An existing `cloudflared` on `PATH` is preferred; otherwise CodeRelay downloads a pinned official binary and verifies its SHA256 before execution.

Force a provider when needed:

```bash
coderelay --transport openai
coderelay --transport cloudflare
```

For local-only testing:

```bash
coderelay --no-tunnel
```

The daemon and local MCP server remain available while a public tunnel is warming up. `coderelay status` and `coderelay doctor` distinguish the local MCP process, transport process, and public endpoint.

For diagnosing MCP session behavior, start the daemon with request tracing enabled:

```bash
CODERELAY_MCP_TRACE=1 coderelay
```

The trace is written to the daemon server log under `~/.coderelay/daemon/logs/`. Each line records the JSON-RPC method, tool name, incoming and outgoing `Mcp-Session-Id`, transport session ID, internal session ID, route (`new`/`existing`/`missing`), and workspace binding before and after the request.

## Workspace registry

```bash
coderelay add <path> [--name <name>]
coderelay remove <name>
coderelay workspaces
coderelay status
coderelay stop
coderelay restart
coderelay doctor
```

Names default to the directory name. Collisions receive `-2`, `-3`, and so on. The registry stores canonical workspace roots in:

```text
~/.coderelay/workspaces.json
```

The daemon runtime and logs are kept outside projects:

```text
~/.coderelay/daemon/runtime.json
~/.coderelay/daemon/logs/
```

At session binding time, CodeRelay discovers root-level `AGENTS.md` and `AGENTS.override.md` and exposes their contents through `current_workspace`. They are read-only context; CodeRelay does not generate or modify them.

## Security defaults

CodeRelay binds the MCP server to `127.0.0.1`, protects the endpoint with a random path token, and rejects browser origins that do not match the request host.

Every file path is canonicalized and checked against the selected workspace. Symlink escapes, `..` traversal, and sensitive files are blocked. Commands run with `shell: false`; pipes, redirects, chaining, privilege escalation, destructive Git operations, and recursive deletion are rejected.

The endpoint is a local developer tool, not a replacement for reviewing proposed edits or commands.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run pack:check
```

The E2E suite covers one daemon, two MCP sessions, independent workspace bindings, concurrent access, workspace switching, traversal and symlink rejection, AGENTS context, and registry persistence.

## License

MIT
