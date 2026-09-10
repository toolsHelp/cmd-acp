/**
 * Permission broker wire protocol (v1).
 *
 * Shared shape between Command Code's `BrokerPermissionProvider` (the client,
 * installed by `tools/command-code-patch`) and cmd-acp's `PermissionBrokerServer`
 * (the server). Both sides must stay byte-compatible; this file is the single
 * definition of that contract.
 *
 * Framing: newline-delimited JSON over a local socket
 *   - Windows: named pipe, addressed as `\\.\pipe\<name>`
 *   - POSIX:   unix domain socket path
 *
 * Direction: Command Code -> cmd-acp -> (ACP client) -> cmd-acp -> Command Code
 */

export const PERMISSION_PROTOCOL_VERSION = "1.0"

/** Request id prefix, so broker ids are distinguishable in logs from ACP ids. */
export const REQUEST_ID_PREFIX = "req_"

/** A tool call awaiting a decision. */
export interface PermissionRequestMessage {
  type: "permission_request"
  version: string
  /** Broker-side correlation id. Never sent to the ACP client as such. */
  requestId: string
  /** ACP session the tool call belongs to, when known. */
  sessionId?: string
  toolCall: {
    /** Command Code's own id (`call_<hex>`), stable across queued/blocked. */
    toolCallId?: string
    toolName: string
    input?: unknown
  }
  timestamp?: number
}

/** The broker's verdict. */
export interface PermissionResponseMessage {
  type: "permission_response"
  version: string
  requestId: string
  decision: {
    result: "allow" | "deny" | "timeout" | "cancelled"
    reason?: string
    /** Requested persistence. `always` maps to ACP's `allow_always`. */
    scope?: "once" | "session" | "always"
  }
  timestamp?: number
}

export type BrokerMessage = PermissionRequestMessage | PermissionResponseMessage

/** Reason strings surfaced back to Command Code when a decision is not made. */
export const DENY_REASONS = {
  timeout: "Permission request timed out",
  cancelled: "Permission request was cancelled",
  closed: "Permission broker connection closed",
  unavailable: "Permission broker is not reachable",
} as const

/** Narrow an arbitrary parsed JSON value to a request frame. */
export function isPermissionRequest(value: unknown): value is PermissionRequestMessage {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<PermissionRequestMessage>
  return (
    candidate.type === "permission_request" &&
    typeof candidate.requestId === "string" &&
    !!candidate.toolCall &&
    typeof candidate.toolCall.toolName === "string"
  )
}

/** Narrow an arbitrary parsed JSON value to a response frame. */
export function isPermissionResponse(value: unknown): value is PermissionResponseMessage {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<PermissionResponseMessage>
  return (
    candidate.type === "permission_response" &&
    typeof candidate.requestId === "string" &&
    !!candidate.decision &&
    typeof candidate.decision.result === "string"
  )
}
