/**
 * IPC transport for the permission broker.
 *
 * Newline-delimited JSON over a local socket:
 *   - Windows: named pipe, addressed by bare pipe name
 *   - POSIX:   unix domain socket path
 *
 * The address comes from `CMD_ACP_PERMISSION_BROKER`. The gate checks that
 * variable before constructing this transport, so an absent broker keeps
 * Command Code's built-in fail-closed behaviour.
 *
 * Wire protocol (version 1) — see `protocol.ts`:
 *   -> permission_request  { requestId, sessionId, toolCall: {...} }
 *   <- permission_response { requestId, decision: { result } }
 *
 * Failure policy: any error resolves to `deny`. A broken broker must never
 * become an unintended approval.
 */

import { connect, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import type {
  PermissionContext,
  PermissionDecision,
  PermissionTransport,
} from "./permission-provider.js"

const PROTOCOL_VERSION = "1.0"

/** Broker wire decision -> provider decision. */
interface BrokerResponse {
  type?: string
  requestId?: string
  decision?: {
    result?: "allow" | "deny" | "timeout" | "cancelled"
    reason?: string
    scope?: "once" | "session" | "always"
  }
}

/**
 * Normalise a broker address for `net.connect`.
 *
 * On Windows a named pipe must be addressed as `\\.\pipe\<name>`; a bare name
 * fails with EACCES. Accept either spelling so configuration stays readable.
 */
export function normalizeBrokerAddress(value: string, platform = process.platform): string {
  if (platform !== "win32") return value
  return value.startsWith("\\\\") ? value : `\\\\.\\pipe\\${value}`
}

export interface IpcTransportOptions {
  /** Pipe name (Windows) or socket path (POSIX). */
  address: string
  /** Reported to the broker so it can bind a decision to a session. */
  sessionId?: () => string | undefined
  /** 0 disables the timeout (wait for the user indefinitely). */
  timeoutMs?: number
}

export class IpcPermissionTransport implements PermissionTransport {
  private socket: Socket | null = null
  private buffer = ""
  private connecting: Promise<Socket | null> | null = null
  private readonly pending = new Map<string, (d: PermissionDecision) => void>()

  constructor(private readonly options: IpcTransportOptions) {}

  async request(ctx: PermissionContext): Promise<PermissionDecision> {
    const socket = await this.ensureSocket()
    if (!socket) {
      return { type: "deny", message: "Permission broker is not reachable" }
    }

    const requestId = `req_${randomUUID()}`
    const sessionId = this.options.sessionId?.()
    const payload = {
      type: "permission_request",
      version: PROTOCOL_VERSION,
      requestId,
      ...(sessionId ? { sessionId } : {}),
      toolCall: {
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        toolName: ctx.toolName,
        input: ctx.input,
      },
      timestamp: Date.now(),
    }

    const answer = new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })

    socket.write(JSON.stringify(payload) + "\n")

    const limit = this.options.timeoutMs ?? 0
    if (limit <= 0) return answer

    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<PermissionDecision>((resolve) => {
      timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ type: "deny", message: "Permission request timed out" })
      }, limit)
      if (typeof timer.unref === "function") timer.unref()
    })
    try {
      return await Promise.race([answer, timeout])
    } finally {
      clearTimeout(timer!)
    }
  }

  close(): void {
    this.failAll("Permission broker connection closed")
    try {
      this.socket?.destroy()
    } catch {
      // Already gone.
    }
    this.socket = null
  }

  private failAll(message: string): void {
    for (const [, resolve] of this.pending) {
      resolve({ type: "deny", message })
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: BrokerResponse
    try {
      message = JSON.parse(line) as BrokerResponse
    } catch {
      // Malformed frame: ignore rather than fail a pending request; the
      // timeout (or connection close) will settle it.
      return
    }
    if (message.type !== "permission_response") return
    const requestId = message.requestId
    if (!requestId) return
    const resolve = this.pending.get(requestId)
    if (!resolve) return
    this.pending.delete(requestId)
    resolve(toDecision(message))
  }

  private ensureSocket(): Promise<Socket | null> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting

    this.connecting = new Promise<Socket | null>((resolve) => {
      const socket = connect(normalizeBrokerAddress(this.options.address))
      socket.setEncoding("utf8")
      socket.on("connect", () => {
        this.socket = socket
        this.connecting = null
        resolve(socket)
      })
      socket.on("data", (chunk: string) => {
        this.buffer += chunk
        let index: number
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + 1)
          this.handleLine(line)
        }
      })
      const giveUp = (why: string) => {
        this.connecting = null
        this.socket = null
        this.failAll(`Permission broker unavailable: ${why}`)
        resolve(null)
      }
      socket.on("error", (err: Error) => giveUp(err.message))
      socket.on("close", () => {
        this.socket = null
        this.failAll("Permission broker connection closed")
      })
    })
    return this.connecting
  }
}

/** Map a broker wire response onto a provider decision, defaulting to deny. */
export function toDecision(message: BrokerResponse): PermissionDecision {
  const result = message.decision?.result
  if (result === "allow") {
    // `always`/`session` scope is a policy change the broker already applied;
    // the gate only needs to know it may run.
    return message.decision?.scope === "always"
      ? { type: "always_allow" }
      : { type: "allow" }
  }
  const message_ =
    message.decision?.reason ??
    (result === "timeout"
      ? "Permission request timed out"
      : result === "cancelled"
        ? "Permission request cancelled"
        : "Permission denied")
  return { type: "deny", message: message_ }
}
