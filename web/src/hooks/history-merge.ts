/**
 * planDeltaMerge — THE single copy of "fold a history delta response into what
 * the client already holds".
 *
 * Two mirrors used to implement this independently: useSessionHistory's delta
 * branch and session-cache's deltaRefreshHistory. They had already drifted —
 * the hook gained the identity-overlap guard (the one that actually bites) and
 * revision application, while the cache path still had only the length check
 * that proved WORTHLESS in production (tautologically satisfied while a whale
 * session's sliding window dropped the newest messages for two days with zero
 * mismatch logs — inc-1785993576822). One drifted mirror is exactly how this
 * bug family survives fixes, so the fold is now a pure function both callers
 * share. The chat lab (tests/web/chat-lab/) replays production traces through
 * THIS function — not a reimplementation — so a lab pass means the shipped
 * merge logic is what was proven.
 *
 * Outcomes:
 *  · merged     — adopt `messages` (revisions folded in, delta appended)
 *  · unchanged  — nothing new and no revision applied (skip the re-render)
 *  · rebuild    — the delta cannot be applied losslessly; the caller must
 *                 re-fetch the FULL history. Every ambiguous case lands here:
 *                 re-sending history costs bandwidth, dropping a message costs
 *                 the user their conversation.
 */

import type { SessionHistoryMessage } from '@/types/session';
import { applyRevisedMessages } from './history-anchor';
import { appendAcrossGap, gapIndex, liveGaps, type HistoryGap } from './history-gap';

export interface DeltaResultLike {
  messages: SessionHistoryMessage[];
  /** Fresh copies of prefix rows the client re-asked for (unsettled loop). */
  revisedMessages?: SessionHistoryMessage[];
  cursor?: number;
}

export type DeltaMergeOutcome =
  | { kind: 'unchanged'; cursor: number }
  | { kind: 'merged'; messages: SessionHistoryMessage[]; cursor: number }
  | { kind: 'rebuild'; reason: string };

export function planDeltaMerge(
  base: readonly SessionHistoryMessage[],
  result: DeltaResultLike,
  currentCursor: number,
  opts?: {
    /** Messages hidden BEFORE base[0] (lazy tail load: base is the last N of a
     *  longer history, cursor space counts them all). The length guard compares
     *  `merged.length + baseOffset` against the cursor. MUST be tracked
     *  explicitly at adoption time — deriving it here as `cursor - base.length`
     *  would make the guard tautological, which is exactly how the sliding-
     *  window bug stayed invisible (inc-1785993576822). */
    baseOffset?: number;
  },
): DeltaMergeOutcome {
  const baseOffset = opts?.baseOffset ?? 0;
  // Revised prefix rows replace BY IDENTITY first, so the append below builds
  // on the corrected array (a late bgTaskFinished / tool result — the frozen-
  // prefix bug, inc-1785965937858).
  const withRevisions = applyRevisedMessages(base, result.revisedMessages) as SessionHistoryMessage[];
  const revisedApplied = withRevisions !== base;

  if (result.messages.length === 0) {
    // Empty delta = nothing new yet (archive lagging). Cursor still advances —
    // and a revision-only response must still be adopted, or the corrected row
    // is dropped exactly where the fix matters.
    const cursor = result.cursor ?? currentCursor;
    return revisedApplied
      ? { kind: 'merged', messages: withRevisions, cursor }
      : { kind: 'unchanged', cursor };
  }

  const merged = [...withRevisions, ...result.messages];

  // Consistency guards against duplication/loss. Two independent checks,
  // because the length check alone proved WORTHLESS in production:
  //
  //  (a) IDENTITY OVERLAP — any delta message whose msgId we ALREADY hold means
  //      the split point was wrong. Appending would render that message twice
  //      ("compact still shows old messages below"). This is the check that
  //      actually bites: it compares content identity, not counts.
  //  (b) length vs cursor — kept, but understand its limit: cursor is derived
  //      from the same `since` we sent, so it fires only when our own cursor
  //      drifted from our own array. It is structurally BLIND to a server-side
  //      index shift (inc-1785993576822). Do not treat a silent guard as a
  //      healthy one.
  const baseIds = new Set<string>();
  for (const m of withRevisions) if (m.msgId) baseIds.add(m.msgId);
  const overlap = result.messages.find(m => m.msgId && baseIds.has(m.msgId));
  if (overlap) return { kind: 'rebuild', reason: `overlap:${overlap.msgId}` };

  const expected = result.cursor ?? (merged.length + baseOffset);
  if (result.cursor != null && merged.length + baseOffset !== expected) {
    return { kind: 'rebuild', reason: `length:${merged.length}+${baseOffset}!=${expected}` };
  }

  return { kind: 'merged', messages: merged, cursor: result.cursor ?? (merged.length + baseOffset) };
}

