/**
 * Who runs and judges a session (docs/plan/one-service-every-host.md, phase 2): the one question
 * every leader-side gate asks before it acts on a session.
 *
 *   'host'    the session's row says `judge: 'host'` and its host is not this server: that host's
 *             own service assembles, runs and judges it. The leader keeps a copy (the channel
 *             applies it), forwards commands, and does none of the session's own work: no
 *             resend, respawn, recovery, snapshot repair or turn-end queue drain.
 *   'legacy'  everything else: today's path, the leader runs it.
 *
 * For a start (no session yet): 'host' when the switch is on for that host (session-channel/switch.ts
 * hostRunsSessionsFor) and its service names SESSION_JUDGE_CAP; the leader side
 * (session-channel/leader-side.ts) installs that probe. With nothing installed, and on every server whose store never applied a
 * host's channel, every answer is 'legacy' at the cost of one small query once.
 */
import { anyChannelCursor, sessionJudgeInStore } from '../session-db.js'
import { judgedByHost, rowOwnedHere, thisHostKey } from './session-row-owner.js'
import type { SessionRecord } from '../types.js'

export type Judge = 'host' | 'legacy'

/** Sessions known to be a host's (a start it answered, a row the channel applied): sid -> host. */
const known = new Map<string, string>()
/** Rows seen in the store that are not a host's; bounded, cleared when full. */
const legacy = new Set<string>()
const LEGACY_MEMO_MAX = 20_000
/** Sessions this host replica runs for its leader (taskSideOnLeader said so); bounded, cleared when full. */
const ownHere = new Set<string>()
/** Did this store ever apply a host's channel? null: not asked yet. */
let anyCursor: boolean | null = null
/** A host replica whose leader is an older Walnut without the session channel judges none of its own rows (session-channel/old-leader-watch.ts). */
let standsDown = false

/**
 * The leader side's answer for a start on `host`: true (its own service runs it), the host key of
 * the service that runs it (another name of the same machine, whose service goes by that name),
 * or false / null (legacy).
 */
type StartProbe = (host: string) => boolean | string | null
let startProbe: StartProbe | null = null

/** Installed by the leader side: does `host`'s service run and judge sessions now (switch on, capability named, linked)? */
export function setHostJudgeProbe(probe: StartProbe | null): void {
  startProbe = probe
}

/**
 * The host key whose service would run a new session started on `host`, or null (legacy): `host`
 * itself, or the name its machine's one service goes by when `host` is another name of that
 * machine (an ssh row of a box that joined the host network: one daemon, one service).
 */
export function hostServiceKeyOf(host: string | undefined): string | null {
  if (!host || host === '__local__' || !startProbe) return null
  try {
    const a = startProbe(host)
    return a === true ? host : typeof a === 'string' && a !== '' && a !== '__local__' ? a : null
  } catch { return null }
}

/** The leader learned that `sid` is `host`'s (its start answered, the channel wrote its row, a rename). */
export function noteHostJudged(sid: string, host: string): void {
  if (!sid || !host) return
  known.set(sid, host)
  legacy.delete(sid)
  anyCursor = true
}

/** A start the leader handed to a host did not go: `sid` is not that host's after all. */
export function forgetHostJudged(sid: string): void {
  known.delete(sid)
}

/** The host whose service judges `sid`, or null (a legacy session, or no such row). */
export function judgingHostOf(sid: string): string | null {
  if (!sid) return null
  const k = known.get(sid)
  if (k !== undefined) return k
  if (legacy.has(sid)) return null
  if (anyCursor === null) {
    try { anyCursor = anyChannelCursor() } catch { return null }
  }
  if (!anyCursor) return null
  let row: ReturnType<typeof sessionJudgeInStore>
  try { row = sessionJudgeInStore(sid) } catch { return null }
  // No row yet (a start in flight): never remembered, it may be a host's a moment later.
  if (!row) return null
  const here = thisHostKey()
  if (row.judgedByHost && row.host && row.host !== here) {
    known.set(sid, row.host)
    return row.host
  }
  if (legacy.size >= LEGACY_MEMO_MAX) legacy.clear()
  legacy.add(sid)
  return null
}

/** Who judges this existing session. */
export function judgeOf(sid: string): Judge {
  return judgingHostOf(sid) !== null ? 'host' : 'legacy'
}

