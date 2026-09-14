/** Type declarations for the fork workspace deps linker (plain ESM). */

export interface LinkOptions {
  /** Command Code package root. Resolved from the environment when omitted. */
  commandCodeDir?: string
  /** Workspace to prepare. Defaults to `fork/cc`. */
  workspace?: string
}

export interface LinkResult {
  /** `already-linked` when the existing link already pointed at the target. */
  status: "linked" | "already-linked" | "blocked"
  target?: string
}

export interface LinkReport {
  commandCodeDir: string
  workspaceDir: string
  packageJsonStatus: "copied" | "missing at source"
  link: LinkResult
}

/**
 * Give `workspace` the `node_modules` and `package.json` a patched bundle needs.
 * Throws when the Command Code package cannot supply them.
 */
export declare function linkForkDeps(options?: LinkOptions): LinkReport
