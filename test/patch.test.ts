import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  CONFIRM_ANCHOR,
  CONFIRM_REPLACEMENT,
  GATE_ANCHOR,
  GATE_REPLACEMENT,
  PATCH_MARKER,
  applyPatch,
  buildConfirmReplacement,
  buildGateReplacement,
  patchSource,
} from "../tools/command-code-patch/patch.mjs"

/** The real `headlessInteraction` shape from command-code 1.53.0. */
const HEADLESS =
  "function headlessInteraction(e={}){return{" +
  CONFIRM_ANCHOR +
  ',askQuestion:__name(async({questions:e})=>({answers:e.map((e,t)=>({questionIndex:t,selectedOptions:[e.options[0]?.label??""]}))}),"askQuestion")}}'

/** The real `createPrintPermissionGateMod` shape from command-code 1.53.0. */
const GATE_MOD =
  'function createPrintPermissionGateMod(){return{id:"print-permission-gate",' +
  GATE_ANCHOR +
  "}}"

/** A bundle carrying both checkpoints, as 1.53.0 ships them. */
const BUNDLE = `var DE=new Set(["write_file"]);${GATE_MOD}${HEADLESS}`

describe("command-code permission patch", () => {
  test("patches both checkpoints", () => {
    const { source: out, status, confirmAnchorCount, gateAnchorCount } = patchSource(BUNDLE)

    expect(status).toBe("patched")
    expect(confirmAnchorCount).toBe(1)
    expect(gateAnchorCount).toBe(1)

    expect(out).not.toContain(CONFIRM_ANCHOR)
    expect(out).not.toContain(GATE_ANCHOR)
    expect(out).toContain(PATCH_MARKER)

    // Surroundings survive: the enclosing functions and their siblings.
    expect(out).toContain("function headlessInteraction(e={}){return{")
    expect(out).toContain("askQuestion:__name(")
    expect(out).toContain("function createPrintPermissionGateMod(){return{")
    expect(out).toContain('"print-permission-gate"')
  })

  test("is idempotent", () => {
    const once = patchSource(BUNDLE).source
    const twice = patchSource(once)
    expect(twice.status).toBe("already-patched")
    expect(twice.source).toBe(once)
  })

  test("reports a missing anchor instead of guessing", () => {
    const { status, confirmAnchorCount, gateAnchorCount, source } = patchSource(
      "function unrelated(){}",
    )
    expect(status).toBe("anchor-not-found")
    expect(confirmAnchorCount).toBe(0)
    expect(gateAnchorCount).toBe(0)
    expect(source).toBe("function unrelated(){}")
  })

  test("refuses an ambiguous anchor", () => {
    const { status, confirmAnchorCount } = patchSource(
      `${CONFIRM_ANCHOR}${CONFIRM_ANCHOR}${GATE_ANCHOR}`,
    )
    expect(status).toContain("anchor-ambiguous")
    expect(confirmAnchorCount).toBe(2)
  })

  test("refuses to patch only half of the pair", () => {
    // A bundle with just the decision gate would leave the execution gate
    // blocking every tool, which is worse than refusing to patch at all.
    const { status, source } = patchSource(HEADLESS)
    expect(status).toBe("anchor-not-found")
    expect(source).toBe(HEADLESS)
  })

  test("hands the decision gate's approval to the execution gate", () => {
    expect(CONFIRM_REPLACEMENT).toContain("s.grant(s.key(")
    expect(GATE_REPLACEMENT).toContain("s.consume(s.key(")
  })

  test("the execution gate still asks when no grant is waiting", () => {
    // Consuming is a fast path, not the only path: if the decision gate was
    // bypassed or its grant expired, the gate must ask rather than block blind.
    const consumeAt = GATE_REPLACEMENT.indexOf("s.consume(")
    const askAt = GATE_REPLACEMENT.indexOf("r.check(")
    expect(consumeAt).toBeGreaterThan(-1)
    expect(askAt).toBeGreaterThan(consumeAt)
  })

  test("both replacements share one provider module URL", () => {
    // Same URL means one module instance, which is what makes the grant store
    // visible to both hooks.
    const url = 'new URL("./cmd-acp-permission/provider.mjs",import.meta.url).href'
    expect(CONFIRM_REPLACEMENT).toContain(url)
    expect(GATE_REPLACEMENT).toContain(url)
    expect(CONFIRM_REPLACEMENT).toContain("grantStore:s")
    expect(GATE_REPLACEMENT).toContain("grantStore:s")
  })

  test("falls back to the original behaviour when nothing answers", () => {
    // The decision gate keeps its whole original rule as the final expression.
    expect(CONFIRM_REPLACEMENT).toContain(
      'return void 0!==(a&&a.risk)?"deny":e.autoAllow?"allow":"deny"',
    )
    // The execution gate keeps blocking.
    expect(GATE_REPLACEMENT).toContain(
      "return{block:!0,additionalContext:printPermissionDeniedMessage(e)}",
    )
    // A thrown import/transport error must not skip either fallback.
    expect(CONFIRM_REPLACEMENT).toContain("catch(i){}")
    expect(GATE_REPLACEMENT).toContain("catch(i){}")
  })

  test("only an explicit allow returns allow", () => {
    expect(CONFIRM_REPLACEMENT).toContain('o.type==="allow"||o.type==="always_allow"')
    // A non-explicit denial still falls through, so an absent provider keeps
    // the built-in rules rather than becoming a blanket denial.
    expect(CONFIRM_REPLACEMENT).toContain('if(o&&o.type==="deny"&&o.explicit)return"deny"')
  })

  test("passes the structured risk through rather than flattening it", () => {
    expect(CONFIRM_REPLACEMENT).toContain("risk:a&&a.risk")
    expect(CONFIRM_REPLACEMENT).toContain("explain:a&&a.explain")
  })

  test("survives the minifier renaming its identifiers", () => {
    // Command Code updated itself 1.53.0 -> 1.53.1 and the same functions came
    // out with different short names (`DE` became `OE`), which broke a
    // literal-string anchor. The patch must follow the names, not assume them.
    const renamed = BUNDLE.replace("DE=new Set", "OE=new Set").replaceAll("DE.has", "OE.has")
    const { source: out, status } = patchSource(renamed)

    expect(status).toBe("patched")
    // The replacement has to reference the set this bundle actually uses.
    expect(out).toContain("if(!OE.has(e))return;")
    expect(out).not.toContain("DE.has")
  })

  test("reuses the bundle's own identifiers in each fallback", () => {
    // Both fallbacks must compile against whatever names the minifier chose.
    expect(buildConfirmReplacement("q")).toContain('q.autoAllow?"allow":"deny"')
    expect(buildGateReplacement("Z9")).toContain("if(!Z9.has(e))return;")
  })

  test("keeps the __name registration but adds no nested one", () => {
    // The wrapper is part of the injection site and must survive so the
    // function keeps its name.
    expect(CONFIRM_REPLACEMENT.startsWith("confirmTool:__name(async(a)=>{")).toBe(true)
    expect(CONFIRM_REPLACEMENT.endsWith('},"confirmTool")')).toBe(true)
    expect(GATE_REPLACEMENT.startsWith("beforeToolCall:__name(async(g)=>{")).toBe(true)
    expect(GATE_REPLACEMENT.endsWith('},"beforeToolCall")')).toBe(true)

    // Exactly one __name call each: the outer registration.
    expect(CONFIRM_REPLACEMENT.split("__name").length - 1).toBe(1)
    expect(GATE_REPLACEMENT.split("__name").length - 1).toBe(1)

    expect(CONFIRM_REPLACEMENT).not.toContain("import {")
    expect(GATE_REPLACEMENT).not.toContain("import {")
    expect(CONFIRM_REPLACEMENT).toContain("await import(new URL(")
    expect(GATE_REPLACEMENT).toContain("await import(new URL(")
  })
})

