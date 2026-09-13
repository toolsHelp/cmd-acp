/**
 * Command Code permission patcher.
 *
 * Command Code has no configuration or plugin surface that can answer a
 * permission prompt in headless (`-p`) mode. In 1.53 one tool call passes
 * through two independent checkpoints, both of which must agree:
 *
 *   1. `headlessInteraction.confirmTool` — decides whether the tool may run.
 *      Unpatched it is a stub:
 *          confirmTool: async ({risk}) =>
 *            risk !== undefined ? "deny" : (autoAllow ? "allow" : "deny")
 *
 *   2. `createPrintPermissionGateMod.beforeToolCall` — guards execution and
 *      blocks five tool families outright (`edit_file`, `write_file`,
 *      `shell_command`, `monitor_command`, `kill_shell`).
 *
 * Verified path (beacon evidence in fork/command-code/README.md):
 *
 *     tool call -> checkPermissions -> permissions.check
 *               -> resolveDecision -> confirm -> confirmTool (1)
 *     ...then, before execution -> beforeToolCall (2)
 *
 * Patching only (1) is not enough: (2) blocks the tool anyway. Patching both
 * independently would prompt the user twice for one action, so (1) records the
 * decision it obtained in a shared grant store and (2) consumes it.
 *
 * Both replacements fall back to the original logic whenever the provider
 * cannot answer, so an unreachable broker never becomes an approval.
 *
 * Plain ESM (no TypeScript syntax): this file runs via `node tools/...`.
 */

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Prefix shared by both replacements: lazy-import the provider bundle. */
const PROVIDER_IMPORT = [
  'const{resolvePermissionProvider:n,grantStore:s}=',
  'await import(new URL("./cmd-acp-permission/provider.mjs",import.meta.url).href);',
].join("")

/**
 * Main anchor: the `confirmTool` stub inside `headlessInteraction`.
 *
 * Matched by pattern rather than as a literal because the bundle is minified
 * and the short names are not stable across releases — Command Code updated
 * itself 1.53.0 -> 1.53.1 mid-session and the equivalent of this function came
 * out with different identifiers. Captured names are reused in the
 * replacement, so the result is correct whichever names the minifier picked.
 *
 *   group 1: the destructured `risk` parameter
 *   group 2: the `headlessInteraction` options parameter (`autoAllow`)
 */
const CONFIRM_ANCHOR_RE =
  /confirmTool:__name\(async\(\{risk:(\w+)\}\)=>void 0!==\1\?"deny":(\w+)\.autoAllow\?"allow":"deny","confirmTool"\)/g

/**
 * Literal 1.53.0 spelling, kept for tests and as a readable reference for what
 * {@link CONFIRM_ANCHOR_RE} matches.
 */
export const CONFIRM_ANCHOR =
  'confirmTool:__name(async({risk:t})=>void 0!==t?"deny":e.autoAllow?"allow":"deny","confirmTool")'

/**
 * Build the replacement `confirmTool`.
 *
 * `interactionVar` is the minified name of the options object carrying
 * `autoAllow`; the fallback must use the same one the original did.
 *
 * Constraints imposed by the injection site:
 *   - the `__name` wrapper is kept and no top-level imports are added, because
 *     the surrounding scope is a minified bundle
 *   - the provider is imported lazily inside the call, so a session that never
 *     triggers a prompt never pays for it
 *   - any failure falls through to the original rule: an unreachable provider
 *     must not silently grant access
 *
 * `risk` is preserved as structured data (`{kind, detail}`) rather than being
 * flattened, so a policy layer can later distinguish "the user asked to be
 * prompted for this tool" from "this operation is inherently risky".
 *
 * @param {string} interactionVar
 */
export function buildConfirmReplacement(interactionVar) {
  return [
    "confirmTool:__name(async(a)=>{",
    "try{",
    PROVIDER_IMPORT,
    "const r=n(printPermissionDeniedMessage),",
    "o=await r.check({toolName:a&&a.toolName,input:a&&a.input,description:a&&a.description,risk:a&&a.risk,explain:a&&a.explain});",
    'if(o&&(o.type==="allow"||o.type==="always_allow")){',
    // Hand the approval to the execution gate so it does not prompt again.
    "try{s.grant(s.key(a&&a.toolName,a&&a.input),o.type)}catch(_){}",
    'return"allow"}',
    // Only an explicit denial overrides the built-in rules; an absent or
    // undecided provider must not become a blanket denial.
    'if(o&&o.type==="deny"&&o.explicit)return"deny"',
    "}catch(i){}",
    'return void 0!==(a&&a.risk)?"deny":' + interactionVar + '.autoAllow?"allow":"deny"',
    '},"confirmTool")',
  ].join("")
}

