import * as acp from "@agentclientprotocol/sdk"
import type { SessionConfigOption, ToolKind } from "@agentclientprotocol/sdk"
import { runCmdPrompt } from "./cmd-runner.js"
import { listModels } from "./models.js"
import { materializeMcp } from "./mcp.js"
import { ACPPermissionHandler } from "./permission/acp-handler.js"
import {
  brokerTimeoutFromEnv,
  startSessionBroker,
  type SessionBroker,
} from "./permission/session-broker.js"
import { SessionStore } from "./sessions.js"

export const AGENT_NAME = "cmd-acp"

/** Default context window assumed for `cmd` runs (usage size). */
const DEFAULT_CONTEXT_SIZE = 200_000

/** Map a Command Code tool name to an ACP `ToolKind`. */
function toolKindFor(toolName: string): ToolKind {
  switch (toolName) {
    case "shell_command":
    case "monitor_command":
    case "kill_shell":
      return "execute"
    case "edit_file":
    case "write_file":
    case "apply_patch":
      return "edit"
    case "read_file":
      return "read"
    case "list_dir":
    case "glob":
    case "grep":
    case "search":
      return "search"
    case "delete_file":
      return "delete"
    case "move_file":
      return "move"
    case "webfetch":
    case "fetch":
      return "fetch"
    default:
      return "other"
  }
}

/** One-line title for a tool call, preferring its most telling argument. */
function describeTool(toolName: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    const candidate =
      record.command ?? record.file_path ?? record.path ?? record.pattern ?? record.query
    if (typeof candidate === "string" && candidate.trim()) {
      return `${toolName}: ${candidate.trim()}`
    }
  }
  return toolName
}

/**
 * Build the ACP `configOptions` returned on session/new and
 * session/set_config_option: a `model` select (from `cmd --list-models`,
 * cached), a `reasoning` select (--effort), a `permission_mode` select
 * (safe/yolo), and a `mode` select (normal/plan).
 *
 * When `sessionId` is given, the select values recorded on that session are
 * reported back as `currentValue`, so a client that re-reads the options after
 * a change sees its own selection.
 */
