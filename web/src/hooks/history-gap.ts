/**
 * A hole inside the loaded history, and how it closes.
 *
 * A transcript past the full read's byte ceiling is served as its newest 4 MB.
 * When one turn appends more than the server can reach back through (a run of
 * screenshots, 2026-10-05: up to 37 MB in one turn), the turn-end refetch comes
 * back as a window that shares no row with what the client holds. Swapping it
 * in wiped every earlier reply and left the user's own messages piled under it.
 * Nothing in that window says the held rows are wrong, only that the rows
 * between them are not in hand; so the client keeps both and records the gap,
 * which older pages (`?before=`) then fill from the window's side.
 *
 * A gap is named by the row after it (its key), so it moves with the array when
 * pages are added above or deltas below, and it is gone once that row is.
 */

/** The identity history-merge uses for a row (msgId + timestamp + role). */
type Keyed = { msgId?: string; timestamp?: string; role?: string };

export function gapRowKey(m: Keyed): string | undefined {
  return m.msgId ? `${m.msgId}|${m.timestamp ?? ''}|${m.role ?? ''}` : undefined;
}

export interface HistoryGap {
  /** Key of the first row after the gap. */
  afterKey: string;
  /** Timestamps of the rows on either side (what bubbles and pages are placed by). */
  beforeTs?: string;
  afterTs?: string;
}

/**
 * held ++ incoming with a gap between them, or null when the two cannot be laid
 * end to end: either is empty, they share a row (then they overlap and the
 * ordinary stitch applies), or the window is not later than everything held
 * (history was rewritten, so the held rows are not its past).
 */
export function appendAcrossGap<T extends Keyed>(
  held: readonly T[],
  incoming: readonly T[],
): { messages: T[]; gap: HistoryGap } | null {
  if (held.length === 0 || incoming.length === 0) return null;
  const afterKey = gapRowKey(incoming[0]);
  if (!afterKey) return null;
  const heldKeys = new Set<string>();
  for (const m of held) { const k = gapRowKey(m); if (k) heldKeys.add(k); }
  if (incoming.some((m) => { const k = gapRowKey(m); return k !== undefined && heldKeys.has(k); })) return null;
  const beforeTs = lastTs(held);
  const afterTs = firstTs(incoming);
  if (!beforeTs || !afterTs || afterTs < beforeTs) return null;
  return { messages: [...held, ...incoming], gap: { afterKey, beforeTs, afterTs } };
}

/** Where the gap sits: the index of the row after it, or -1 when it is gone. */
export function gapIndex(messages: readonly Keyed[], gap: HistoryGap): number {
  const at = messages.findIndex((m) => gapRowKey(m) === gap.afterKey);
  return at > 0 ? at : -1;
}

/** The gaps still inside `messages`, with their sides re-read from the rows. */
export function liveGaps(messages: readonly Keyed[], gaps: readonly HistoryGap[] | undefined): HistoryGap[] {
  const out: HistoryGap[] = [];
  for (const gap of gaps ?? []) {
    const at = gapIndex(messages, gap);
    if (at < 0) continue;
    out.push({ afterKey: gap.afterKey, beforeTs: lastTs(messages.slice(0, at)) ?? gap.beforeTs, afterTs: messages[at].timestamp ?? gap.afterTs });
  }
  return out;
}

/**
 * Put one older page (rows strictly older than the gap's after row, oldest
 * first) into the gap. Rows already held are skipped. The gap closes when the
 * page reaches the row before it (a row at or before that time, or one already
 * held) or the start of the file; otherwise it shrinks to before the oldest row
 * the page added.
 */
export function fillGap<T extends Keyed>(
  messages: readonly T[],
  gap: HistoryGap,
  page: readonly T[],
  reachedStart: boolean,
): { messages: T[]; inserted: number; gap: HistoryGap | null } {
  const at = gapIndex(messages, gap);
  if (at < 0) return { messages: messages as T[], inserted: 0, gap: null };
  const beforeTs = lastTs(messages.slice(0, at)) ?? gap.beforeTs ?? '';
  const held = new Set<string>();
  for (const m of messages) { const k = gapRowKey(m); if (k) held.add(k); }
  let reached = reachedStart;
  const fresh: T[] = [];
  for (const m of page) {
    const k = gapRowKey(m);
    const ts = m.timestamp ?? '';
    if ((k && held.has(k)) || (ts && ts < beforeTs)) { reached = true; continue; }
    if (ts === beforeTs && beforeTs) reached = true;
    fresh.push(m);
  }
  // A page with nothing new means nothing is left between the two sides.
  if (fresh.length === 0) reached = true;
  const next = [...messages.slice(0, at), ...fresh, ...messages.slice(at)];
  if (reached) return { messages: next, inserted: fresh.length, gap: null };
  const afterKey = gapRowKey(fresh[0]);
  if (!afterKey) return { messages: next, inserted: fresh.length, gap: null };
  return { messages: next, inserted: fresh.length, gap: { afterKey, beforeTs, afterTs: fresh[0].timestamp } };
}

function firstTs(rows: readonly Keyed[]): string | undefined {
  for (const m of rows) if (m.timestamp) return m.timestamp;
  return undefined;
}

function lastTs(rows: readonly Keyed[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].timestamp) return rows[i].timestamp;
  return undefined;
}
