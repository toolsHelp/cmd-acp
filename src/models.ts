import { execFile } from "node:child_process"
import { resolveCmdSpawn } from "./cmd-runner.js"

export interface ModelInfo {
  /** Full model id, e.g. "deepseek/deepseek-v4-flash". */
  id: string
  /** Short label (provider/model). */
  name: string
  description?: string
}

const CACHE_TTL_MS = 60_000

let cachedModels: ModelInfo[] | null = null
let cacheFetchedAt = 0

/** Known section headers in `cmd --list-models` output. */
const SECTION_HEADERS = new Set(["open source", "command code", "available models"])

/** A model id: `provider/model` (open source) or a bare name (Command Code models). */
const MODEL_ID = /^[A-Za-z0-9][\w.:+-]*(?:\/[\w.:+-]+)?$/

/** Footer/usage lines that must not be mistaken for models. */
const FOOTER_LINE = /^(pass|cmdc|cmd|docs|usage|https?:|--)/i

/** Parse `cmd --list-models` output (grouped plain-text table). */
export function parseModelsOutput(raw: string): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (SECTION_HEADERS.has(trimmed.toLowerCase())) continue
    if (/^available models/.test(trimmed.toLowerCase())) continue
    if (FOOTER_LINE.test(trimmed)) continue
    const match = trimmed.match(/^(\S+)\s+(.*)$/)
    if (!match) continue
    const id = match[1]
    const description = match[2].trim()
    if (!description) continue
    // Model ids are either `provider/model` (open source) or a bare name
    // (Command Code's own claude-* / gpt-* models). Shape-check instead of
    // requiring a slash, so bare ids are not dropped.
    if (!MODEL_ID.test(id)) continue
    models.push({
      id,
      name: id,
      description,
    })
  }
  return models
}

/** Resolve the model list from `cmd --list-models`, cached for CACHE_TTL_MS. */
export async function listModels(): Promise<ModelInfo[]> {
  const now = Date.now()
  if (cachedModels && now - cacheFetchedAt < CACHE_TTL_MS) {
    return cachedModels
  }
  const { command, argsPrefix } = resolveCmdSpawn()
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(command, [...argsPrefix, "--list-models"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
  cachedModels = parseModelsOutput(raw)
  cacheFetchedAt = now
  return cachedModels
}

/** For tests. */
export function _resetModelsCache(): void {
  cachedModels = null
  cacheFetchedAt = 0
}
