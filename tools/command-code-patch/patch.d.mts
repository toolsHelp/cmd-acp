/** Type declarations for the Command Code permission-gate patcher (plain ESM). */

export declare const GATE_ARROW_ANCHOR: string
export declare const GATE_ARROW_REPLACEMENT: string
export declare const PATCH_MARKER: string
export declare const PROVIDER_DIR_NAME: string

export type PatchStatus =
  | "patched"
  | "already-patched"
  | "anchor-not-found"
  | `anchor-ambiguous(${number})`

export interface PatchResult {
  source: string
  status: PatchStatus
  anchorCount: number
}

export interface ApplyOptions {
  commandCodeDir?: string
  /** Report only; write nothing. */
  check?: boolean
  /** Write the patched bundle here instead of patching in place. */
  output?: string
}

export interface ApplyReport {
  cliPath: string
  status: PatchStatus
  anchorCount: number
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
