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
 * Keep what the reader loaded ABOVE a fresh windowed tail. The incoming head is
 * looked up in what is held: found means the two touch, so the held rows before
 * it are the tail's true predecessors and stay; not found (the window slid past
 * everything held, or history was rewritten) means the gap is unknown and the
 * tail stands alone, which only costs a click on "Load earlier".
 */
export function stitchHeldOlder<T extends RowIdentity>(held: readonly T[], incoming: readonly T[]): T[] {
  const head = incoming.length > 0 ? rowKey(incoming[0]) : undefined;
  if (!head) return incoming as T[];
  const at = held.findIndex((m) => rowKey(m) === head);
  return at > 0 ? [...held.slice(0, at), ...incoming] : incoming as T[];
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
 * Fold a FULL payload into the array the client will hold. A non-windowed payload
 * is the whole answer. A windowed one is only the server's tail, so the older
 * pages already loaded stay above it, and the cursor (a count of the array the
 * client holds, which the next anchored delta extends) grows by their length.
 * `kept` is how many older rows stayed above the tail.
 */
export function foldFullPayload<T extends RowIdentity>(
  held: readonly T[],
  result: { messages: T[]; cursor?: number; windowed?: boolean },
): { messages: T[]; cursor: number; kept: number } {
  const cursor = result.cursor ?? result.messages.length;
  if (!result.windowed) return { messages: result.messages, cursor, kept: 0 };
  const messages = stitchHeldOlder(held, result.messages);
  const kept = messages.length - result.messages.length;
  return { messages, cursor: cursor + kept, kept };
}
