/**
 * Presence events: time tracking → in-process subscribers (plugins).
 *
 * A plugin that measures how long the human has been continuously at the
 * keyboard (a stand-up reminder, a pomodoro) needs the attention stream, not
 * the day rollups. These two events are that stream. Both are emitted with NO
 * destinations, so only global bus subscribers (plugin `events.on`) receive
 * them; the browser's 'web-ui' subscriber is destination-gated and never sees
 * them, which keeps a 5s sampler off every open tab's WebSocket.
 *
 *   time:banked   human records just banked (phone and console heartbeats)
 *   time:outside  Mac-wide attention from the outside-activity collector,
 *                 aggregated to at most one event per OUTSIDE_EMIT_MS
 */
import { bus, EventNames } from '../event-bus.js'
import type { TimeBankedEvent, TimeOutsideEvent } from '../event-types.js'
import type { TimeRecord } from './types.js'

/**
 * The collector samples every 5s; one event per sample would be ~17k bus events a
 * day for a consumer that only needs "still here" granularity. 30s sums six
 * samples and still notices a break long before any reminder threshold.
 */
export const OUTSIDE_EMIT_MS = 30_000

/** Announce human records that were just accepted. Agent-lane records never belong here. */
export function emitTimeBanked(records: readonly TimeRecord[]): void {
  const human = records.filter(r => r.kind !== 'agent')
  if (human.length === 0) return
  const payload: TimeBankedEvent = {
    records: human.map(r => ({
      ts: r.ts,
      durationMs: r.durationMs,
      kind: r.kind,
      ...(r.source ? { source: r.source } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    })),
  }
  bus.emit(EventNames.TIME_BANKED, payload, [], { source: 'time-tracking' })
}

let pending: TimeOutsideEvent | null = null
let lastEmitAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (!pending) return
  const payload = pending
  pending = null
  lastEmitAt = Date.now()
  bus.emit(EventNames.TIME_OUTSIDE, payload, [], { source: 'time-tracking' })
}

/**
 * One outside sample was banked as attention. Leading edge: the first sample
 * after a quiet stretch goes out at once (a consumer learns the human is back
 * without waiting). Inside the window, samples accumulate and ONE trailing
 * timer sends the sum when the window closes, so the tail is never lost when
 * the human walks away.
 */
export function noteOutsideAttention(sample: {
  ts: string
  durationMs: number
  bundleId?: string
  idleSecs?: number
}): void {
  const now = Date.now()
  if (!(sample.durationMs > 0)) return
  pending = pending
    ? {
        ts: pending.ts,
        durationMs: pending.durationMs + sample.durationMs,
        ...(sample.bundleId ? { bundleId: sample.bundleId } : {}),
        ...(sample.idleSecs !== undefined ? { idleSecs: sample.idleSecs } : {}),
      }
    : {
        ts: sample.ts,
        durationMs: sample.durationMs,
        ...(sample.bundleId ? { bundleId: sample.bundleId } : {}),
        ...(sample.idleSecs !== undefined ? { idleSecs: sample.idleSecs } : {}),
      }
  const wait = lastEmitAt + OUTSIDE_EMIT_MS - now
  if (wait <= 0) { flush(); return }
  if (flushTimer) return
  flushTimer = setTimeout(flush, wait)
  flushTimer.unref?.()
}

/** Collector stop + tests: drop the batch and the timer. */
export function resetPresenceEvents(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  pending = null
  lastEmitAt = 0
}
