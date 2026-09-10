/**
 * Bootstrap for the patched permission gate.
 *
 * The gate is injected into Command Code's minified bundle, which has no
 * import surface of its own. So the gate dynamically imports this module and
 * asks it for a provider, caching the result per process.
 *
 * Provider selection is purely environment driven:
 *
 *   CMD_ACP_PERMISSION_BROKER unset  -> ConsolePermissionProvider (built-in)
 *   CMD_ACP_PERMISSION_BROKER set    -> BrokerPermissionProvider over IPC
 *
 * `denyMessage` is passed in by the gate because the bundle's own
 * `printPermissionDeniedMessage` is not importable; this keeps the default
 * refusal text byte-identical to the unpatched behaviour.
 */

import {
  BrokerPermissionProvider,
  ConsolePermissionProvider,
  type PermissionProvider,
} from "./permission-provider.js"
import { IpcPermissionTransport } from "./ipc-transport.js"

let cached: PermissionProvider | null = null

export function resolvePermissionProvider(
  denyMessage: (toolName: string) => string,
): PermissionProvider {
  if (cached) return cached

  const address = process.env.CMD_ACP_PERMISSION_BROKER?.trim()
  if (!address) {
    cached = new ConsolePermissionProvider(denyMessage)
    return cached
  }

  const timeoutRaw = Number(process.env.CMD_ACP_PERMISSION_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 0

  cached = new BrokerPermissionProvider(
    new IpcPermissionTransport({
      address,
      timeoutMs,
      sessionId: () => process.env.COMMAND_CODE_SESSION?.trim() || undefined,
    }),
  )
  return cached
}

/** Test seam: drop any cached provider so env changes take effect. */
export function resetPermissionProvider(): void {
  cached = null
}
