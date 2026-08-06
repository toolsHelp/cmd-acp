import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { McpServer } from "@agentclientprotocol/sdk"

const MCP_JSON = ".mcp.json"
const ORIGINAL_MCP_JSON = ".mcp.json.cmd-acp.bak"

interface McpJsonShape {
  mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
}

/**
 * Convert ACP `McpServer` (stdio) to the `.mcp.json` shape Command Code reads.
 * Only stdio servers are supported (http/sse are skipped).
 */
function toCommandCodeServer(server: McpServer) {
  // McpServer is a union that includes McpServerStdio (no `type` discriminator
  // on the stdio variant); http/sse variants carry a `type` field we skip.
  if ("type" in server) return null
  const s = server as { name?: string; command?: string; args?: string[]; env?: { name: string; value: string }[] }
  if (!s.command) return null
  const env: Record<string, string> = {}
  for (const v of s.env ?? []) {
    if (v.name && v.value !== undefined) env[v.name] = String(v.value)
  }
  return {
    command: s.command,
    args: s.args ?? [],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }
}

/**
 * Materialize the MCP servers a client injected on session/new into a
 * `.mcp.json` in the session cwd, so Command Code connects them.
 *
 * Preserves any pre-existing `.mcp.json` (backed up to `.mcp.json.cmd-acp.bak`)
 * and restores it on release. Returns a cleanup function.
 */
export function materializeMcp(cwd: string, servers: McpServer[] | null | undefined): () => void {
  const stdioServers = (servers ?? []).map(toCommandCodeServer).filter(Boolean) as {
    command: string
    args: string[]
    env?: Record<string, string>
  }[]

  // Nothing to inject: make cleanup a no-op.
  if (stdioServers.length === 0) {
    return () => {}
  }

  const mcpPath = join(cwd, MCP_JSON)
  const bakPath = join(cwd, ORIGINAL_MCP_JSON)
  const hadOriginal = existsSync(mcpPath)

  const mcpServers: McpJsonShape["mcpServers"] = {}
  for (const s of stdioServers) {
    // Use the command as a stable-ish key; de-dupe by command.
    const key = s.command.split(/[\\/]/).pop() ?? s.command
    if (!mcpServers[key]) mcpServers[key] = s
  }
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
