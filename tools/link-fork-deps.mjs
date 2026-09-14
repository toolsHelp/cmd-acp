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
import { resolveCliPath, resolveCommandCodeDir } from "./command-code-patch/patch.mjs"

const DEFAULT_WORKSPACE = "fork/cc"

function valueOf(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/**
 * Point `linkPath` at `target`.
 *
 * An existing link is replaced only when it points elsewhere; a real directory
 * is left alone, because deleting it could destroy work this tool did not
 * create. A dangling link is replaced, which is the whole point: it is what a
 * Node upgrade leaves behind.
 */
function linkModules(target, linkPath) {
  let existing
  try {
    existing = lstatSync(linkPath)
  } catch {
    existing = null
  }

  if (existing && !existing.isSymbolicLink()) {
    return { status: "left-alone", reason: "exists and is not a symlink" }
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

function main() {
  const args = process.argv.slice(2)
  const dirFlag = valueOf(args, "--dir")
  const positional = args.filter((a) => !a.startsWith("--") && a !== dirFlag)

  const commandCodeDir = resolveCommandCodeDir(positional[0])
  const cliPath = resolveCliPath(commandCodeDir)
  if (!existsSync(cliPath)) {
    console.error(`Command Code bundle not found at ${cliPath}`)
    console.error("Pass the Command Code package directory, or set COMMAND_CODE_DIR.")
    process.exit(1)
  }

  const commandCodeModules = join(commandCodeDir, "node_modules")
  if (!existsSync(commandCodeModules)) {
    console.error(
      `No node_modules under ${commandCodeDir}. The bundle imports its ` +
        "dependencies as bare specifiers, so they have to be installed there.",
    )
    process.exit(1)
  }

  const workspaceDir = resolve(dirFlag ?? DEFAULT_WORKSPACE)
  mkdirSync(workspaceDir, { recursive: true })

  const packageJson = join(commandCodeDir, "package.json")
  const packageJsonStatus = existsSync(packageJson) ? "copied" : "missing at source"
  if (existsSync(packageJson)) {
    copyFileSync(packageJson, join(workspaceDir, "package.json"))
  }

  const link = linkModules(commandCodeModules, join(workspaceDir, "node_modules"))

  console.log(`command-code : ${commandCodeDir}`)
  console.log(`workspace    : ${workspaceDir}`)
  console.log(`package.json : ${packageJsonStatus}`)
  console.log(
    `node_modules : ${link.status}` +
      (link.target ? ` -> ${link.target}` : "") +
      (link.reason ? ` (${link.reason})` : ""),
  )

  if (link.status === "left-alone") {
    console.error(
      "Refusing to finish: a real node_modules directory is in the way. Move " +
        "it aside and re-run so the bundle resolves against Command Code's own.",
    )
    process.exit(1)
  }
}

main()
