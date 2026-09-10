/**
 * Permission provider abstraction for Command Code's headless permission gate.
 *
 * This module is deliberately free of any transport, client or product
 * concepts (no ACP, no named pipes, no sessions-as-protocol). It answers one
 * question: may this tool run?
 *
 *   print-permission-gate
 *           |
 *           v
 *   PermissionProvider            <- this file
 *           |
 *     +-----+------+
 *     |            |
 *   Console      Broker
 *   (default)    (delegates to a PermissionTransport)
 *
 * Keeping the gate on this interface means a future transport (pipe, socket,
 * websocket, stdio) can be swapped in without touching Command Code again.
 */

/**
 * What the gate knows about a tool call when it asks for a decision.
 *
 * Fields are optional where the caller may not have them: `toolCallId` comes
 * from the harness, `sessionId` only exists in multi-turn/headless runs.
 */
export interface PermissionContext {
  toolCallId?: string
  toolName: string
  input: unknown
  sessionId?: string
}

/**
 * The gate's verdict.
 *
 * `always_allow` is distinct from `allow` on purpose: clients that remember
 * choices ("Allow this tool from now on") need to express a policy change,
 * not just a one-shot approval. A provider that does not implement persistence
 * should return `allow`.
 */
export type PermissionDecision =
  | { type: "allow" }
  | { type: "always_allow" }
  | { type: "deny"; message: string }

/** Source of permission decisions. */
export interface PermissionProvider {
  check(ctx: PermissionContext): Promise<PermissionDecision>
}

/**
 * Default provider: reproduces Command Code's built-in headless behaviour
 * exactly — sensitive tools are refused with the standard hint.
 *
 * Its message text is injected rather than imported, because this module is
 * loaded from beside a minified bundle and cannot reach its internals.
 */
export class ConsolePermissionProvider implements PermissionProvider {
  constructor(
    private readonly denyMessage: (toolName: string) => string,
  ) {}

  async check(ctx: PermissionContext): Promise<PermissionDecision> {
    return { type: "deny", message: this.denyMessage(ctx.toolName) }
  }
}

/**
 * Transport for reaching an external decision maker.
 *
 * Implementations own their framing and failure handling. A transport must
 * never resolve to `allow` because it failed — breakage degrades to a denial.
 */
export interface PermissionTransport {
  request(ctx: PermissionContext): Promise<PermissionDecision>
}

/**
 * Provider backed by an external transport.
 *
 * Kept separate from `ConsolePermissionProvider` so Command Code never needs
 * to know how a decision is reached.
 */
export class BrokerPermissionProvider implements PermissionProvider {
  constructor(private readonly transport: PermissionTransport) {}

  async check(ctx: PermissionContext): Promise<PermissionDecision> {
    return this.transport.request(ctx)
  }
}

/** Normalise an arbitrary decision to a boolean, defaulting to deny. */
export function isAllowed(decision: PermissionDecision | undefined | null): boolean {
  return decision?.type === "allow" || decision?.type === "always_allow"
}
