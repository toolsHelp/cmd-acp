/**
 * Permission request handling for cmd-acp.
 *
 * The broker server owns transport and correlation; it contains no policy.
 * Deciding *how* to answer is delegated to a `PermissionRequestHandler`, so
 * the same server can be driven by an ACP client, a console prompt, an
 * auto-approve rule set, or a test double.
 *
 *   PermissionBrokerServer          transport + correlation ids
 *           |
 *           v
 *   PermissionRequestHandler        policy
 *           |
 *     +-----+------------------+
 *     |                        |
 *   ACPPermissionHandler     ConsolePermissionHandler
 *   (asks the ACP client)    (no client: deny, loudly)
 *
 * Deliberately free of ACP types: `sessionId` is an opaque string here, and
 * the handler decides what to do with it.
 */

import { DENY_REASONS, type PermissionRequestMessage } from "./protocol.js"

/** What a handler is told about a pending tool call. */
export interface PermissionRequestContext {
  /** Broker correlation id, unique per request. */
  requestId: string
  /** Opaque session id supplied by Command Code, when it had one. */
  sessionId?: string
  /** Command Code's tool call id, stable across its queued/blocked pair. */
  toolCallId?: string
  toolName: string
  input?: unknown
}

/** The handler's verdict. */
export type PermissionDecision =
  | { result: "allow"; scope?: "once" | "session" | "always" }
  | { result: "deny"; reason: string }
  | { result: "timeout"; reason?: string }
  | { result: "cancelled"; reason?: string }

export interface PermissionRequestHandler {
  /**
   * Decide whether a tool may run.
   *
   * Implementations must not throw: the server treats a thrown error as a
   * denial, but returning a decision keeps the reason legible to the user.
   */
  handle(ctx: PermissionRequestContext): Promise<PermissionDecision>
}

/** Convert a wire request into the handler's context. */
export function toContext(message: PermissionRequestMessage): PermissionRequestContext {
  return {
    requestId: message.requestId,
    sessionId: message.sessionId,
    toolCallId: message.toolCall.toolCallId,
    toolName: message.toolCall.toolName,
    input: message.toolCall.input,
  }
}

/**
 * Denies everything, with a reason that says why.
 *
 * Used when no interactive client is available. Refusing loudly is the only
 * safe default: silently allowing an unattended tool call would turn a missing
 * client into an unattended privilege escalation.
 */
export class ConsolePermissionHandler implements PermissionRequestHandler {
  constructor(private readonly log: (message: string) => void = () => {}) {}

  async handle(ctx: PermissionRequestContext): Promise<PermissionDecision> {
    this.log(
      `permission request denied (no interactive client): tool=${ctx.toolName} ` +
        `session=${ctx.sessionId ?? "-"} request=${ctx.requestId}`,
    )
    return { result: "deny", reason: DENY_REASONS.unavailable }
  }
}

/**
 * Allows everything. For tests and explicit opt-in only.
 *
 * The scope is configurable so a test can exercise the `always` path.
 */
export class AutoApprovePermissionHandler implements PermissionRequestHandler {
  constructor(private readonly scope: "once" | "session" | "always" = "once") {}

  async handle(): Promise<PermissionDecision> {
    return { result: "allow", scope: this.scope }
  }
}
