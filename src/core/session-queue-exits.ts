/**
 * Every row that leaves the session message queue unsent leaves a step in the delivery ledger
 * (sessions/delivery-ledger.ts, from SESSION_QUEUE_LEFT), told where the queue file is written
 * (session-queue-store.ts persist), so no way out can skip it (2026-11-25, the Reflection VP's audit: 12 messages read
 * `parked` for 31 to 39 hours and 3 `queued` for up to 44 hours, all long gone from the queue; a
 * Discard, a cleanup, a fold or a move took them out and none of those ways wrote a step).
 *
 * A row that leaves while `processing` is in its session's hands: its delivery records its own steps
 * (`written`, `read`), so it is not recorded here, unless the way that took it out named its step
 * (noteQueueExit). A row that went to another session's queue (an id that changed, an engine switch
 * through its transit) is recorded `queued` there; a row taken into a transit has not left, and a
 * host hand its host took is the host's to record. Any other row that left is `removed`, with what it was, unless its way
 * out named another step (a retired park: `dropped`; a line the CLI said it took: `read`).
 * Ratchet: tests/core/sessions/delivery-ledger-facts-ratchet.test.ts.
 */
import type { QueuedMessage, QueueStore } from './session-queue-store.js';
import type { SessionQueueLeftEvent } from './event-types.js';

/**
 * Where each row was, by id: its session, its status, why it was parked, and `transit` for a row on
 * its way between queues (session-queue-transit.ts: an engine switch's or a host hand's), kept under
 * the session it was taken from.
 */
export type RowPlaces = Map<string, { sid: string; status: QueuedMessage['status']; parkedReason?: string; transit?: 'switch' | 'host' }>;

export function placesOf(s: QueueStore): RowPlaces {
  const out: RowPlaces = new Map();
  for (const t of Object.values(s.transit ?? {})) {
    for (const m of t.rows ?? []) out.set(m.id, { sid: t.from, status: m.status, transit: t.kind });
  }
  // A row in a queue is where it is, whatever a transit also names.
  for (const [sid, rows] of Object.entries(s.queues)) {
    for (const m of rows ?? []) out.set(m.id, { sid, status: m.status, ...(m.parkedReason ? { parkedReason: m.parkedReason } : {}) });
  }
  return out;
}

/** `silent`: the way out says nothing of it (a host giving back a line its leader delivers itself). */
export type ExitStep = 'removed' | 'dropped' | 'read' | 'written' | 'silent';
export type ExitNote = { step: ExitStep; why?: string; via?: string };
export interface QueueExit { step: Exclude<ExitStep, 'silent'> | 'queued'; id: string; sessionId: string; why?: string; via?: string }

/** Steps the way out named, by row id, for the next write that takes the row out. */
const named = new Map<string, ExitNote>();
const NAMED_MAX = 2_000;

/**
 * Called INSIDE the queue mutation that takes `id` out, only for a row it does take out: the step the
 * ledger records for it. A note for a row the write left in place is forgotten after that write.
 */
export function noteQueueExit(id: string, step: ExitStep, opts?: { why?: string; via?: string }): void {
  if (named.size >= NAMED_MAX) named.clear();
  named.set(id, { step, ...(opts?.why ? { why: opts.why.slice(0, 200) } : {}), ...(opts?.via ? { via: opts.via } : {}) });
}

/** The exits between two states of the store (before a write, after it). Pure but for the named steps it consumes. */
export function exitsBetween(was: RowPlaces, now: QueueStore): QueueExit[] {
  const after = placesOf(now);
  const out: QueueExit[] = [];
  for (const [id, before] of was) {
    const at = after.get(id);
    if (at) {
      // Into a transit is not an exit; out of one, or straight, into another session's queue is a move.
      if (!at.transit && at.sid !== before.sid) out.push({ step: 'queued', id, sessionId: at.sid, why: `moved from session ${before.sid}` });
      continue;
    }
    const step = named.get(id);
    named.delete(id);
    if (step?.step === 'silent') continue;
    // In its delivery's hands, or a host hand its host took (the host records its steps): not an exit here.
    if (!step && (before.status === 'processing' || before.transit === 'host')) continue;
    const what = before.status === 'parked' && before.parkedReason ? `parked: ${before.parkedReason}` : before.status;
    out.push({ step: step?.step ?? 'removed', id, sessionId: before.sid, why: (step?.why ?? `left the queue unsent (it was ${what})`).slice(0, 200), ...(step?.via ? { via: step.via } : {}) });
  }
  // A note for a row this write left where it was (a recheck under the lock kept it) is not for a later write.
  for (const id of [...named.keys()]) if (after.has(id)) named.delete(id);
  return out;
}

/**
 * Tell the exits a write made (after it reached the disk), one event per session. An event, not a
 * ledger write: a host's queue (a host that judges its sessions) reaches its leader's ledger only as
 * a channel fact (session-channel/event-classes.ts). Never throws.
 */
export function recordQueueExits(exits: readonly QueueExit[]): void {
  if (exits.length === 0) return;
  const bySession = new Map<string, SessionQueueLeftEvent>();
  for (const e of exits) {
    const ev = bySession.get(e.sessionId) ?? { sessionId: e.sessionId, messageIds: [], exits: {} };
    ev.messageIds.push(e.id);
    ev.exits[e.id] = { step: e.step, ...(e.why ? { why: e.why } : {}), ...(e.via ? { via: e.via } : {}) };
    bySession.set(e.sessionId, ev);
  }
  void import('./event-bus.js').then(({ bus, EventNames }) => {
    for (const ev of bySession.values()) {
      try { bus.emit(EventNames.SESSION_QUEUE_LEFT, ev, ['main-ai'], { source: 'session-queue' }); } catch { /* best effort */ }
    }
  }).catch(() => {});
}

export function _resetQueueExitsForTesting(): void {
  named.clear();
}
