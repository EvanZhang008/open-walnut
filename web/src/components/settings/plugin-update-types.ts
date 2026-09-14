/**
 * Mirrors src/core/plugins/update-status.ts (the server is the source of truth; the SPA
 * cannot import server code, so the types are copied by hand and kept identical).
 *
 * The client only RENDERS these states. `checking` is the one client-local kind: a request
 * is in flight for the row. The chip's `pending` look (first GET not back yet) is a client
 * flag, not a state, so it never appears in `UpdateState`.
 */

export type UnreachableCause = 'network' | 'auth' | 'timeout' | 'unknown'

export type UpdateState =
  | { kind: 'unchecked'; reason?: string }
  | { kind: 'checking' }
  | { kind: 'current'; ahead?: number }
  | { kind: 'available'; behind?: number; toVersion?: string; ahead?: number }
  | { kind: 'dirty'; behind?: number | null }
  | { kind: 'diverged'; behind: number; ahead: number }
  | { kind: 'missing' }
  | {
      kind: 'unreachable'
      cause: UnreachableCause
      lastKnown?: 'current' | 'available' | 'dirty' | 'diverged' | 'unchecked'
      reason: string
      /** The counts (or version) behind `lastKnown`, so a stale chip still says "3 commits behind". */
      behind?: number | null
      ahead?: number
      toVersion?: string
    }
  | { kind: 'unsupported'; reason: string; hint: string }

export type UpdateKind = UpdateState['kind']

export interface UpdateStatusRow {
  state: UpdateState
  /** ISO time of the last completed network check for this row, or null when never. */
  checkedAt: string | null
  target?: { kind: 'linked' | 'git' | 'npm'; toRef?: string }
  /** Raw (masked) git or npm text for the Details disclosure. Never rendered inline. */
  detail?: string
  /** A lock collision: the previous entry was kept; retry the row in 30 s. */
  transient?: boolean
  /** An update for this rowKey is in flight on the server. */
  busy?: boolean
}

export interface PluginUpdatesResponse {
  /** Max `checkedAt` over rows; the header time. */
  checkedAt: string | null
  minIntervalMs: number
  /** A batch check is running; poll every 2 s (max 15 times) until false. */
  refreshing: boolean
  rows: Record<string, UpdateStatusRow>
  /** pluginId -> rowKey (linked siblings sharing a checkout share one row). */
  rowKeyOf: Record<string, string>
  attempted?: number
  failed?: number
  /** Every attempted row failed with cause network: fold into one header sentence. */
  allNetworkFailed?: boolean
}

/** Same string rule as the server: a source row is keyed by its slug. */
export function sourceRowKey(slug: string): string {
  return `source:${slug}`
}

/**
 * The lifecycle state the registry reports for a plugin whose files a source update
 * replaced while it was loaded (server twin: `RESTART_PENDING_STATE` in
 * src/core/plugins/restart-pending.ts). The OLD code is still running, so the row's switch
 * reads ON next to its RESTART TO ACTIVATE badge; a `discovered` plugin also maps to
 * pending-restart but is not running, and its switch stays OFF.
 */
export const RESTART_PENDING_STATE = 'stale-after-update'
