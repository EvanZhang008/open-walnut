/**
 * A trigger's audit trail: what every check decided, and for a fire, what was
 * delivered where.
 *
 * Why it exists: `state.lastCheck` is ONE snapshot, so a trigger that fired at
 * 09:04 and has been quiet since looks — three hours later, from the UI — exactly
 * like a trigger that never ran. The user's question ("not sure if this works,
 * I don't see how it triggered, what got injected?") is unanswerable from a
 * single field, and answering it by grepping a daemon log is not a product.
 *
 * TWO bounded lists rather than one, because they answer different questions and
 * one would starve the other: a 30s trigger produces 120 quiet checks an hour, so
 * a single list of 20 loses every fire within ten minutes.
 *  - `checkLog` — the last N checks of ANY outcome: proof the clock is alive and
 *    where the errors are.
 *  - `fireLog` — the last N fires with the delivery result and a preview of the
 *    exact text the session received: the answer to "what did it inject".
 *
 * Everything here is pure so the shape is pinned by unit tests, and so the
 * append happens inside the same locked persist the check already does (no extra
 * write per check).
 */

import type { TriggerAuditEntry, TriggerAuditDelivery } from './types.js';

/** Recent activity: ~2 minutes at the 10s floor, hours at a sane cadence. */
export const TRIGGER_CHECK_LOG_MAX = 12;
/** Fires are rare and are the thing being audited, so they get their own depth. */
export const TRIGGER_FIRE_LOG_MAX = 10;
/**
 * How much of the delivered message the audit keeps. Long enough to recognise
 * the prompt and the first item, short enough that ten of them do not turn
 * cron-jobs.json into a transcript store — the session itself holds the full
 * text, and this preview is what tells you WHICH message to go read.
 */
export const INJECTED_PREVIEW_CAP = 600;

/** Newest first, bounded. Never mutates the input (the store may be shared). */
export function appendAudit(
  list: TriggerAuditEntry[] | undefined,
  entry: TriggerAuditEntry,
  max: number,
): TriggerAuditEntry[] {
  const base = Array.isArray(list) ? list : [];
  return [entry, ...base].slice(0, Math.max(1, max));
}

/** The preview, flattened and clamped, with the total length kept separately. */
export function injectedPreview(text: string): { chars: number; preview: string } {
  const chars = text.length;
  const flat = text.replace(/\r/g, '');
  if (flat.length <= INJECTED_PREVIEW_CAP) return { chars, preview: flat };
  let cut = flat.slice(0, INJECTED_PREVIEW_CAP);
  // Never end on a lone high surrogate. Slicing UTF-16 units splits an astral
  // character (an emoji in a delivered item, a rare CJK glyph) in half, and the
  // half then rides into cron-jobs.json - strict JSON readers reject a lone
  // surrogate and the whole file stops parsing, which has cost this repo a real
  // incident before. Same reason sessionHandle caps by code point.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { chars, preview: `${cut}…` };
}

/**
 * A fire's delivery, as the audit records it. `retrying` is deliberately its own
 * status and not an error: the fire is still owned by the daemon (unacked) and
 * will be delivered again, so calling it a failure would be a lie the user then
 * acts on.
 */
export function auditDelivery(input: {
  status: 'ok' | 'error';
  retry: boolean;
  summary?: string;
  error?: string;
  sessionId?: string;
}): TriggerAuditDelivery {
  return {
    status: input.retry ? 'retrying' : input.status,
    ...(input.summary ? { summary: clampStored(input.summary) } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.error ? { error: clampStored(input.error) } : {}),
  };
}

/**
 * Bound on the delivery strings the audit stores. The executor's summary and a
 * failure's message are not produced by this module: a summary names a session
 * whose title is arbitrary, and an error can carry a subprocess's whole stderr.
 * Ten fire rows holding tens of KB each would turn the cron store into a log.
 */
export const AUDIT_TEXT_CAP = 200;

/** One line, clamped, never ending on half an astral character. */
function clampStored(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= AUDIT_TEXT_CAP) return flat;
  const cut = flat.slice(0, AUDIT_TEXT_CAP);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
}

/** Drop undefined-valued keys so a stored entry has no noise in it. */
function compact(entry: TriggerAuditEntry): TriggerAuditEntry {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(entry)) {
    if (v !== undefined) out[k] = v;
  }
  return out as TriggerAuditEntry;
}

export function checkedAuditEntry(input: {
  atMs: number;
  outcome: 'quiet' | 'error';
  reason?: TriggerAuditEntry['reason'];
  durationMs?: number;
  error?: string;
}): TriggerAuditEntry {
  return compact({
    atMs: input.atMs,
    outcome: input.outcome,
    reason: input.reason,
    durationMs: input.durationMs,
    error: input.error,
  });
}

