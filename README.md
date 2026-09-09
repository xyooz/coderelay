# CodeRelay

**Turn ChatGPT into a local coding agent in 30 seconds.**

No API key. No copy-paste. No manual MCP configuration.

```bash
cd your-project
npx coderelay
```

Then add the printed MCP endpoint to ChatGPT and ask:

> Analyze this project and tell me how it is structured.

CodeRelay gives ChatGPT a small, safe toolset for your current repository:

- List and search code
- Read, create, and edit files
- Run tests and builds
- Inspect Git diffs
- Stay inside the workspace

## Requirements

- Node.js 22 or newer
- Git
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on `PATH` for the public MCP endpoint

CodeRelay uses a Cloudflare Quick Tunnel. It does not require a Cloudflare account or API key. The tunnel URL is temporary and changes when CodeRelay restarts.

## Commands

```bash
coderelay              # same as coderelay start
coderelay start
coderelay stop
coderelay status
coderelay doctor
coderelay restart
coderelay config show
```

For local development or security checks without a public endpoint:

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

Runtime state and logs live outside the repository:

```text
~/.coderelay/runtime.json
~/.coderelay/logs/
```

The workspace `.coderelay/` directory is ignored by Git.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The MCP server is built with the official MCP TypeScript SDK and served over Streamable HTTP. The first release intentionally avoids GUI, multi-agent routing, memory, indexing, and cloud account features.

## License

MIT
