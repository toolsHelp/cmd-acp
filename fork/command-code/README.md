# Command Code fork — permission provider

Adds a pluggable permission decision source to Command Code's headless
(`-p`) mode.

## Why a patch is needed

Command Code has no configuration or plugin surface that can answer a
permission prompt in print mode. The decision is produced by a stub inside
`headlessInteraction(...)`:

```js
function headlessInteraction(e = {}) {
  return {
    confirmTool: async ({risk}) =>
      risk !== undefined ? "deny" : (e.autoAllow ? "allow" : "deny"),
    askQuestion: async ({questions}) => /* auto-selects the first option */,
  }
}
```

`askQuestion` picking the first option is why an unattended run never shows a
prompt. `confirmTool` never consults anything external, so there is nothing to
configure — the bundle has to be patched.

### Two checkpoints, not one

A sensitive tool is refused in **two** independent places, and both must agree:

```
tool call
   |
   +--> checkPermissions --> permissions.check --> resolveDecision --> confirm
   |                                                                      |
   |                                                     (1) confirmTool   <-- decision
   |                                                              |
   |                                       allowance recorded in grantStore
   |
   +--> (2) beforeToolCall        <-- execution guard
              |
              v
         execute / block
```

**(1) `headlessInteraction.confirmTool`** is the only place print mode consults
anyone. Unpatched:

```js
confirmTool: async ({risk}) =>
  risk !== undefined ? "deny" : (e.autoAllow ? "allow" : "deny")
```

**(2) `createPrintPermissionGateMod.beforeToolCall`** blocks five tool families
outright, without asking anyone and without seeing (1)'s verdict:

```js
BLOCKED = new Set(["edit_file", "write_file", "shell_command",
                   "monitor_command", "kill_shell"])
```

Patching only (1) never lets a tool run — (2) blocks it afterwards. Both are
patched. `--yolo` skips (2) entirely (`resolvePrintHarnessMods` returns `[]`),
which is why `--yolo` can write.

Argument shapes differ, and it matters (probed on a running bundle):

| hook | argument keys |
|---|---|
| `confirmTool` | `toolName, input, description, signal, explain` — **no id** |
| `beforeToolCall` | `toolCallId, toolName, input, state` |

Because there is no shared id, (1) records its decision in a grant store keyed
on `toolName` + a stable hash of the input, and (2) consumes it. One prompt,
both gates satisfied. See `src/grant-store.ts`.

When a tool matches an `ask` rule, Command Code attaches a structured reason:

```json
{ "risk": { "kind": "ask-rule", "detail": "write_file" } }
```

## Layering

```
(1) headlessInteraction.confirmTool \
                                     >-- PermissionGrantStore (shared decision)
(2) beforeToolCall (execution gate) /              |
                                                   v
                                        PermissionProvider
                                          src/permission-provider.ts
                                                   |
                              +--------------------+--------------------+
                              |                                         |
              ConsolePermissionProvider                    BrokerPermissionProvider
              (no opinion: falls back                                  |
               to the built-in rules)                         PermissionTransport
                                                                       |
                                                          IpcPermissionTransport
                                                             src/ipc-transport.ts
                                                                       |
                                                          named pipe / unix socket
```

Both hooks dynamically import the same module URL, so **module scope is what
makes the grant store shared** — no `globalThis` plumbing.

Nothing above `PermissionTransport` knows about ACP, named pipes or any
particular client. A future transport only has to implement:

```ts
interface PermissionTransport {
  request(ctx: PermissionContext): Promise<PermissionDecision>
}
```

## Decisions

```ts
type PermissionDecision =
  | { type: "allow" }
  | { type: "always_allow" }
  | { type: "deny"; message: string }
```

Two fields carry meaning beyond the verdict:

- **`always_allow`** is separate from `allow` so a client can express a policy
  change ("allow this tool from now on") rather than a one-shot approval.
- **`explicit`** distinguishes "a real party answered deny" from "nobody
  answered". The patched `confirmTool` only honours an explicit denial;
  otherwise it falls through to the built-in rules, so an absent provider
  behaves exactly like the unpatched bundle instead of becoming a blanket
  denial.

`risk` is passed through as structured data rather than flattened to a boolean,
so a policy layer can later tell "the user asked to be prompted for this tool"
apart from "this operation is inherently risky".

## Activation

| Environment | Provider | Behaviour |
|---|---|---|
| `CMD_ACP_PERMISSION_BROKER` unset | `ConsolePermissionProvider` | Identical to unpatched Command Code |
| `CMD_ACP_PERMISSION_BROKER` set | `BrokerPermissionProvider` | Asks the broker; unavailable broker denies |

Optional:

- `CMD_ACP_PERMISSION_TIMEOUT_MS` — `0`/unset waits indefinitely (matches
  interactive clients, which have no timeout)
- `COMMAND_CODE_SESSION` — forwarded as `sessionId` for multi-session brokers

## Failure policy

Every error path falls through to the original stub, and the broker transport
denies on any error. An allow is only ever returned when a broker explicitly
says so. Verified cases:

| Case | Result |
|---|---|
| no broker configured | built-in rules apply (unchanged) |
| unreachable broker | denied (fails closed) |
| broker returns allow | grant recorded; execution gate stands down; tool runs |
| broker returns deny | `tool_denied`; execution gate never reached |
| grant expired or decision gate bypassed | execution gate asks again (never assumes) |
| non-risky tool | provider not consulted at all |

## Files

```
src/permission-provider.ts   provider + decision + risk types, Console/Broker
src/ipc-transport.ts         newline-delimited JSON over a local socket
src/grant-store.ts           one-shot grants shared by the two hooks
src/bootstrap.ts             env-driven provider selection (cached per process)
```

## Build and patch

```bash
# compile the provider module into the patcher's dist/
bun run build:patcher

# inspect what would change, without writing anything
node tools/command-code-patch/patch.mjs <command-code-dir> --check

# patch a copy (never the global install during development)
node tools/command-code-patch/patch.mjs <command-code-dir> \
  --output fork/cc/dist/cli.mjs
```

The patcher fails loudly when the anchor stops matching, so an upstream change
cannot result in a silently unpatched or mispatched bundle.

## Upstream re-anchoring

**The anchors are patterns, not literal strings.** The bundle is minified and
its short identifiers are not stable across releases: Command Code updated
itself 1.53.0 → 1.53.1 mid-session and the blocked-tool set went from `DE` to
`OE`, which silently broke a literal anchor. The patterns capture the
identifiers and the replacements reuse them, so the fallback compiles against
whatever names the bundle actually uses.

When Command Code changes, first look at what is actually in the bundle:

```bash
# decision gate — its body contains quotes, so match lazily rather than [^"]*
grep -o 'confirmTool:__name(async({risk:[a-zA-Z0-9_$]*}).*"confirmTool")' \
  <command-code>/dist/cli.mjs

# execution guard — the set name is not stable (DE in 1.53.0, OE in 1.53.1)
grep -o 'beforeToolCall:__name(async({toolName:[a-zA-Z0-9_$]*}).*"beforeToolCall")' \
  <command-code>/dist/cli.mjs
```

Both should print exactly one line. If either prints none or more than one,
the bundle changed shape and the pattern needs re-deriving before patching.

Then update `CONFIRM_ANCHOR_RE` / `GATE_ANCHOR_RE` in
`tools/command-code-patch/patch.mjs` and the literal `*_ANCHOR` constants used
by the tests. No other file knows the bundle's shape.

`--check` reports how many times each anchor matched; the patcher refuses to
apply when either count is not exactly 1.
