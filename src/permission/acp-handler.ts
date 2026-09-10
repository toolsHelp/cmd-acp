/**
 * ACP-backed permission handler.
 *
 * The only module in cmd-acp that knows both worlds: it takes a broker request
 * (transport-agnostic) and turns it into an ACP `session/request_permission`
 * call, then maps the client's answer back to a broker decision.
 *
 * ACP specifics that matter here (verified against SDK 1.3.0):
 *   - `AgentContext` has no `requestPermission()`; the call goes through the
 *     generic `request(method, params, options)` with the method constant
 *   - `params` must be annotated `RequestPermissionRequest`, otherwise TS falls
 *     back to the permissive `request<Response, Params>` overload and silently
 *     stops checking the payload
 *   - the response discriminates on `outcome.outcome`, and `optionId` lives
 *     inside `outcome`
 *   - there is no request-id field in ACP; correlation uses our own
 *     `requestId` on the broker side only
 */

import * as acp from "@agentclientprotocol/sdk"
import type {
  AgentContext,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type {
  PermissionDecision,
  PermissionRequestContext,
  PermissionRequestHandler,
} from "./provider.js"

/** Option ids cmd-acp issues; the `kind` carries the semantics. */
export const OPTION_IDS = {
  allowOnce: "allow-once",
  allowAlways: "allow-always",
  rejectOnce: "reject-once",
  rejectAlways: "reject-always",
} as const

/** The option list presented to the user, in display order. */
export function permissionOptions(): PermissionOption[] {
  return [
    { optionId: OPTION_IDS.allowOnce, name: "Allow once", kind: "allow_once" },
    { optionId: OPTION_IDS.allowAlways, name: "Allow always", kind: "allow_always" },
    { optionId: OPTION_IDS.rejectOnce, name: "Reject", kind: "reject_once" },
    { optionId: OPTION_IDS.rejectAlways, name: "Reject always", kind: "reject_always" },
  ]
}

/** Map a Command Code tool name onto an ACP tool kind. */
export function toolKindFor(toolName: string): NonNullable<ToolCallUpdate["kind"]> {
  switch (toolName) {
    case "shell_command":
    case "monitor_command":
    case "kill_shell":
      return "execute"
    case "edit_file":
    case "write_file":
    case "apply_patch":
      return "edit"
    case "read_file":
      return "read"
    case "list_dir":
    case "glob":
    case "grep":
      return "search"
    case "delete_file":
      return "delete"
    case "move_file":
      return "move"
    default:
      return "other"
  }
}

/** One-line title, preferring the most telling argument. */
export function describeToolCall(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    const candidate =
      record.command ?? record.file_path ?? record.path ?? record.pattern ?? record.query
    if (typeof candidate === "string" && candidate.trim()) {
      return `${toolName}: ${candidate.trim()}`
    }
  }
  return toolName
}

/** Build the ACP request payload for a broker request. */
export function buildPermissionParams(
  sessionId: string,
  ctx: PermissionRequestContext,
): RequestPermissionRequest {
  const title = describeToolCall(ctx.toolName, ctx.input)
  // Reuse Command Code's tool call id when it supplied one: the client looks up
  // its tool snapshot by that id to render the prompt.
  const toolCallId = ctx.toolCallId ?? ctx.requestId
  const params: RequestPermissionRequest = {
    sessionId,
    toolCall: {
      toolCallId,
      kind: toolKindFor(ctx.toolName),
      title,
      status: "pending",
      ...(ctx.input !== undefined
        ? { rawInput: ctx.input as Record<string, unknown> }
        : {}),
    },
    options: permissionOptions(),
  }
  return params
}

/**
 * Map an ACP response onto a broker decision.
 *
 * Unknown option ids deny: an unrecognised approval must never become an
 * approval. `cancelled` maps to `cancelled` so Command Code can distinguish a
 * user abort from an explicit refusal.
 */
export function mapACPOutcome(response: RequestPermissionResponse): PermissionDecision {
  const outcome = response.outcome
  if (outcome.outcome === "cancelled") {
    return { result: "cancelled", reason: "Permission request cancelled by client" }
  }
  switch (outcome.optionId) {
    case OPTION_IDS.allowOnce:
      return { result: "allow", scope: "once" }
    case OPTION_IDS.allowAlways:
      return { result: "allow", scope: "always" }
    case OPTION_IDS.rejectAlways:
      return { result: "deny", reason: "Denied by user (always)" }
    case OPTION_IDS.rejectOnce:
      return { result: "deny", reason: "Denied by user" }
    default:
      return { result: "deny", reason: `Unrecognised permission option: ${outcome.optionId}` }
  }
}

export interface ACPPermissionHandlerOptions {
  /** ACP session this handler answers for. */
  sessionId: string
  /** Aborts the ACP call when the prompt turn is cancelled. */
  signal?: AbortSignal
}

/**
 * Asks the connected ACP client for a decision.
 *
 * A client that does not implement `session/request_permission` makes the
 * request fail with a JSON-RPC method-not-found error; that is reported as a
 * denial rather than thrown, so one unsupported method cannot kill the turn.
 */
export class ACPPermissionHandler implements PermissionRequestHandler {
  constructor(
    private readonly client: AgentContext,
    private readonly options: ACPPermissionHandlerOptions,
  ) {}

  async handle(ctx: PermissionRequestContext): Promise<PermissionDecision> {
    const params = buildPermissionParams(this.options.sessionId, ctx)
    let response: RequestPermissionResponse
    try {
      response = await this.client.request(
        acp.methods.client.session.requestPermission,
        params,
        ...(this.options.signal ? [{ cancellationSignal: this.options.signal }] : []),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { result: "deny", reason: `Permission request failed: ${message}` }
    }
    return mapACPOutcome(response)
  }
}
