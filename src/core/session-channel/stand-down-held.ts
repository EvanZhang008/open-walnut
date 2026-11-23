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
 * kept ends go to the resend family's own subscribers only (host-resend.ts replay), whose gate
 * (judge-of.ts judgedHere) is open again; nothing else hears them twice, and the emitter, which
 * already wrote them to the fact log, does not see them again.
 */

const TURN_ENDS = new Set(['session:result', 'session:error'])
/** Events that say the session went on after its turn end. */
const WENT_ON = new Set(['session:send', 'session:started', 'session:message-queued', 'session:messages-delivered', 'session:text-delta', 'session:tool-use'])

export interface HeldTurnEnd { name: string; data: unknown; source?: string; timestamp?: number }

/** A held end older than this at the stand-up is never replayed. */
export const HELD_MAX_AGE_MS = 15 * 60_000
/** The consumed offset a held end is compared with is read this long after it (its trailing lines written). */
export const SETTLE_MS = 5_000

interface Kept { end: HeldTurnEnd; at: number; offset: number | undefined }

export interface StandDownHeld {
  /** One bus event (the host's subscriber calls it with every `session:` event). */
  note(event: { name: string; data: unknown; source?: string; timestamp?: number }): void
  /** The kept ends still worth replaying (see the header), oldest first, and forget them all. */
  take(): HeldTurnEnd[]
  size(): number
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
  return {
    note(event) {
      const sid = sessionIdOf(event.data)
      if (!sid) return
      if (TURN_ENDS.has(event.name)) {
        if (!o.standingDown() || !o.owns(sid)) return
        held.delete(sid)
        const kept: Kept = {
          end: { name: event.name, data: event.data, ...(event.source ? { source: event.source } : {}), ...(typeof event.timestamp === 'number' ? { timestamp: event.timestamp } : {}) },
          at: now(), offset: offsetOf(sid),
        }
        held.set(sid, kept)
        later(() => { if (held.get(sid) === kept) kept.offset = offsetOf(sid) ?? kept.offset }, SETTLE_MS)
      } else if (WENT_ON.has(event.name)) {
        held.delete(sid)
      }
    },
    take() {
      const out: HeldTurnEnd[] = []
      const t = now()
      for (const [sid, k] of held) {
        const off = offsetOf(sid)
        if (t - k.at > maxAge) { o.log?.('info', 'host sessions: a turn end of the stand-down is too old to replay', { sessionId: sid, ageMs: t - k.at }); continue }
        if (k.offset !== undefined && off !== undefined && off > k.offset) { o.log?.('info', 'host sessions: a turn end of the stand-down is not replayed, its transcript grew since', { sessionId: sid, from: k.offset, to: off }); continue }
        out.push(k.end)
      }
      held.clear()
      return out
    },
    size: () => held.size,
  }
}
