import { describe, expect, test } from "bun:test"
import {
  CONFIRM_ANCHOR,
  CONFIRM_REPLACEMENT,
  LEGACY_GATE_ANCHOR,
  PATCH_MARKER,
  patchSource,
} from "../tools/command-code-patch/patch.mjs"

/** The real `headlessInteraction` shape from command-code 1.53.0. */
const HEADLESS =
  "function headlessInteraction(e={}){return{" +
  CONFIRM_ANCHOR +
  ',askQuestion:__name(async({questions:e})=>({answers:e.map((e,t)=>({questionIndex:t,selectedOptions:[e.options[0]?.label??""]}))}),"askQuestion")}}'

describe("command-code permission patch", () => {
  test("replaces only the confirmTool stub", () => {
    const source = `var x=1;${HEADLESS}var y=2;`
    const { source: out, status, anchorCount } = patchSource(source)

    expect(status).toBe("patched")
    expect(anchorCount).toBe(1)

    // Untouched: the enclosing function, its sibling, the __name wrapper.
    expect(out).toContain("function headlessInteraction(e={}){return{")
    expect(out).toContain("askQuestion:__name(")
    expect(out).toContain('},"confirmTool")')
    expect(out.startsWith("var x=1;")).toBe(true)
    expect(out.endsWith("var y=2;")).toBe(true)

    // Replaced.
    expect(out).not.toContain(CONFIRM_ANCHOR)
    expect(out).toContain(PATCH_MARKER)
  })

  test("is idempotent", () => {
    const once = patchSource(`x;${HEADLESS};y`).source
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
    const { status, anchorCount } = patchSource(`${CONFIRM_ANCHOR}${CONFIRM_ANCHOR}`)
    expect(status).toContain("anchor-ambiguous")
    expect(anchorCount).toBe(2)
  })

  test("detects but does not touch the legacy gate", () => {
    const source = `function createPrintPermissionGateMod(){return{${LEGACY_GATE_ANCHOR}}}${HEADLESS}`
    const { source: out, legacyGatePresent } = patchSource(source)

    expect(legacyGatePresent).toBe(true)
    // The legacy gate must survive byte for byte: it is dead code, not ours to
    // rewrite, and silently changing it would hide a future behaviour change.
    expect(out).toContain(LEGACY_GATE_ANCHOR)
  })

  test("reports no legacy gate when the bundle lacks it", () => {
    const { legacyGatePresent } = patchSource(HEADLESS)
    expect(legacyGatePresent).toBe(false)
  })

  test("falls back to the original stub when no provider answers", () => {
    // The whole original rule must survive as the final expression.
    expect(CONFIRM_REPLACEMENT).toContain(
      'return void 0!==(a&&a.risk)?"deny":e.autoAllow?"allow":"deny"',
    )
    // And a thrown import/transport error must not skip that fallback.
    expect(CONFIRM_REPLACEMENT).toContain("catch(i){}")
  })

  test("only an explicit allow returns allow", () => {
    expect(CONFIRM_REPLACEMENT).toContain('if(o&&o.type==="allow")return"allow";')
    // A non-explicit denial still falls through, so an absent provider keeps
    // the built-in rules rather than becoming a blanket denial.
    expect(CONFIRM_REPLACEMENT).toContain('if(o&&o.type==="deny"&&o.explicit)return"deny"')
  })

  test("passes the structured risk through rather than flattening it", () => {
    expect(CONFIRM_REPLACEMENT).toContain("risk:a&&a.risk")
    expect(CONFIRM_REPLACEMENT).toContain("explain:a&&a.explain")
  })

  test("keeps the __name registration but adds no nested one", () => {
    // The wrapper is part of the injection site and must survive so the
    // function keeps its name.
    expect(CONFIRM_REPLACEMENT.startsWith("confirmTool:__name(async(a)=>{")).toBe(true)
    expect(CONFIRM_REPLACEMENT.endsWith('},"confirmTool")')).toBe(true)
    // Exactly one __name call: the outer registration.
    expect(CONFIRM_REPLACEMENT.split("__name").length - 1).toBe(1)
    expect(CONFIRM_REPLACEMENT).not.toContain("import {")
    expect(CONFIRM_REPLACEMENT).toContain("await import(new URL(")
  })
})