// ── Older pages of a windowed transcript ─────────────────────────────────────
// A transcript past the full read's byte ceiling is served as a sliding tail
// (`windowed`), and its older part is paged in on request. Those pages live in
// the same array as the tail, so two rules keep the array honest: a fresh tail
// REPLACES the server's window but must not throw away pages the reader already
// loaded above it, and pages only join the array where the two provably touch.

type RowIdentity = { msgId?: string; timestamp?: string; role?: string };

/** One parsed row's identity. A message split across the seam of two windows
 *  shares its msgId but not its timestamp, so the pair tells the halves apart. */
function rowKey(m: RowIdentity): string | undefined {
  return m.msgId ? `${m.msgId}|${m.timestamp ?? ''}|${m.role ?? ''}` : undefined;
}

/**
 * Keep what the reader loaded ABOVE a fresh windowed tail. The first incoming row that is
 * also held marks where the two touch: the held rows before it are the tail's true
 * predecessors and stay. No incoming row held (the window slid past everything held, or
 * history was rewritten) means the gap is unknown and the tail stands alone, which only
 * costs a click on "Load earlier".
 *
 * The match is not only the head (2026-11-17: an open of a 49 MB session showed 207 rows, its
 * full read answered a 126-row window and the 81 rows above it vanished). A message the
 * window's start cuts through is parsed from its later lines only, so the tail's head row
 * carries another timestamp than the held one: its key is held nowhere. Rows of the tail
 * before the first match are those halves; held rows of the same messages just above the
 * match give way to them, so nothing shows twice.
 */
export function stitchHeldOlder<T extends RowIdentity>(held: readonly T[], incoming: readonly T[]): T[] {
  if (held.length === 0 || incoming.length === 0) return incoming as T[];
  const heldAt = new Map<string, number>();
  held.forEach((m, i) => { const k = rowKey(m); if (k && !heldAt.has(k)) heldAt.set(k, i); });
  for (let j = 0; j < incoming.length; j++) {
    const k = rowKey(incoming[j]);
    const at = k ? heldAt.get(k) : undefined;
    if (at === undefined) continue;
    const headIds = new Set(incoming.slice(0, j).map((m) => m.msgId).filter((id): id is string => !!id));
    let cut = at;
    while (cut > 0 && headIds.has(held[cut - 1].msgId ?? '')) cut--;
    return cut > 0 ? [...held.slice(0, cut), ...incoming] : incoming as T[];
  }
  return incoming as T[];
}

export function mergeHistoryBackfill<T extends RowIdentity>(held: readonly T[], incoming: T[]): T[] {
  const head = held[0] && rowKey(held[0]);
  const seam = head ? incoming.findIndex(m => rowKey(m) === head) : -1;
  if (seam < 0) return held as T[];
  const heldByKey = new Map(held.flatMap(m => { const key = rowKey(m); return key ? [[key, m] as const] : []; }));
  const merged = incoming.map(m => heldByKey.get(rowKey(m) ?? '') ?? m);
  const lastKey = incoming.at(-1) && rowKey(incoming.at(-1)!);
  const lastAt = lastKey ? held.findIndex(m => rowKey(m) === lastKey) : -1;
  return lastAt >= 0 ? [...merged, ...held.slice(lastAt + 1)] : merged;
}

