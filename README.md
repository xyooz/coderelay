# CodeRelay

**Turn ChatGPT into a local coding agent in 30 seconds.**

CodeRelay runs one local daemon, one secure tunnel, and serves multiple registered workspaces. Each ChatGPT chat can keep a separate logical task context, so two chats can work on two projects without sharing a global “current project”.

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

Connect the one CodeRelay MCP app in ChatGPT. Treat one ChatGPT chat as one logical task context: ask CodeRelay to call `list_workspaces`, then `use_workspace` with the project name. CodeRelay returns the workspace identity and instructions for the task. For clients that recreate MCP sessions, workspace-scoped tools also accept the registered workspace name explicitly; explicit workspace takes precedence over the transport session cache.

The common tools are:

- `list_files`, `read_file`, and `search_code`
- `write_file` and `edit_file`
- `run_command`
- `git_diff`

Before using a file or command tool, either pass `workspace: "project-name"` or call `use_workspace` first. `workspace` accepts only a registry name or id, never an arbitrary path. `use_workspace` sets the default for the logical task context; when the user explicitly asks to work in another registered project, pass that workspace on the relevant call.

For example:

```text
use_workspace({ name: "attendance" })
read_file({ workspace: "attendance", path: "README.md" })
run_command({ workspace: "attendance", command: "npm test" })
```

## Secure transport

The first interactive `coderelay` run can guide you through transport setup. You can also open it explicitly:

```bash
coderelay setup
```

CodeRelay supports four transports:

- `openai` — OpenAI Secure MCP Tunnel, preferred when configured
- `cloudflare-named` — a remotely-managed Cloudflare tunnel connector (local-management remains supported for advanced setups)
- `cloudflare-quick` — zero-configuration fallback
- `local` — loopback only, equivalent to local testing

Choose a transport for the current run without changing saved preferences:

```bash
coderelay --transport openai
coderelay --transport cloudflare-named
coderelay --transport cloudflare-quick
coderelay --transport local
coderelay --no-tunnel
```

Saved non-secret settings live in `~/.coderelay/config.json`. The OpenAI API key, if saved, lives separately in `~/.coderelay/credentials.json` with mode `0600`; `~/.coderelay` is kept at mode `0700`.

OpenAI credentials use this precedence:

1. `CONTROL_PLANE_API_KEY`
2. the local credentials file
3. missing

Manage the local credential without revealing it:

```bash
coderelay auth openai
coderelay auth status
coderelay auth logout
```

The OpenAI tunnel ID uses CLI `--tunnel-id` first, then saved config, then `CONTROL_PLANE_TUNNEL_ID`. The key is never written to project config, runtime state, logs, traces, status output, or command-line arguments.

OpenAI transport uses the official `tunnel-client`. When automatic selection cannot use it, CodeRelay explicitly reports the reason and falls back to `cloudflare-quick`. No Cloudflare account or API key is required for a Quick Tunnel. An existing `cloudflared` on `PATH` is preferred; otherwise CodeRelay downloads a pinned official binary and verifies its SHA256 before execution.

For a Cloudflare Named Tunnel, the setup flow uses a remotely-managed tunnel: create a Tunnel in the [Cloudflare dashboard](https://dash.cloudflare.com/), add a Published Application with service `http://127.0.0.1:7676`, choose “Install and run a connector”, and paste the connector command or token into CodeRelay. The token is kept in `~/.coderelay/credentials.json` with mode `0600`; the hostname and management mode are stored separately in `~/.coderelay/config.json`. Locally-managed tunnels remain supported by setting `cloudflare.management` to `local` and providing the existing local config and credentials.

Inspect the saved non-secret settings with:

```bash
coderelay config show
coderelay config transport openai
```

For local-only testing:

```bash
coderelay --no-tunnel
```

The daemon and local MCP server remain available while a public tunnel is warming up. `coderelay status` and `coderelay doctor` distinguish the local MCP process, transport process, and public endpoint. Missing credentials and setup problems include the relevant official remediation links.

For diagnosing MCP session behavior, start the daemon with request tracing enabled:

```bash
CODERELAY_MCP_TRACE=1 coderelay
```

The trace is written to the daemon server log under `~/.coderelay/daemon/logs/`. Each line records the JSON-RPC method, tool name, incoming and outgoing `Mcp-Session-Id`, transport session ID, internal session ID, route (`new`/`existing`/`missing`), explicit workspace, session-cached workspace, resolved workspace, resolution source, and workspace binding before and after the request.

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