export function firedAuditEntry(input: {
  atMs: number;
  seq: number;
  items: number;
  durationMs?: number;
  error?: string;
  /** The caller's authoritative attempt number for THIS fire (state.fireRetry). */
  attempts?: number;
  delivery: TriggerAuditDelivery;
  injected?: { chars: number; preview: string };
}): TriggerAuditEntry {
  return compact({
    atMs: input.atMs,
    outcome: 'fired',
    seq: input.seq,
    items: input.items,
    durationMs: input.durationMs,
    error: input.error,
    attempts: input.attempts !== undefined && input.attempts > 1 ? input.attempts : undefined,
    delivery: input.delivery,
    injected: input.injected,
  });
}

/**
 * A WAKE-fired run's audit line: the routine ran because enough events arrived.
 *
 * Same row shape as a trigger's fire so one list reads uniformly, minus the
 * daemon's (epoch, seq) — a wake fire is counted by this server, has no daemon
 * sequence, and is never replayed, so there are no attempts to fold. `items` is
 * the counter value the dispatch observed, which is exactly what the run
 * consumed. It exists for the same reason the trigger trail does: without it, a
 * run woken by 20 new items is indistinguishable from the clock's own tick, and
 * nothing records what was injected.
 */
export function wakeAuditEntry(input: {
  atMs: number;
  items: number;
  durationMs?: number;
  error?: string;
  delivery: TriggerAuditDelivery;
  injected?: { chars: number; preview: string };
}): TriggerAuditEntry {
  return compact({
    atMs: input.atMs,
    outcome: 'fired',
    items: input.items,
    durationMs: input.durationMs,
    error: input.error,
    delivery: input.delivery,
    injected: input.injected,
  });
}

/**
 * Fold a RUN'S OUTCOME into the row that recorded its dispatch, or append it.
 *
 * Why this is not just `appendAudit`: a run has two moments and they are learned
 * by two different layers. The dispatch row is written by applyJobResult the
 * instant the executor returned ("fired, 22 items, a session was started"); how
 * the run actually ENDED is only known later, by whoever watches the session
 * (src/core/triage/runs.ts). Appending would make one run read as two fires —
 * exactly the confusion this trail exists to remove — so the outcome merges into
 * the newest fired row when that row belongs to this run, and is appended when
 * there is none (a clock-driven run writes no dispatch row at all, because
 * applyJobResult only logs a fire when a wake counter was consumed).
 *
 * `ref` is what makes "belongs to this run" decidable, and it is deliberately an
 * identity rather than a time window: two runs of the same routine can start
 * inside a minute of each other, so "the newest row, recently" would hand run 1's
 * verdict to run 2's row. An executor that starts a session puts the task id in
 * its dispatch summary, so the row that names THIS run's task is the row to
 * update; anything else appends. The OLD row is spread first so its `injected`
 * preview survives an outcome that carries none.
 */
export function mergeRunOutcome(
  list: TriggerAuditEntry[] | undefined,
  entry: TriggerAuditEntry,
  ref: string,
  max: number,
): TriggerAuditEntry[] {
  const base = Array.isArray(list) ? list : [];
  const at = ref
    ? base.findIndex((e) => e.outcome === 'fired' && (e.delivery?.summary ?? '').includes(ref))
    : -1;
  if (at < 0) return appendAudit(base, entry, max);
  const merged = [...base];
  merged[at] = {
    ...base[at],
    ...entry,
    // The dispatch knew the real batch size and the text it sent; an outcome that
    // counted neither must not overwrite them with nothing.
    items: entry.items ?? base[at].items,
    delivery: entry.delivery ?? base[at].delivery,
    injected: entry.injected ?? base[at].injected,
  };
  return merged.slice(0, Math.max(1, max));
}

/**
 * Fold a fire's later attempt into the entry it belongs to instead of appending a
 * second row. A transient delivery failure is replayed by the daemon about once a
 * minute, so three attempts of ONE fire would otherwise read as three fires —
 * exactly the confusion this trail exists to remove. Matched on (epoch, seq)
 * carried by the caller: same fire, updated verdict.
 */
export function mergeFireAttempt(
  list: TriggerAuditEntry[] | undefined,
  entry: TriggerAuditEntry,
  max: number,
): TriggerAuditEntry[] {
  const base = Array.isArray(list) ? list : [];
  const at = base.findIndex((e) => e.outcome === 'fired' && e.seq === entry.seq && (e.epoch ?? '') === (entry.epoch ?? ''));
  if (at < 0) return appendAudit(base, entry, max);
  const merged = [...base];
  // Spread the OLD row first: a later attempt that failed before building the
  // envelope carries no injected preview, and dropping the one attempt 1 did
  // record would lose the answer to "what was it trying to send".
  merged[at] = {
    ...base[at],
    ...entry,
    attempts: entry.attempts ?? (base[at].attempts ?? 1) + 1,
  };
  return merged.slice(0, Math.max(1, max));
}
