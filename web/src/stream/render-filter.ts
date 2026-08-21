/**
 * render-filter — NON-DESTRUCTIVE absorption of streaming blocks into history.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLIP (single-timeline refactor)
 * ═══════════════════════════════════════════════════════════════════════════
 * The old model DELETED streaming blocks at turn boundaries, which made
 * correctness depend on ordering ("delete the right blocks at the right moment
 * holding the right evidence"): batch-completed racing session:result, stale
 * completedLen, 5s fallback timers, deferred clears — every new CLI stream
 * format broke one of them (7 same-shape incidents, 2026-06~07).
 *
 * New model: blocks are APPEND-ONLY. Nothing is deleted at a turn boundary.
 * At render time, a block is HIDDEN iff the full current history PROVES it was
 * absorbed (id twin, content twin in the turn window, or finished-background
 * lane). The check is idempotent and order-insensitive — there is no window in
 * which "deleting early" or "deleting wrong" can lose content. Failure inverts:
 * a missed match means a block briefly renders TWICE (next to its history
 * twin) and collapses as soon as evidence lands; it can never vanish.
 *
 * Matching rules live in cache/promote-blocks.ts (computeAbsorbedIndices) —
 * the exact evidence semantics that survived the incident chain: msgId /
 * toolUseId id-first, delta-scoped content multiset + '\n' join-runs,
 * childMessages recursion, thinking-redaction guard, bgTaskFinished lane
 * proof, pure-UI GC only when the whole window matched.
 */

import type { StreamingBlock } from '@/stream/stream-reducer';
import { lastMainLaneIndex } from '@/stream/stream-reducer';
import type { SessionHistoryMessage } from '@/types/session';
import { computeAbsorbedIndices, buildIdOnlyEvidence, type DeltaEvidence } from '@/cache/promote-blocks';

/** ID-ONLY evidence over the full history. Blocks change every animation frame
 *  while streaming but history only changes per fetch — callers should memoize
 *  this by the `messages` reference (whale sessions hold 5000+ messages; the
 *  walk shouldn't run per frame). */
export function buildHistoryEvidence(messages: readonly SessionHistoryMessage[]): DeltaEvidence {
  return buildIdOnlyEvidence(messages as SessionHistoryMessage[]);
}

export interface RenderFilterInput {
  blocks: readonly StreamingBlock[];
  /** FULL current persisted history (id evidence is safe at any scope). */
  messages: readonly SessionHistoryMessage[];
  /** History length when the CURRENT turn started streaming. Content matching
   *  (for id-less blocks) only trusts messages[watermark..] — identical short
   *  texts DO recur across turns, so content evidence must not reach into old
   *  history. 0 = trust everything (mount mid-stream; equals the legacy
   *  first-load behavior where the whole fetch was the delta). */
  watermark: number;
  isStreaming: boolean;
  /** Turn boundary: blocks[0..completedLen) belong to FINISHED turns. The
   *  live-tail guard must not protect those (inc-1786664172811): a resubscribe
   *  right after send adopts a server snapshot holding the PREVIOUS turn's
   *  retained blocks with isStreaming already true for the next turn — without
   *  this floor, the old final text was treated as "still accumulating",
   *  excluded from matching, and rendered as a duplicate below the new bubble
   *  until the next turn's first delta. 0 = everything is current-turn. */
  completedLen?: number;
  /** Prebuilt buildHistoryEvidence(messages) — pass to avoid a full-history
   *  walk per call; rebuilt internally when omitted. */
  historyEvidence?: DeltaEvidence;
  /** Server-transported orphan finished-agent toolUseIds (inc-1786496042099):
   *  NESTED background agents' tool_use lines never reach the canonical JSONL,
   *  so no history row carries their id — the parser ships their
   *  <task-notification> completion proof OUTSIDE the messages array. Counts
   *  as finished-parent lane evidence exactly like bgTaskFinished. */
  finishedAgentIds?: ReadonlySet<string>;
}

export interface RenderFilterResult {
  /** Indices of blocks proven absorbed by history → hidden at render. */
  hidden: Set<number>;
  /** Finished blocks with NO history twin — kept visible (never deleted), but
   *  a persistent occurrence means archive & stream disagree (a real bug the
   *  caller should surface). */
  unmatched: Array<{ index: number; kind: string; reason: string }>;
}

/**
 * Which blocks has history absorbed?
 *
 * Live-tail guard: while streaming, the LAST main-lane block is the one still
 * accumulating — its partial content could transiently equal an already-
 * persisted message (and with partial-message streaming its msgId is known
 * before the content finishes). Matching never reaches it; it becomes eligible
 * the moment the turn ends or a newer main-lane block lands. Trailing
 * subagent-lane blocks after it belong to live background agents — their lane
 * rule (running parent → keep) makes exclusion harmless.
 *
 * The guard only protects a block of the LIVE turn (index >= completedLen).
 * A finished turn's final block can sit last while isStreaming is true — send
 * → markStreaming → resubscribe adopts the old-turn snapshot before the first
 * delta — and protecting it just double-renders proven-absorbed content
 * (inc-1786664172811's "old / new / old" sandwich).
 */
export function computeRenderFilter(input: RenderFilterInput): RenderFilterResult {
  const { blocks, messages, watermark, isStreaming } = input;
  if (blocks.length === 0) return { hidden: new Set(), unmatched: [] };
  // Content evidence: the current turn's window. On shrink (/compact rewrote
  // history to fewer messages) the clamp yields an empty window — content
  // matching pauses (worst case: brief duplicate until the next turn resets
  // the watermark), id matching below is unaffected.
  const contentDelta = messages.slice(Math.min(Math.max(watermark, 0), messages.length));
  const fullEv = input.historyEvidence ?? buildHistoryEvidence(messages);
  const tailIdx = isStreaming ? lastMainLaneIndex(blocks) : -1;
  const liveTail = tailIdx >= (input.completedLen ?? 0) ? tailIdx : -1;
  const boundary = liveTail >= 0 ? liveTail : blocks.length;
  const { absorbed, unmatched } = computeAbsorbedIndices(
    blocks, contentDelta as SessionHistoryMessage[], boundary, fullEv, input.finishedAgentIds,
  );
  return { hidden: absorbed, unmatched };
}

/** Convenience: just the hidden set (production code uses computeRenderFilter
 *  directly for the unmatched diagnostics; this wrapper serves tests). */
export function computeHiddenBlocks(input: RenderFilterInput): Set<number> {
  return computeRenderFilter(input).hidden;
}

/** True when every block is absorbed — the safe moment for the OPTIONAL
 *  physical reset (pure memory reclamation): nothing from blocks[] is visible,
 *  so dropping the array has zero rendered difference. Never reset while
 *  streaming (the live turn appends next frame).
 *
 *  Expect this to stay false indefinitely for turns whose thinking was
 *  redacted from history: those blocks are kept visible BY DESIGN (the
 *  streamed copy is the only surviving one), so the reset never fires and the
 *  array persists until session switch. That is not a leak — do not "fix" it
 *  by loosening the thinking match (that re-introduces the vanish bug). */
export function allBlocksAbsorbed(
  blocks: readonly StreamingBlock[],
  hidden: Set<number>,
  isStreaming: boolean,
): boolean {
  return !isStreaming && blocks.length > 0 && hidden.size === blocks.length;
}
