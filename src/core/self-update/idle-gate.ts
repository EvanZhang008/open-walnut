/**
 * When may a running server restart into an update it installed (live-update.ts)?
 * Only while nobody is using it: a restart drops every open page's socket for a
 * few seconds and ends a turn's server-side bookkeeping mid-way.
 *
 *   - No person activity for IDLE_MS (10 min; WALNUT_UPDATE_IDLE_MS). Activity is
 *     the latest end of any time heartbeat sample (the web page and the phone bank
 *     one for every window the person had it in front of them) and any message a
 *     person sends into a session. Callers report it with noteUserActivity.
 *   - No session turn running, except after the install has waited
 *     MAX_TURN_WAIT_MS (6 h): sessions live in the daemon and survive a restart,
 *     so a turn that never ends must not hold an update back for ever.
 *
 * Dependency-free on purpose: the send path and the heartbeat ingest import it.
 */

export const IDLE_MS = 10 * 60 * 1000
export const MAX_TURN_WAIT_MS = 6 * 60 * 60 * 1000
export const IDLE_MS_ENV = 'WALNUT_UPDATE_IDLE_MS'

let lastActivityMs: number | null = null

/**
 * A person used Walnut at `atMs` (the end of a heartbeat window, a send). A time
 * in the future counts as now: a client clock ahead of ours must not keep the
 * gate shut for hours.
 */
export function noteUserActivity(atMs: number = Date.now(), now: number = Date.now()): void {
  if (!Number.isFinite(atMs)) return
  const at = Math.min(atMs, now)
  if (lastActivityMs === null || at > lastActivityMs) lastActivityMs = at
}

/** The latest person activity this process saw, or null. */
export function lastUserActivity(): number | null {
  return lastActivityMs
}

/** The latest end (ts + durationMs) among heartbeat samples, or null. */
export function latestSampleEnd(samples: ReadonlyArray<{ ts: string; durationMs: number }>): number | null {
  let latest: number | null = null
  for (const s of samples) {
    const end = Date.parse(s.ts) + (Number.isFinite(s.durationMs) ? Math.max(0, s.durationMs) : 0)
    if (Number.isFinite(end) && (latest === null || end > latest)) latest = end
  }
  return latest
}

/** Tests: forget what was seen. */
export function resetUserActivityForTest(): void {
  lastActivityMs = null
}

/** IDLE_MS, or the env override (a positive number of milliseconds). */
export function idleMsFrom(env: Record<string, string | undefined>): number {
  const raw = Number(env[IDLE_MS_ENV])
  return Number.isFinite(raw) && raw > 0 ? raw : IDLE_MS
}

export interface IdleVerdict {
  ready: boolean
  /** How long since the last person activity; null when none was seen since this server started. */
  userIdleMs: number | null
  turnsRunning: number
  /** ISO time the install went in and the restart started waiting; null when nothing waits. */
  waitingSince: string | null
}

export interface IdleInputs {
  now: number
  /** Latest person activity, or null (none seen). */
  lastActivity: number | null
  /** When this server started watching: with no activity seen, idleness counts from here. */
  sinceMs: number
  turnsRunning: number
  /** When the install went in, or null. */
  waitingSinceMs: number | null
  idleMs?: number
  maxTurnWaitMs?: number
}

export function judgeIdle(i: IdleInputs): IdleVerdict {
  const idleMs = i.idleMs ?? IDLE_MS
  const maxTurnWaitMs = i.maxTurnWaitMs ?? MAX_TURN_WAIT_MS
  const userIdleMs = i.lastActivity === null ? null : Math.max(0, i.now - i.lastActivity)
  const quietFor = Math.max(0, i.now - (i.lastActivity ?? i.sinceMs))
  const personAway = quietFor >= idleMs
  const turnsWaitedOut = i.waitingSinceMs !== null && i.now - i.waitingSinceMs >= maxTurnWaitMs
  return {
    ready: personAway && (i.turnsRunning === 0 || turnsWaitedOut),
    userIdleMs,
    turnsRunning: i.turnsRunning,
    waitingSince: i.waitingSinceMs === null ? null : new Date(i.waitingSinceMs).toISOString(),
  }
}

/**
 * Turns running inside this server process (embedded and SDK sessions): no daemon
 * keeps them, so a restart cuts them. A record marked running from before this
 * process started belongs to a server that is gone, and never holds the gate.
 */
export function countInProcessTurns(
  records: ReadonlyArray<{ provider?: string; process_status?: string; archived?: boolean; lastActiveAt?: string }>,
  sinceMs: number,
): number {
  return records.filter((s) => {
    if (s.archived || s.process_status !== 'running') return false
    if (s.provider !== 'embedded' && s.provider !== 'sdk') return false
    const at = s.lastActiveAt ? Date.parse(s.lastActiveAt) : NaN
    return Number.isFinite(at) && at >= sinceMs
  }).length
}
