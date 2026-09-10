#!/usr/bin/env node
// Fake Command Code CLI for tests. Supports:
//   -p "<prompt>" --output-format json  → NDJSON stream (tool events + result)
//   --list-models                        → plain-text model list
//   --resume <id>                        → echoes the resumed session id
//   --plan / --effort <l>                → echoed in finalText
// Honors --yolo / --model by including them in the emitted text.
const args = process.argv.slice(2)

if (args.includes("--list-models")) {
  process.stdout.write(`Available models  ·  2 models

Open Source

deepseek/deepseek-v4-flash           fast hybrid-attention reasoning (default)
moonshotai/kimi-k3                   long-horizon coding & knowledge work
`)
  process.exit(0)
}

let prompt = ""
let yolo = false
let model = ""
let effort = ""
let plan = false
let resume = ""
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-p") {
    prompt = args[i + 1] ?? ""
    i++
  } else if (args[i] === "--output-format") {
    i++
  } else if (args[i] === "--yolo") {
    yolo = true
  } else if (args[i] === "--model") {
    model = args[i + 1] ?? ""
    i++
  } else if (args[i] === "--effort") {
    effort = args[i + 1] ?? ""
    i++
  } else if (args[i] === "--plan") {
    plan = true
  } else if (args[i] === "--resume") {
    resume = args[i + 1] ?? ""
    i++
  }
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n")

emit({ type: "event", event: { type: "thinking_start" } })
emit({ type: "event", event: { type: "thinking_delta", delta: "Let me think" } })
emit({ type: "event", event: { type: "thinking_delta", delta: " about this." } })
emit({ type: "event", event: { type: "thinking_end" } })
emit({
  type: "event",
  event: {
    type: "tool_queued",
    toolCallId: "call_fake0001",
    toolName: "read_file",
    input: { file_path: "package.json" },
  },
})
if (!yolo) {
  // Current Command Code releases emit `tool_denied` with no reason at all.
  // The pre-1.53 `tool_hook_blocked` shape is covered by unit tests instead.
  emit({
    type: "event",
    event: {
      type: "tool_denied",
      toolCallId: "call_fake0001",
      toolName: "read_file",
    },
  })
}
emit({
  type: "result",
  subtype: "success",
  sessionId: "fake-session-1",
  stopReason: "end_turn",
  usage: { totalTokens: 1234, inputTokens: 1000, outputTokens: 234 },
  finalText: [
    `Fake response to: ${prompt}`,
    yolo ? "(yolo)" : "",
    model ? `model=${model}` : "",
    effort ? `effort=${effort}` : "",
    plan ? "(plan)" : "",
    resume ? `resumed=${resume}` : "",
  ]
    .filter(Boolean)
    .join(" "),
})