/** Add one older page above what is held. Rows already held are skipped, so a
 *  page fetched twice cannot double a row. */
export function prependOlderPage<T extends RowIdentity>(held: readonly T[], page: readonly T[]): T[] {
  const have = new Set<string>();
  for (const m of held) { const k = rowKey(m); if (k) have.add(k); }
  const fresh = page.filter((m) => { const k = rowKey(m); return !k || !have.has(k); });
  return fresh.length === 0 ? held as T[] : [...fresh, ...held];
}

/**
 * How many messages the source holds, from a payload's own numbers: its `cursor`
 * (the count the next delta extends) when it has one, else its `total`. Phase 1
 * (the streams read) carries only `total` on the Mac, where nothing changes; a
 * host replica's copy answers both reads with its own `cursor`, so the older-
 * messages hint counts what the copy can serve, not rows only the Mac can page.
 */
export function sourceCountOf(result: { cursor?: number; total?: number }): number | undefined {
  return result.cursor ?? result.total;
}

/**
 * Fold a FULL payload into the array the client will hold. A non-windowed payload
 * is the whole answer. A windowed one is only the server's tail, so the older
 * pages already loaded stay above it, and the cursor (a count of the array the
 * client holds, which the next anchored delta extends) grows by their length.
 * `kept` is how many older rows stayed above the tail.
 *
 * `acrossGap`: a window that shares no row with what is held but is provably
 * later (one turn outgrew what the server can reach back through) goes AFTER the
 * held rows with a gap between them, instead of replacing them (history-gap.ts).
 * Off for a held array that is not the transcript's own parse (the streams file
 * of Phase 1). `gaps` are the gaps already in `held`; the result says which
 * survive: none in a complete payload, and none inside the contiguous window.
 */
/**
 * A payload's fork boundary in the array the client holds after a fold. The server counts it
 * from the payload's first row; a fold that kept `kept` older rows above the payload (a windowed
 * payload over held rows: Phase 1's view, cached rows, earlier pages) moves it down by them.
 * Every boundary the hook stores goes through here (tests/web/history-fork-boundary-shift.test.ts).
 */
export function shiftedForkBoundary(boundary: number | undefined, kept: number): number | undefined {
  return boundary == null ? undefined : boundary + Math.max(0, kept);
}

export function foldFullPayload<T extends RowIdentity>(
  held: readonly T[],
  result: { messages: T[]; cursor?: number; windowed?: boolean },
  opts?: { acrossGap?: boolean; gaps?: readonly HistoryGap[] },
): { messages: T[]; cursor: number; kept: number; gaps: HistoryGap[] } {
  const cursor = result.cursor ?? result.messages.length;
  if (!result.windowed) return { messages: result.messages, cursor, kept: 0, gaps: [] };
  const messages = stitchHeldOlder(held, result.messages);
  const kept = messages.length - result.messages.length;
  if (kept > 0) {
    // A gap at or above the window's head is still open; one inside it is not.
    const gaps = liveGaps(messages, opts?.gaps).filter((g) => gapIndex(messages, g) <= kept);
    return { messages, cursor: cursor + kept, kept, gaps };
  }
  const across = opts?.acrossGap ? appendAcrossGap(held, result.messages) : null;
  if (across) {
    return {
      messages: across.messages,
      cursor: cursor + held.length,
      kept: held.length,
      gaps: [...liveGaps(held, opts?.gaps), across.gap],
    };
  }
  return { messages, cursor, kept: 0, gaps: [] };
}

/**
 * A cached copy is behind the server's screen when the screen's newest row is not in it. The
 * open then shows the screen, not the copy (2026-11-17: an IndexedDB copy 5 h old won the race at
 * 77 ms; its last 75 rows were machine turns folded out of sight, so the chat showed nothing for
 * 5.8 s while the click's own screen, answered in 5 ms, went unused).
 */
export function cacheBehindScreen(cached: readonly RowIdentity[], screen: readonly RowIdentity[]): boolean {
  const newest = [...screen].reverse().find((m) => m.msgId)?.msgId;
  return !!newest && !cached.some((m) => m.msgId === newest);
}
