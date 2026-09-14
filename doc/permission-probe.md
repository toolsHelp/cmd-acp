# Why the patch exists — probe evidence

Behavioural evidence behind the patcher's rationale in
[`fork/command-code/README.md`](../fork/command-code/README.md): Command Code's
engine already decides `allow` / `ask` / `deny`, and already has a hook layer —
what it has no surface for is answering an `ask` at runtime.

## Question

Can a `PreToolUse` hook stand in for a runtime permission provider? Concretely:
does `permissionDecision: "allow"` let a write past the engine's refusal?

## Setup

- Stock Command Code **1.54.0** (`command-code/dist/cli.mjs`) — no cmd-acp patch,
  so the result is about the built-in engine rather than about this bridge.
- `-p "<prompt>" --output-format json`, no `--yolo`, mode `default`.
- Project-scoped `.commandcode/settings.json`.

The prompt pins the tool. Without that the model substitutes a different call
between runs and the arms stop being comparable — an initial uncontrolled run
appeared to show the `deny` arm *writing* the file, which did not reproduce.

```text
Use the write_file tool exactly once to create a file named probe.txt in the
current directory with the content "hi". Do not use any other tool, and do not
use the shell.
```

```jsonc
// .commandcode/settings.json — one arm, with the verdict varied
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write|edit",
        "hooks": [
          { "type": "command", "command": "node hook.mjs", "timeout": 30 }
        ]
      }
    ]
  }
}
```

The hook appends to a log file (to prove it ran) and prints its verdict:

```js
// hook.mjs — the arm's verdict is baked in
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  }),
)
```

## Results

| arm | hook returns | tool called | `probe.txt` | reason the engine gave |
|---|---|---|---|---|
| A | no hook | `write_file` | no | `requires permissions. Use --yolo … in print mode` |
| B | `"allow"` | `write_file` | no | *identical to A* |
| C | `"deny"` | `write_file` | no | `PreToolUse:Write File blocked: …` |

The hook fired in both B and C (its log file was written). In B the engine
emitted no `tool_hooks` frame at all — the only block came from the print-mode
permission gate. In C the hook's verdict is recorded and its reason reaches the
model.

## Key frames

Arms A and B — the engine's own refusal, identical in both:

```json
{"type":"tool_hook_blocked","toolName":"write_file","hookOutput":"Error: Tool \"write_file\" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode."}
```

Arm C — the hook's verdict, then the block:

```json
{"type":"tool_hooks","toolName":"write_file","phase":"pre","lines":[],"outcome":{"kind":"block","text":"PreToolUse:Write File blocked: probe: hook denied this write"}}
{"type":"tool_hook_blocked","toolName":"write_file","hookOutput":"probe: hook denied this write\n\n(Blocked by hook policy. Do not retry this tool — choose another approach or ask the user.)"}
```

## Reading

The engine's ladder is 13 rungs — deny rules, ask rules, external-directory gate,
plan gate, taste-directory, malformed writes, read-only fast path, root/home
breaker, bypass, sensitive-write ask, allow rules, auto-accept fast path, else
ask (denied under `dont-ask`) — and **there is no hook rung**. Hooks are a
separate, veto-only layer: `"allow"` means "this hook does not block", which is
the documented default ("empty stdout on exit `0` means no opinion, allow"),
while `"deny"` blocks and surfaces its reason to the model.

Two consequences:

- `permissions.allow` rules *can* grant, but they are static policy. They cannot
  hand an `ask` to an external party and take a live answer back — which is what
  an ACP client needs, per call.
- A hook therefore cannot replace a runtime decision provider. The patch supplies
  the decision source the engine has nobody to ask; it does not add a permission
  system.

The ladder, the modes and the hook schema are documented in the shipped
reference, `<command-code>/dist/bundled/command-code-knowledge/reference/`
(`permissions.md`, `hooks.md`) — that is the authority to check these claims
against, rather than the minified bundle.

## Reproducing

Run the same prompt three times against the stock CLI, varying only the hook's
`permissionDecision`, then inspect the emitted NDJSON. Keep the raw frames: the
outcome that matters is whether a `tool_hooks` frame appears at all, since an
`"allow"` verdict produces none.
