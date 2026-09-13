/**
 * One-shot grants shared between Command Code's two permission checkpoints.
 *
 * Command Code 1.53 refuses sensitive tools in print mode through two
 * independent hooks, and a single tool call passes through both:
 *
 *   1. `headlessInteraction.confirmTool`  — decides whether the tool may run
 *   2. `createPrintPermissionGateMod.beforeToolCall` — guards execution
 *
 * Asking twice would mean two prompts for one action. Hook 1 records the
 * decision it obtained; hook 2 consumes it instead of asking again.
 *
 * Why key on the input: hook 1 receives no tool-call id (verified by probing
 * the running bundle — its argument is `{toolName, input, description, signal,
 * explain}`), while hook 2 gets `{toolCallId, toolName, input, state}`. The
 * input is the only thing both hooks agree on, and hook 1 always runs first, so
 * a grant cannot be stale by the time hook 2 looks for it.
 */

/** A decision that has not been consumed yet. */
export interface Grant {
  toolName: string
  /** `"allow"` or `"always_allow"`; a denial is never stored as a grant. */
  decision: "allow" | "always_allow"
  scope?: "once" | "session" | "always"
  createdAt: number
}

/** How long an unconsumed grant stays valid, in milliseconds. */
const GRANT_TTL_MS = 30_000

/**
 * Serialise a value with object keys in sorted order, so the same input
 * produces the same key regardless of property order. The two hooks receive
 * the same input with different key order in practice.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

export class PermissionGrantStore {
  private readonly grants = new Map<string, Grant>()

  /** Now, overridable so tests do not depend on the clock. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Build the key identifying one tool invocation.
   *
   * `toolName` is part of the key so two tools handed the same argument object
   * cannot share a grant.
   */
  key(toolName: string | undefined, input: unknown): string {
    if (!toolName) return "unknown:unkeyable"
    try {
      const json = stableStringify(input ?? null)
      // Length plus a rolling hash: cheap, and collisions only matter between
      // concurrent calls, which the hook ordering rules out.
      let hash = 0
      for (let i = 0; i < json.length; i++) hash = (hash * 31 + json.charCodeAt(i)) | 0
      return `${toolName}:${(hash >>> 0).toString(16)}:${json.length}`
    } catch {
      // Non-serialisable input (cycle, BigInt): fall back to a per-tool key so
      // correctness is preserved even if sharing is lost.
      return `${toolName}:unserialisable`
    }
  }

  /** Record a decision for the execution gate to consume. */
  grant(key: string, decision: Grant["decision"], scope?: Grant["scope"]): void {
    this.grants.set(key, { toolName: key.split(":")[0], decision, scope, createdAt: this.now() })
  }

  /**
   * Take the grant for `key`, if one exists and has not expired.
   *
   * Consuming deletes it: a grant covers exactly one pass through the
   * execution gate, so a later identical call prompts again.
   */
  consume(key: string): Grant | undefined {
    const grant = this.grants.get(key)
    if (!grant) return undefined
    this.grants.delete(key)
    if (this.now() - grant.createdAt > GRANT_TTL_MS) return undefined
    return grant
  }

  /** Drop grants nobody consumed, so a long session cannot accumulate them. */
  prune(): void {
    const cutoff = this.now() - GRANT_TTL_MS
    for (const [key, grant] of this.grants) {
      if (grant.createdAt < cutoff) this.grants.delete(key)
    }
  }

  /** Number of outstanding grants (tests and diagnostics). */
  get size(): number {
    return this.grants.size
  }

  clear(): void {
    this.grants.clear()
  }
}

/**
 * The process-wide store.
 *
 * Module scope is what makes sharing work: both hooks dynamically import the
 * same module URL, so they observe the same map without any `globalThis`
 * plumbing.
 */
export const grantStore = new PermissionGrantStore()