async function buildConfigOptions(
  sessions: SessionStore,
  sessionId?: string,
): Promise<SessionConfigOption[]> {
  const session = sessionId ? sessions.get(sessionId) : undefined
  const options: SessionConfigOption[] = []

  try {
    const models = await listModels()
    if (models.length > 0) {
      const selected =
        session?.config.model && models.some((m) => m.id === session.config.model)
          ? session.config.model
          : models[0].id
      options.push({
        type: "select",
        id: "model",
        name: "Model",
        description: "Command Code model for this session",
        category: "model",
        currentValue: selected,
        options: models.map((m) => ({
          value: m.id,
          name: m.name,
          description: m.description,
        })),
      })
    }
  } catch {
    // `cmd --list-models` failed (auth, missing binary) — omit the model select.
  }

  options.push({
    type: "select",
    id: "reasoning",
    name: "Reasoning effort",
    description: "Reasoning effort for the model (--effort)",
    category: "thought_level",
    currentValue: session?.config.reasoning ?? "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  })

  // A single `mode` select drives both session mode and permission policy.
  // Clients expose only the first `category: "mode"` option as their mode
  // list (and switch it via session/set_mode or this config option), so
  // permission policy has to live here to be reachable from the UI.
  //   normal - full agent, edits/shell refused (Command Code's print default)
  //   plan   - read-only exploration (--plan)
  //   yolo   - allow edits and shell (--yolo)
  const currentMode = session?.config.permissionMode === "yolo" ? "yolo" : (session?.config.mode ?? "normal")
  options.push({
    type: "select",
    id: "mode",
    name: "Session mode",
    description: "normal: tools blocked · plan: read-only (--plan) · yolo: allow edits/shell (--yolo)",
    category: "mode",
    currentValue: currentMode,
    options: [
      { value: "normal", name: "Normal", description: "Full agent, edits and shell blocked" },
      { value: "plan", name: "Plan", description: "Read-only exploration" },
      { value: "yolo", name: "Yolo", description: "Allow edits and shell commands" },
    ],
  })

  return options
}

/**
 * Register all ACP handlers on the agent app.
 */
export function registerHandlers(app: ReturnType<typeof acp.agent>, sessions: SessionStore) {
  app
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }))
    .onRequest("session/new", async (ctx) => {
      const session = sessions.create(ctx.params.cwd ?? process.cwd())
      // MCP passthrough: materialize the injected servers into .mcp.json.
      session.cleanupMcp = materializeMcp(session.cwd, ctx.params.mcpServers)
      const configOptions = await buildConfigOptions(sessions)
      return { sessionId: session.id, configOptions }
    })
    .onRequest("session/close", (ctx) => {
      sessions.close(ctx.params.sessionId)
      return {}
    })
    .onRequest("session/set_config_option", async (ctx) => {
      sessions.setConfig(ctx.params.sessionId, ctx.params.configId, ctx.params.value)
      // Return the full option list with the updated currentValue. Clients
      // replace their cached configOptions with this response, so returning an
      // empty array makes them believe the options no longer exist.
      const configOptions = await buildConfigOptions(sessions, ctx.params.sessionId)
      return { configOptions }
    })
    .onRequest("session/set_mode", (ctx) => {
      // Clients that expose session modes natively call this instead of
      // session/set_config_option. Map the mode id onto the `mode` option.
      // The ACP response carries no configOptions here, so the client keeps
      // its own mode state.
      sessions.setConfig(ctx.params.sessionId, "mode", ctx.params.modeId)
      return {}
    })
    .onRequest("session/prompt", async (ctx) => {
      const session = sessions.require(ctx.params.sessionId)

      const text = ctx.params.prompt
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")

      const notifyText = (chunk: string) =>
        ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
          },
        })

      // Reasoning streams before the answer; send it as a thought chunk so the
      // client can render it separately (Paseo maps this to a "reasoning"
      // timeline item). Without it the turn looks stalled for many seconds.
      const notifyThought = (chunk: string) =>
        ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: chunk },
          },
        })

      // Continuity: from the 2nd turn onward, resume the previous cmd session.
      const config = { ...session.config }
      if (session.hasPrompted && session.cmdSessionId) {
        config.resumeSessionId = session.cmdSessionId
      }

      // Tool calls that have been announced but not yet resolved. Command Code
      // can end a turn with a tool still queued (e.g. it runs out of turns
      // after being blocked), which would otherwise leave the client spinning.
      const openToolCalls = new Map<string, string>()

      // Permission broker: only needed when Command Code is patched to ask.
      // Without the patch it never connects, and an idle pipe costs nothing.
      // In yolo mode Command Code bypasses the gate entirely, so skip it.
      let broker: SessionBroker | null = null
      if (session.config.permissionMode !== "yolo") {
        try {
          broker = await startSessionBroker({
            sessionId: session.id,
            timeoutMs: brokerTimeoutFromEnv(),
            makeHandler: () =>
              new ACPPermissionHandler(ctx.client, {
                sessionId: ctx.params.sessionId,
                signal: ctx.signal,
              }),
          })
          session.broker = broker
        } catch (err) {
          // A broker we cannot start must not block the turn: Command Code
          // falls back to its own fail-closed behaviour.
          const message = err instanceof Error ? err.message : String(err)
          await notifyText(`\n\n> ⚠️ Permission broker unavailable: ${message}`)
          broker = null
        }
      }

      const outcome = await runCmdPrompt({
        prompt: text,
        cwd: session.cwd,
        config,
        signal: ctx.signal,
        brokerAddress: broker?.address,
        sessionId: session.id,
        onText: (chunk) => {
          void notifyText(chunk)
        },
        onThought: (chunk) => {
          void notifyThought(chunk)
        },
        onTool: (tool) => {
          // Use Command Code's own id (e.g. `call_<hex>`): it is stable across
          // the queued/blocked pair and unique per invocation.
          const toolCallId = tool.toolCallId
          openToolCalls.set(toolCallId, tool.toolName)
          void ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: describeTool(tool.toolName, tool.input),
              kind: toolKindFor(tool.toolName),
              status: "in_progress",
              rawInput: (tool.input ?? {}) as Record<string, unknown>,
            },
          })
        },
        onToolBlocked: (tool) => {
          openToolCalls.delete(tool.toolCallId)
          // Print mode has no permission prompt, so Command Code refuses the
          // tool itself. Surface it as a failed tool call rather than silence.
          void ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: tool.toolCallId,
              status: "failed",
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: tool.hookOutput ?? "Blocked: requires permissions",
                  },
                },
              ],
            },
          })
        },
      })

      // The broker belongs to this turn: Command Code has exited (or been
      // killed), so nothing can still be waiting on it.
      if (broker) {
        session.broker = null
        await broker.stop().catch(() => {})
      }

      // Close out any tool call that never received a terminal event, so the
      // client does not show a spinner forever.
      for (const [toolCallId, toolName] of openToolCalls) {
        void ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: (outcome.stopReason === "error" ? "failed" : "completed") as
              | "failed"
              | "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text:
                    outcome.stopReason === "error"
                      ? `Tool did not complete: ${outcome.error ?? "unknown error"}`
                      : `${toolName} finished without a result event`,
                },
              },
            ],
          },
        })
      }

      session.hasPrompted = true
      if (outcome.cmdSessionId) session.cmdSessionId = outcome.cmdSessionId

      // Usage: emit a usage_update so the client can track tokens. The real
      // `cmd` result frame carries inputTokens/outputTokens (no totalTokens).
      const usage = outcome.usage
      const usedTokens =
        usage?.totalTokens ??
        (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined
          ? usage.inputTokens + usage.outputTokens
          : undefined)
      if (usedTokens !== undefined && usedTokens > 0) {
        void ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: usedTokens,
            size: DEFAULT_CONTEXT_SIZE,
          },
        })
      }

      switch (outcome.stopReason) {
        case "cancelled":
          return { stopReason: "cancelled" as const }
        case "max_turns":
          // ACP has no "max_turns" stop reason; surface it as end_turn.
          return { stopReason: "end_turn" as const }
        case "error": {
          // ACP has no error stop reason; report the error text as a message.
          const message = outcome.error ?? "Command Code failed"
          await notifyText(`\n\n> ⚠️ Command Code error: ${message}`)
          return { stopReason: "end_turn" as const }
        }
        default:
          return { stopReason: "end_turn" as const }
      }
    })
    .onNotification("session/cancel", (ctx) => {
      sessions.cancelPrompt(ctx.params.sessionId)
    })
}
