/**
 * Flight recorder — a per-session ring buffer of the exact inputs the chat
 * pipeline consumed: WS stream events and /history fetch results.
 *
 * WHY: every incident in the "stale thing pinned at the bottom" family died in
 * forensics for the same reason — by the time the bundle was captured, the
 * client-side inputs were gone (refresh clears the artifact, logs hold only
 * server-side lines). The recorder closes the loop the replication lab needs:
 * when the render-filter tripwire fires ("N completed blocks had no delta
 * twin"), the trace of what THIS client actually received is dumped alongside,
 * and scripts/chat-lab-trace.md documents how to turn it into a replayable
 * tests/web/chat-lab/ scenario.
 *
 * Deliberately tiny: fixed-size ring (memory-bounded), trimmed payloads (labels
 * and ids, never full content), no timers, no persistence of its own — it rides
 * the existing browser-log forwarding to /tmp/open-walnut/ via log.warn.
 */

const RING_CAP = 200;
const MAX_SESSIONS = 20;

export interface FlightEntry {
  /** ms since page load (performance.now truncated) — orders entries cheaply. */
  t: number;
  /** Event name (session:text-delta, history:delta, …). */
  ev: string;
  /** Trimmed payload — ids + shape only. */
  d?: Record<string, unknown>;
}

const rings = new Map<string, FlightEntry[]>();

function ring(sid: string): FlightEntry[] {
  let r = rings.get(sid);
  if (!r) {
    r = [];
    rings.set(sid, r);
    // Bound total sessions (LRU by insertion — same policy as session-cache).
    if (rings.size > MAX_SESSIONS) {
      const oldest = rings.keys().next().value;
      if (oldest) rings.delete(oldest);
    }
  }
  return r;
}

function now(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
}

/** Record one pipeline input. `data` should already be trimmed by the caller. */
export function recordFlight(sid: string, ev: string, data?: Record<string, unknown>): void {
  const r = ring(sid);
  r.push({ t: now(), ev, ...(data ? { d: data } : {}) });
  if (r.length > RING_CAP) r.splice(0, r.length - RING_CAP);
}

/** Trim a WS stream event payload to replay-relevant shape (ids, lanes, sizes —
 *  never content: content is in the JSONL; the trace needs ORDER and IDENTITY). */
export function trimStreamEvent(data: unknown): Record<string, unknown> {
  const d = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['msgId', 'parentToolUseId', 'toolUseId', 'toolName', 'subagentType', 'requestId', 'variant']) {
    if (d?.[k] !== undefined) out[k] = d[k];
  }
  if (typeof d?.delta === 'string') out.len = (d.delta as string).length;
  if (typeof d?.result === 'string') out.resultLen = (d.result as string).length;
  return out;
}

/** The full trace for a session (for the tripwire dump). */
export function flightTrace(sid: string): FlightEntry[] {
  return rings.get(sid) ?? [];
}

export function clearFlight(sid: string): void {
  rings.delete(sid);
}
