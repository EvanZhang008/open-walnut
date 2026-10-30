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
 * proof, pure-UI GC only when the whole window matched, and never for a
 * PENDING permission card whatever isStreaming says (2026-09-16: a question
 * asked >5 min before the panel opened was hidden as leftover UI).
 */

import type { StreamingBlock } from '@/stream/stream-reducer';
import { lastMainLaneIndex } from '@/stream/stream-reducer';
import { GROUPABLE_STREAM_TOOLS } from '@/stream/group-blocks';
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
 * Live-tail guard: while streaming, the LAST main-lane text/thinking block is
 * the one still accumulating — its partial content could transiently equal an
 * already-persisted message (and with partial-message streaming its msgId is
 * known before the content finishes). Matching never reaches it; it becomes
 * eligible the moment the turn ends, a newer main-lane block lands, or history
 * holds its whole text under the same msgId. An Agent/Task tail is not guarded
 * (exact-id twin, see below). Trailing
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
  // An Agent/Task tail is never protected: its only match key is the exact
  // toolUseId, and its persisted row is the anchor we WANT on screen (it
  // lazy-loads the transcript and mirrors the ledger's live status). Protecting
  // it kept a streamed Agent card visible for a whole sync subagent run next
  // to the persisted card of the same call (the turn-start refetch lands the
  // row while the Agent is still 'calling' and last in the main lane). Other
  // tool_calls keep the guard: their persisted twin is result-less until the
  // tool returns and would render as finished-with-empty-output.
  const tail = tailIdx >= 0 ? blocks[tailIdx] : undefined;
  const tailIsAgentCall = tail?.type === 'tool_call' && GROUPABLE_STREAM_TOOLS.has(tail.name);
  const liveTail = tailIdx >= (input.completedLen ?? 0) && !tailIsAgentCall ? tailIdx : -1;
  const boundary = liveTail >= 0 ? liveTail : blocks.length;
  const { absorbed, unmatched } = computeAbsorbedIndices(
    blocks, contentDelta as SessionHistoryMessage[], boundary, fullEv, input.finishedAgentIds,
  );
  // The guarded tail is absorbed after all once history holds its whole text
  // under the same msgId, ending on a word boundary: the persisted copy then
  // shows at least what the streamed one does. Without this a turn that wrote
  // its words and then ran a long command showed those words twice until its
  // next block (2026-10-26, a lead's live turn, 20 s and more). A block still
  // growing past its persisted twin no longer matches and shows again (a
  // persisted copy can be partial: the ACP journal appends per chunk), so the
  // failure stays a brief double, never a vanish.
  if (liveTail >= 0 && tailHasPersistedTwin(blocks[liveTail], messages, fullEv)) absorbed.add(liveTail);
  // An explicit retry notice keeps the failed response in its collapsed detail.
  // Hide only its exact main-lane text/thinking twins; never delete or similarity-match.
  const interruptedIds = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== 'system' || block.variant !== 'error' || !block.replacesMsgId || !block.detail) continue;
    interruptedIds.add(block.replacesMsgId);
    // A notice is not an accumulating model tail: its persisted system twin is final.
    if (block.uuid && fullEv.systemMsgIds.has(block.uuid)) absorbed.add(i);
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if ((block.type === 'text' || block.type === 'thinking') && !block.parentToolUseId
      && block.msgId && interruptedIds.has(block.msgId)) absorbed.add(i);
  }
  return { hidden: absorbed, unmatched: unmatched.filter(row => !absorbed.has(row.index)) };
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

function tailHasPersistedTwin(block: StreamingBlock, messages: readonly SessionHistoryMessage[], ev: DeltaEvidence): boolean {
  if ((block.type !== 'text' && block.type !== 'thinking') || block.parentToolUseId || !block.msgId) return false;
  // Cheap exit on every streaming flush: the usual tail has no persisted row yet.
  if (!(block.type === 'text' ? ev.textMsgIds : ev.thinkingMsgIds).has(block.msgId)) return false;
  const mine = squash(block.content ?? '');
  if (!mine) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.msgId !== block.msgId || m.role !== 'assistant') continue;
    // History joins a message's text parts with '\n' (a space once squashed),
    // so a later part is the whole string or follows a space.
    const theirs = squash((block.type === 'text' ? m.text : m.thinking) ?? '');
    return theirs === mine || theirs.endsWith(` ${mine}`);
  }
  return false;
}

/** Convenience: just the hidden set (production code uses computeRenderFilter
 *  directly for the unmatched diagnostics; this wrapper serves tests). */
export function computeHiddenBlocks(input: RenderFilterInput): Set<number> {
  return computeRenderFilter(input).hidden;
}

/** Does what is shown already hold the message that started the stream's turn?
 *  True when the last user or assistant row is a user row, or a bubble (a send,
 *  the launch prompt) stands for it. False for no rows at all. */
export function turnQuestionShown(messages: readonly SessionHistoryMessage[], bubbles: number): boolean {
  if (bubbles > 0) return true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== 'system') return role === 'user';
  }
  return false;
}

/** How many leading stream blocks stay off screen until this session's first
 *  history answer. None once that answer came (`pending` false) or when the rows
 *  shown hold the stream turn's question; else every block, except:
 *  - a live turn's own blocks (from `completedLen` on) once its short wait is
 *    over (`liveOver`), so live output is never hidden for long, while the
 *    finished turn before it still waits for its question;
 *  - a pending permission card and what follows it (`actionAt`, -1 for none):
 *    it waits on the user;
 *  - never more than before: `shownFrom` is the lowest index already drawn, and
 *    a drawn block stays drawn. The longest wait sets it to 0. */
export function firstCheckHeldBelow(s: {
  pending: boolean; questionShown: boolean; blockCount: number;
  streaming: boolean; liveOver: boolean; completedLen: number;
  actionAt: number; shownFrom: number | null;
}): number {
  if (!s.pending || s.questionShown) return 0;
  let below = s.blockCount;
  if (s.streaming && s.liveOver) below = Math.min(below, s.completedLen);
  if (s.actionAt >= 0) below = Math.min(below, s.actionAt);
  if (s.shownFrom !== null) below = Math.min(below, s.shownFrom);
  return Math.max(0, below);
}

/** The blocks to keep off screen: the absorbed ones, and the first `heldBelow`
 *  (see firstCheckHeldBelow). Rendering only: the reset gate keeps reading the
 *  absorbed set, so a held block is never dropped. */
export function withFirstCheckHold(blockCount: number, hidden: Set<number>, heldBelow: number): Set<number> {
  const end = Math.min(heldBelow, blockCount);
  let missing = false;
  for (let i = 0; i < end && !missing; i++) missing = !hidden.has(i);
  if (!missing) return hidden;
  const out = new Set(hidden);
  for (let i = 0; i < end; i++) out.add(i);
  return out;
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
