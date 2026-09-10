/**
 * Permission RPC tracing.
 *
 * Records the exact JSON cmd-acp sends to a client and the exact JSON it gets
 * back, so the option-id contract can be established from observed traffic
 * instead of assumptions. Writes to a file rather than stdout: stdout carries
 * the ACP stream and must stay free of anything that is not a JSON-RPC frame.
 *
 * Enable with CMD_ACP_PERMISSION_TRACE=<path>. When unset this is a no-op.
 */

import { appendFileSync } from "node:fs"

/** Path from the environment, or null when tracing is off. */
function tracePath(): string | null {
  const value = process.env.CMD_ACP_PERMISSION_TRACE?.trim()
  return value ? value : null
}

/** Append one JSON line describing a traced event. */
export function tracePermission(event: string, data: Record<string, unknown>): void {
  const path = tracePath()
  if (!path) return
  const record = { time: new Date().toISOString(), event, ...data }
  try {
    appendFileSync(path, JSON.stringify(record) + "\n")
  } catch {
    // Tracing is best-effort.
  }
}
