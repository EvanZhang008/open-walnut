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
 * For a start (no session yet): 'host' when the switch is on (session-channel/switch.ts) and the
 * target host's service names SESSION_JUDGE_CAP; the leader side (session-channel/leader-side.ts)
 * installs that probe. With nothing installed, and on every server whose store never applied a
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
/** Did this store ever apply a host's channel? null: not asked yet. */
let anyCursor: boolean | null = null

type StartProbe = (host: string) => boolean
let startProbe: StartProbe | null = null

/** Installed by the leader side: does `host`'s service run and judge sessions now (switch on, capability named, linked)? */
export function setHostJudgeProbe(probe: StartProbe | null): void {
  startProbe = probe
}

/** The leader learned that `sid` is `host`'s (its start answered, the channel wrote its row, a rename). */
export function noteHostJudged(sid: string, host: string): void {
  if (!sid || !host) return
  known.set(sid, host)
  legacy.delete(sid)
  anyCursor = true
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

/** Who judges the session of a record the caller holds (a boot scan): the same rule, no lookup. */
export function judgeOfRecord(rec: Pick<SessionRecord, 'judge' | 'host'> | null | undefined): Judge {
  return judgedByHost(rec) && !rowOwnedHere(rec, thisHostKey()) ? 'host' : 'legacy'
}

/** Records this server runs itself: a host-judged one is its host's (a leader-side scan skips it). */
export function leaderJudgedRecords<R extends Pick<SessionRecord, 'judge' | 'host'>>(recs: readonly R[]): R[] {
  return recs.filter((r) => judgeOfRecord(r) === 'legacy')
}

/** The session a bus event is about (its data's sessionId), if any. */
export function sessionOfEvent(event: { data: unknown }): string | undefined {
  const sid = (event.data as { sessionId?: unknown } | null | undefined)?.sessionId
  return typeof sid === 'string' && sid ? sid : undefined
}

/**
 * A bus handler for the sessions this server runs itself: an event of a host-judged session (a
 * fact its host sent) is skipped, since its host did that session's own work already. The leader's
 * resend, respawn and recovery subscribers take their handler through this.
 */
export function leaderJudgedOnly<E extends { data: unknown }, R>(handler: (event: E) => R): (event: E) => R | undefined {
  return (event: E) => {
    const sid = sessionOfEvent(event)
    if (sid && judgeOf(sid) === 'host') return undefined
    return handler(event)
  }
}

/** Who would judge a new session on `host`. A local start ('' or '__local__') is always the leader's. */
export function judgeOfStart(host: string | undefined): Judge {
  if (!host || host === '__local__' || !startProbe) return 'legacy'
  try { return startProbe(host) ? 'host' : 'legacy' } catch { return 'legacy' }
}

export function _resetJudgeOfForTesting(): void {
  known.clear()
  legacy.clear()
  anyCursor = null
  startProbe = null
}