/**
 * On a host replica that runs its sessions: is `sid` one of them (its row this host's own,
 * session-row-owner.ts rowOwnedHere)? Its task side (the task's phase, its session links) is the
 * leader's, done from the facts this host sends (session-channel/leader-tasks.ts, and the leader's
 * own turn-end handlers on the facts it re-emits), so a write of it here is skipped, never tried:
 * the task store here is a read-only copy. Outside the session classes (their port answers it,
 * session-channel/host-port.ts) each such write passes one of three gates that ask this:
 * applySessionPhase (phase.ts), the session-link writer (task-manager.ts), and the session hooks'
 * dispatcher (the leader runs them on the facts it re-emits). Always false on the leader (no host
 * key), at no cost.
 */
export function taskSideOnLeader(sid: string | null | undefined): boolean {
  const here = thisHostKey()
  if (!sid || !here) return false
  if (ownHere.has(sid)) return true
  let row: ReturnType<typeof sessionJudgeInStore>
  try { row = sessionJudgeInStore(sid) } catch { return false }
  const own = rowOwnedHere(row ? { judge: row.judgedByHost ? 'host' : undefined, host: row.host ?? undefined } : null, here)
  // A row this host made stays its own; asked on every event of its session (the hooks, a stream's phase).
  if (own) {
    if (ownHere.size >= LEGACY_MEMO_MAX) ownHere.clear()
    ownHere.add(sid)
  }
  return own
}

/** Who judges the session of a record the caller holds (a boot scan): the same rule, no lookup. */
export function judgeOfRecord(rec: Pick<SessionRecord, 'judge' | 'host'> | null | undefined): Judge {
  return judgedByHost(rec) && !rowOwnedHere(rec, thisHostKey()) ? 'host' : 'legacy'
}

/**
 * Does this server run and judge `sid` itself? On the leader: every session but a host's (judgeOf
 * 'legacy'). On a host replica that runs its sessions: only its own rows (taskSideOnLeader); a
 * copied row is its leader's (or another host's) to judge, never this one's. The resend, respawn
 * and recovery family asks this on both sides, so each session has exactly one of them acting.
 */
export function judgedHere(sid: string): boolean {
  return thisHostKey() ? !standsDown && taskSideOnLeader(sid) : judgeOf(sid) === 'legacy'
}

/** The records this server runs and judges itself (a boot scan): judgedHere, from the record alone. */
export function judgedHereRecords<R extends Pick<SessionRecord, 'judge' | 'host'>>(recs: readonly R[]): R[] {
  const here = thisHostKey()
  if (here) return standsDown ? [] : recs.filter((r) => rowOwnedHere(r, here))
  return recs.filter((r) => judgeOfRecord(r) === 'legacy')
}

/**
 * A host replica stands down (true) or judges its own rows again (false): its leader is an older
 * Walnut that judges every session itself (session-channel/old-leader-watch.ts). Its rows stay its
 * own (taskSideOnLeader is unchanged: their task side is still never written here); only judging them
 * stops. Nothing on a leader, which has no host key.
 */
export function setHostStandsDown(on: boolean): void {
  standsDown = on
}

export function hostStandsDown(): boolean {
  return standsDown
}

/** The session a bus event is about (its data's sessionId), if any. */
export function sessionOfEvent(event: { data: unknown }): string | undefined {
  const sid = (event.data as { sessionId?: unknown } | null | undefined)?.sessionId
  return typeof sid === 'string' && sid ? sid : undefined
}

/**
 * A bus handler for the sessions this server runs and judges itself (judgedHere): on the leader an
 * event of a host-judged session (a fact its host sent) is skipped, since its host did that
 * session's own work already; on a host an event of a copied row is skipped. The resend, respawn
 * and recovery subscribers take their handler through this.
 */
export function judgedHereOnly<E extends { data: unknown }, R>(handler: (event: E) => R): (event: E) => R | undefined {
  return (event: E) => {
    const sid = sessionOfEvent(event)
    if (sid && !judgedHere(sid)) return undefined
    return handler(event)
  }
}

/** Who would judge a new session on `host`. A local start ('' or '__local__') is always the leader's. */
export function judgeOfStart(host: string | undefined): Judge {
  return hostServiceKeyOf(host) !== null ? 'host' : 'legacy'
}

export function _resetJudgeOfForTesting(): void {
  known.clear()
  legacy.clear()
  ownHere.clear()
  anyCursor = null
  startProbe = null
  standsDown = false
}
