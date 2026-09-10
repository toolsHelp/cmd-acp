# Command Code fork — permission provider

Adds a pluggable permission decision source to Command Code's headless
(`-p`) mode.

## Why a fork at all

Command Code's print harness refuses five tools outright:

```js
DE = new Set(["edit_file","write_file","shell_command","monitor_command","kill_shell"])
```

There is no hook, plugin or config surface that can intercept that decision —
it is a `beforeToolCall` mod returning `{ block: true }` inside the minified
`dist/cli.mjs`. So the only way to add a human-in-the-loop flow is to patch the
bundle.

**Scope of the patch is deliberately one arrow function body.** Everything
around it — the enclosing `createPrintPermissionGateMod`, its `id`, the
`__name(...)` registration and the `resolvePrintHarnessMods` caller — is left
untouched.

## Layering

```
print-permission-gate            (patched, 1 arrow function)
        |
        v
  PermissionProvider             src/permission-provider.ts
        |
   +----+-----------------+
   |                      |
ConsolePermissionProvider  BrokerPermissionProvider
(default = built-in        |
 behaviour)                |
                    PermissionTransport
                           |
                    IpcPermissionTransport   src/ipc-transport.ts
                           |
                    named pipe / unix socket
```

There is no knowledge of ACP, Paseo, sessions-as-protocol or pipes above
`PermissionTransport`. A future transport only has to implement:

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

`always_allow` is separate from `allow` so a client can express a policy change
("allow this tool from now on") rather than a one-shot approval.

## Activation

| Environment | Provider | Behaviour |
|---|---|---|
| `CMD_ACP_PERMISSION_BROKER` unset | `ConsolePermissionProvider` | Identical to unpatched Command Code (fail-closed) |
| `CMD_ACP_PERMISSION_BROKER` set | `BrokerPermissionProvider` | Asks the broker; unavailable broker → deny |

Optional:

- `CMD_ACP_PERMISSION_TIMEOUT_MS` — `0`/unset waits indefinitely (matches
  interactive clients, which have no timeout)
- `COMMAND_CODE_SESSION` — forwarded as `sessionId` for multi-session brokers

## Failure policy

Every error path resolves to **deny**: unreachable broker, malformed frame,
connection close, timeout. An allow is only ever returned when the broker
explicitly says so.

## Files

```
src/permission-provider.ts   provider + decision types, Console/Broker impls
src/ipc-transport.ts         newline-delimited JSON over a local socket
src/bootstrap.ts             env-driven provider selection (cached per process)
```

## Build and patch

```bash
# compile the provider modules into the patcher's dist/
bun build fork/command-code/src/bootstrap.ts \
  --outfile tools/command-code-patch/dist/provider.mjs --target node --format esm

# patch a copy (never the global install during development)
node tools/command-code-patch/patch.mjs <command-code-dir> \
  --output fork/cc/dist/cli.mjs
```

The patcher fails loudly when the anchor stops matching, so an upstream change
cannot result in a silently unpatched or mispatched bundle.

## Upstream re-anchoring

When Command Code changes, locate the gate and re-derive the anchor:

```bash
grep -o 'async({toolName:[a-z]})[^}]*printPermissionDeniedMessage([a-z])}}' \
  <command-code>/dist/cli.mjs
```

Only `GATE_ARROW_ANCHOR` in `tools/command-code-patch/patch.mjs` needs updating;
no other file knows the bundle's shape.
