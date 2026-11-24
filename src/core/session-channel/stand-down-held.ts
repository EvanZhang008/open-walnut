/**
 * The turn ends a host's resend family skipped while the host stood down (old-leader-watch.ts),
 * handed to it when the host stands up again. Standing down is meant for an older leader that judges
 * every session itself; when the watch misjudged (a newer leader that answered but did not open the
 * channel in time), the leader treats these sessions as host-judged and so continues, retries and
 * drains none of them. Without this, a turn end of that time (a usage limit, an endpoint outage, a
 * queued line waiting for the turn's end) would be acted on by no one.
 *
 * Kept per session, only the newest turn end of each session this host runs, and only while
 * nothing happened in the session after it: a line sent, a start, a delivery or new output of a
 * later turn drops it (the session went on; whoever moved it judged that turn). The host's bus may
 * not see a turn an older leader drives, so at the stand-up two more checks drop an end:
 *
 *   older than HELD_MAX_AGE_MS   the replay is for a misfire, minutes long; after a real older
 *                                leader the person or that leader dealt with the turn long ago
 *   its transcript grew          the runner's consumed offset of the session is past the one it had
 *                                when the end settled (SETTLE_MS after it): a later turn ran
 *
 * At the stand-up the
 * kept ends worth replaying go to the resend family's own subscribers only (host-resend.ts replay),
 * whose gate (judge-of.ts judgedHere) is open again; nothing else hears them twice, and the emitter,
 * which already wrote them to the fact log, does not see them again.
 *
 * What the leader hears of them (land 6 review, N5): the emitter wrote each turn end of the
 * stand-down to the fact log at once, marked `standDownHeld` (host-resend.ts turnEndStamp). A leader
 * that reads that mark (it says so on its resume: channel.ts LEADER_READS, READS_HELD_TURN_ENDS)
 * notes the turn end for its boot reconcile but says nothing of it (leader-apply.ts), so a misfire's
 * newer leader never moves the task to NEED_ACTION and pushes for a turn the host is about to
 * continue. The host owes that leader the end instead, said again once it is judged: stamped as its
 * retriers took it in the replay's own tick (a continue keeps the phase as on the live path), and a
 * kept end not replayed (too old, its transcript grew) as taken by no one. The owed end is said once a
 * leader that reads the mark is linked (now, or at its next link), and dropped when the session goes
 * on first or a leader that does not read the mark is linked (that one applied the end as it came,
 * as before).
 *
 * A real needs-you is never lost for it (land 6 review round 1, S1): the worst case is one needs-you
 * too many. The host marks only an end `held` keeps, the very event (startStandDownSide's stamp: an
 * end of a session whose row has not come yet is kept by no one, so it is written unmarked and the
 * leader applies it as it comes). The held and owed ends live in memory only, so a host service
 * restart (or a link that stays down) can leave a marked end said again by no one; the leader keeps
 * a deadline on every marked end it skips (leader-apply.ts, HELD_SAY_AGAIN_MS) and applies the end as
 * usual when neither the host said it again nor a later event of the session came by then, and a
 * mark older than that still standing at a link's catch-up is reconciled (leader-boot.ts).
 */
import type { SubscribeOptions, SubscriberHandler } from '../event-bus.js'

const TURN_ENDS = new Set(['session:result', 'session:error'])
/** Events that say the session went on after its turn end. */
const WENT_ON = new Set(['session:send', 'session:started', 'session:message-queued', 'session:messages-delivered', 'session:text-delta', 'session:tool-use'])

/** Does `name`, of a session after its turn end, take that end's place (a later turn end, or the session went on)? */
export function supersedesTurnEnd(name: string): boolean { return TURN_ENDS.has(name) || WENT_ON.has(name) }

/** A turn end as the bus said it; `to`: its destinations, which the record said again names too. */
export interface HeldTurnEnd { name: string; data: unknown; source?: string; timestamp?: number; to?: string[] }

/** The mark the emitter puts on a turn end it wrote while this host stood down (host-resend.ts turnEndStamp). */
export const STAND_DOWN_HELD_KEY = 'standDownHeld'

/** A turn-end fact a host wrote while standing down: a leader that reads the mark waits for the host to say it again. */
export function isStandDownHeldEnd(name: string, data: unknown): boolean {
  return TURN_ENDS.has(name) && (data as Record<string, unknown> | null)?.[STAND_DOWN_HELD_KEY] === true
}

/** A held end older than this at the stand-up is never replayed. */
export const HELD_MAX_AGE_MS = 15 * 60_000
/**
 * How long a leader waits for the host to say a marked turn end again before it applies the end as
 * usual. The host says it right after the link that carried it catches up (its watch stands up on
 * that link), so a minute or two covers it; a later say-again is at most one needs-you too many.
 */
