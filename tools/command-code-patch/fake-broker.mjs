/**
 * Minimal permission broker for validating the patched gate.
 *
 * Listens on a named pipe (Windows) or unix socket (POSIX), speaks the v1
 * newline-delimited JSON protocol, and answers with a fixed decision chosen by
 * `--decision` / `CMD_ACP_TEST_DECISION`.
 *
 * Not part of the product — Phase 3 replaces this with the ACP bridge.
 *
 * Usage:
 *   node fake-broker.mjs --pipe cmd-acp-test --decision allow
 */

import { createServer } from "node:net"
import { unlinkSync, existsSync } from "node:fs"

const args = process.argv.slice(2)
function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const rawAddress = valueOf("--pipe") ?? process.env.CMD_ACP_TEST_BROKER ?? "cmd-acp-test"
const decision = valueOf("--decision") ?? process.env.CMD_ACP_TEST_DECISION ?? "allow"
const delayMs = Number(valueOf("--delay") ?? 0)
const isWindows = process.platform === "win32"

/**
 * Windows named pipes must be addressed by full path; a bare name yields
 * EACCES. Accept either form so callers can pass a readable short name.
 */
function normalizeAddress(value) {
  if (!isWindows) return value
  return value.startsWith("\\\\") ? value : `\\\\.\\pipe\\${value}`
}

const address = normalizeAddress(rawAddress)

if (!isWindows && existsSync(rawAddress)) {
  try {
    unlinkSync(rawAddress)
  } catch {
    // Stale socket we cannot remove; the bind below will report it.
  }
}

const server = createServer((socket) => {
  socket.setEncoding("utf8")
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      handle(socket, line)
    }
  })
  socket.on("error", () => {})
})

function handle(socket, line) {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type !== "permission_request") return

  console.log(
    `[broker] request ${message.requestId} tool=${message.toolCall?.toolName} ` +
      `id=${message.toolCall?.toolCallId} input=${JSON.stringify(message.toolCall?.input)}`,
  )

  const respond = () => {
    const response = {
      type: "permission_response",
      version: "1.0",
      requestId: message.requestId,
      decision:
        decision === "allow"
          ? { result: "allow", scope: "once" }
          : { result: "deny", reason: `Denied by test broker (${decision})` },
      timestamp: Date.now(),
    }
    socket.write(JSON.stringify(response) + "\n")
    console.log(`[broker] response ${message.requestId} -> ${decision}`)
  }

  if (delayMs > 0) setTimeout(respond, delayMs)
  else respond()
}

server.listen(address, () => {
  console.log(`[broker] listening on ${address} (decision=${decision})`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close()
    process.exit(0)
  })
}
