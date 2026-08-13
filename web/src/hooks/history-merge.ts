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
