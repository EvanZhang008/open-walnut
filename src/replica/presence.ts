/**
 * Whether the Mac answers, as a host replica sees it
 * (docs/plan/walnut-replica-servers-impl.md, section 3, "Presence"). One rule:
 *
 *   leaderAnswers = holder == 'primary' && primaryConnected
 *                   && primaryHeardAgoMs + viewAge < LEADER_QUIET_MS
 *                   && !suspect && drainablePending == 0
 *
 * Input is the daemon's follower view (follower.status), how old it is, and the
 * last forward outcome (a failed stream marks the leader suspect for a few
 * seconds, host-server/route.ts SUSPECT_MS). The window is the DAEMON's one
 * (`quietMs` in the view, the same LEADER_QUIET_MS it applies to follower writes
 * and gateway routing), so the replica and the daemon never disagree on
 * "away"; before a daemon says it, the same env knob and default as the twins.
 *
 * `drainablePending` counts this home's journal records the current leader's
 * drain can take. While the Mac's frames are back but its drain still runs, the
 * replica stays away and keeps writing to the journal: one writer during a
 * drain. A record parked for a newer Mac is not in that count, so it can never
 * pin the host away.
 */

import type { FollowerView } from '../host-server/daemon-link.js'
import { SUSPECT_MS, VIEW_STALE_MS, type Route } from '../host-server/route.js'
// The daemon twins' own parse of a timer knob (daemon-source.ts mirrors it verbatim).
import { envTimerMs } from '../providers/daemon-core.js'

/** The one quiet window (C4): the Mac not heard this long is away. Pinned equal to both twins. */
export const LEADER_QUIET_MS = envTimerMs(process.env.WALNUT_LEADER_QUIET_MS, 30_000, 500)

export { SUSPECT_MS, VIEW_STALE_MS }

export type PresenceWhy =
  | 'answers' | 'no-daemon' | 'companion-leads' | 'mac-away' | 'unreachable' | 'draining'

export interface Presence {
  answers: boolean
  why: PresenceWhy
  /** When the Mac was last heard, by the daemon's view (what the copies are at most as fresh as); 0 when unknown. */
  asOf: number
}

export interface PresenceInput {
  view: { view: FollowerView; at: number } | null
  now: number
  /** Until when each target is skipped. */
  suspect: { leader?: number; companion?: number }
  /** The window when no daemon said one (tests). */
  quietMs?: number
}

function freshView(input: PresenceInput): FollowerView | null {
  const v = input.view
  return v && input.now - v.at <= VIEW_STALE_MS ? v.view : null
}

/** The window in force: the daemon's, else the knob. */
export function quietWindow(input: PresenceInput): number {
  const fromDaemon = input.view?.view.quietMs
  return typeof fromDaemon === 'number' && fromDaemon > 0 ? fromDaemon : (input.quietMs ?? LEADER_QUIET_MS)
}

export function presenceOf(input: PresenceInput): Presence {
  const v = freshView(input)
  if (!v) return { answers: false, why: 'no-daemon', asOf: 0 }
  const viewAge = input.now - input.view!.at
  const asOf = Math.max(0, input.view!.at - v.primaryHeardAgoMs)
  if (v.holder !== 'primary') return { answers: false, why: 'companion-leads', asOf }
  if (!v.primaryConnected || v.primaryHeardAgoMs + viewAge >= quietWindow(input)) return { answers: false, why: 'mac-away', asOf }
  if ((input.suspect.leader ?? 0) > input.now) return { answers: false, why: 'unreachable', asOf }
  if ((v.drainablePending ?? 0) > 0) return { answers: false, why: 'draining', asOf }
  return { answers: true, why: 'answers', asOf: input.now }
}

/**
 * Where a browser's request goes: the leader while it answers; the companion
 * while it stands in (today's path, forwarded as the host server does); else
 * this replica answers itself ('alone', the away answers).
 */
export function chooseReplicaRoute(input: PresenceInput): Route {
  const p = presenceOf(input)
  if (p.answers) return { kind: 'leader' }
  const v = freshView(input)
  if (!v) return { kind: 'alone', why: 'no-daemon' }
  // A drain still running keeps every request here: the journal is the one writer.
  if (p.why !== 'draining' && v.bridge.connected && v.bridge.companion && (input.suspect.companion ?? 0) <= input.now) {
    return { kind: 'companion', origin: v.bridge.companion }
  }
  return { kind: 'alone', why: p.why === 'draining' ? 'draining' : v.bridge.companion ? 'nobody-answers' : 'mac-away' }
}

type TargetKind = 'leader' | 'companion'

/**
 * The suspect marks of a host replica (a failed stream to a target). A mark
 * lasts SUSPECT_MS; each one after another with no answer from the target in
 * between doubles it, up to the quiet window. A Mac whose daemon link is alive
 * but whose stream door refuses (booting, this host not linked yet) is so tried
 * every 5, 10, 20, then 30 s, not every 5 s. An answer from the target (a
 * response, a 101) starts the count again. Failures while a mark holds (the
 * forwards already in flight) count once.
 */
export class SuspectMarks {
  /** Until when each target is skipped (PresenceInput.suspect). */
  readonly until: { leader?: number; companion?: number } = {}
  private readonly fails: Record<TargetKind, number> = { leader: 0, companion: 0 }

  constructor(private readonly cap: () => number) {}

