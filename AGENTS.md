# CodeRelay contributor notes

## Scope

CodeRelay is a small TypeScript CLI that exposes a local workspace through MCP. Keep the MVP focused on setup, safe local access, useful coding tools, and self-diagnosis.

## Security invariants

- Every file path must go through `resolveWorkspacePath`.
- Never follow symlinks outside the workspace.
- Never expose sensitive file patterns from `sensitive-files.ts`.
- Commands must be parsed and executed with `shell: false`.
- Keep the MCP server bound to loopback.
- Do not add a new tunnel provider without preserving the `TunnelProvider` interface.
- Treat a Quick Tunnel URL as provisional until the public health check passes.
- A public health-check timeout must not terminate a healthy local MCP server; keep the transport state visible as `starting` or `degraded`.
- Automatic tunnel downloads must use a pinned official release and verify SHA256 before execution.
- Prefer a user-installed `cloudflared` on `PATH` before the CodeRelay cache.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build` before opening a pull request.
