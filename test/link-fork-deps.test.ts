import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linkForkDeps } from "../tools/link-fork-deps.mjs"

let roots: string[] = []

function tmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cmd-acp-${label}-`))
  roots.push(dir)
  return dir
}

/** A minimal stand-in for an installed Command Code package. */
function fakeCommandCode(options: { modules?: boolean } = {}): string {
  const root = tmpDir("cc")
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "dist", "cli.mjs"), "// the bundle\n")
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "command-code", version: "9.9.9", type: "module" }),
  )
  if (options.modules !== false) {
    mkdirSync(join(root, "node_modules", "@opentelemetry", "api"), { recursive: true })
  }
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe("linkForkDeps", () => {
  test("gives the workspace the link and package.json the bundle reads", () => {
    const commandCodeDir = fakeCommandCode()
    const workspace = join(tmpDir("ws"), "nested")

    const report = linkForkDeps({ commandCodeDir, workspace })

    expect(report.link.status).toBe("linked")
    expect(readlinkSync(join(workspace, "node_modules"))).toBe(
      join(commandCodeDir, "node_modules"),
    )
    const copied = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
    expect(copied.version).toBe("9.9.9")
  })

  test("is idempotent, so re-running it after a Node upgrade is safe", () => {
    const commandCodeDir = fakeCommandCode()
    const workspace = tmpDir("ws")

    linkForkDeps({ commandCodeDir, workspace })

    expect(linkForkDeps({ commandCodeDir, workspace }).link.status).toBe("already-linked")
  })

  test("refuses to replace a real directory and writes nothing", () => {
    const commandCodeDir = fakeCommandCode()
    const workspace = tmpDir("ws")
    mkdirSync(join(workspace, "node_modules"), { recursive: true })

    expect(() => linkForkDeps({ commandCodeDir, workspace })).toThrow(/not a symlink/)
    expect(lstatSync(join(workspace, "node_modules")).isDirectory()).toBe(true)
    expect(existsSync(join(workspace, "package.json"))).toBe(false)
  })

  test("fails when the package has no bundle", () => {
    const commandCodeDir = tmpDir("empty")

    expect(() => linkForkDeps({ commandCodeDir, workspace: tmpDir("ws") })).toThrow(
      /bundle not found/,
    )
  })

  test("fails when the package has no node_modules to link", () => {
    const commandCodeDir = fakeCommandCode({ modules: false })

    expect(() => linkForkDeps({ commandCodeDir, workspace: tmpDir("ws") })).toThrow(
      /No node_modules/,
    )
  })
})
