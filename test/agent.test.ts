import { describe, expect, test } from "bun:test"
import * as acp from "@agentclientprotocol/sdk"
import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"

// Point the bridge at the fake CLI for the whole integration test.
const fakeCmd = fileURLToPath(new URL("./fake-cmd.mjs", import.meta.url))
const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url))

/** Extract plain text from an ACP ContentBlock (text or image). */
function blockText(content: unknown): string {
  if (content && typeof content === "object") {
    const c = content as { type?: string; text?: string }
    if (c.type === "text" && typeof c.text === "string") return c.text
  }
  return ""
}

/** Spawn the compiled cmd-acp binary and drive it via a ClientContext. */
async function withClient<T>(fn: (ctx: acp.ClientContext) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, CMD_BIN: fakeCmd },
    stdio: ["pipe", "pipe", "pipe"],
  })
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    return await acp
      .client({ name: "cmd-acp-test" })
      .connectWith(stream, async (ctx) => fn(ctx))
  } finally {
    child.kill()
  }
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

      const chunks: string[] = []
      const responsePromise = session.prompt("hello world")
      let message = await session.nextUpdate()
      while (message.kind !== "stop") {
        if (
          message.kind === "session_update" &&
          message.update?.sessionUpdate === "agent_message_chunk"
        ) {
          chunks.push(blockText(message.update.content))
        }
        message = await session.nextUpdate()
      }
      const response = await responsePromise
      expect(response.stopReason).toBe("end_turn")
      expect(chunks.join("")).toContain("hello world")
    })
  })

  test("maps tool_running to tool_call updates", async () => {
    await withClient(async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      const session = await ctx.buildSession(process.cwd()).start()
      const toolTitles: string[] = []
      const responsePromise = session.prompt("hello")
      let message = await session.nextUpdate()
      while (message.kind !== "stop") {
        if (message.kind === "session_update" && message.update?.sessionUpdate === "tool_call") {
          toolTitles.push(message.update.title ?? "")
        }
        message = await session.nextUpdate()
      }
      await responsePromise
      expect(toolTitles).toContain("Read package.json")
    })
  })
})
