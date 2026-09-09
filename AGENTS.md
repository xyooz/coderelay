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

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build` before opening a pull request.