export const HELD_SAY_AGAIN_MS = 2 * 60_000
/** The consumed offset a held end is compared with is read this long after it (its trailing lines written). */
export const SETTLE_MS = 5_000

interface Kept { end: HeldTurnEnd; at: number; offset: number | undefined }

export interface StandDownHeld {
  /** One bus event (the host's subscriber calls it with every `session:` event). */
  note(event: { name: string; data: unknown; source?: string; timestamp?: number; destinations?: string[] }): void
  /**
   * Forget every kept end: `replay` the ones still worth replaying (see the header), oldest first,
   * `dropped` the others (kept, but too old or their transcript grew).
   */
  take(): { replay: HeldTurnEnd[]; dropped: HeldTurnEnd[] }
  /**
   * The stand-up (see the header): take the kept ends, `replay` the ones worth it, and owe the leader
   * every one, a replayed end stamped by `stamp` in the replay's own tick (as the emitter stamps a
   * live one), a dropped one as taken by no one. Returns how many were replayed.
   */
  standUp(o: { replay(ends: HeldTurnEnd[]): void; stamp(name: string, data: unknown): unknown }): number
  /**
   * Once a leader is linked: say every owed end (`say`) when it reads the held mark, else forget them
   * (it applied them as they came). Nothing while no leader is linked. Returns how many were said.
   */
  payOwed(o: { leaderLinked(): boolean; leaderReadsHeld(): boolean; say(name: string, data: unknown, to?: string[]): void }): number
  /** Is this very event (its data object) the end kept now for its session? The mark is put only on such an end. */
  holds(name: string, data: unknown): boolean
  size(): number
  owedSize(): number
}

function sessionIdOf(data: unknown): string {
  const sid = (data as { sessionId?: unknown } | null)?.sessionId
  return typeof sid === 'string' ? sid : ''
}

export function createStandDownHeld(o: {
  standingDown(): boolean
  owns(sid: string): boolean
  /** The runner's consumed offset of the session's transcript now (undefined: not known). */
  offsetOf?(sid: string): number | undefined
  now?(): number
  /** Run `fn` after `ms` (tests: at once). */
  later?(fn: () => void, ms: number): void
  maxAgeMs?: number
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}): StandDownHeld {
  const now = o.now ?? Date.now
  const later = o.later ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.() })
  const maxAge = o.maxAgeMs ?? HELD_MAX_AGE_MS
  const offsetOf = (sid: string): number | undefined => { try { const v = o.offsetOf?.(sid); return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined } catch { return undefined } }
  const held = new Map<string, Kept>()
  const owed = new Map<string, HeldTurnEnd>()
  const take = (): { replay: HeldTurnEnd[]; dropped: HeldTurnEnd[] } => {
    const replay: HeldTurnEnd[] = []
    const dropped: HeldTurnEnd[] = []
    const t = now()
    for (const [sid, k] of held) {
      const off = offsetOf(sid)
      if (t - k.at > maxAge) { o.log?.('info', 'host sessions: a turn end of the stand-down is too old to replay', { sessionId: sid, ageMs: t - k.at }); dropped.push(k.end); continue }
      if (k.offset !== undefined && off !== undefined && off > k.offset) { o.log?.('info', 'host sessions: a turn end of the stand-down is not replayed, its transcript grew since', { sessionId: sid, from: k.offset, to: off }); dropped.push(k.end); continue }
      replay.push(k.end)
    }
    held.clear()
    return { replay, dropped }
  }
  return {
    note(event) {
      const sid = sessionIdOf(event.data)
      if (!sid) return
      if (TURN_ENDS.has(event.name)) {
        // A later turn end of the session: the owed one is history (the leader hears this one).
        owed.delete(sid)
        if (!o.standingDown() || !o.owns(sid)) return
        held.delete(sid)
        const kept: Kept = {
          end: { name: event.name, data: event.data, ...(event.source ? { source: event.source } : {}), ...(typeof event.timestamp === 'number' ? { timestamp: event.timestamp } : {}), ...(event.destinations ? { to: [...event.destinations] } : {}) },
          at: now(), offset: offsetOf(sid),
        }
        held.set(sid, kept)
        later(() => { if (held.get(sid) === kept) kept.offset = offsetOf(sid) ?? kept.offset }, SETTLE_MS)
      } else if (WENT_ON.has(event.name)) {
        held.delete(sid)
        owed.delete(sid)
      }
    },
    take,
    standUp(u) {
      const { replay, dropped } = take()
      if (replay.length > 0) u.replay(replay)
      const owe = (e: HeldTurnEnd, data: unknown): void => { const sid = sessionIdOf(data); if (sid) { owed.delete(sid); owed.set(sid, { ...e, data }) } }
      for (const e of replay) owe(e, u.stamp(e.name, e.data))
      for (const e of dropped) owe(e, { ...(e.data as object), hostTakenBy: null })
      return replay.length
    },
    payOwed(p) {
      if (owed.size === 0 || !p.leaderLinked()) return 0
      const ends = [...owed.values()]
      owed.clear()
      if (!p.leaderReadsHeld()) return 0
      let said = 0
      for (const e of ends) {
        try { p.say(e.name, e.data, e.to); said++ } catch (err) { o.log?.('warn', 'host sessions: a turn end of the stand-down was not said again', { sessionId: sessionIdOf(e.data), error: err instanceof Error ? err.message : String(err) }) }
      }
      return said
    },
    holds: (name, data) => TURN_ENDS.has(name) && data !== null && data !== undefined && held.get(sessionIdOf(data))?.end.data === data,
    size: () => held.size,
    owedSize: () => owed.size,
  }
}

