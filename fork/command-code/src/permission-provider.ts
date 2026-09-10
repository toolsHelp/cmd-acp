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
 * Why a decision was requested.
 *
 * Command Code attaches this when a tool needs confirmation. `kind` is
 * preserved verbatim (`"ask-rule"` when the user's own rules matched,
 * otherwise a risk classification) so a policy layer can apply finer rules
 * than "this tool, always".
 */
export interface PermissionRisk {
  kind: string
  detail?: string
}

/**
 * What the caller knows about a tool call when it asks for a decision.
 *
 * Fields are optional where the caller may not have them: `toolCallId` is not
 * supplied by `headlessInteraction`, and `sessionId` only exists in
 * multi-turn/headless runs.
 */
export interface PermissionContext {
  toolCallId?: string
  toolName: string
  input: unknown
  /** Human-readable summary, when the caller produced one. */
  description?: string
  /** Structured reason the prompt is being raised. */
  risk?: PermissionRisk
  /** Extra explanation for the prompt UI, when available. */
  explain?: unknown
  sessionId?: string
}

/**
 * The verdict.
 *
 * `always_allow` is distinct from `allow` on purpose: clients that remember
 * choices ("Allow this tool from now on") need to express a policy change,
 * not just a one-shot approval. A provider that does not implement persistence
 * should return `allow`.
 *
 * `explicit` marks a decision that came from a real answering party. The
 * caller uses it to tell "the provider refused this" apart from "no provider
 * answered", which must fall back to the built-in rules instead of denying.
 */
export type PermissionDecision =
  | { type: "allow"; explicit?: boolean }
  | { type: "always_allow"; explicit?: boolean }
  | { type: "deny"; message: string; explicit?: boolean }

/** Source of permission decisions. */
export interface PermissionProvider {
  check(ctx: PermissionContext): Promise<PermissionDecision>
}

/**
 * Default provider: reproduces Command Code's built-in headless behaviour.
 *
 * Its message text is injected rather than imported, because this module is
 * loaded from beside a minified bundle and cannot reach its internals.
 *
 * `explicit` is left unset: this provider has no opinion about the tool, it
 * only states that it cannot answer. The caller then applies the built-in
 * rules, which is exactly what the unpatched bundle would have done.
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
 *
 * Every decision is marked `explicit`: whatever the transport reports, it
 * represents an answer from a real party (including "the broker timed out", a
 * denial the caller should honour rather than reinterpret).
 */
export class BrokerPermissionProvider implements PermissionProvider {
  constructor(private readonly transport: PermissionTransport) {}

  async check(ctx: PermissionContext): Promise<PermissionDecision> {
    const decision = await this.transport.request(ctx)
    return { ...decision, explicit: true }
  }
}

/** Normalise an arbitrary decision to a boolean, defaulting to deny. */
export function isAllowed(decision: PermissionDecision | undefined | null): boolean {
  return decision?.type === "allow" || decision?.type === "always_allow"
}
