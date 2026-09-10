/**
 * Per-session permission broker registry.
 *
 * A broker server is created lazily for the session that needs one and torn
 * down with that session. The socket address is unique per session so two
 * concurrent sessions can never receive each other's decisions.
 *
 * Wiring, end to end:
 *
 *   Command Code (patched gate)
 *        |  CMD_ACP_PERMISSION_BROKER=<address>
 *        v
 *   PermissionBrokerServer            this module
 *        |  PermissionRequestHandler
 *        v
 *   ACPPermissionHandler              session/request_permission
 *        |
 *        v
 *   ACP client
 */

import { randomUUID } from "node:crypto"
import { PermissionBrokerServer } from "./broker-server.js"
import type { PermissionRequestHandler } from "./provider.js"

export interface SessionBroker {
  /** Address to hand to Command Code via the environment. */
  address: string
  stop(): Promise<void>
}

/** Stable-but-unique pipe/socket name for a session. */
export function brokerAddressForSession(sessionId: string, unique = randomUUID()): string {
  // Keep the tail short: Windows pipe names are limited in length.
  const short = unique.replace(/-/g, "").slice(0, 12)
  return `cmd-acp-permission-${short}`
}

export interface CreateBrokerOptions {
  sessionId: string
  /** Builds the handler; called once per session with its own abort signal. */
  makeHandler: () => PermissionRequestHandler
  timeoutMs?: number
  log?: (message: string) => void
}

/**
 * Start a broker server for one session.
 *
 * The caller owns the returned handle and must `stop()` it on session
 * close/cancel, otherwise a pending prompt outlives its session.
 */
export async function startSessionBroker(options: CreateBrokerOptions): Promise<SessionBroker> {
  const address = brokerAddressForSession(options.sessionId)
  const server = new PermissionBrokerServer({
    address,
    handler: options.makeHandler(),
    timeoutMs: options.timeoutMs ?? 0,
    ...(options.log ? { log: options.log } : {}),
  })
  await server.start()
  return {
    // Hand back the normalised address so Command Code connects to exactly
    // what the server bound.
    address: server.addressForClients,
    stop: () => server.stop(),
  }
}

/** Read the broker timeout from the environment, if configured. */
export function brokerTimeoutFromEnv(): number {
  const raw = Number(process.env.CMD_ACP_PERMISSION_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}
