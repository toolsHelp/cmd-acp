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

`cmd -p` is one-shot, so by default there is **no interactive permission
request** mid-turn (unlike native ACP agents such as OpenCode). With a
**patched Command Code bundle** (see
[Patching Command Code](#patching-command-code)), cmd-acp turns that refusal
into a real `session/request_permission` call and the connected client decides.

- **Safe mode (default)**: the client is asked before `edit_file`,
  `write_file`, `shell_command`, `monitor_command` and `kill_shell`. Without a
  patch, or with no broker reachable, Command Code keeps its own fail-closed
  behaviour.
- **`--yolo` mode**: opt-in via the `permission_mode` config option. Command
  Code skips its execution guard entirely and no broker is started.
- **Plan mode**: the `mode` config option (`plan`) runs `cmd -p --plan` for
  read-only exploration. Command Code enforces this ahead of any permission
  prompt — in plan mode, writes outside `~/.commandcode/plans/` are refused by
  Command Code itself, not by this bridge.

Switching mode mid-session takes effect on the next prompt: a resumed Command
Code session carries the mode it was created with, so cmd-acp starts one fresh
turn after a change and resumes again afterwards.

Full protocol — the two checkpoints inside Command Code, the broker wire
format, and the ACP option mapping — lives in
[`doc/architecture/permission-flow.md`](doc/architecture/permission-flow.md).

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

## Patching Command Code

Interactive permissions need a patched Command Code bundle. The patch replaces
two checkpoints that refuse sensitive tools in print mode, so both consult the
provider before deciding. Command Code itself is never modified in place unless
you ask for it.

```bash
bun run build:patcher    # compile the provider the patch injects
bun run link:fork-deps   # let the output directory resolve Command Code's deps

# inspect first — writes nothing
node tools/command-code-patch/patch.mjs <command-code-dir> --check

# patch a copy, leaving the installed CLI alone
node tools/command-code-patch/patch.mjs <command-code-dir> \
  --output fork/cc/dist/cli.mjs
```

Then point the bridge at it:

```bash
CMD_ENTRY=/path/to/fork/cc/dist/cli.mjs
```

`bun run build:all` runs both preparation steps above, plus the `dist/` build.
The patched bundle is a copy of Command Code's own, so it resolves dependencies
through the linked `node_modules`; re-run `link:fork-deps` after switching Node
versions, since the link follows the running Node's install directory rather than
a fixed path.

The patcher refuses to apply unless both anchors match exactly once, so an
upstream change cannot silently produce a half-patched bundle. Anchors are
patterns that follow the bundle's minified identifiers rather than assuming
them.

- `CMD_ACP_PERMISSION_BROKER` is injected automatically by cmd-acp; an
  unpatched Command Code simply never connects.
- `CMD_ACP_PERMISSION_TRACE=<path>` appends one JSON line per permission
  request, response and error. Off by default.

See [`fork/command-code/README.md`](fork/command-code/README.md) for the
provider layering and
[`doc/architecture/permission-flow.md`](doc/architecture/permission-flow.md)
for the full protocol.

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