  /** A stream to `kind` failed at `now`: how long it is skipped now. */
  fail(kind: TargetKind, now: number): number {
    const held = (this.until[kind] ?? 0) - now
    if (held > 0) return held
    this.fails[kind]++
    const ms = Math.min(SUSPECT_MS * 2 ** Math.min(this.fails[kind] - 1, 16), Math.max(SUSPECT_MS, this.cap()))
    this.until[kind] = now + ms
    return ms
  }

  /** `kind` answered: the next failure is marked SUSPECT_MS again. */
  answered(kind: TargetKind): void {
    this.fails[kind] = 0
  }

  /** Failures in a row with no answer between them (the report, tests). */
  failures(kind: TargetKind): number {
    return this.fails[kind]
  }
}

export interface LeaderReturnDeps {
  /** Open a stream to the Mac and let it go: resolves once it opened. */
  probe(): Promise<void>
  /** Presence still answers (when the probe is back). */
  answers(): boolean
  /** Move the browsers to the Mac: the companion's sockets and the replica's own close 4002 leader_back. */
  close(): void
  answered(): void
  failed(err: Error): void
}

/**
 * What a flip back to the Mac does: the replica's own sockets close (4002), so
 * each browser reconnects to the Mac, but only once a stream to the Mac opened.
 * A Mac whose frames flow while its stream door still refuses (booting, this
 * host not linked yet) would otherwise have every browser moved off and back on
 * at each flip. One probe at a time; a refused one is a suspect mark.
 */
export function leaderReturn(deps: LeaderReturnDeps): () => void {
  let probing = false
  return () => {
    if (probing) return
    probing = true
    deps.probe().then(() => {
      probing = false
      deps.answered()
      if (deps.answers()) deps.close()
    }, (err: unknown) => {
      probing = false
      deps.failed(err instanceof Error ? err : new Error(String(err)))
    })
  }
}

/**
 * Whether the Mac is really away: the quiet window passed, no daemon view, or
 * the companion leads. Only then are in-flight forwards to the Mac answered 504
 * and its spliced sockets closed 4001. A suspect mark ('unreachable', one
 * failed stream to a live Mac) or a drain still running steers NEW requests and
 * handshakes elsewhere and nothing more: a frozen Mac is still caught by the
 * quiet window, and a forward that really fails fails on its own.
 */
export function macAway(why: PresenceWhy): boolean {
  return why === 'mac-away' || why === 'no-daemon' || why === 'companion-leads'
}

export interface PresenceWatchDeps {
  presence(): Presence
  /** Every change of answers or why (the log, the replica's own clients). */
  changed(p: Presence): void
  /** The Mac is really away (macAway), once per absence: cut its in-flight forwards and sockets. */
  away(): void
  /** Presence answers again after it did not: move the browsers back (leaderReturn). */
  back(): void
}

/**
 * The front's look at presence (front.ts): a change is told once, a real
 * absence cuts once (also when it follows a bare suspect mark, whose flip to
 * answers:false cut nothing), and a return calls back().
 */
export function presenceWatch(deps: PresenceWatchDeps): () => Presence {
  let last: Presence | null = null
  // Whether the in-flight work on the Mac was already cut in this absence.
  let cut = false
  return () => {
    const p = deps.presence()
    const prev = last
    if (!prev || prev.answers !== p.answers || prev.why !== p.why) {
      last = p
      deps.changed(p)
      if (prev && !prev.answers && p.answers) { cut = false; deps.back() }
    }
    if (p.answers) return p
    if (!prev) { cut = macAway(p.why); return p }
    if (!cut && macAway(p.why)) { cut = true; deps.away() }
    return p
  }
}

export interface LeaderPresenceWiring {
  input: () => PresenceInput
  marks: SuspectMarks
  /** The dispatcher (late-bound: it needs this wiring's `look` and `onSuspect`). */
  dispatcher: () => { presenceChanged(answers: boolean): void }
  /** Opens one stream to the Mac and closes it: resolves when it opened. */
  probe: () => Promise<void>
  /** Presence changed (answers or why): tell the replica's own clients. */
  changed: (p: Presence) => void
  /** The Mac is back and a probe opened: close the replica's own sockets (4002). */
  closeOwnSockets?: () => void
  /** A forward failed and marked the target suspect for `skipMs`. */
  failed?: (kind: 'leader' | 'companion', err: Error, skipMs: number) => void
}

/**
 * The front's presence wiring (front.ts uses exactly this, and the suspect
 * tests drive it): a real absence (macAway) cuts the Mac's in-flight forwards
 * and spliced sockets once; a bare suspect mark only steers new requests; back
 * means a probe stream opened, then the replica's own sockets close.
 */
export function wireLeaderPresence(w: LeaderPresenceWiring): {
  look: () => Presence
  onSuspect: (kind: 'leader' | 'companion', err: Error) => void
} {
  const look = presenceWatch({
    presence: () => presenceOf(w.input()),
    changed: w.changed,
    away: () => w.dispatcher().presenceChanged(false),
    back: () => backToLeader(),
  })
  const backToLeader = leaderReturn({
    probe: w.probe,
    answers: () => presenceOf(w.input()).answers,
    close: () => {
      w.dispatcher().presenceChanged(true)
      w.closeOwnSockets?.()
    },
    answered: () => w.marks.answered('leader'),
    failed: (err) => onSuspect('leader', err),
  })
  function onSuspect(kind: 'leader' | 'companion', err: Error): void {
    const ms = w.marks.fail(kind, Date.now())
    w.failed?.(kind, err, ms)
    look()
  }
  return { look, onSuspect }
}
