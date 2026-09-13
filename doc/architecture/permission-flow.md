# Permission flow

How a tool call in Command Code ends up as a prompt in an ACP client, and how
the answer gets back. Every claim here was verified against a running bundle
(Command Code 1.53.1, ACP SDK 1.3.0, Paseo) — the evidence is listed at the
bottom so the reasoning can be re-checked when a release changes things.

```
                        ┌──────────────────────────────────────┐
                        │  Command Code (patched, print mode)  │
                        └──────────────────────────────────────┘

   tool call
       │
       ├──► checkPermissions ──► permissions.check ──► resolveDecision
       │                                                     │
       │                                              (1) confirmTool
       │                                                     │
       ├─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
       │         grant recorded ──► PermissionGrantStore
       │
       └──► beforeToolCall  (2)  ──► consume grant, or ask again
                │
                ▼
           execute tool
```

**The two checkpoints are the single most important thing here.** Command Code
1.53 refuses a sensitive tool in two places, and both must agree. Patching only
`confirmTool` never lets a tool run — `beforeToolCall` blocks it afterwards.

---

## 1. Command Code side

### The two checkpoints

**(1) `headlessInteraction.confirmTool` — the decision gate.**

Unpatched it is a stub that has no way to reach a user:

```js
confirmTool: async ({risk}) =>
  risk !== undefined ? "deny" : (autoAllow ? "allow" : "deny")
```

This is the only place print mode consults anyone about a tool, which is why
"headless" means "always refuses" by default.

Its argument (probed on a running bundle):

```json
{ "toolName": "write_file", "input": {...}, "description": null,
  "signal": "<AbortSignal>", "explain": "<fn>" }
```

**No tool-call id, no session id.** That constraint drives the grant design
below.

**(2) `createPrintPermissionGateMod.beforeToolCall` — the execution guard.**

```js
beforeToolCall: async ({toolName}) => {
  if (BLOCKED.has(toolName)) return { block: true, additionalContext: ... }
}
```

with

```js
BLOCKED = new Set(["edit_file", "write_file", "shell_command",
                   "monitor_command", "kill_shell"])
```

It does not ask anyone and does not see the decision gate's verdict. Its
argument *does* carry an id:

```json
{ "toolCallId": "call_<hex>", "toolName": "write_file",
  "input": {...}, "state": { "sessionId": "...", "messages": [...] } }
```

`--yolo` skips this entirely — `resolvePrintHarnessMods` returns `[]` instead of
the gate module, which is why `--yolo` can write.

### Ordering

The decision gate always runs first. Measured gap between the two hooks for a
single `write_file`: ~2-4 ms. A grant recorded by the first is therefore never
stale when the second looks for it.

### How the patch is applied

`tools/command-code-patch/patch.mjs` rewrites both functions. Constraints the
injection site imposes:

- the `__name` wrapper must survive (it is how the bundle names functions)
- no top-level imports — the surrounding scope is a minified bundle, so the
  provider is imported lazily inside the call
- any failure must fall through to the original logic

**The anchors are patterns, not literals.** The bundle is minified and its short
identifiers change between releases: Command Code updated itself 1.53.0 → 1.53.1
mid-session and `DE` became `OE`, which silently broke a literal-string anchor.
The patterns capture the identifiers and the replacement reuses them, so the
fallback compiles against whichever names the bundle actually has.

The patcher refuses to rewrite one checkpoint without the other — half a pair
changes behaviour in a way no caller asked for.

---

## 2. Sharing one decision: the grant store

Patching both checkpoints independently would prompt the user twice for one
action. Instead:

```
confirmTool  ──► provider.check()  ──► user chooses
                        │
                        ├─ allow ──► grantStore.grant(key, decision)
                        │
beforeToolCall ──► grantStore.consume(key) ──► hit: stand down
                        │
                        └─ miss: ask the provider anyway (fail closed)
```

`fork/command-code/src/grant-store.ts`. Both hooks import the same module URL,
so module scope is what makes the store shared — no `globalThis` plumbing.

### Why the key is the input

The two hooks share no identifier: one has `toolCallId` but the other does not.
The input is the only thing both see, so the key is

```
toolName + ":" + hash(stableStringify(input))
```

`stableStringify` sorts object keys, because the two hooks receive the same
input with different property order in practice (`{file_path, content}` vs
`{content, file_path}`).

### Why this is safe

- the decision gate always runs first, so a matching grant cannot be stale
- a grant is deleted on consumption — it covers exactly one execution, so a
  later identical call prompts again
- unconsumed grants expire after 30 s
- the execution gate asks when there is no grant, so a bypassed decision gate
  or an expired grant degrades to "ask", never to "allow"
- `toolName` is part of the key, so two tools handed the same argument cannot
  share a grant

---

## 3. Broker protocol (cmd-acp ↔ Command Code)

`src/permission/protocol.ts` is the single definition; both sides must stay
byte-compatible.

Newline-delimited JSON over a local socket:

