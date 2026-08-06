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
| `initialize` | ACP v1, `concurrent_sessions: false`, `load_session: false`, `terminal: false` |
| `session/new` | Records `cwd`; lazy — no `cmd` spawn yet |
| `session/prompt` | Runs `cmd -p "<text>" --output-format json` in the session `cwd` |
| `session/cancel` | SIGINT to the child `cmd` process |
| `session/close` | Kills child, clears session state |
| `session/set_config_option` | `model` → `--model`, `reasoning` → `--effort`, `permission_mode` → `--permission-mode` |

## Permissions

`cmd -p` is one-shot: there is **no interactive permission request** mid-turn
(unlike native ACP agents such as OpenCode).

- **Safe mode (default)**: run `cmd` **without** `--yolo`. Command Code itself
  blocks file edits and shell commands (fail-closed). The client sees tool calls
  as a log, not as a prompt gate.
- **`--yolo` mode**: opt-in via the `permission_mode` config option, for users
  who want edits and shell execution without a gate.

The client's own permission engine still applies at session level.

## Config options

- `model` — select a Command Code model (from `cmd --list-models`).
- `reasoning` — `--effort` level (`low`, `medium`, `high`).
- `permission_mode` — `safe` (default) or `yolo`.

## Development

```bash
bun install
bun test          # deterministic fake CLI — no real cmd needed
bun run build     # bundle to dist/
```

## License

MIT
