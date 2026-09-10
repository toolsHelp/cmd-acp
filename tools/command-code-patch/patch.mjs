/**
 * Command Code permission-gate patcher.
 *
 * Command Code's headless (`-p`) mode refuses sensitive tools outright: the
 * `print-permission-gate` mod returns `{ block: true }` for a fixed tool set,
 * and there is no hook or plugin surface to intercept it. Adding a
 * human-in-the-loop flow therefore requires patching the bundled `cli.mjs`.
 *
 * Scope: only the gate's *decision*. The enclosing function, its id, the
 * `__name(...)` wrapper and the `resolvePrintHarnessMods` caller are all left
 * alone, so the diff against upstream stays as small as possible and a future
 * release can be re-anchored by locating one short string.
 *
 *   function createPrintPermissionGateMod(){return{id:"print-permission-gate",
 *     beforeToolCall:__name(                                 <-- kept
 *       async({toolName:e})=>{ ... }                         <-- replaced
 *     ,"beforeToolCall")}}                                   <-- kept
 *
 * The replacement delegates to the provider bootstrap, which picks an
 * implementation from the environment. With no broker configured it
 * reproduces the original refusal byte for byte.
 *
 * Plain ESM (no TypeScript syntax): this file runs via `node tools/...`.
 */

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Anchor: the arrow function passed to `__name`, body included.
 * Present exactly once in command-code 1.51.3 - 1.53.0.
 */
export const GATE_ARROW_ANCHOR =
  'async({toolName:e})=>{if(DE.has(e))return{block:!0,additionalContext:printPermissionDeniedMessage(e)}}'

/**
 * Replacement arrow function.
 *
 * Constraints imposed by the injection site:
 *   - no `__name` (the wrapper is kept) and no top-level imports, because the
 *     surrounding scope is a minified bundle
 *   - keeps the destructured `toolName` binding, plus the `toolCallId`/`input`
 *     fields the harness already passes through
 *   - reuses `printPermissionDeniedMessage` from the same scope, so the
 *     default message stays identical to the unpatched bundle
 */
export const GATE_ARROW_REPLACEMENT = [
  "async({toolName:e,toolCallId:t,input:n})=>{",
  "if(!DE.has(e))return;",
  'const{resolvePermissionProvider:i}=await import(new URL("./cmd-acp-permission/provider.mjs",import.meta.url).href);',
  "const r=i(printPermissionDeniedMessage),o=await r.check({toolName:e,toolCallId:t,input:n,sessionId:process.env.COMMAND_CODE_SESSION});",
  'if(o&&(o.type==="allow"||o.type==="always_allow"))return;',
  "return{block:!0,additionalContext:(o&&o.message)||printPermissionDeniedMessage(e)}}",
].join("")

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
 * Returns `{ source, status, anchorCount }` rather than throwing, so callers
 * can tell "patched now", "already patched" and "anchor not found" apart.
 */
export function patchSource(source) {
  const anchorCount = countOccurrences(source, GATE_ARROW_ANCHOR)
  const alreadyPatched = source.includes(PATCH_MARKER)

  if (anchorCount === 0 && alreadyPatched) {
    return { source, status: "already-patched", anchorCount }
  }
  if (anchorCount === 0) {
    return { source, status: "anchor-not-found", anchorCount }
  }
  if (anchorCount > 1) {
    return { source, status: `anchor-ambiguous(${anchorCount})`, anchorCount }
  }
  return {
    source: source.replace(GATE_ARROW_ANCHOR, GATE_ARROW_REPLACEMENT),
    status: "patched",
    anchorCount,
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
 * @returns {{cliPath:string,status:string,anchorCount:number,installed:string[],sha256Before?:string,sha256After?:string}}
 */
export function applyPatch(options = {}) {
  const commandCodeDir = resolveCommandCodeDir(options.commandCodeDir)
  const sourceCli = resolveCliPath(commandCodeDir)
  if (!existsSync(sourceCli)) {
    throw new Error(`cli.mjs not found at ${sourceCli}`)
  }

  const original = readFileSync(sourceCli, "utf8")
  const { source, status, anchorCount } = patchSource(original)

  if (status === "anchor-not-found") {
    throw new Error(
      "The permission-gate anchor no longer matches. Command Code changed its " +
        "gate body; re-derive GATE_ARROW_ANCHOR from the new bundle before " +
        "patching. Search for: print-permission-gate",
    )
  }
  if (status.startsWith("anchor-ambiguous")) {
    throw new Error(`Anchor matched ${anchorCount} times; expected exactly 1.`)
  }

  const cliPath = options.output ?? sourceCli
  const report = { cliPath, status, anchorCount, installed: [] }

  if (options.check) return report

  // Where the provider modules go: beside whichever bundle we produce, so the
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
    // Still hand back an identical copy so callers get a usable bundle.
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
