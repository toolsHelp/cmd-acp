import { randomUUID } from "node:crypto"
import type { CmdConfig } from "./cmd-runner.js"

export interface Session {
  id: string
  cwd: string
  config: CmdConfig
  /** AbortController for the in-flight `cmd` process (if any). */
  promptAbort: AbortController | null
  /** Last sessionId returned by `cmd`'s result frame (for future --resume). */
  cmdSessionId?: string
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>()

  create(cwd: string): Session {
    const id = randomUUID()
    const session: Session = { id, cwd, config: {}, promptAbort: null }
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
    this.sessions.delete(sessionId)
  }

  cancelPrompt(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.promptAbort && !session.promptAbort.signal.aborted) {
      session.promptAbort.abort()
    }
  }
}
