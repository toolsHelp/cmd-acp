#!/usr/bin/env node
// Fake Command Code CLI for tests. Reads -p "<prompt>" and emits the same
// NDJSON shape as `cmd -p --output-format json`:
//   {"type":"event","event":{"type":"tool_running",...}}
//   {"type":"result","subtype":"success",...}
// Honors --yolo / --model by including them in the emitted text.
const args = process.argv.slice(2)
let prompt = ""
let yolo = false
let model = ""
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
    i++
  }
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n")

emit({
  type: "event",
  event: {
    type: "tool_running",
    toolCallId: "t1",
    toolName: "read_file",
    description: "Read package.json",
  },
})
emit({
  type: "result",
  subtype: "success",
  sessionId: "fake-session-1",
  stopReason: "end_turn",
  finalText: `Fake response to: ${prompt}${yolo ? " (yolo)" : ""}${model ? ` model=${model}` : ""}`,
})
