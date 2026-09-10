import { describe, expect, test } from "bun:test"
import {
  GATE_ARROW_ANCHOR,
  GATE_ARROW_REPLACEMENT,
  PATCH_MARKER,
  patchSource,
} from "../tools/command-code-patch/patch.mjs"

/** The exact gate function shipped by command-code 1.51.3 - 1.53.0. */
const ORIGINAL_GATE =
  'function createPrintPermissionGateMod(){return{id:"print-permission-gate",' +
  "beforeToolCall:__name(" +
  GATE_ARROW_ANCHOR +
  ',"beforeToolCall")}}'

describe("command-code permission gate patch", () => {
  test("replaces only the decision body, keeping the function shell", () => {
    const source = `var x=1;${ORIGINAL_GATE}var y=2;`
    const { source: out, status, anchorCount } = patchSource(source)

    expect(status).toBe("patched")
    expect(anchorCount).toBe(1)

    // Untouched: the enclosing function, the id, the __name wrapper, callers.
    expect(out.startsWith("var x=1;function createPrintPermissionGateMod(){")).toBe(true)
    expect(out).toContain('id:"print-permission-gate"')
    expect(out).toContain("beforeToolCall:__name(")
    expect(out).toContain(',"beforeToolCall")}}')
    expect(out.endsWith("var y=2;")).toBe(true)

    // Replaced: the arrow body now delegates.
    expect(out).not.toContain(GATE_ARROW_ANCHOR)
    expect(out).toContain(PATCH_MARKER)
  })

  test("is idempotent", () => {
    const once = patchSource(`x;${ORIGINAL_GATE};y`).source
    const twice = patchSource(once)
    expect(twice.status).toBe("already-patched")
    expect(twice.source).toBe(once)
  })

  test("reports a missing anchor instead of guessing", () => {
    const { status, anchorCount, source } = patchSource("function unrelated(){}")
    expect(status).toBe("anchor-not-found")
    expect(anchorCount).toBe(0)
    expect(source).toBe("function unrelated(){}")
  })

  test("refuses an ambiguous anchor", () => {
    const { status, anchorCount } = patchSource(`${GATE_ARROW_ANCHOR}${GATE_ARROW_ANCHOR}`)
    expect(status).toContain("anchor-ambiguous")
    expect(anchorCount).toBe(2)
  })

  test("keeps the original denial message by reusing printPermissionDeniedMessage", () => {
    // The replacement must not hardcode the message: it must reuse the
    // bundle's own helper so wording stays identical to unpatched behaviour.
    expect(GATE_ARROW_REPLACEMENT).toContain("printPermissionDeniedMessage(e)")
  })

  test("keeps non-sensitive tools untouched", () => {
    // Tools outside the sensitive set must pass straight through.
    expect(GATE_ARROW_REPLACEMENT).toContain("if(!DE.has(e))return;")
  })

  test("defaults to deny on provider failure", () => {
    // An allow must be explicit; anything else falls through to block.
    expect(GATE_ARROW_REPLACEMENT).toContain('o.type==="allow"||o.type==="always_allow"')
    expect(GATE_ARROW_REPLACEMENT).toContain("||printPermissionDeniedMessage(e)")
  })

  test("has no top-level imports or __name usage in the injected code", () => {
    expect(GATE_ARROW_REPLACEMENT).not.toContain("__name")
    expect(GATE_ARROW_REPLACEMENT).not.toContain("import {")
    // Uses a dynamic import resolved relative to the bundle.
    expect(GATE_ARROW_REPLACEMENT).toContain("await import(new URL(")
  })
})
