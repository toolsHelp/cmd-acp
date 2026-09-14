/**
 * Prepare the local fork workspace so a patched bundle can actually run.
 *
 * The patched bundle is a copy of Command Code's `dist/cli.mjs`, which imports
 * its dependencies as bare specifiers (`@opentelemetry/api`, ...). Node resolves
 * those from the bundle's own directory upwards, so the workspace needs a
 * `node_modules` beside it — plus a `package.json`, because the bundle reads its
 * own version from there.
 *
 * Both live under `fork/cc/`, which git ignores, so they are recreated here
 * instead of committed. Re-run this after switching Node versions: the link
 * follows the running Node's install directory, not a fixed path.
 *
 * Plain ESM (no TypeScript syntax): this file runs via `node tools/...`.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveCliPath, resolveCommandCodeDir } from "./command-code-patch/patch.mjs"

const DEFAULT_WORKSPACE = "fork/cc"

function valueOf(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/**
 * Point `linkPath` at `target`.
 *
 * An existing link is replaced only when it points elsewhere. A real directory
 * is left alone, because deleting it could destroy work this tool did not
 * create; a dangling link is replaced, which is the whole point — that is what
 * a Node upgrade leaves behind.
 */
function linkModules(target, linkPath) {
  let existing
  try {
    existing = lstatSync(linkPath)
  } catch {
    existing = null
  }

  if (existing && !existing.isSymbolicLink()) {
    return { status: "blocked" }
  }

  if (existing) {
    let current
    try {
      current = readlinkSync(linkPath)
    } catch {
      current = null
    }
    if (current && resolve(current).toLowerCase() === resolve(target).toLowerCase()) {
      return { status: "already-linked", target: current }
    }
    rmSync(linkPath, { force: true })
  }

  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir")
  return { status: "linked", target }
}

/**
 * Prepare `workspace` to run a patched bundle built from `commandCodeDir`.
 *
 * Throws rather than exiting so callers (and tests) can react; the CLI wrapper
 * below turns a throw into a message and a non-zero exit.
 */
export function linkForkDeps(options = {}) {
  const commandCodeDir = resolveCommandCodeDir(options.commandCodeDir)
  const cliPath = resolveCliPath(commandCodeDir)
  if (!existsSync(cliPath)) {
    throw new Error(
      `Command Code bundle not found at ${cliPath}. Pass the Command Code ` +
        "package directory, or set COMMAND_CODE_DIR.",
    )
  }

  const commandCodeModules = join(commandCodeDir, "node_modules")
  if (!existsSync(commandCodeModules)) {
    throw new Error(
      `No node_modules under ${commandCodeDir}. The bundle imports its ` +
        "dependencies as bare specifiers, so they have to be installed there.",
    )
  }

  const workspaceDir = resolve(options.workspace ?? DEFAULT_WORKSPACE)
  const link = linkModules(commandCodeModules, join(workspaceDir, "node_modules"))
  if (link.status === "blocked") {
    throw new Error(
      `${join(workspaceDir, "node_modules")} exists and is not a symlink. Move ` +
        "it aside so the bundle resolves against Command Code's own dependencies.",
    )
  }

  const packageJson = join(commandCodeDir, "package.json")
  const packageJsonStatus = existsSync(packageJson) ? "copied" : "missing at source"
  if (existsSync(packageJson)) {
    copyFileSync(packageJson, join(workspaceDir, "package.json"))
  }

  return { commandCodeDir, workspaceDir, packageJsonStatus, link }
}

function main() {
  const args = process.argv.slice(2)
  const dirFlag = valueOf(args, "--dir")
  const positional = args.filter((a) => !a.startsWith("--") && a !== dirFlag)

  let report
  try {
    report = linkForkDeps({ commandCodeDir: positional[0], workspace: dirFlag })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  console.log(`command-code : ${report.commandCodeDir}`)
  console.log(`workspace    : ${report.workspaceDir}`)
  console.log(`package.json : ${report.packageJsonStatus}`)
  console.log(
    `node_modules : ${report.link.status}` +
      (report.link.target ? ` -> ${report.link.target}` : ""),
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
