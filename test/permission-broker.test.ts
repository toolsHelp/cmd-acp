import { afterEach, describe, expect, test } from "bun:test"
import { connect, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { PermissionBrokerServer, normalizeBrokerAddress } from "../src/permission/broker-server.js"
import { AutoApprovePermissionHandler, ConsolePermissionHandler } from "../src/permission/provider.js"
import type { PermissionRequestHandler } from "../src/permission/provider.js"
import type { PermissionResponseMessage } from "../src/permission/protocol.js"

/** Unique pipe name per test, so parallel runs cannot collide. */
function testAddress(): string {
  return `cmd-acp-test-${randomUUID()}`
}

const servers: PermissionBrokerServer[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.destroy()
    } catch {
      // Already closed.
    }
  }
  for (const server of servers.splice(0)) {
    await server.stop()
  }
})

async function startServer(
  handler: PermissionRequestHandler,
  timeoutMs?: number,
): Promise<PermissionBrokerServer> {
  const server = new PermissionBrokerServer({
    address: testAddress(),
    handler,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  await server.start()
  servers.push(server)
  return server
}

/** Open a client connection and give back a line-oriented reader. */
function connectClient(server: PermissionBrokerServer): {
  send: (frame: unknown) => void
  nextResponse: () => Promise<PermissionResponseMessage>
} {
  const socket = connect(server.addressForClients)
  sockets.push(socket)
  socket.setEncoding("utf8")

  let buffer = ""
  const queue: PermissionResponseMessage[] = []
  const waiters: ((value: PermissionResponseMessage) => void)[] = []

  socket.on("data", (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as PermissionResponseMessage
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else queue.push(parsed)
    }
  })

  return {
    send: (frame) => socket.write(JSON.stringify(frame) + "\n"),
    nextResponse: () =>
      new Promise<PermissionResponseMessage>((resolve, reject) => {
        const queued = queue.shift()
        if (queued) {
          resolve(queued)
          return
        }
        const timer = setTimeout(() => reject(new Error("timed out waiting for response")), 5000)
        waiters.push((value) => {
          clearTimeout(timer)
          resolve(value)
        })
      }),
  }
}

function request(sessionId: string, toolName: string, input?: unknown) {
  return {
    type: "permission_request",
    version: "1.0",
    requestId: `req_${randomUUID()}`,
    sessionId,
    toolCall: { toolCallId: "call_abc", toolName, input },
    timestamp: Date.now(),
  }
}

describe("PermissionBrokerServer", () => {
  test("allows when the handler allows", async () => {
    const server = await startServer(new AutoApprovePermissionHandler("once"))
    const client = connectClient(server)
    const frame = request("sess-1", "write_file", { file_path: "a.txt" })
    client.send(frame)

    const response = await client.nextResponse()
    expect(response.type).toBe("permission_response")
    expect(response.requestId).toBe(frame.requestId)
    expect(response.decision.result).toBe("allow")
    expect(response.decision.scope).toBe("once")
  })

  test("propagates always_allow scope", async () => {
    const server = await startServer(new AutoApprovePermissionHandler("always"))
    const client = connectClient(server)
    client.send(request("sess-1", "shell_command"))
    const response = await client.nextResponse()
    expect(response.decision.result).toBe("allow")
    expect(response.decision.scope).toBe("always")
  })

  test("denies with the handler's reason", async () => {
    const handler: PermissionRequestHandler = {
      handle: async () => ({ result: "deny", reason: "user said no" }),
    }
    const server = await startServer(handler)
    const client = connectClient(server)
    client.send(request("sess-1", "write_file"))
    const response = await client.nextResponse()
    expect(response.decision.result).toBe("deny")
    expect(response.decision.reason).toBe("user said no")
  })

  test("forwards tool identity and session to the handler", async () => {
    let seen: Record<string, unknown> | null = null
    const handler: PermissionRequestHandler = {
      handle: async (ctx) => {
        seen = ctx as unknown as Record<string, unknown>
        return { result: "allow" }
      },
    }
    const server = await startServer(handler)
    const client = connectClient(server)
    const frame = request("sess-42", "shell_command", { command: "rm -rf x" })
    client.send(frame)
    await client.nextResponse()

    expect(seen).toBeTruthy()
    expect(seen!.toolName).toBe("shell_command")
    expect(seen!.sessionId).toBe("sess-42")
    expect(seen!.toolCallId).toBe("call_abc")
    expect(seen!.requestId).toBe(frame.requestId)
    expect((seen!.input as { command: string }).command).toBe("rm -rf x")
  })

  test("times out to deny instead of hanging", async () => {
    // Handler never settles.
    const handler: PermissionRequestHandler = {
      handle: () => new Promise(() => {}),
    }
    const server = await startServer(handler, 150)
    const client = connectClient(server)
    client.send(request("sess-1", "write_file"))

    const response = await client.nextResponse()
    expect(response.decision.result).toBe("timeout")
    expect(response.decision.reason).toBeTruthy()
  })

  test("treats a throwing handler as a denial", async () => {
    const handler: PermissionRequestHandler = {
      handle: () => {
        throw new Error("boom")
      },
    }
    const server = await startServer(handler)
    const client = connectClient(server)
    client.send(request("sess-1", "write_file"))
    const response = await client.nextResponse()
    expect(response.decision.result).toBe("deny")
    expect(response.decision.reason).toContain("boom")
  })

  test("defaults to deny when no interactive client is available", async () => {
    const server = await startServer(new ConsolePermissionHandler())
    const client = connectClient(server)
    client.send(request("sess-1", "write_file"))
    const response = await client.nextResponse()
    expect(response.decision.result).toBe("deny")
    expect(response.decision.reason).toBeTruthy()
  })

  test("handles concurrent requests on one connection", async () => {
    const server = await startServer(new AutoApprovePermissionHandler())
    const client = connectClient(server)
    const frames = [
      request("sess-1", "write_file"),
      request("sess-1", "shell_command"),
      request("sess-2", "edit_file"),
    ]
    for (const frame of frames) client.send(frame)

    const seen = new Set<string>()
    for (let i = 0; i < frames.length; i++) {
      const response = await client.nextResponse()
      seen.add(response.requestId)
      expect(response.decision.result).toBe("allow")
    }
    // Every request gets exactly its own reply.
    expect(seen).toEqual(new Set(frames.map((f) => f.requestId)))
    expect(server.pendingCount).toBe(0)
  })

  test("ignores malformed and unknown frames", async () => {
    const server = await startServer(new AutoApprovePermissionHandler())
    const client = connectClient(server)
    // Garbage, then a valid request: the valid one must still be answered.
    client.send({ type: "something_else" })
    const frame = request("sess-1", "write_file")
    client.send(frame)
    const response = await client.nextResponse()
    expect(response.requestId).toBe(frame.requestId)
  })

  test("stop() clears pending state", async () => {
    const handler: PermissionRequestHandler = { handle: () => new Promise(() => {}) }
    const server = await startServer(handler)
    const client = connectClient(server)
    client.send(request("sess-1", "write_file"))
    await new Promise((r) => setTimeout(r, 50))
    expect(server.pendingCount).toBe(1)

    await server.stop()
    expect(server.pendingCount).toBe(0)
    expect(server.isListening).toBe(false)
  })
})

describe("normalizeBrokerAddress", () => {
  test("prefixes a bare pipe name on Windows", () => {
    expect(normalizeBrokerAddress("cmd-acp-x", "win32")).toBe("\\\\.\\pipe\\cmd-acp-x")
  })

  test("leaves an already-qualified pipe path alone", () => {
    expect(normalizeBrokerAddress("\\\\.\\pipe\\cmd-acp-x", "win32")).toBe("\\\\.\\pipe\\cmd-acp-x")
  })

  test("leaves a unix socket path alone", () => {
    expect(normalizeBrokerAddress("/tmp/cmd-acp.sock", "linux")).toBe("/tmp/cmd-acp.sock")
  })
})
