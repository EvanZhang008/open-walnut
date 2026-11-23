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
 * later turn drops it (the session went on; whoever moved it judged that turn). At the stand-up the
 * kept ends go to the resend family's own subscribers only (host-resend.ts replay), whose gate
 * (judge-of.ts judgedHere) is open again; nothing else hears them twice, and the emitter, which
 * already wrote them to the fact log, does not see them again.
 */

const TURN_ENDS = new Set(['session:result', 'session:error'])
/** Events that say the session went on after its turn end. */
const WENT_ON = new Set(['session:send', 'session:started', 'session:message-queued', 'session:messages-delivered', 'session:text-delta', 'session:tool-use'])

export interface HeldTurnEnd { name: string; data: unknown; source?: string; timestamp?: number }

export interface StandDownHeld {
  /** One bus event (the host's subscriber calls it with every `session:` event). */
  note(event: { name: string; data: unknown; source?: string; timestamp?: number }): void
  /** The kept ends, oldest first, and forget them. */
  take(): HeldTurnEnd[]
  size(): number
}

function sessionIdOf(data: unknown): string {
  const sid = (data as { sessionId?: unknown } | null)?.sessionId
  return typeof sid === 'string' ? sid : ''
}

export function createStandDownHeld(o: { standingDown(): boolean; owns(sid: string): boolean }): StandDownHeld {
  const held = new Map<string, HeldTurnEnd>()
  return {
    note(event) {
      const sid = sessionIdOf(event.data)
      if (!sid) return
      if (TURN_ENDS.has(event.name)) {
        if (!o.standingDown() || !o.owns(sid)) return
        held.delete(sid)
        held.set(sid, { name: event.name, data: event.data, ...(event.source ? { source: event.source } : {}), ...(typeof event.timestamp === 'number' ? { timestamp: event.timestamp } : {}) })
      } else if (WENT_ON.has(event.name)) {
        held.delete(sid)
      }
    },
    take() {
      const out = [...held.values()]
      held.clear()
      return out
    },
    size: () => held.size,
  }
}
