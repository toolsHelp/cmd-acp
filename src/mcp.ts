import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { HttpHeader, McpServer } from "@agentclientprotocol/sdk"

const MCP_JSON = ".mcp.json"
const ORIGINAL_MCP_JSON = ".mcp.json.cmd-acp.bak"

/** A `.mcp.json` entry in the shape Command Code's `inferTransport` understands. */
interface McpJsonServer {
  type?: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

interface McpJsonShape {
  mcpServers: Record<string, McpJsonServer>
}

/** Convert ACP's `[{name, value}]` header list to the object form Command Code reads. */
function headersToRecord(headers: HttpHeader[] | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const h of headers ?? []) {
    if (h?.name && h.value !== undefined) out[h.name] = String(h.value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Convert ACP `env` entries (`[{name, value}]`) to a plain record. */
function envToRecord(env: { name: string; value: string }[] | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const v of env ?? []) {
    if (v?.name && v.value !== undefined) out[v.name] = String(v.value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Convert one ACP `McpServer` to the `.mcp.json` shape Command Code reads.
 *
 * Returns null for variants Command Code cannot launch: `acp` (an ACP-internal
 * transport) and any http/sse entry missing a url.
 */
export function toCommandCodeServer(server: McpServer): McpJsonServer | null {
  if ("type" in server) {
    switch (server.type) {
      case "http":
      case "sse": {
        if (!server.url) return null
        return {
          type: server.type,
          url: server.url,
          headers: headersToRecord(server.headers),
        }
      }
      case "acp":
        // Client-side ACP proxy transport; Command Code has no equivalent.
        return null
      default:
        return null
    }
  }
  // McpServerStdio carries no `type` discriminator.
  const s = server as {
    command?: string
    args?: string[]
    env?: { name: string; value: string }[]
  }
  if (!s.command) return null
  return {
    type: "stdio",
    command: s.command,
    args: s.args ?? [],
    env: envToRecord(s.env),
  }
}

/** Stable, filesystem-safe key for a server entry. */
function serverKey(server: McpServer, fallback: string): string {
  const name = (server as { name?: string }).name
  if (typeof name === "string" && name.trim()) return name.trim()
  const converted = toCommandCodeServer(server)
  const basis = converted?.command ?? converted?.url ?? fallback
  const tail = basis.split(/[\\/]/).pop() ?? basis
  return tail.replace(/[^A-Za-z0-9._-]/g, "_") || fallback
}

/**
 * Materialize the MCP servers a client injected on session/new into a
 * `.mcp.json` in the session cwd, so Command Code connects them.
 *
 * Supports the stdio, http and sse ACP transports. Preserves any pre-existing
 * `.mcp.json` (backed up to `.mcp.json.cmd-acp.bak`) and restores it on
 * release. Returns a cleanup function.
 */
export function materializeMcp(cwd: string, servers: McpServer[] | null | undefined): () => void {
  const list = servers ?? []
  const mcpServers: Record<string, McpJsonServer> = {}
  let index = 0
  for (const server of list) {
    const converted = toCommandCodeServer(server)
    index += 1
    if (!converted) continue
    const key = serverKey(server, `server-${index}`)
    if (!mcpServers[key]) mcpServers[key] = converted
  }

  // Nothing to inject: make cleanup a no-op.
  if (Object.keys(mcpServers).length === 0) {
    return () => {}
  }

  const mcpPath = join(cwd, MCP_JSON)
  const bakPath = join(cwd, ORIGINAL_MCP_JSON)
  const hadOriginal = existsSync(mcpPath)

  const shape: McpJsonShape = { mcpServers }

  // Back up any existing .mcp.json before overwriting.
  if (hadOriginal) {
    try {
      writeFileSync(bakPath, readFileSync(mcpPath))
    } catch {
      // Best-effort backup.
    }
  }

  try {
    writeFileSync(mcpPath, JSON.stringify(shape, null, 2))
  } catch {
    // Failed to write — cleanup should not try to restore.
    return () => {}
  }

  return () => {
    try {
      rmSync(mcpPath, { force: true })
    } catch {
      // Best-effort cleanup.
    }
    if (hadOriginal) {
      try {
        writeFileSync(mcpPath, readFileSync(bakPath))
        rmSync(bakPath, { force: true })
      } catch {
        // Best-effort restore.
      }
    }
  }
}