/** Replacement as produced for the 1.53.0 spelling (tests, docs). */
export const CONFIRM_REPLACEMENT = buildConfirmReplacement("e")

/**
 * Second anchor: the execution guard in `createPrintPermissionGateMod`.
 *
 * Unpatched it blocks five tool families regardless of what the decision gate
 * concluded, which is why patching `confirmTool` alone never let a tool run.
 *
 *   group 1: the destructured `toolName` parameter
 *   group 2: the blocked-tool set (`DE` in 1.53.0, `OE` in 1.53.1)
 */
const GATE_ANCHOR_RE =
  /beforeToolCall:__name\(async\(\{toolName:(\w+)\}\)=>\{if\((\w+)\.has\(\1\)\)return\{block:!0,additionalContext:printPermissionDeniedMessage\(\1\)\}\},"beforeToolCall"\)/g

/** Literal 1.53.0 spelling; see {@link GATE_ANCHOR_RE}. */
export const GATE_ANCHOR =
  'beforeToolCall:__name(async({toolName:e})=>{if(DE.has(e))return{block:!0,additionalContext:printPermissionDeniedMessage(e)}},"beforeToolCall")'

/**
 * Build the replacement execution guard.
 *
 * It consumes the decision gate's grant, and — if there is none, e.g. because
 * the decision gate was bypassed or the grant expired — still asks, so it
 * fails closed either way.
 *
 * @param {string} blockedSetVar name of the blocked-tool set in this bundle
 */
export function buildGateReplacement(blockedSetVar) {
  return [
    "beforeToolCall:__name(async(g)=>{",
    "const e=g&&g.toolName,t=g&&g.input;",
    "if(!" + blockedSetVar + ".has(e))return;",
    "try{",
    PROVIDER_IMPORT,
    // One user decision covers both checkpoints: consume it and stand down.
    "if(s.consume(s.key(e,t)))return;",
    "const r=n(printPermissionDeniedMessage),",
    "o=await r.check({toolName:e,input:t});",
    'if(o&&(o.type==="allow"||o.type==="always_allow"))return;',
    'if(o&&o.type==="deny"&&o.explicit)return{block:!0,additionalContext:o.message||printPermissionDeniedMessage(e)};',
    "}catch(i){}",
    "return{block:!0,additionalContext:printPermissionDeniedMessage(e)}",
    '},"beforeToolCall")',
  ].join("")
}

/** Replacement as produced for the 1.53.0 spelling (tests, docs). */
export const GATE_REPLACEMENT = buildGateReplacement("DE")

/** Marker present only in a patched bundle. */
export const PATCH_MARKER = "cmd-acp-permission/provider.mjs"

/** Directory (beside the bundle) holding the provider modules. */
export const PROVIDER_DIR_NAME = "cmd-acp-permission"

/** File copied from this tool's `dist/` into the bundle's dist directory. */
const PROVIDER_FILES = ["provider.mjs"]

/** Locate the Command Code package, allowing an explicit override. */
export function resolveCommandCodeDir(explicit) {
  if (explicit) return explicit
  const fromEnv = process.env.COMMAND_CODE_DIR?.trim()
  if (fromEnv) return fromEnv
  return join(dirname(process.execPath), "node_modules", "command-code")
}

/** Absolute path to the bundled CLI. */
export function resolveCliPath(commandCodeDir) {
  return join(commandCodeDir, "dist", "cli.mjs")
}

