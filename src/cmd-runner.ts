import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

export interface CmdConfig {
  model?: string
  reasoning?: string
  permissionMode?: "safe" | "yolo"
  /** Session mode: normal (default) or plan (read-only, --plan). */
  mode?: "normal" | "plan"
  /** Resume a previous Command Code session (--resume <sessionId>). */
  resumeSessionId?: string
}

export interface CmdToolRunning {
  type: "tool_running"
  toolCallId: string
  toolName: string
  description?: string
}

export interface CmdEvent {
  type: "event"
  event: CmdToolRunning
}

export interface CmdUsage {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CmdResult {
  type: "result"
  subtype: "success" | "error" | "max_turns"
  sessionId?: string
  stopReason?: string
  finalText?: string
  error?: string
  usage?: CmdUsage | null
}

export type CmdLine = CmdEvent | CmdResult

export interface CmdRunOutcome {
  /** Raw final text from Command Code (may be empty on error). */
  finalText: string
  /** Emitted NDJSON tool_running events, in order. */
  tools: CmdToolRunning[]
  stopReason: "end_turn" | "max_turns" | "error" | "cancelled"
  /** Present when subtype === "error". */
  error?: string
  /** sessionId from the result frame, when present. */
  cmdSessionId?: string
  /** Token usage from the result frame, when present. */
  usage?: CmdUsage
}

/**
 * Resolve the `cmd` binary: CMD_BIN env override, then `cmd` on PATH.
 */
export function resolveCmdBinary(): string {
  const override = process.env.CMD_BIN?.trim()
  if (override) return override
  return "cmd"
}

/**
 * Run a single headless Command Code prompt and stream its NDJSON frames.
 * One `cmd -p --output-format json` process per call (fire-and-forget).
 */
export async function runCmdPrompt(opts: {
  prompt: string
  cwd: string
  config?: CmdConfig
  signal?: AbortSignal
  onTool?: (tool: CmdToolRunning) => void
  onText?: (text: string) => void
}): Promise<CmdRunOutcome> {
  const { prompt, cwd, config = {}, signal, onTool, onText } = opts

  const args = ["-p", prompt, "--output-format", "json"]
  if (config.model) args.push("--model", config.model)
  if (config.reasoning) args.push("--effort", config.reasoning)
  if (config.permissionMode === "yolo") args.push("--yolo")
  if (config.mode === "plan") args.push("--plan")
  if (config.resumeSessionId) args.push("--resume", config.resumeSessionId)

  const child = spawn(resolveCmdBinary(), args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (!child.stdout || !child.stderr) {
    throw new Error("Failed to spawn cmd: missing stdio streams")
  }

  const abortHandler = () => {
    child.kill("SIGINT")
  }
  signal?.addEventListener("abort", abortHandler, { once: true })

  let buffered = ""
  const tools: CmdToolRunning[] = []
  let finalText = ""
  let stopReason: CmdRunOutcome["stopReason"] = "end_turn"
  let error: string | undefined
  let cmdSessionId: string | undefined
  let usage: CmdUsage | undefined

  const stderr: string[] = []

  function handleLine(line: string) {
    if (!line.trim()) return
    let parsed: CmdLine
    try {
      parsed = JSON.parse(line) as CmdLine
    } catch {
      // Forward-compatible: ignore non-JSON lines on stdout.
      return
    }
    if (parsed.type === "event" && parsed.event?.type === "tool_running") {
      tools.push(parsed.event)
      onTool?.(parsed.event)
      return
    }
    if (parsed.type === "result") {
      if (parsed.sessionId) cmdSessionId = parsed.sessionId
      if (parsed.usage) usage = parsed.usage
      if (parsed.subtype === "error") {
        stopReason = "error"
        error = parsed.error ?? "Command Code returned an error"
      } else if (parsed.subtype === "max_turns") {
        stopReason = "max_turns"
      }
      if (parsed.finalText) {
        finalText = parsed.finalText
        onText?.(parsed.finalText)
      }
    }
  }

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk
    let nl: number
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      handleLine(line)
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr.push(chunk)
  })

  let exitCode: number | null = null
  try {
    const [code] = await Promise.all([
      new Promise<number>((resolve, reject) => {
        child.on("error", reject)
        child.on("exit", (c) => {
          exitCode = c ?? 0
          resolve(c ?? 0)
        })
      }),
      sleep(0),
    ])
    if (signal?.aborted) {
      return { finalText, tools, stopReason: "cancelled", cmdSessionId, usage }
    }
    if ((stopReason as string) === "error") {
      const stderrText = stderr.join("").trim()
      const fallback = `cmd exited with code ${code}`
      return {
        finalText,
        tools,
        stopReason,
        error: error ?? (stderrText || fallback),
        cmdSessionId,
        usage,
      }
    }
    // Handle nonzero exit / unparsed failure (e.g. auth error EXIT_AUTH_ERROR=3).
    if (exitCode !== 0 && !finalText && tools.length === 0) {
      const stderrText = stderr.join("").trim()
      return {
        finalText: "",
        tools,
        stopReason: "error",
        error: stderrText || `cmd exited with code ${exitCode}`,
        cmdSessionId,
        usage,
      }
    }
    return { finalText, tools, stopReason, cmdSessionId, usage }
  } finally {
    signal?.removeEventListener("abort", abortHandler)
  }
}
