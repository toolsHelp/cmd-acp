/** Type declarations for the Command Code permission patcher (plain ESM). */

export declare const CONFIRM_ANCHOR: string
export declare const CONFIRM_REPLACEMENT: string
export declare const GATE_ANCHOR: string
export declare const GATE_REPLACEMENT: string

/**
 * Builders for the replacements. The bundle is minified and its short names
 * differ between releases, so the replacement is generated with whatever
 * identifiers the anchor captured.
 */
export declare function buildConfirmReplacement(interactionVar: string): string
export declare function buildGateReplacement(blockedSetVar: string): string
export declare const PATCH_MARKER: string
export declare const PROVIDER_DIR_NAME: string

export type PatchStatus =
  | "patched"
  | "already-patched"
  | "anchor-not-found"
  | "partial"
  | `anchor-ambiguous(${number})`

export interface PatchResult {
  source: string
  status: PatchStatus
  /** Times the `confirmTool` anchor matched; 1 is expected. */
  confirmAnchorCount: number
  /** Times the `beforeToolCall` anchor matched; 1 is expected. */
  gateAnchorCount: number
}

export interface ApplyOptions {
  commandCodeDir?: string
  /** Report only; write nothing. */
  check?: boolean
  /** Write the patched bundle here instead of patching in place. */
  output?: string
  /** Where the compiled provider lives. Defaults to the patcher's own `dist/`. */
  providerSourceDir?: string
}

export interface ApplyReport {
  cliPath: string
  status: PatchStatus
  confirmAnchorCount: number
  gateAnchorCount: number
  installed: string[]
  sha256Before?: string
  sha256After?: string
}

export declare function resolveCommandCodeDir(explicit?: string): string
export declare function resolveCliPath(commandCodeDir: string): string
export declare function resolveProviderDir(commandCodeDir: string): string
export declare function sha256(text: string): string
export declare function patchSource(source: string): PatchResult
export declare function applyPatch(options?: ApplyOptions): ApplyReport