/** Where the provider modules are installed for a given bundle. */
export function resolveProviderDir(commandCodeDir) {
  return join(commandCodeDir, "dist", PROVIDER_DIR_NAME)
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

/**
 * Apply the patch to a source string.
 *
 * Both checkpoints must be patched: the decision gate alone leaves the
 * execution gate blocking, and the execution gate alone never sees a decision.
 *
 * Returns `{ source, status, confirmAnchorCount, gateAnchorCount }` rather than
 * throwing, so callers can tell "patched now", "already patched", "anchor not
 * found" and "partially patched" apart. A bundle where only one anchor still
 * matches is reported as `partial` and left alone: rewriting half the pair
 * would silently change behaviour in a way no caller asked for.
 */
export function patchSource(source) {
  const confirmMatches = [...source.matchAll(CONFIRM_ANCHOR_RE)]
  const gateMatches = [...source.matchAll(GATE_ANCHOR_RE)]
  const confirmAnchorCount = confirmMatches.length
  const gateAnchorCount = gateMatches.length
  const alreadyPatched = source.includes(PATCH_MARKER)

  if (confirmAnchorCount > 1 || gateAnchorCount > 1) {
    return {
      source,
      status: `anchor-ambiguous(${Math.max(confirmAnchorCount, gateAnchorCount)})`,
      confirmAnchorCount,
      gateAnchorCount,
    }
  }
  // Both checkpoints or neither. Rewriting one of the pair would silently
  // change behaviour in a way no caller asked for.
  if (confirmAnchorCount === 0 || gateAnchorCount === 0) {
    return {
      source,
      status: alreadyPatched ? "already-patched" : "anchor-not-found",
      confirmAnchorCount,
      gateAnchorCount,
    }
  }

  // `lastIndex` is global-regex state; reset before reusing the patterns.
  CONFIRM_ANCHOR_RE.lastIndex = 0
  GATE_ANCHOR_RE.lastIndex = 0

  const patched = source
    .replace(CONFIRM_ANCHOR_RE, (_match, _riskVar, interactionVar) =>
      buildConfirmReplacement(interactionVar),
    )
    .replace(GATE_ANCHOR_RE, (_match, _toolNameVar, blockedSetVar) =>
      buildGateReplacement(blockedSetVar),
    )

  return {
    source: patched,
    status: "patched",
    confirmAnchorCount,
    gateAnchorCount,
  }
}

/** Compiled providers live beside this script. */
function providerSourceDir() {
  return join(HERE, "dist")
}

/**
 * Patch a Command Code bundle.
 *
 * @param {object} [options]
 * @param {string} [options.commandCodeDir] Command Code package root.
 * @param {boolean} [options.check] Report only; write nothing.
 * @param {string} [options.output] Write the patched bundle here instead of
 *   patching in place. The CLI itself is never modified in this mode.
 */
export function applyPatch(options = {}) {
  const commandCodeDir = resolveCommandCodeDir(options.commandCodeDir)
  const sourceCli = resolveCliPath(commandCodeDir)
  if (!existsSync(sourceCli)) {
    throw new Error(`cli.mjs not found at ${sourceCli}`)
  }

  const original = readFileSync(sourceCli, "utf8")
  const { source, status, confirmAnchorCount, gateAnchorCount } = patchSource(original)

  if (status === "anchor-not-found" || status === "partial") {
    throw new Error(
      "The permission anchors no longer match " +
        `(confirmTool: ${confirmAnchorCount}, beforeToolCall: ${gateAnchorCount}; expected 1 each). ` +
        "Command Code changed its headless permission hooks; re-derive the " +
        "anchors from the new bundle before patching. Search for: " +
        "headlessInteraction, createPrintPermissionGateMod",
    )
  }
  if (status.startsWith("anchor-ambiguous")) {
    throw new Error(
      `An anchor matched more than once (confirmTool: ${confirmAnchorCount}, ` +
        `beforeToolCall: ${gateAnchorCount}); expected exactly 1 each.`,
    )
  }

  const cliPath = options.output ?? sourceCli
  const report = { cliPath, status, confirmAnchorCount, gateAnchorCount, installed: [] }

  if (options.check) return report

  // The provider module must sit beside whichever bundle we produce, so the
  // injected dynamic import resolves without any path configuration.
  const providerDir = join(dirname(cliPath), PROVIDER_DIR_NAME)
  const srcDir = providerSourceDir()
  if (existsSync(srcDir)) {
    mkdirSync(providerDir, { recursive: true })
    for (const file of PROVIDER_FILES) {
      const from = join(srcDir, file)
      if (!existsSync(from)) continue
      const to = join(providerDir, file)
      copyFileSync(from, to)
      report.installed.push(to)
    }
    if (report.installed.length > 0) {
      writeFileSync(
        join(providerDir, "package.json"),
        JSON.stringify({ type: "module" }, null, 2),
      )
    }
  }

  if (status === "already-patched" && options.output) {
    // Still hand back a usable bundle so callers get a runnable copy.
    writeFileSync(cliPath, source)
    return report
  }

  const before = sha256(original)
  writeFileSync(cliPath, source)
  report.sha256Before = before
  report.sha256After = sha256(source)
  return report
}

function valueOf(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const output = valueOf(args, "--output")
  const positional = args.filter((a) => !a.startsWith("--") && a !== output)

  try {
    const report = applyPatch({
      commandCodeDir: positional[0],
      check,
      ...(output ? { output } : {}),
    })
    console.log(`cli.mjs         : ${report.cliPath}`)
    console.log(`confirmTool     : ${report.confirmAnchorCount} match(es)`)
    console.log(`beforeToolCall  : ${report.gateAnchorCount} match(es)`)
    console.log(`status          : ${report.status}`)
    for (const file of report.installed) console.log(`installed      : ${file}`)
    if (report.sha256Before) {
      console.log(`sha256 before  : ${report.sha256Before}`)
      console.log(`sha256 after   : ${report.sha256After}`)
    }
    if (check) console.log("(check mode: nothing written)")
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(3)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
