import { describe, expect, test } from "bun:test"
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk"
import {
  ACPPermissionHandler,
  OPTION_IDS,
  buildPermissionParams,
  mapACPOutcome,
  permissionOptions,
  toolKindFor,
} from "../src/permission/acp-handler.js"
import type { PermissionRequestContext } from "../src/permission/provider.js"

const ctx: PermissionRequestContext = {
  requestId: "req_1",
  sessionId: "sess-1",
  toolCallId: "call_abc",
  toolName: "write_file",
  input: { file_path: "a.txt", content: "hi" },
}

describe("buildPermissionParams", () => {
  test("uses Command Code's tool call id so the client can find its snapshot", () => {
    const params = buildPermissionParams("sess-1", ctx)
    expect(params.sessionId).toBe("sess-1")
    expect(params.toolCall.toolCallId).toBe("call_abc")
  })

  test("falls back to the broker request id when no tool call id exists", () => {
    const params = buildPermissionParams("sess-1", { ...ctx, toolCallId: undefined })
    expect(params.toolCall.toolCallId).toBe("req_1")
  })

  test("offers all four decision kinds", () => {
    const params = buildPermissionParams("sess-1", ctx)
    expect(params.options.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ])
  })

  test("option ids are cmd-acp's own, so unknown-client ids can be rejected", () => {
    const ids = permissionOptions().map((o) => o.optionId)
    expect(ids).toContain(OPTION_IDS.allowOnce)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("carries the tool title and raw input for the prompt UI", () => {
    const params = buildPermissionParams("sess-1", ctx)
    expect(params.toolCall.title).toContain("a.txt")
    expect(params.toolCall.rawInput).toEqual({ file_path: "a.txt", content: "hi" })
  })
})

describe("toolKindFor", () => {
  test("maps the gated tools onto sensible kinds", () => {
    expect(toolKindFor("write_file")).toBe("edit")
    expect(toolKindFor("edit_file")).toBe("edit")
    expect(toolKindFor("shell_command")).toBe("execute")
    expect(toolKindFor("read_file")).toBe("read")
    expect(toolKindFor("something_new")).toBe("other")
  })
})

describe("mapACPOutcome", () => {
  test("maps allow_once to an allow with once scope", () => {
    const response: RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId: OPTION_IDS.allowOnce },
    }
    expect(mapACPOutcome(response)).toEqual({ result: "allow", scope: "once" })
  })

  test("maps allow_always to an allow with always scope", () => {
    const response: RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId: OPTION_IDS.allowAlways },
    }
    expect(mapACPOutcome(response)).toEqual({ result: "allow", scope: "always" })
  })

  test("maps reject_once to a deny", () => {
    const response: RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId: OPTION_IDS.rejectOnce },
    }
    const decision = mapACPOutcome(response)
    expect(decision.result).toBe("deny")
  })

  test("maps cancelled to cancelled, not deny", () => {
    // Command Code distinguishes a user abort from a refusal.
    const decision = mapACPOutcome({ outcome: { outcome: "cancelled" } })
    expect(decision.result).toBe("cancelled")
  })

  test("denies an unrecognised option id", () => {
    const decision = mapACPOutcome({
      outcome: { outcome: "selected", optionId: "some-other-client-id" },
    })
    expect(decision.result).toBe("deny")
  })
})

describe("ACPPermissionHandler", () => {
  /** Minimal AgentContext stand-in that records the outgoing request. */
  function fakeClient(response: RequestPermissionResponse | Error) {
    const calls: { method: string; params: RequestPermissionRequest; options?: unknown }[] = []
    return {
      calls,
      request: async (method: string, params: RequestPermissionRequest, options?: unknown) => {
        calls.push({ method, params, options })
        if (response instanceof Error) throw response
        return response
      },
    }
  }

  test("sends session/request_permission and maps the answer", async () => {
    const client = fakeClient({
      outcome: { outcome: "selected", optionId: OPTION_IDS.allowOnce },
    })
    const handler = new ACPPermissionHandler(client as never, { sessionId: "sess-1" })
    const decision = await handler.handle(ctx)

    expect(decision).toEqual({ result: "allow", scope: "once" })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].method).toBe("session/request_permission")
    expect(client.calls[0].params.toolCall.toolCallId).toBe("call_abc")
  })

  test("passes the abort signal so a cancel can withdraw the prompt", async () => {
    const client = fakeClient({
      outcome: { outcome: "selected", optionId: OPTION_IDS.allowOnce },
    })
    const controller = new AbortController()
    const handler = new ACPPermissionHandler(client as never, {
      sessionId: "sess-1",
      signal: controller.signal,
    })
    await handler.handle(ctx)
    expect(client.calls[0].options).toEqual({ cancellationSignal: controller.signal })
  })

  test("denies instead of throwing when the client lacks the method", async () => {
    // A client without a session/request_permission handler answers with a
    // JSON-RPC method-not-found error.
    const client = fakeClient(new Error("Method not found"))
    const handler = new ACPPermissionHandler(client as never, { sessionId: "sess-1" })
    const decision = await handler.handle(ctx)
    expect(decision.result).toBe("deny")
    expect("reason" in decision && decision.reason).toContain("Method not found")
  })
})
