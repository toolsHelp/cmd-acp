import { execFile } from "node:child_process"
import { resolveCmdBinary } from "./cmd-runner.js"

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

/** Parse `cmd --list-models` output (grouped plain-text table). */
export function parseModelsOutput(raw: string): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (SECTION_HEADERS.has(trimmed.toLowerCase())) continue
    if (/^available models/.test(trimmed.toLowerCase())) continue
    const match = trimmed.match(/^(\S+)\s+(.*)$/)
    if (!match) continue
    const id = match[1]
    const description = match[2].trim()
    if (!description) continue
    // All Command Code model ids are provider/model (e.g. "deepseek/deepseek-v4-flash");
    // require the slash to skip footer/usage lines ("cmd --model …", "Docs: …").
    if (!id.includes("/")) continue
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
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(resolveCmdBinary(), ["--list-models"], { timeout: 10_000 }, (err, stdout) => {
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
