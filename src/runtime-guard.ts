import type { RtkConfig } from './config.js'

/** What the last probe found. */
export interface RtkRuntimeStatus {
  rtkAvailable: boolean
  lastCheckedAt?: number
  rtkExecutablePath?: string
  rtkExecutableCommand?: string
  rtkExecutableResolver?: string
  rtkExecutableResolutionWarning?: string
  lastError?: string
}

/** How long a probe result stays authoritative before it is refreshed. */
export const RUNTIME_STATUS_TTL_MS = 30_000

/**
 * Whether a missing rtk binary must be established before handling a command.
 *
 * Only rewrite mode consults availability: `suggest` mode reports what rtk
 * *would* do and never gates execution on it, and compaction is a pure text
 * transform that needs no binary at all.
 */
export function shouldRequireRtkAvailability(config: RtkConfig): boolean {
  return config.enabled && config.mode === 'rewrite'
}

/**
 * Whether command rewriting must stand down for this call.
 *
 * With `guardWhenRtkMissing` on, a call that cannot prove rtk is available
 * runs unchanged — the user's command is never blocked by an absent optimizer.
 */
export function shouldSkipRewrite(config: RtkConfig, status: RtkRuntimeStatus): boolean {
  if (!config.enabled) return true
  if (!config.guardWhenRtkMissing) return false
  return !status.rtkAvailable
}

/** Whether the cached probe is stale and must be refreshed before use. */
export function isStatusStale(status: RtkRuntimeStatus, now: number, ttlMs = RUNTIME_STATUS_TTL_MS): boolean {
  if (status.lastCheckedAt === undefined) return true
  return now - status.lastCheckedAt > ttlMs
}