- Windows: named pipe, addressed `\\.\pipe\<name>` (a bare name fails EACCES)
- POSIX: unix domain socket path

The address reaches Command Code via `CMD_ACP_PERMISSION_BROKER`, injected by
`cmd-runner.ts`. **Unset means the provider never runs**, and Command Code keeps
its built-in fail-closed behaviour — the patch is inert without a broker.

```jsonc
// Command Code -> cmd-acp
{ "type": "permission_request", "version": "1.0",
  "requestId": "req_<uuid>", "sessionId": "...",
  "toolCall": { "toolCallId": "call_<hex>", "toolName": "write_file",
                "input": {...} } }

// cmd-acp -> Command Code
{ "type": "permission_response", "version": "1.0",
  "requestId": "req_<uuid>",
  "decision": { "result": "allow", "scope": "once" } }
```

`requestId` is broker-side correlation only; ACP has no request id of its own,
so this never leaves the pipe.

One broker per session, torn down with it: a pending prompt must not outlive
the session it belongs to. Yolo mode skips the broker entirely.

---

## 4. ACP side (cmd-acp ↔ client)

`src/permission/acp-handler.ts` is the only module that knows both worlds.

Options offered (these are ours; the client echoes one back):

| optionId | kind | name |
|---|---|---|
| `allow-once` | `allow_once` | Allow once |
| `allow-always` | `allow_always` | Allow always |
| `reject-once` | `reject_once` | Reject |
| `reject-always` | `reject_always` | Reject always |

Response, as actually returned by Paseo:

```json
{ "jsonrpc": "2.0", "id": 0,
  "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } } }
```

Note the double `outcome` — the response discriminates on `outcome.outcome`, and
`optionId` lives inside it.

### Mapping (`mapACPOutcome`)

| client answer | broker decision |
|---|---|
| `allow-once` | `{ result: "allow", scope: "once" }` |
| `allow-always` | `{ result: "allow", scope: "always" }` |
| `reject-once` | `{ result: "deny", reason: "Denied by user" }` |
| `reject-always` | `{ result: "deny", reason: "Denied by user (always)" }` |
| `cancelled` | `{ result: "cancelled", ... }` |
| anything else | `{ result: "deny", ... }` |

Unknown option ids deny: an unrecognised approval must never become an approval.
`cancelled` stays distinct so a user abort is not reported as a refusal.

A client that does not implement `session/request_permission` fails the call
with method-not-found; that is reported as a denial rather than thrown, so one
unsupported method cannot kill the turn.

---

## 5. Failure policy

Everything fails closed. `allow` is produced only when a real answering party
said so.

| situation | result |
|---|---|
| `CMD_ACP_PERMISSION_BROKER` unset | provider never runs; built-in rules |
| broker unreachable | deny |
| handler throws | deny |
| timeout | deny (`CMD_ACP_PERMISSION_TIMEOUT_MS`, 0 = wait forever) |
| connection closed mid-request | deny |
| session closed with a request pending | cancelled, socket destroyed |
| unknown ACP option id | deny |

---

## 6. Debugging

`CMD_ACP_PERMISSION_TRACE=<path>` appends one JSON line per request, response
and error. Off by default; it writes nothing and never affects the flow or the
ACP stream when unset.

```bash
export CMD_ACP_PERMISSION_TRACE=/tmp/perm.jsonl
export CMD_ACP_PERMISSION_TIMEOUT_MS=0   # wait for the user indefinitely
```

To see the whole path, including the ACP frames, run the agent through
`C:/Users/wucy0/acp-probe/probe.js` (records to `logs/trace.jsonl`).

Regenerating a patched bundle:

```bash
bun run build:patcher
node tools/command-code-patch/patch.mjs \
  "<path-to-command-code>" --output fork/cc/dist/cli.mjs
node tools/command-code-patch/patch.mjs "<path-to-command-code>" --check
```

---

## Evidence

| claim | how it was established |
|---|---|
| two checkpoints, not one | single-gate patch: broker replied `allow`, tool still blocked; `tool_hook_blocked` 8 ms later |
| both hooks reachable from one provider | after patching both: one broker request, file written |
| `confirmTool` has no id | probed the argument: keys are `toolName, input, description, signal, explain` |
| `beforeToolCall` has `toolCallId` | same probe: `toolCallId, toolName, input, state` |
| decision gate runs first | timestamped trace: ~2-4 ms gap, consistent across runs |
| `BLOCKED` set contents | literal in the bundle: `edit_file, write_file, shell_command, monitor_command, kill_shell` |
| `--yolo` skips the gate | `resolvePrintHarnessMods` returns `[]` when `dangerouslySkipPermissions` |
| ACP response shape | captured from Paseo: `{outcome:{outcome:"selected",optionId:"allow-once"}}` |
| minified names change between releases | 1.53.0 `DE` vs 1.53.1 `OE`, same function |
| one prompt per action | Paseo: one `session/request_permission`, file written |
