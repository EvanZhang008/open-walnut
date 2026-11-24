/**
 * What a host's channel records do on this leader (leader-side.ts holds the links): the rows,
 * renames and position in one transaction (deps.applyBatch, session-tracker applyHostChannelBatch),
 * then, in log order, the facts on this bus, the `live` records and the flow events, each only for a
 * session the host owns here and naming that session. A fact says the task of the leader's own row
 * of its session (fact-keys.ts factAsLeaderSays), never the host's word, and only the queue rows
 * and transfer attempts the leader handed that session (deps.scopeIds). A revoked host's
 * records are never applied (leader-issue.ts revokeHostDoorNow): the apply throws, so the channel
 * closes the link and the host keeps them.
 */
import type { AppliedFact, ChannelCursor } from './channel.js'
import { channelClassOf, sessionIdOf } from './event-classes.js'
import { factAsLeaderSays, type FactScope } from './fact-keys.js'
import { EventNames } from '../event-bus.js'
import type { LiveState } from './host-api.js'
import type { HostChannelBatch } from '../session-tracker.js'
import type { SessionRecord } from '../types.js'
import type { LeaderSideDeps } from './leader-side.js'
import { isTurnEndName, turnEndEdgeOf } from '../sessions/turn-end-edge.js'
import type { HostTurnEnd } from './turn-ends.js'
import { oneDaemonNow } from './revoked-hosts.js'
import { LEADER_QUIET_MS } from '../../host-server/route.js'
import { HELD_SAY_AGAIN_MS, STAND_DOWN_HELD_KEY, isStandDownHeldEnd, supersedesTurnEnd } from './stand-down-held.js'

/** The session:started of a session born on `hostId`, from its row (as the runner says one: handleStart); its task is the leader's row's. */
function startedOf(hostId: string, sid: string, row: Record<string, unknown>, taskId: string | null | undefined): Record<string, unknown> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return { sessionId: sid, claudeSessionId: sid, taskId: taskId || undefined, project: str(row.project) ?? '', host: hostId }
}

/** This process's start on its own clock: a host fact that happened after it was never judged by another leader. */
const PROCESS_STARTED_AT = Math.round(performance.timeOrigin)
/**
 * How long before that start a mark is still not honoured: the presence quiet window, plus a margin for
 * the clock offset (the fact's time is the host's, moved onto this leader's clock). An older leader whose
 * link did not close cleanly (a network cut, a sleep) still reads as answering on the host for up to
 * LEADER_QUIET_MS after it went away, so a turn that ends then is marked though nobody judged it; within
 * this slack the mark is ignored and the turn acted on here: at worst a duplicate, never a loss.
 */
export const STARTED_SLACK_MS = LEADER_QUIET_MS + 5_000

/**
 * The one rule for "this leader has nothing left to act on" in a host's record: it is applied (its
 * rows, the position) and never said on this bus, so no turn-end consumer (usage, triage, notices,
 * session:ended, the queue, the phase) runs for it a second time. Either
 *   - a link before this one applied it and said it then (its seq at or below the position the
 *     batch's transaction read, M2: `appliedBefore`), or
 *   - a bus fact the leader that answered while the host stood down for it judged (`judgedBy:
 *     'leader'`, fact-log.ts; old-leader-watch.ts says when a host marks one): that older leader acted
 *     on the turn from the session's transcript itself. Never one that happened while this process
 *     ran (`happenedAt` after its start, with slack): this leader speaks the channel and judged no host
 *     row itself, so a mark of that time is a misjudged stand-down, and dropping it would lose the
 *     turn end. Only bus facts carry the mark (host-emitter.ts); on another record it means nothing.
 *     Not covered: a misjudged stand-down under an earlier process of this leader (a deploy restart
 *     between the mark and its apply) is honoured, so its turn ends are lost; the host stands up as soon
 *     as it hears the cap, so such a stand-down lasts about one copy round.
 * A turn end of the second kind also leaves no phase mark (turn-ends.ts: it only supersedes an older
 * one), so the boot reconcile does not move the phase for it either.
 */
export function actedOnAlready(r: MarkedRecord & { seq: number }, appliedBefore = 0, startedAt = PROCESS_STARTED_AT): boolean {
  return r.seq <= appliedBefore || markOf(r, startedAt) === 'honoured'
}

interface MarkedRecord { name: string; judgedBy?: unknown; happenedAt?: number }

