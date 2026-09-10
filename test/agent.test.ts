import { describe, expect, test } from "bun:test"
import * as acp from "@agentclientprotocol/sdk"
import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"

// Point the bridge at the fake CLI for the whole integration test.
const fakeCmd = fileURLToPath(new URL("./fake-cmd.mjs", import.meta.url))
const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url))

/** Spawn the compiled cmd-acp binary and drive it via a ClientContext. */
async function withClient<T>(fn: (ctx: acp.ClientContext) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, CMD_BIN: fakeCmd },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let childErr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (c) => (childErr += c))
  child.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`cmd-acp child exited code=${code} sig=${sig}\n${childErr}`)
    }
  })
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    return await acp
      .client({ name: "cmd-acp-test" })
      .connectWith(stream, async (ctx) => fn(ctx))
  } finally {
    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 1000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/** Extract plain text from an ACP ContentBlock (text or image). */
function blockText(content: unknown): string {
  if (content && typeof content === "object") {
    const c = content as { type?: string; text?: string }
    if (c.type === "text" && typeof c.text === "string") return c.text
  }
  return ""
}

describe("cmd-acp ACP server (E2E over stdio)", () => {
  test("initialize + session/new + prompt streams agent_message_chunk and returns end_turn", async () => {
    await withClient(async (ctx) => {
      const init = await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION)
      expect(init.agentCapabilities?.loadSession).toBe(false)

      const session = await ctx.buildSession(process.cwd()).start()
      expect(session.sessionId).toBeTruthy()
      // session/new must expose the configOptions the client renders as its
      // selectors: model, reasoning, and a single mode list.
      const opts = session.newSessionResponse.configOptions ?? []
      const ids = opts.map((o) => o.id)
      expect(ids).toContain("model")
      expect(ids).toContain("reasoning")
      expect(ids).toContain("mode")
      const model = opts.find((o) => o.id === "model")
      expect(model && model.type === "select" ? model.options.length : 0).toBeGreaterThan(0)
      // `yolo` must be reachable as a mode, otherwise a client can never
      // enable edits/shell (there is no separate permission selector).
      const mode = opts.find((o) => o.id === "mode")
      const modeValues =
        mode && mode.type === "select"
          ? mode.options.flatMap((o) => ("value" in o ? [o.value] : []))
          : []
      expect(modeValues).toContain("yolo")
      expect(modeValues).toContain("plan")

      const chunks: string[] = []
      const thoughts: string[] = []
      const responsePromise = session.prompt("hello world")
      let message = await session.nextUpdate()
      while (message.kind !== "stop") {
        if (message.kind === "session_update") {
          if (message.update?.sessionUpdate === "agent_message_chunk") {
            chunks.push(blockText(message.update.content))
          } else if (message.update?.sessionUpdate === "agent_thought_chunk") {
            thoughts.push(blockText(message.update.content))
          }
        }
        message = await session.nextUpdate()
      }
      const response = await responsePromise
      expect(response.stopReason).toBe("end_turn")
      expect(chunks.join("")).toContain("hello world")
      // Reasoning must be surfaced separately, not merged into the answer.
      expect(thoughts.join("")).toBe("Let me think about this.")
      expect(chunks.join("")).not.toContain("Let me think")
    })
  })

  test("maps tool_queued/tool_denied to tool_call and tool_call_update", async () => {
    await withClient(async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      const session = await ctx.buildSession(process.cwd()).start()
      const calls: { id: string; kind: string; title: string; status: string }[] = []
      const updates: { id: string; status: string }[] = []
      const responsePromise = session.prompt("hello")
      let message = await session.nextUpdate()
      while (message.kind !== "stop") {
        if (message.kind === "session_update") {
          const u = message.update
          if (u?.sessionUpdate === "tool_call") {
            calls.push({
              id: u.toolCallId,
              kind: u.kind ?? "",
              title: u.title ?? "",
              status: u.status ?? "",
            })
          } else if (u?.sessionUpdate === "tool_call_update") {
            updates.push({ id: u.toolCallId, status: u.status ?? "" })
          }
        }
        message = await session.nextUpdate()
      }
      await responsePromise

      // Command Code's own id must be reused verbatim: a permission request
      // looks up the tool snapshot by this id.
      expect(calls).toHaveLength(1)
      expect(calls[0].id).toBe("call_fake0001")
      expect(calls[0].kind).toBe("read")
      expect(calls[0].title).toBe("read_file: package.json")
      expect(calls[0].status).toBe("in_progress")

      // Not run with --yolo, so the tool is refused and must surface as failed.
      expect(updates).toHaveLength(1)
      expect(updates[0].id).toBe("call_fake0001")
      expect(updates[0].status).toBe("failed")
    })
  })

  test("emits usage_update and resumes the cmd session on the 2nd prompt", async () => {
    await withClient(async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      const session = await ctx.buildSession(process.cwd()).start()
      const chunks: string[] = []

      async function runTurn(prompt: string): Promise<string> {
        const respPromise = session.prompt(prompt)
        let message = await session.nextUpdate()
        const turnChunks: string[] = []
        while (message.kind !== "stop") {
          if (message.kind === "session_update") {
            const u = message.update
            if (u?.sessionUpdate === "agent_message_chunk") {
              turnChunks.push(blockText(u.content))
            } else if (u?.sessionUpdate === "usage_update") {
              expect(u.used).toBeGreaterThan(0)
            }
          }
          message = await session.nextUpdate()
        }
        await respPromise
        return turnChunks.join("")
      }

      // Turn 1: no --resume.
      const first = await runTurn("first message")
      expect(first).toContain("first message")
      expect(first).not.toContain("resumed=")

      // Turn 2: must pass --resume <cmdSessionId> for continuity.
      const second = await runTurn("second message")
      expect(second).toContain("second message")
      expect(second).toContain("resumed=fake-session-1")
    })
  })

  test("session/set_mode switches to yolo and enables --yolo", async () => {
    await withClient(async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      const session = await ctx.buildSession(process.cwd()).start()

      // Clients expose session modes natively and call this method.
      await ctx.request("session/set_mode", {
        sessionId: session.sessionId,
        modeId: "yolo",
      })

      const respPromise = session.prompt("go")
      let message = await session.nextUpdate()
      const chunks: string[] = []
      while (message.kind !== "stop") {
        if (message.kind === "session_update" && message.update?.sessionUpdate === "agent_message_chunk") {
          chunks.push(blockText(message.update.content))
        }
        message = await session.nextUpdate()
      }
      await respPromise

      // The fake CLI echoes --yolo, and with --yolo it no longer emits the
      // blocked event.
      expect(chunks.join("")).toContain("(yolo)")
      expect(chunks.join("")).toContain("go")
    })
  })

  test("rejects an unknown mode", async () => {
    await withClient(async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      const session = await ctx.buildSession(process.cwd()).start()
      let failed = false
      try {
        await ctx.request("session/set_mode", {
          sessionId: session.sessionId,
          modeId: "nonsense",
        })
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
    })
  })
})
