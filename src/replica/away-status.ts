/**
 * The user status a host replica shows while the Mac is away, for the tasks whose sessions this
 * host runs and judges itself (docs/plan/one-service-every-host.md, phase 2; the plan's one source
 * of the user status).
 *
 * The leader alone stores a task's `user_status` (user-status-sync.ts, boot policy `user-status`);
 * a replica stores none. Its task copy carries the status the leader last wrote, which is right for
 * every task whose facts the replica holds no newer than the leader did. A session this host runs
 * goes on while the Mac is away (its turns end, a prompt opens), and its row here is newer than
 * anything the Mac saw: for those tasks a reader gets the status derived now by the same function
 * the leader's pass uses (deriveUserStatuses), from this host's facts, never a second stored copy.
 * The leader derives once more from the facts when it is back (the late lane of user-status-sync.ts).
 *
 * Cached for CACHE_MS: one derivation serves a burst of reads (the list, then the task it opens).
 */
import type { UserStatus } from '../core/user-status.js'

const CACHE_MS = 3_000

export interface AwayStatusDeps {
  /** This host's own session rows' tasks (rows it runs and judges: session-row-owner.ts rowOwnedHere). */
  ownTaskIds(): Promise<Set<string>>
  /** The status of each of these open tasks now (user-status-sync.ts deriveUserStatuses). */
  derive(ids: ReadonlySet<string>): Promise<Map<string, UserStatus>>
  now?: () => number
}

export interface AwayStatus {
  /** The statuses to show now (a task not in it reads as its copy says). */
  current(): Promise<ReadonlyMap<string, UserStatus>>
}

export function createAwayStatus(deps: AwayStatusDeps): AwayStatus {
  const now = deps.now ?? Date.now
  let cached: { at: number; map: ReadonlyMap<string, UserStatus> } | null = null
  let inflight: Promise<ReadonlyMap<string, UserStatus>> | null = null
  return {
    async current() {
      if (cached && now() - cached.at < CACHE_MS) return cached.map
      inflight ??= (async () => {
        const ids = await deps.ownTaskIds()
        const map = ids.size ? await deps.derive(ids) : new Map<string, UserStatus>()
        cached = { at: now(), map }
        return map
      })().finally(() => { inflight = null })
      return inflight
    },
  }
}

/** The default sources on a host replica: its own rows (by its host key) and the leader's derivation. */
export function hostAwayStatus(hostKey: string): AwayStatus {
  return createAwayStatus({
    ownTaskIds: async () => {
      const [{ listSessions }, { rowOwnedHere }] = await Promise.all([
        import('../core/session-tracker.js'),
        import('../core/sessions/session-row-owner.js'),
      ])
      const ids = new Set<string>()
      for (const r of await listSessions()) if (r.taskId && rowOwnedHere(r, hostKey)) ids.add(r.taskId)
      return ids
    },
    derive: async (ids) => (await import('../core/user-status-sync.js')).deriveUserStatuses(ids),
  })
}

/** A task row with the status a reader is shown now (open tasks only: a finished one reads Done). */
export function withShownStatus<R extends { id: string }>(row: R, shown: ReadonlyMap<string, UserStatus> | null): R {
  const s = shown?.get(row.id)
  if (!s) return row
  const r = row as R & { phase?: unknown; status?: unknown }
  if (r.phase === 'COMPLETE' || r.status === 'done') return row
  return { ...row, user_status: s }
}
