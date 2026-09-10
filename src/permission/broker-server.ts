/**
 * Permission broker server.
 *
 * Listens on a local socket for Command Code's permission requests, forwards
 * each to a `PermissionRequestHandler`, and writes the decision back on the
 * same connection.
 *
 * Responsibilities are deliberately narrow:
 *   - own the socket lifecycle
 *   - correlate requests to replies by `requestId`
 *   - enforce a timeout so a silent handler cannot hang Command Code forever
 *   - clean up pending requests when a connection or the server goes away
 *
 * Policy lives in the handler; nothing here knows about ACP, Paseo or tools.
 */

import { createServer, type Server, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { unlinkSync, existsSync } from "node:fs"
import {
  DENY_REASONS,
  PERMISSION_PROTOCOL_VERSION,
  REQUEST_ID_PREFIX,
  isPermissionRequest,
  type PermissionResponseMessage,
} from "./protocol.js"
import {
  toContext,
  type PermissionDecision,
  type PermissionRequestHandler,
} from "./provider.js"

export interface BrokerServerOptions {
  /** Pipe name (Windows) or socket path (POSIX). Normalised on Windows. */
  address: string
  handler: PermissionRequestHandler
  /** Milliseconds to wait for a decision. 0 disables the timeout. */
  timeoutMs?: number
  /** Diagnostic sink. Defaults to a no-op. */
  log?: (message: string) => void
}

/** A request that has been forwarded and is awaiting a decision. */
interface PendingRequest {
  requestId: string
  createdAt: number
  toolName: string
}

/** Normalise a broker address for `net.connect`/`listen`. */
export function normalizeBrokerAddress(value: string, platform = process.platform): string {
  if (platform !== "win32") return value
  return value.startsWith("\\\\") ? value : `\\\\.\\pipe\\${value}`
}

export class PermissionBrokerServer {
  private readonly address: string
  private readonly handler: PermissionRequestHandler
  private readonly timeoutMs: number
  private readonly log: (message: string) => void

  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  /** requestId -> pending entry, across all connections. */
  private readonly pending = new Map<string, PendingRequest>()
  /** socket -> its in-flight request ids, for cleanup on disconnect. */
  private readonly owned = new Map<Socket, Set<string>>()
  private listening = false

  constructor(options: BrokerServerOptions) {
    this.address = normalizeBrokerAddress(options.address)
    this.handler = options.handler
    this.timeoutMs = options.timeoutMs ?? 0
    this.log = options.log ?? (() => {})
  }

  /** The address clients should connect to (normalised for the platform). */
  get addressForClients(): string {
    return this.address
  }

  get isListening(): boolean {
    return this.listening
  }

  /** Number of requests awaiting a decision. */
  get pendingCount(): number {
    return this.pending.size
  }

  async start(): Promise<void> {
    if (this.server) return

    // A stale unix socket file would make listen() fail with EADDRINUSE.
    if (process.platform !== "win32" && existsSync(this.address)) {
      try {
        unlinkSync(this.address)
      } catch {
        // Nothing to do; listen() below reports the real problem.
      }
    }

    const server = createServer((socket) => this.onConnection(socket))
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening)
        reject(err)
      }
      const onListening = () => {
        server.off("error", onError)
        this.listening = true
        this.log(`permission broker listening on ${this.address}`)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(this.address)
    })
  }

  /**
   * Stop listening and settle every outstanding request as cancelled.
   *
   * Called on session close/cancel so a pending prompt cannot outlive the
   * session and leave Command Code waiting on a socket nobody will answer.
   */
  async stop(): Promise<void> {
    this.cancelAll(DENY_REASONS.cancelled)
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    }
    this.sockets.clear()
    this.owned.clear()

    const server = this.server
    this.server = null
    this.listening = false
    if (!server) return

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  /**
   * Abandon every in-flight request.
   *
   * Callers are expected to have already asked their handler to settle those
   * requests (e.g. by cancelling the prompt turn). This only clears the local
   * bookkeeping so a stopped server reports no pending work.
   */
  cancelAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.log(`request ${id} (${entry.toolName}) cancelled: ${reason}`)
    }
    this.pending.clear()
    for (const ids of this.owned.values()) ids.clear()
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket)
    this.owned.set(socket, new Set())
    socket.setEncoding("utf8")
    this.log("permission broker client connected")

    let buffer = ""
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        void this.handleLine(socket, line)
      }
    })
    socket.on("error", (err: Error) => {
      this.log(`permission broker socket error: ${err.message}`)
    })
    socket.on("close", () => {
      this.sockets.delete(socket)
      this.releaseSocket(socket, DENY_REASONS.closed)
    })
  }

  /** Drop the requests a disconnected client still had in flight. */
  private releaseSocket(socket: Socket, reason: string): void {
    const ids = this.owned.get(socket)
    this.owned.delete(socket)
    if (!ids) return
    for (const id of ids) {
      const entry = this.pending.get(id)
      this.pending.delete(id)
      if (entry) this.log(`request ${id} released: ${reason}`)
    }
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.log("ignoring malformed frame from client")
      return
    }
    if (!isPermissionRequest(parsed)) return

    const requestId = parsed.requestId || `${REQUEST_ID_PREFIX}${randomUUID()}`
    const ctx = toContext({ ...parsed, requestId })
    this.log(
      `permission request ${requestId} tool=${ctx.toolName} ` +
        `toolCallId=${ctx.toolCallId ?? "-"} session=${ctx.sessionId ?? "-"}`,
    )

    const decision = await this.decide(socket, ctx)

    if (socket.destroyed) {
      this.log(`request ${requestId} settled after client disconnect; dropping reply`)
      return
    }
    this.write(socket, requestId, decision)
  }

  /** Run the handler under the configured timeout. */
  private async decide(
    socket: Socket,
    ctx: {
      requestId: string
      sessionId?: string
      toolCallId?: string
      toolName: string
      input?: unknown
    },
  ): Promise<PermissionDecision> {
    const id = ctx.requestId
    this.pending.set(id, { requestId: id, createdAt: Date.now(), toolName: ctx.toolName })
    this.owned.get(socket)?.add(id)

    let handlerPromise: Promise<PermissionDecision>
    try {
      handlerPromise = this.handler.handle(ctx)
    } catch (err) {
      this.pending.delete(id)
      this.owned.get(socket)?.delete(id)
      return { result: "deny", reason: `Handler threw: ${String(err)}` }
    }

    const settled = handlerPromise.catch(
      (err): PermissionDecision => ({
        result: "deny",
        reason: `Handler failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    )

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout =
      this.timeoutMs > 0
        ? new Promise<PermissionDecision>((resolve) => {
            timer = setTimeout(() => {
              resolve({ result: "timeout", reason: DENY_REASONS.timeout })
            }, this.timeoutMs)
            if (typeof timer.unref === "function") timer.unref()
          })
        : null

    try {
      return await (timeout ? Promise.race([settled, timeout]) : settled)
    } finally {
      if (timer) clearTimeout(timer)
      this.pending.delete(id)
      this.owned.get(socket)?.delete(id)
    }
  }

  private write(socket: Socket, requestId: string, decision: PermissionDecision): void {
    const frame: PermissionResponseMessage = {
      type: "permission_response",
      version: PERMISSION_PROTOCOL_VERSION,
      requestId,
      decision:
        decision.result === "allow"
          ? { result: "allow", ...(decision.scope ? { scope: decision.scope } : {}) }
          : { result: decision.result, reason: decision.reason },
      timestamp: Date.now(),
    }
    try {
      socket.write(JSON.stringify(frame) + "\n")
    } catch (err) {
      this.log(`failed to write decision for ${requestId}: ${String(err)}`)
      return
    }
    this.log(`permission response ${requestId} -> ${decision.result}`)
  }
}
