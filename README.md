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

Register projects once. Registration is explicit local authorization; starting CodeRelay never silently registers the current directory:

```bash
coderelay add ~/Projects/attendance
coderelay add ~/Projects/docseek
coderelay workspaces
```

If the registry is empty, `coderelay` still starts the daemon but prints the next local step:

```text
No workspaces registered.
Register one with:
  coderelay add .
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
run_command({ workspace: "attendance", command: { program: "npm", args: ["test"] } })
```

## Agent Command Runtime

`run_command` accepts a structured command, or a sequential list of structured commands:

```json
{
  "commands": [
    { "program": "npm", "args": ["run", "typecheck"] },
    { "program": "npm", "args": ["test"] }
  ],
  "stop_on_error": true,
  "timeout_ms": 120000
}
```

Legacy string commands remain supported for compatibility, but shell operators are rejected. Every command runs with `shell: false`, inside the selected workspace, with bounded output and an explicit timeout. The result includes exit code, signal, duration, timeout, truncation, stdout, stderr, risk, policy, and approval state.

The command policy defaults to `safe`. Higher-risk commands return `approval_required` instead of running immediately. Approve or deny the request from the local terminal:

```bash
coderelay approve <request_id> --once
coderelay approve <request_id> --workspace
coderelay deny <request_id>
```

The available modes are:

```bash
coderelay config policy safe
coderelay config policy workspace
coderelay config policy unrestricted
coderelay trust <workspace-name>
coderelay untrust <workspace-name>
coderelay trust status
coderelay policy list
coderelay policy remove <rule-id>
```

Workspace approvals are exact-match rules: the workspace, program, argument count, and every argument must match. `coderelay policy list` labels the stored arguments as `ARGS (EXACT MATCH)`; approving `git push origin main` does not approve `git push origin main --force`.

`workspace` mode allows inspection by default and requires a trusted workspace for workspace writes or execution. Network, external writes, destructive, and privileged operations still require approval. `unrestricted` removes those approval prompts except for hard-denied commands such as deleting the filesystem root. The policy store and pending approvals are kept under `~/.coderelay/policies/` with restrictive permissions; the audit log is `~/.coderelay/audit.log` and does not include command output, environment variables, or inline credentials.

Command policy is authoritative on the user side (`~/.coderelay/config.json` and the policy store). A project-controlled `.coderelay/config.json` cannot widen the daemon policy; any future project-level policy must only make it stricter.

The workspace policy is a boundary for CodeRelay decisions, not an OS sandbox. Even trusted workspace execution can access files outside the workspace or the network through scripts and tools. True filesystem and network isolation requires a later OS-level sandbox implementation.

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

The MCP endpoint path token is generated once with a cryptographically secure random source and is also kept in `~/.coderelay/credentials.json`. It survives daemon restarts and transport changes. Show the active endpoint with:

```bash
coderelay endpoint
```

To invalidate the old URL and issue a new token:

```bash
coderelay endpoint rotate
```

The rotate command restarts a running daemon so the old endpoint immediately stops responding.

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
coderelay prune
coderelay status
coderelay stop
coderelay restart
coderelay doctor
coderelay endpoint
coderelay endpoint rotate
```

Names default to the directory name. Collisions receive `-2`, `-3`, and so on. The registry stores canonical workspace roots in:

```text
~/.coderelay/workspaces.json
```

`coderelay remove` and `coderelay prune` revoke trust, persisted workspace approval rules, and pending approvals before removing the registry entry. They never delete files in the real workspace directory. `prune` targets roots that no longer exist or whose canonical path changed. Workspace lifecycle changes are local CLI operations; the MCP server only exposes `list_workspaces`, `use_workspace`, and `current_workspace` for workspace selection.

The daemon runtime and logs are kept outside projects:

```text
~/.coderelay/daemon/runtime.json
~/.coderelay/daemon/logs/
```

At session binding time, CodeRelay discovers root-level `AGENTS.md` and `AGENTS.override.md` and exposes their contents through `current_workspace`. They are read-only context; CodeRelay does not generate or modify them.

## Security defaults

CodeRelay binds the MCP server to `127.0.0.1`, protects the endpoint with a random path token, and rejects browser origins that do not match the request host.

Every file path is canonicalized and checked against the selected workspace. Symlink escapes, `..` traversal, and sensitive files are blocked. Commands run with `shell: false`; pipes, redirects, and chaining are rejected. Risky operations go through the configured policy and local approval flow, while hard-denied commands remain blocked in every mode.

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
