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

  test("writes http servers with url and object headers", () => {
    const dir = makeDir()
    // Shape Paseo actually sends on session/new.
    const httpServer = {
      type: "http",
      name: "paseo",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=abc",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
    } as unknown as McpServer

    const cleanup = materializeMcp(dir, [httpServer])
    const mcpPath = join(dir, ".mcp.json")
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8"))
    const entry = parsed.mcpServers.paseo
    expect(entry).toBeTruthy()
    expect(entry.type).toBe("http")
    expect(entry.url).toContain("127.0.0.1:6767")
    // ACP sends headers as an array; Command Code expects a plain object.
    expect(entry.headers).toEqual({ Authorization: "Bearer tok" })
    expect(entry.command).toBeUndefined()

    cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes stdio env as a plain object", () => {
    const dir = makeDir()
    const server = {
      name: "srv",
      command: "node",
      args: ["server.js"],
      env: [{ name: "TOKEN", value: "abc" }],
    } as unknown as McpServer

    const cleanup = materializeMcp(dir, [server])
    const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))
    expect(parsed.mcpServers.srv.env).toEqual({ TOKEN: "abc" })

    cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  test("skips the acp transport", () => {
    const dir = makeDir()
    const acpServer = { type: "acp", name: "x", id: "srv-1" } as unknown as McpServer
    const cleanup = materializeMcp(dir, [acpServer])
    // Nothing convertible → no file written at all.
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false)
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
})