/** The bus subscriber that keeps the held ends; it subscribes before the emitter, so the emitter's stamp sees what it kept. */
export const STAND_DOWN_HELD_SUBSCRIBER = 'host-stand-down-held'

export interface StandDownSide {
  held: StandDownHeld
  /**
   * The emitter's stamp (host-emitter.ts `stamp`): `base` (host-resend.ts turnEndStamp), with the
   * held mark on a turn end only when `held` keeps this very event, so the host never marks an end it
   * will not say again.
   */
  stamp(name: string, data: unknown): unknown
  /** The old-leader watch's stand-down. */
  standDown(): void
  /** The old-leader watch's stand-up: the kept ends to the resend family, owed to the leader, said when it reads them. */
  standUp(): void
  /** The channel's leader linked and caught up (HostChannel onLeaderLinked): the owed ends go to it. */
  onLeaderLinked(): void
  stop(): void
}

/**
 * The host's stand-down side (host-boot.ts): `held` on the bus, subscribed before the emitter starts,
 * and the stamp, stand-down, stand-up and leader-link steps that keep it, owe and say its ends.
 */
export function startStandDownSide(o: {
  bus: { subscribe(name: string, handler: SubscriberHandler, opts: SubscribeOptions): void; unsubscribe(name: string): void }
  standingDown(): boolean
  setStandsDown(on: boolean): void
  owns(sid: string): boolean
  offsetOf?(sid: string): number | undefined
  /** The stamp of a turn end as this host judges it now (host-resend.ts turnEndStamp). */
  stamp(name: string, data: unknown): unknown
  /** Hand ends to the resend family's own subscribers (host-resend.ts replay). */
  replay(ends: HeldTurnEnd[]): void
  /** A leader is linked and caught up now (HostChannel.leaderLive), and does it read the mark. */
  leaderLinked(): boolean
  leaderReadsHeld(): boolean
  /** Say an owed end again to the leader, to its event's destinations (host-emitter.ts sayAgain). */
  sayAgain(name: string, data: unknown, to?: string[]): void
  /** Tests: the held clock. */
  heldOptions?: { now?(): number; later?(fn: () => void, ms: number): void; maxAgeMs?: number }
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}): StandDownSide {
  const say = o.log ?? (() => {})
  const held = createStandDownHeld({ standingDown: o.standingDown, owns: o.owns, ...(o.offsetOf ? { offsetOf: o.offsetOf } : {}), ...(o.heldOptions ?? {}), log: say })
  o.bus.subscribe(STAND_DOWN_HELD_SUBSCRIBER, (event) => held.note(event), { global: true, interest: ['session:'] })
  const payOwed = (): void => {
    const said = held.payOwed({ leaderLinked: o.leaderLinked, leaderReadsHeld: o.leaderReadsHeld, say: o.sayAgain })
    if (said > 0) say('info', 'host sessions: the turn ends of the stand-down were said again to the leader, as judged here', { count: said })
  }
  return {
    held,
    stamp(name, data) {
      const stamped = o.stamp(name, data)
      if (!held.holds(name, data) || !stamped || typeof stamped !== 'object') return stamped
      return { ...(stamped as Record<string, unknown>), [STAND_DOWN_HELD_KEY]: true }
    },
    standDown: () => o.setStandsDown(true),
    standUp() {
      o.setStandsDown(false)
      held.standUp({
        replay: (ends) => {
          say('info', 'host sessions: handing the turn ends of the stand-down to the resend family', { count: ends.length, sessionIds: ends.slice(0, 20).map((e) => sessionIdOf(e.data)) })
          o.replay(ends)
        },
        stamp: o.stamp,
      })
      payOwed()
    },
    onLeaderLinked: payOwed,
    stop: () => o.bus.unsubscribe(STAND_DOWN_HELD_SUBSCRIBER),
  }
}
