/**
 * The periodic repair of a host's own sessions (docs/plan/one-service-every-host.md, phase 2): the
 * leader's health monitor skips a session its host judges, and the monitor is off on every replica,
 * so a host-run session whose CLI died without a turn end (an OOM, a kill) would read `running`
 * on both sides for good. Here, on the host, for its own rows only (rowOwnedHere):
 *
 *   every `everyMs`   each own row that says running or idle, of an engine whose liveness the
 *                     session id answers (engine-registry sidLivenessProbe), quiet for `quietMs`,
 *                     is asked of this host's runner (getOrAttachLiveSession: its live object, or
 *                     the record's process attached again)
 *   twice dead        a row found dead on two sweeps in a row is written stopped
 *                     (`liveness_check_failed`, as the monitor writes it) through the own-row
 *                     writer; the channel carries the row to the leader
 *
 * One sweep at a time; a sweep that fails is logged and the next one runs.
 */
import type { SessionRecord } from '../types.js'

export interface HostStaleRepairDeps {
  ownRows(): Promise<SessionRecord[]>
  /** Is the session's process alive on this host (attached again when it is)? */
  alive(row: SessionRecord): Promise<boolean>
  /** Does this engine answer liveness by session id (claude CLI: yes; an ACP worker: no)? */
  probes(row: SessionRecord): boolean
  write(sid: string, patch: Partial<SessionRecord>): Promise<unknown>
  everyMs?: number
  quietMs?: number
  now?: () => number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export const STALE_SWEEP_MS = 2 * 60_000
/** A row active this recently is never judged dead (a spawn, a turn between its lines). */
export const STALE_QUIET_MS = 5 * 60_000

export function createHostStaleRepair(d: HostStaleRepairDeps): { sweep(): Promise<string[]>; start(): void; stop(): void } {
  const now = d.now ?? Date.now
  const quietMs = d.quietMs ?? STALE_QUIET_MS
  /** Rows found dead on the last sweep. */
  let deadLast = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function sweep(): Promise<string[]> {
    if (running) return []
    running = true
    const repaired: string[] = []
    try {
      const dead = new Set<string>()
      for (const row of await d.ownRows()) {
        if (row.archived || (row.process_status !== 'running' && row.process_status !== 'idle') || !d.probes(row)) continue
        const active = Date.parse(row.lastActiveAt ?? '')
        if (Number.isFinite(active) && now() - active < quietMs) continue
        if (await d.alive(row).catch(() => true)) continue
        dead.add(row.claudeSessionId)
        if (!deadLast.has(row.claudeSessionId)) continue
        await d.write(row.claudeSessionId, {
          process_status: 'stopped', last_status_change: new Date(now()).toISOString(),
          status_reason: 'liveness_check_failed', status_changed_by: 'system',
        } as Partial<SessionRecord>)
        repaired.push(row.claudeSessionId)
      }
      deadLast = new Set([...dead].filter((sid) => !repaired.includes(sid)))
      if (repaired.length) d.log?.('warn', 'host sessions: own rows whose process is gone were written stopped', { sessionIds: repaired })
    } catch (err) {
      d.log?.('warn', 'host sessions: a stale-row sweep failed', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      running = false
    }
    return repaired
  }

  return {
    sweep,
    start() {
      if (timer) return
      timer = setInterval(() => { void sweep() }, d.everyMs ?? STALE_SWEEP_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
