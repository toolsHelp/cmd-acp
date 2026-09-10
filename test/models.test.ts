import { describe, expect, test } from "bun:test"
import { parseModelsOutput } from "../src/models.js"

describe("parseModelsOutput", () => {
  test("parses grouped plain-text model list", () => {
    const raw = `Available models  ·  52 models

Open Source

deepseek/deepseek-v4-flash           fast hybrid-attention reasoning (default)
moonshotai/kimi-k3                   long-horizon coding & knowledge work with 1M context
zai-org/glm-5.2                      powerful coding with 1M context

Command Code

claude-sonnet-4-6                    balanced coding
`
    const models = parseModelsOutput(raw)
    expect(models).toHaveLength(4)
    expect(models[0]).toEqual({
      id: "deepseek/deepseek-v4-flash",
      name: "deepseek/deepseek-v4-flash",
      description: "fast hybrid-attention reasoning (default)",
    })
    expect(models[1].id).toBe("moonshotai/kimi-k3")
    expect(models[2].id).toBe("zai-org/glm-5.2")
    // Command Code's own models have no provider prefix and must be kept.
    expect(models[3]).toEqual({
      id: "claude-sonnet-4-6",
      name: "claude-sonnet-4-6",
      description: "balanced coding",
    })
  })

  test("ignores footer and usage lines", () => {
    const raw = `Available models  ·  2 models

Open Source

deepseek/deepseek-v4-flash           fast reasoning

Pass the full id, or just the short name after the last "/":
  cmdc --model moonshotai/kimi-k2.5
  cmdc --model kimi-k2.5
Docs: https://commandcode.ai/docs/reference/cli/models
`
    const models = parseModelsOutput(raw)
    expect(models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-flash"])
  })

  test("ignores header lines and empty lines", () => {
    const models = parseModelsOutput("Available models  ·  52 models\n\nOpen Source\n\n")
    expect(models).toHaveLength(0)
  })
})
