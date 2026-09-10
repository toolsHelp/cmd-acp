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

### The verified decision path

Established with beacons against command-code 1.53.0:

```
tool call
   |
   v
checkPermissions()
   |
   v
permissions.check()          ruleset: allow / ask / deny
   |
   v
resolveDecision()
   |
   v
confirm()
   |
   v
headlessInteraction.confirmTool()      <-- the only interactive hook
   |
   v
tool_denied
```

When a tool matches an `ask` rule, Command Code attaches a structured reason:

```json
{ "risk": { "kind": "ask-rule", "detail": "write_file" } }
```

### `createPrintPermissionGateMod` is legacy

An earlier release refused sensitive tools through a `beforeToolCall` mod
(`createPrintPermissionGateMod`). As of 1.53 that mod is present in the bundle
but no longer reaches a decision — the permission engine answers through
`confirmTool` instead.

The patcher therefore **detects it but never modifies it**. Rewriting dead code
would hide the day it becomes live again.

## Layering

```
headlessInteraction.confirmTool        (patched, one arrow function)
        |
        v
  PermissionProvider                   src/permission-provider.ts
        |
   +----+-----------------+
   |                      |
ConsolePermissionProvider  BrokerPermissionProvider
(no opinion: falls back    |
 to the built-in rules)    |
                    PermissionTransport
                           |
                    IpcPermissionTransport   src/ipc-transport.ts
                           |
                    named pipe / unix socket
```

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
| broker returns allow | tool runs |
| broker returns deny | `tool_denied` |
| non-risky tool | provider not consulted at all |

## Files

```
src/permission-provider.ts   provider + decision + risk types, Console/Broker
src/ipc-transport.ts         newline-delimited JSON over a local socket
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

When Command Code changes, locate the stub and re-derive the anchor:

```bash
grep -o 'confirmTool:__name(async({risk:[a-z]})[^}]*"confirmTool")' \
  <command-code>/dist/cli.mjs
```

Only `CONFIRM_ANCHOR` in `tools/command-code-patch/patch.mjs` needs updating;
no other file knows the bundle's shape.
