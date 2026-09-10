import { randomUUID } from "node:crypto"
import type { CmdConfig } from "./cmd-runner.js"
import type { SessionBroker } from "./permission/session-broker.js"

export interface Session {
  id: string
  cwd: string
  config: CmdConfig
  /** AbortController for the in-flight `cmd` process (if any). */
  promptAbort: AbortController | null
  /** Last sessionId returned by `cmd`'s result frame (for --resume). */
  cmdSessionId?: string
  /** True once a prompt has been sent (enables --resume on later turns). */
  hasPrompted: boolean
  /** Cleanup for the materialized .mcp.json (MCP passthrough). */
  cleanupMcp?: () => void
  /** Live permission broker for this session, while a turn is running. */
  broker?: SessionBroker | null
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>()

  create(cwd: string): Session {
    const id = randomUUID()
    const session: Session = { id, cwd, config: {}, promptAbort: null, hasPrompted: false }
    this.sessions.set(id, session)
    return session
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  require(sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    return session
  }

  setConfig(sessionId: string, configId: string, value: string | boolean): Session {
    const session = this.require(sessionId)
    switch (configId) {
      case "model":
        if (typeof value !== "string") throw new Error("model must be a string")
        session.config.model = value
        break
      case "reasoning":
        if (typeof value !== "string") throw new Error("reasoning must be a string")
        session.config.reasoning = value
        break
      case "permission_mode":
        session.config.permissionMode = value === "yolo" ? "yolo" : "safe"
        break
      case "mode":
        // Single mode selector covering both session mode and permission
        // policy. `yolo` is the only value that permits edits/shell, and it is
        // mutually exclusive with `plan`.
        switch (value) {
          case "yolo":
            session.config.permissionMode = "yolo"
            session.config.mode = "normal"
            break
          case "plan":
            session.config.permissionMode = "safe"
            session.config.mode = "plan"
            break
          case "normal":
            session.config.permissionMode = "safe"
            session.config.mode = "normal"
            break
          default:
            throw new Error(`mode must be 'normal', 'plan' or 'yolo'`)
        }
        break
      default:
        throw new Error(`Unknown config option: ${configId}`)
    }
    return session
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.promptAbort) {
      session.promptAbort.abort()
      session.promptAbort = null
    }
    // Tear the broker down before dropping the session: a pending permission
    // prompt must not outlive the session it belongs to.
    if (session?.broker) {
      const broker = session.broker
      session.broker = null
      void broker.stop().catch(() => {})
    }
    session?.cleanupMcp?.()
    this.sessions.delete(sessionId)
  }

  cancelPrompt(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.promptAbort && !session.promptAbort.signal.aborted) {
      session.promptAbort.abort()
    }
  }
}