describe("applyPatch", () => {
  let roots: string[] = []

  function tmpDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `cmd-acp-patch-${label}-`))
    roots.push(dir)
    return dir
  }

  /** A Command Code package whose bundle carries both checkpoints. */
  function fakeBundle(): string {
    const dir = tmpDir("cc")
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "cli.mjs"), BUNDLE)
    return dir
  }

  function fakeProvider(): string {
    const dir = tmpDir("provider")
    writeFileSync(join(dir, "provider.mjs"), "export const grantStore = {}\n")
    return dir
  }

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots = []
  })

  test("installs the provider beside the bundle it patches", () => {
    const output = join(tmpDir("out"), "dist", "cli.mjs")

    const report = applyPatch({
      commandCodeDir: fakeBundle(),
      output,
      providerSourceDir: fakeProvider(),
    })

    expect(report.status).toBe("patched")
    expect(report.installed).toHaveLength(1)
    expect(existsSync(join(dirname(output), "cmd-acp-permission", "provider.mjs"))).toBe(true)
    expect(existsSync(join(dirname(output), "cmd-acp-permission", "package.json"))).toBe(true)
  })

  test("refuses to write a bundle when the provider was never compiled", () => {
    const output = join(tmpDir("out"), "dist", "cli.mjs")

    expect(() =>
      applyPatch({
        commandCodeDir: fakeBundle(),
        output,
        providerSourceDir: join(tmpDir("empty"), "dist"),
      }),
    ).toThrow(/build:patcher/)

    // The whole point of failing here: no half-patched bundle to run by mistake.
    expect(existsSync(output)).toBe(false)
  })

  test("refuses when the provider directory exists but holds no provider", () => {
    const output = join(tmpDir("out"), "dist", "cli.mjs")

    expect(() =>
      applyPatch({
        commandCodeDir: fakeBundle(),
        output,
        providerSourceDir: tmpDir("partial"),
      }),
    ).toThrow(/provider\.mjs is missing/)

    expect(existsSync(output)).toBe(false)
    expect(existsSync(join(dirname(output), "cmd-acp-permission"))).toBe(false)
  })
})
