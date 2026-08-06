# cmd-acp — Agent instructions

## Role

Bridge exposing **Command Code** (`cmd`) as an **ACP** (Agent Client Protocol) agent
over stdio, so ACP-compatible clients (Circulo, Zed, JetBrains, etc.) can drive
`cmd -p --output-format json`.

## Commands

```bash
bun install
bun run build      # build dist/ (bun bundle)
bun test           # run test suite (fake CLI, no real cmd needed)
bun run typecheck  # tsc --noEmit
npm publish        # publish to npm (manual) — or CI on tag v*
```

## Conventions

- TypeScript, ESM (`"type": "module"`), Bun runtime.
- ACP protocol v1, JSON-RPC 2.0 over stdio.
- No interactive permission prompts: `cmd -p` is one-shot per prompt.
- Unknown NDJSON events are forward-compatible — never crash on unknown `event.type`.
- Tests use a deterministic fake CLI; never depend on a real authenticated `cmd`.
- Publish: `npm publish` requires npm auth; CI uses `NPM_TOKEN` secret on tag `v*`.
