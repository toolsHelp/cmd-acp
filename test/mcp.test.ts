import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { materializeMcp } from "../src/mcp.js"
import type { McpServer } from "@agentclientprotocol/sdk"

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmd-acp-mcp-"))
  return dir
}

function stdioServer(name: string, command: string, args: string[]): McpServer {
  return { name, command, args } as unknown as McpServer
}

describe("materializeMcp", () => {
  test("writes .mcp.json with injected servers and cleans up", () => {
    const dir = makeDir()
    const cleanup = materializeMcp(dir, [stdioServer("github", "npx", ["-y", "@modelcontextprotocol/server-github"])])

    const mcpPath = join(dir, ".mcp.json")
    expect(existsSync(mcpPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8"))
    expect(parsed.mcpServers).toBeTruthy()
    const key = Object.keys(parsed.mcpServers)[0]
    expect(parsed.mcpServers[key].command).toBe("npx")
    expect(parsed.mcpServers[key].args).toContain("@modelcontextprotocol/server-github")

    cleanup()
    expect(existsSync(mcpPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("no-op when no stdio servers are injected", () => {
    const dir = makeDir()
    const cleanup = materializeMcp(dir, null)
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false)
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  test("preserves a pre-existing .mcp.json", () => {
    const dir = makeDir()
    const mcpPath = join(dir, ".mcp.json")
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { original: { command: "echo" } } }))

    const cleanup = materializeMcp(dir, [stdioServer("gh", "gh", ["mcp"])])
    const injected = JSON.parse(readFileSync(mcpPath, "utf8"))
    expect(Object.keys(injected.mcpServers)).toContain("gh")

    cleanup()
    const restored = JSON.parse(readFileSync(mcpPath, "utf8"))
    expect(restored.mcpServers.original).toBeTruthy()
    rmSync(dir, { recursive: true, force: true })
  })
})
