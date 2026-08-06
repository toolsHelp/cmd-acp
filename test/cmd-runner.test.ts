import { describe, expect, test } from "bun:test"
import { runCmdPrompt, resolveCmdBinary } from "../src/cmd-runner.js"
import { fileURLToPath } from "node:url"

const fakeCmd = fileURLToPath(new URL("./fake-cmd.mjs", import.meta.url))

describe("runCmdPrompt", () => {
  test("parses tool_running events and success result", async () => {
    process.env.CMD_BIN = fakeCmd
    const tools: string[] = []
    const chunks: string[] = []
    const outcome = await runCmdPrompt({
      prompt: "hello",
      cwd: process.cwd(),
      onTool: (t) => tools.push(t.toolName),
      onText: (t) => chunks.push(t),
    })
    expect(outcome.stopReason).toBe("end_turn")
    expect(outcome.tools.map((t) => t.toolName)).toEqual(["read_file"])
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
