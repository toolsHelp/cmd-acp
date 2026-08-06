#!/usr/bin/env node
import * as acp from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"
import { registerHandlers, AGENT_NAME } from "./agent.js"
import { SessionStore } from "./sessions.js"

// The SDK's ndJsonStream(output, input) takes the two web streams in this
// order: output = what the agent writes (stdout), input = what the agent
// reads (stdin). Matches the official SDK example agent.
const output = Writable.toWeb(process.stdout)
const input = Readable.toWeb(process.stdin)
const stream = acp.ndJsonStream(output, input)

const sessions = new SessionStore()
const app = acp.agent({ name: AGENT_NAME })
registerHandlers(app, sessions)
app.connect(stream)
