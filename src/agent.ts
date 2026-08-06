import * as acp from "@agentclientprotocol/sdk"
import { runCmdPrompt } from "./cmd-runner.js"
import { SessionStore } from "./sessions.js"

export const AGENT_NAME = "cmd-acp"

/**
 * Register all ACP handlers on the agent app.
 */
export function registerHandlers(app: ReturnType<typeof acp.agent>, sessions: SessionStore) {
  app
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        concurrentSessions: false,
        loadSession: false,
        terminal: false,
      },
    }))
    .onRequest("session/new", (ctx) => {
      const session = sessions.create(ctx.params.cwd ?? process.cwd())
      return { sessionId: session.id }
    })
    .onRequest("session/close", (ctx) => {
      sessions.close(ctx.params.sessionId)
      return {}
    })
    .onRequest("session/set_config_option", (ctx) => {
      sessions.setConfig(ctx.params.sessionId, ctx.params.configId, ctx.params.value)
      return { configOptions: [] }
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

      const outcome = await runCmdPrompt({
        prompt: text,
        cwd: session.cwd,
        config: session.config,
        signal: ctx.signal,
        onText: (chunk) => {
          void notifyText(chunk)
        },
        onTool: (tool) => {
          const toolCallId = `cmd-${tool.toolName}`
          void ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: tool.description ?? tool.toolName,
              kind: "read",
              status: "pending",
              rawInput: { toolName: tool.toolName },
            },
          })
          void ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "completed",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "" },
                },
              ],
              rawOutput: {},
            },
          })
        },
      })
      if (outcome.cmdSessionId) session.cmdSessionId = outcome.cmdSessionId

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
