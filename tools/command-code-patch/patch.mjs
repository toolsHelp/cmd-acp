/**
 * Command Code permission patcher.
 *
 * Command Code has no configuration or plugin surface that can answer a
 * permission prompt in headless (`-p`) mode. The decision comes from
 * `headlessInteraction(...)`, whose `confirmTool` is a stub:
 *
 *     confirmTool: async ({risk}) =>
 *       risk !== undefined ? "deny" : (autoAllow ? "allow" : "deny")
 *
 * Verified path (beacon evidence in fork/command-code/README.md):
 *
 *     tool call -> checkPermissions -> permissions.check
 *               -> resolveDecision -> confirm -> confirmTool
 *
 * This patcher replaces that one arrow function so it delegates to a
 * configurable provider first and falls back to the original logic whenever no
 * provider is available. Everything around it (`headlessInteraction`, its
 * `askQuestion` sibling, the `__name` wrapper) is left untouched.
 *
 * A second, legacy injection point (`createPrintPermissionGateMod`) is detected
 * but never modified: as of 1.53 it no longer reaches a decision. Reporting it
 * explicitly is more useful than silently rewriting dead code.
 *
 * Plain ESM (no TypeScript syntax): this file runs via `node tools/...`.
 */

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Primary anchor: the `confirmTool` stub inside `headlessInteraction`.
 * Present exactly once in command-code 1.53.0.
 */
export const CONFIRM_ANCHOR =
  'confirmTool:__name(async({risk:t})=>void 0!==t?"deny":e.autoAllow?"allow":"deny","confirmTool")'

/**
 * Replacement `confirmTool`.
 *
 * Constraints imposed by the injection site:
 *   - no `__name` (the wrapper is kept) and no top-level imports, because the
 *     surrounding scope is a minified bundle
 *   - the provider is imported lazily inside the call, so a session that never
 *     triggers a prompt never pays for it
 *   - any failure falls through to the original stub: an unreachable provider
 *     must not silently grant access
 *
 * `risk` is preserved as structured data (`{kind, detail}`) rather than being
 * flattened, so a policy layer can later distinguish "the user asked to be
 * prompted for this tool" from "this operation is inherently risky".
 */
export const CONFIRM_REPLACEMENT = [
  "confirmTool:__name(async(a)=>{",
  "try{",
  'const{resolvePermissionProvider:n}=await import(new URL("./cmd-acp-permission/provider.mjs",import.meta.url).href);',
  "const r=n(printPermissionDeniedMessage),o=await r.check({toolName:a&&a.toolName,input:a&&a.input,description:a&&a.description,risk:a&&a.risk,explain:a&&a.explain});",
  // Only an explicit allow allows; anything else keeps the built-in rules, so
  // an absent or undecided provider does not become a blanket denial.
  'if(o&&o.type==="allow")return"allow";',
  'if(o&&o.type==="deny"&&o.explicit)return"deny"',
  "}catch(i){}",
  'return void 0!==(a&&a.risk)?"deny":e.autoAllow?"allow":"deny"',
  '},"confirmTool")',
].join("")

/**
 * Legacy gate, kept only for detection.
 *
 * Present in the bundle but no longer part of the decision path: the
 * permission engine answers through `confirmTool`. Reported by `--check` so a
 * future release that starts using it again is visible rather than silent.
 */
export const LEGACY_GATE_ANCHOR =
  'beforeToolCall:__name(async({toolName:e})=>{if(DE.has(e))return{block:!0,additionalContext:printPermissionDeniedMessage(e)}},"beforeToolCall")'

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

function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Apply the patch to a source string.
 *
 * Returns `{ source, status, anchorCount, legacyGatePresent }` rather than
 * throwing, so callers can tell "patched now", "already patched" and "anchor
 * not found" apart.
 */
export function patchSource(source) {
  const anchorCount = countOccurrences(source, CONFIRM_ANCHOR)
  const alreadyPatched = source.includes(PATCH_MARKER)
  const legacyGatePresent = source.includes(LEGACY_GATE_ANCHOR)

  if (anchorCount === 0 && alreadyPatched) {
    return { source, status: "already-patched", anchorCount, legacyGatePresent }
  }
  if (anchorCount === 0) {
    return { source, status: "anchor-not-found", anchorCount, legacyGatePresent }
  }
  if (anchorCount > 1) {
    return { source, status: `anchor-ambiguous(${anchorCount})`, anchorCount, legacyGatePresent }
  }
  return {
    source: source.replace(CONFIRM_ANCHOR, CONFIRM_REPLACEMENT),
    status: "patched",
    anchorCount,
    legacyGatePresent,
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
  const { source, status, anchorCount, legacyGatePresent } = patchSource(original)

  if (status === "anchor-not-found") {
    throw new Error(
      "The confirmTool anchor no longer matches. Command Code changed its " +
        "headless interaction stub; re-derive CONFIRM_ANCHOR from the new " +
        "bundle before patching. Search for: headlessInteraction",
    )
  }
  if (status.startsWith("anchor-ambiguous")) {
    throw new Error(`Anchor matched ${anchorCount} times; expected exactly 1.`)
  }

  const cliPath = options.output ?? sourceCli
  const report = { cliPath, status, anchorCount, legacyGatePresent, installed: [] }

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
    console.log(`cli.mjs        : ${report.cliPath}`)
    console.log(`anchor matches : ${report.anchorCount}`)
    console.log(`status         : ${report.status}`)
    console.log(
      `legacy gate    : ${report.legacyGatePresent ? "present (left untouched)" : "absent"}`,
    )
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
