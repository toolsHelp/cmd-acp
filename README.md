# cmd-acp

Expose **Command Code** (`cmd`) as an **Agent Client Protocol (ACP)** agent over stdio.

Command Code does not ship a native ACP mode, but its headless mode emits a
machine-readable NDJSON stream (`cmd -p --output-format json`). `cmd-acp` is a
small bridge that speaks ACP (JSON-RPC 2.0 over stdio) to ACP-compatible clients
such as [Circulo](https://github.com/soycanopa/circulo), Zed, JetBrains, and
others, and drives `cmd` underneath — one `cmd -p` process per prompt.

## Why

- ACP clients spawn an external agent subprocess and talk JSON-RPC over stdio.
- `cmd` already exposes everything needed: NDJSON events + a final result line.
- No PTY hacks or database parsing needed (unlike some adapters).

## Install

```bash
npm i -g cmd-acp
# or run on demand:
npx -y cmd-acp
```

Prerequisites:

- [Command Code](https://commandcode.ai) installed: `cmd` on `PATH` (Node >= 22).
- Authenticated once: `cmd login`.

Override the `cmd` / `cmd-acp` binaries with env vars if needed:

```bash
CMD_BIN=/path/to/cmd CMD_ACP_BIN=/path/to/cmd-acp cmd-acp
```

## Usage in an ACP client

Point your ACP client at the `cmd-acp` binary:

```json
{
  "command": "cmd-acp"
}
```

Or via npx:

```json
{
  "command": "npx",
  "args": ["-y", "cmd-acp"]
}
```

## Protocol support

| ACP method | Behavior |
|---|---|
| `initialize` | ACP v1, `load_session: false` |
| `session/new` | Records `cwd`; materializes injected MCP servers into `.mcp.json`; returns `configOptions` |
| `session/prompt` | Runs `cmd -p "<text>" --output-format json` in the session `cwd`; from turn 2 resumes via `--resume <cmdSessionId>` |
| `session/cancel` | SIGINT to the child `cmd` process |
| `session/close` | Kills child, restores any pre-existing `.mcp.json`, clears session state |
| `session/set_config_option` | `model` → `--model`, `reasoning` → `--effort`, `permission_mode` → `--yolo`, `mode` → `--plan` |

## Permissions

`cmd -p` is one-shot: there is **no interactive permission request** mid-turn
(unlike native ACP agents such as OpenCode).

- **Safe mode (default)**: run `cmd` **without** `--yolo`. Command Code itself
  blocks file edits and shell commands (fail-closed). The client sees tool calls
  as a log, not as a prompt gate.
- **`--yolo` mode**: opt-in via the `permission_mode` config option, for users
  who want edits and shell execution without a gate.
- **Plan mode**: the `mode` config option (`plan`) runs `cmd -p --plan` for
  read-only exploration.

The client's own permission engine still applies at session level.

## Config options

- `model` — select a Command Code model (from `cmd --list-models`).
- `reasoning` — `--effort` level (`low`, `medium`, `high`).
- `permission_mode` — `safe` (default) or `yolo`.
- `mode` — `normal` (default) or `plan` (read-only).

## Features

- **Conversation continuity**: each turn runs `cmd -p --resume <cmdSessionId>`
  from the 2nd turn on, so Command Code keeps the full conversation context.
- **Usage tracking**: emits ACP `usage_update` with the token usage from the
  result frame, so clients can show token consumption.
- **MCP passthrough**: MCP servers a client injects on `session/new` are written
  to a temporary `.mcp.json` in the session cwd (restored on close), so Command
  Code can use those tools.

## Standalone binaries

Pre-compiled standalone binaries (no Node runtime needed) are attached to each
[GitHub Release](https://github.com/soycanopa/cmd-acp/releases):

- `cmd-acp-darwin-arm64` / `cmd-acp-darwin-x64` (macOS)
- `cmd-acp-linux-x64` / `cmd-acp-linux-arm64` (Linux)
- `cmd-acp-windows-x64.exe` (Windows)

## Development

```bash
bun install
bun test          # deterministic fake CLI — no real cmd needed
bun run build     # bundle to dist/
```

## License

MIT
