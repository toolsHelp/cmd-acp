import { describe, expect, test } from "bun:test"
import { runCmdPrompt, resolveCmdBinary } from "../src/cmd-runner.js"
import { fileURLToPath } from "node:url"

const fakeCmd = fileURLToPath(new URL("./fake-cmd.mjs", import.meta.url))

describe("runCmdPrompt", () => {
  test("parses tool events and success result", async () => {
    process.env.CMD_BIN = fakeCmd
    const tools: string[] = []
    const chunks: string[] = []
    const blocked: string[] = []
    const thoughts: string[] = []
    const outcome = await runCmdPrompt({
      prompt: "hello",
      cwd: process.cwd(),
      onTool: (t) => tools.push(t.toolName),
      onToolBlocked: (t) => blocked.push(t.toolName),
      onThought: (t) => thoughts.push(t),
      onText: (t) => chunks.push(t),
    })
    expect(outcome.stopReason).toBe("end_turn")
    expect(tools).toEqual(["read_file"])
    expect(blocked).toEqual(["read_file"])
    expect(thoughts.join("")).toBe("Let me think about this.")
    expect(outcome.finalText).toContain("hello")
    expect(outcome.cmdSessionId).toBe("fake-session-1")
    expect(chunks.join("")).toContain("hello")
    delete process.env.CMD_BIN
  })

  test("forwards --yolo and --model flags", async () => {
    process.env.CMD_BIN = fakeCmd
    const outcome = await runCmdPrompt({
      prompt: "fix it",
      cwd: process.cwd(),
      config: { permissionMode: "yolo", model: "grok-4.5" },
    })
    expect(outcome.finalText).toContain("(yolo)")
    expect(outcome.finalText).toContain("model=grok-4.5")
    delete process.env.CMD_BIN
  })

  test("forwards --resume, --plan, and --effort flags", async () => {
    process.env.CMD_BIN = fakeCmd
    const outcome = await runCmdPrompt({
      prompt: "continue",
      cwd: process.cwd(),
      config: {
        resumeSessionId: "prev-123",
        mode: "plan",
        reasoning: "high",
      },
    })
    expect(outcome.finalText).toContain("resumed=prev-123")
    expect(outcome.finalText).toContain("(plan)")
    expect(outcome.finalText).toContain("effort=high")
    delete process.env.CMD_BIN
  })

  test("parses usage from result frame", async () => {
    process.env.CMD_BIN = fakeCmd
    const outcome = await runCmdPrompt({ prompt: "hi", cwd: process.cwd() })
    expect(outcome.usage?.totalTokens).toBe(1234)
    expect(outcome.usage?.inputTokens).toBe(1000)
    delete process.env.CMD_BIN
  })

  test("maps nonzero exit to error", async () => {
    process.env.CMD_BIN = "false" // exits 1, no stdout
    const outcome = await runCmdPrompt({ prompt: "x", cwd: process.cwd() })
    expect(outcome.stopReason).toBe("error")
    expect(outcome.error).toBeTruthy()
    delete process.env.CMD_BIN
  })

  test("resolveCmdBinary respects CMD_BIN override", () => {
    process.env.CMD_BIN = "/custom/cmd"
    expect(resolveCmdBinary()).toBe("/custom/cmd")
    delete process.env.CMD_BIN
    expect(resolveCmdBinary()).toBe("cmd")
  })
})