/** A bus fact's `judgedBy: 'leader'` mark: none, honoured (before this process), or of this process's time (not honoured). */
export function markOf(r: MarkedRecord, startedAt = PROCESS_STARTED_AT): 'none' | 'honoured' | 'this-leader' {
  if (r.judgedBy !== 'leader' || channelClassOf(r.name) !== 'fact') return 'none'
  return typeof r.happenedAt === 'number' && r.happenedAt < startedAt - STARTED_SLACK_MS ? 'honoured' : 'this-leader'
}

/** What a revoked host's link answers its records with: not applied, the link closes (channel.ts `apply_failed`). */
export class HostRevoked extends Error {
  constructor(readonly hostKey: string) { super(`${hostKey} is revoked: nothing it sends is applied`) }
}

interface ApplyContext {
  askResync(hostId: string, sids: readonly string[]): void
  /** Throws HostRevoked (closing the link) when `hostId` is revoked. */
  refuseRevoked(hostId: string): void
  isRevoked(hostKey: string): boolean
  /** The task of the leader's row (null: none); undefined only with no taskOf dep (then a fact's own task keys stand). */
  taskOf(sid: string): string | null | undefined
}

export function createLeaderApply(deps: LeaderSideDeps, ctx: ApplyContext) {
  const { askResync, refuseRevoked, isRevoked, taskOf } = ctx

  /** The task a born row is said started for: the leader's row's (no taskOf dep: the row's own, as before). */
  const leaderTaskOf = (sid: string, patch: Record<string, unknown> | undefined): string | null | undefined => {
    const t = taskOf(sid)
    return t !== undefined ? t : typeof patch?.taskId === 'string' ? patch.taskId : undefined
  }

  /** The leader objects `sid` of `hostId` may name (none on a throw: a fact never names what is not checked). */
  const scopeOf = (hostId: string, sid: string): { scope?: FactScope } => deps.scopeIds
    ? { scope: (key, ids) => { try { return deps.scopeIds!(hostId, sid, key, ids) } catch { return [] } } }
    : {}

  /**
   * The marked turn ends skipped here (stand-down-held.ts), each waiting for its host to say it
   * again: a later turn end or a went-on event of the session ends the wait (the host said it again,
   * or the session went on); at the deadline the end is said as usual, so a real needs-you is never
   * lost when the host's memory of it is (a restart of its service, a link that stays down).
   */
  const heldWaits = new Map<string, { hostId: string; timer: ReturnType<typeof setTimeout> }>()
  const sayAgainMs = deps.heldSayAgainMs ?? HELD_SAY_AGAIN_MS
  const endHeldWait = (sid: string): void => { const w = heldWaits.get(sid); if (w) { clearTimeout(w.timer); heldWaits.delete(sid) } }
  function awaitHeld(hostId: string, r: AppliedFact): void {
    endHeldWait(r.sid)
    const timer = setTimeout(() => {
      if (heldWaits.get(r.sid)?.timer !== timer) return
      heldWaits.delete(r.sid)
      if (isRevoked(hostId) || !hostsOwn(hostId, r.sid, new Set())) return
      const { [STAND_DOWN_HELD_KEY]: _mark, ...data } = (r.data ?? {}) as Record<string, unknown>
      const said = factAsLeaderSays(r.name, data, { sid: r.sid, hostId, taskId: taskOf(r.sid), ...scopeOf(hostId, r.sid) })
      if (said === null) return
      deps.log('info', 'session channel: a turn end of a host\'s stand-down was not said again in time; applied as it came', { hostId, sessionId: r.sid, waitedMs: sayAgainMs })
      emitFact(hostId, { ...r, late: true }, r.name, said, r.to)
    }, sayAgainMs)
    timer.unref?.()
    heldWaits.set(r.sid, { hostId, timer })
  }

  /** One step after the commit: a throw is logged, never closes the link (the position is already past it). */
  function after(hostId: string, what: string, sid: string, fn: () => void): void {
    try { fn() } catch (err) {
      deps.log('warn', 'session channel: a step after the apply failed', { hostId, what, sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Does this record of `hostId` name a session that host owns here (M1), under any name of its machine? */
  function hostsOwn(hostId: string, sid: string, wrote: ReadonlySet<string>): boolean {
    if (wrote.has(sid)) return true
    try { const owner = deps.ownerOf(sid); return !!owner && oneDaemonNow(owner, hostId) } catch { return false }
  }

  async function applyRecs(hostId: string, recs: AppliedFact[], next: ChannelCursor): Promise<void> {
    refuseRevoked(hostId)
    const rows: HostChannelBatch['rows'][number][] = []
    const renames: HostChannelBatch['renames'][number][] = []
    const drops: string[] = []
    const check = new Set<string>()
    // Turn ends that move a task's phase: marked with the rows, so a leader that stops before saying them sets the phase at boot (turn-ends.ts).
    const turnEnds: HostTurnEnd[] = []
    // A new id a rename of this batch moves a row to: its row is that session's, never a start (R2-H1).
    const renamedTo = new Set<string>()
    for (const r of recs) {
      const d = (r.data ?? {}) as Record<string, unknown>
      // A `resync` row is the host's whole row again: applied as a born one (its omitted fields cleared, made when missing).
      // A born row's echo of its start's hand (handed-sessions.ts): only that start's open hand takes it.
      if (r.name === 'row') rows.push({ sid: r.sid, born: d.born === true || d.resync === true, patch: (d.patch ?? {}) as Record<string, unknown>, seq: r.seq, ...(typeof d.hand === 'string' ? { hand: d.hand } : {}) })
      else if (r.name === 'rename' && typeof d.from === 'string' && typeof d.to === 'string') { renames.push({ from: d.from, to: d.to, seq: r.seq }); renamedTo.add(d.to) }
      else if (r.name === 'drop') drops.push(r.sid)
      else {
        check.add(r.sid)
        // Every turn end of the session counts: one with no edge (a retrier took it, work goes on) still supersedes an older mark.
        if (channelClassOf(r.name) === 'fact' && sessionIdOf(r.name, r.data) === r.sid && isTurnEndName(r.name)) turnEnds.push({ sid: r.sid, edge: actedOnAlready(r) ? null : turnEndEdgeOf(r.name, r.data), seq: r.seq })
      }
    }
    // A host that marked facts of this process's time stood down while this leader ran (a misjudged
    // stand-down): its turn ends are acted on here, and its Walnut Health item says it stood down.
    const misjudged = recs.filter((r) => markOf(r) === 'this-leader').length
    if (misjudged > 0) deps.log('warn', 'session channel: a host marked turns of this leader\'s time as judged by an older leader; they are acted on here', { hostId, count: misjudged })
    const applied = await deps.applyBatch({ hostId, rows, renames, cursor: next, ...(drops.length ? { drops } : {}), ...(check.size ? { check: [...check] } : {}), ...(turnEnds.length ? { turnEnds } : {}) })
    const { written } = applied
    for (const sid of written) after(hostId, 'noteHostJudged', sid, () => deps.noteHostJudged(sid, hostId))
    const wrote = new Set(written)
    // Deleted here, its host not done yet: nothing of it is said (leader-drops.ts).
    const gone = new Set(applied.gone ?? [])
    // Applied by a link before this one (the transaction read the position, M2): said then.
    const appliedBefore = applied.after ?? 0
    // The renames the transaction applied (a `to` it wrote through its born row was not renamed into).
    const renamedNow = applied.renamed ? new Set(applied.renamed.map((x) => `${x.from}\n${x.to}`)) : null
    if (applied.resync?.length) askResync(hostId, applied.resync)
    const refused = new Set<string>()
    // After the commit, in log order: the rows a fact's subscribers read are already there.
    for (const r of recs) {
      if (actedOnAlready(r, appliedBefore) || gone.has(r.sid)) continue
      if (r.name === 'row') {
        // A session born on the host, from a start this leader handed it (the batch wrote it only
        // then, handed-sessions.ts): said as started here, at its row's place, with the task of the
        // leader's row; the channel's emit keeps one in all (leader-tasks.ts claimHostStarted). A
        // session a host starts alone while this leader is away reaches it through the host's
        // journal instead (offline-merge/apply-session.ts), never as a born row here. A rows frame
        // (applyRows) is a resync, never a start, and so is a whole row the host sends again
        // (`resync`: its boot, the leader's ask).
        // It names no destinations: it goes where a start this leader hands on says it (reemitDestinations).
        const d = (r.data ?? {}) as { born?: unknown; patch?: Record<string, unknown> }
        if (d.born === true && wrote.has(r.sid)) {
          if (deps.noteBorn) after(hostId, 'noteBorn', r.sid, () => deps.noteBorn!(r.sid))
          if (!renamedTo.has(r.sid)) emitFact(hostId, r, EventNames.SESSION_STARTED, startedOf(hostId, r.sid, d.patch ?? {}, leaderTaskOf(r.sid, d.patch)), undefined)
        }
        continue
      }
      if (r.name === 'turn-summary') continue
      if (r.name === 'rename') {
        // Only a rename the batch applied: the host renamed a row of its own (the transaction checked `from`).
        const d = r.data as { from?: string; to?: string }
        if (d?.from && d?.to && (renamedNow ? renamedNow.has(`${d.from}\n${d.to}`) : wrote.has(d.to))) after(hostId, 'noteRename', d.to, () => deps.noteRename(d.from!, d.to!))
        continue
      }
      // A dropped session holds nothing live on its host; one of another host's is not this one's to end.
      // (A drop of a row this leader deleted is in `gone`; one of a row long gone here needs nothing.)
      if (r.name === 'drop') { if (hostsOwn(hostId, r.sid, wrote)) after(hostId, 'noteLive', r.sid, () => deps.noteLive(r.sid, { gone: true }, hostId)); continue }
      // Every other record names a session this host owns here, or it is not said (M1).
      if (!hostsOwn(hostId, r.sid, wrote)) { refused.add(r.sid); continue }
      if (r.name === 'live') {
        after(hostId, 'noteLive', r.sid, () => deps.noteLive(r.sid, ((r.data as { state?: LiveState } | null)?.state ?? {}) as LiveState, hostId))
        continue
      }
      if (channelClassOf(r.name) !== 'fact') continue
      // A turn end its host wrote while standing down: marked for the reconcile above, said by no one
      // here; the host says it again once it stood up and judged it (stand-down-held.ts), so a turn
      // it continues is never handed back and pushed first. Said as usual if the host does not by
      // the deadline (awaitHeld).
      if (isStandDownHeldEnd(r.name, r.data)) { awaitHeld(hostId, r); continue }
      if (supersedesTurnEnd(r.name)) endHeldWait(r.sid)
      // The event names the record's own session, or it is not said; it says the leader's task of it.
      const said = sessionIdOf(r.name, r.data) === r.sid ? factAsLeaderSays(r.name, r.data, { sid: r.sid, hostId, taskId: taskOf(r.sid), ...scopeOf(hostId, r.sid) }) : null
      if (said === null) { refused.add(r.sid); continue }
      emitFact(hostId, r, r.name, said, r.to)
    }
    if (refused.size > 0) {
      if (deps.refused) after(hostId, 'refused', '', () => deps.refused!(hostId, [...refused]))
      else deps.log('warn', 'session channel: records of sessions this host does not own were not said', { hostId, count: refused.size })
    }
    // A hand-over its host answered with a row that is no born one (a row it owned already): ended too.
    const bornHere = new Set(recs.filter((r) => r.name === 'row' && (r.data as { born?: unknown } | null)?.born === true).map((r) => r.sid))
    if (deps.noteBorn) for (const sid of applied.handOversEnded ?? []) if (!bornHere.has(sid)) after(hostId, 'noteBorn', sid, () => deps.noteBorn!(sid))
  }

  function emitFact(hostId: string, r: AppliedFact, name: string, data: unknown, to: string[] | undefined): void {
    after(hostId, name, r.sid, () => deps.emit(name, data, { late: r.late, at: r.happenedAt, ...(to ? { to } : {}) }))
  }

  async function applyRows(hostId: string, rows: SessionRecord[], next: ChannelCursor, frame: { at: number; gone: string[] }): Promise<void> {
    refuseRevoked(hostId)
    const { written, removed } = await deps.applyBatch({
      hostId,
      rows: rows.map((row) => ({ sid: row.claudeSessionId, born: true, patch: row as unknown as Record<string, unknown> })),
      renames: [],
      cursor: next,
      // Every row the host owns now, as of record `at`: only a row it names gone is deleted (rows-snapshot.ts).
      snapshot: { keep: deps.startsInFlight?.() ?? new Set(), at: frame.at, gone: frame.gone },
    })
    for (const sid of written) after(hostId, 'noteHostJudged', sid, () => deps.noteHostJudged(sid, hostId))
    if (deps.noteBorn) for (const sid of written) after(hostId, 'noteBorn', sid, () => deps.noteBorn!(sid))
    if (removed?.length) deps.log('info', 'session channel: rows the host no longer has were removed here', { hostId, count: removed.length })
  }

  /** A text delta of a session this host owns, naming that session, or nothing (M1). */
  function onFlow(hostId: string, sid: string, name: string, data: unknown, to: string[] | undefined): void {
    if (isRevoked(hostId) || !hostsOwn(hostId, sid, new Set()) || sessionIdOf(name, data) !== sid) return
    if (supersedesTurnEnd(name)) endHeldWait(sid)
    const said = factAsLeaderSays(name, data, { sid, hostId, taskId: taskOf(sid), ...scopeOf(hostId, sid) })
    if (said === null) return
    try { deps.emit(name, said, { late: false, ...(to ? { to } : {}) }) } catch { /* a flow event is never kept */ }
  }

  /** Stop every wait (the leader side stops). */
  const stop = (): void => { for (const w of heldWaits.values()) clearTimeout(w.timer); heldWaits.clear() }

  return { applyRecs, applyRows, onFlow, stop }
}
