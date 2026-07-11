/**
 * Evidence-based turn promotion.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * At a turn boundary the same content lives in two places:
 *   1. streaming blocks[] — what the user watched generate live (WS deltas)
 *   2. the freshly-arrived delta of persisted history messages[]
 * We must remove the streaming copies so they don't render twice — but ONLY the
 * ones the archive has actually caught up on. The old code cleared by POSITION
 * (`blocks.slice(completedLen)`), which trusted a bookkeeping counter. When that
 * counter was wrong (batch-completed racing session:result, a stale snapshot),
 * it silently deleted live content → the "messages vanish" bug.
 *
 * This module deletes by EVIDENCE instead: a streaming block is removed only if
 * a twin is found in the delta that just arrived. No twin → keep it (it will be
 * promoted on a later delta, or garbage-collected as a pure-UI block). The worst
 * case is a block shown twice for a moment, never a block that disappears.
 *
 * Matching keys (cheap, in priority order):
 *   · tool_call    → toolUseId (both sides carry Claude's `toolu_…`; exact)
 *   · text/thinking→ msgId (ACP dialect: both sides carry the API `msg_…` id —
 *                    the persisted message with that id SUPERSEDES every
 *                    streaming block stamped with it, regardless of content
 *                    divergence from truncation / '\n'-joins / path rewriting)
 *   · text/thinking→ verbatim content equality — fallback for id-less blocks
 *                    (legacy events, snapshots taken before id threading)
 * Pure-UI blocks that never appear in JSONL (permission cards, system notices)
 * have no possible twin — they are collected separately, and only for turns whose
 * matchable content fully matched (so we never GC a UI block of a live turn).
 *
 * TWO EVIDENCE SCOPES (inc-1783612454903: "last message is not the last one"):
 * the `delta` covers only the NEWEST history increment, so a block whose twin
 * persisted in an OLDER turn can never match it — in long sessions those
 * leftovers accumulated (309 blocks, 226 unmatched) and rendered below the real
 * last message forever. Callers therefore also pass the FULL history as a
 * second, ID-ONLY evidence source: msgId/toolUseId presence anywhere in history
 * promotes a block (ids are globally unique — no cross-turn coincidence risk),
 * while verbatim-content fallback stays delta-scoped (identical short texts DO
 * recur across turns; matching them against all of history would wrongly claim
 * an old twin for a new block).
 *
 * BACKGROUND-SUBAGENT LANE (same incident, the bulk of the 226): blocks with
 * parentToolUseId stream from an async Agent whose transcript persists to a
 * SEPARATE subagents/agent-<id>.jsonl — their twins never appear in THIS
 * session's history, so twin-evidence is structurally impossible. Their
 * archival proof is different: the CLI injects a <task-notification> user line
 * (hidden from chat) when the agent stops; the parser stamps the parent
 * Agent/Task tool with bgTaskFinished. A lane block whose parent is finished
 * is promoted (its content stays viewable via the Agent box, which lazy-loads
 * the subagent transcript); a lane block whose parent is still running is kept
 * SILENTLY (live background agent — not a divergence bug, so it is neither
 * logged as unmatched nor allowed to block pure-UI GC).
 */

import type { StreamingBlock } from '@/stream/stream-reducer';
import type { SessionHistoryMessage } from '@/types/session';

/** Build the set of evidence keys present in a batch of persisted messages. */
export interface DeltaEvidence {
  toolUseIds: Set<string>;
  /** Multiset of text/thinking contents (a value = remaining count still claimable). */
  texts: Map<string, number>;
  /** msgIds of delta messages carrying text. A SET, not a multiset: one message
   *  id may claim MANY streaming blocks (text split across tool calls streams as
   *  several blocks of the same msgId; history collapses them into one message). */
  textMsgIds: Set<string>;
  /** msgIds of delta messages carrying thinking. Separate from textMsgIds so a
   *  thinking block is only id-removed when history actually PRESERVED thinking
   *  (it is frequently redacted) — otherwise id-removal would vanish the
   *  streamed reasoning with no persisted replacement to render. */
  thinkingMsgIds: Set<string>;
  /** toolUseIds of Agent/Task tools whose BACKGROUND run has finished (parser
   *  stamped bgTaskFinished from the <task-notification> line). A subagent-lane
   *  block whose parentToolUseId is here is archived-elsewhere → promotable. */
  finishedBgParents: Set<string>;
}

export function buildDeltaEvidence(delta: SessionHistoryMessage[]): DeltaEvidence {
  const toolUseIds = new Set<string>();
  const texts = new Map<string, number>();
  const textMsgIds = new Set<string>();
  const thinkingMsgIds = new Set<string>();
  const finishedBgParents = new Set<string>();
  const bump = (s: string | undefined) => {
    if (!s) return;
    texts.set(s, (texts.get(s) ?? 0) + 1);
  };
  // Recurses into tools[].childMessages: history grouping (groupInlineChildren)
  // moves inline-subagent messages OUT of the flat list and under their parent
  // Agent/Task tool. Without walking them, streamed subagent blocks never find
  // a twin and are kept forever ("98 completed block(s) had no delta twin").
  const walk = (msgs: SessionHistoryMessage[]) => {
    for (const m of msgs) {
      if (m.role === 'system') continue; // UI notices — never a streamed-block twin
      if (m.text) bump(m.text);
      if (m.thinking) bump(m.thinking);
      if (m.msgId && m.text) textMsgIds.add(m.msgId);
      if (m.msgId && m.thinking) thinkingMsgIds.add(m.msgId);
      if (m.tools) {
        for (const t of m.tools) {
          if (t.toolUseId) toolUseIds.add(t.toolUseId);
          if (t.toolUseId && t.bgTaskFinished) finishedBgParents.add(t.toolUseId);
          if (t.childMessages?.length) walk(t.childMessages);
        }
      }
    }
  };
  walk(delta);
  return { toolUseIds, texts, textMsgIds, thinkingMsgIds, finishedBgParents };
}

/** ID-ONLY evidence over the FULL history (terminal-state cleanup). Content
 *  multiset deliberately left EMPTY: identical short texts recur across turns,
 *  so content-matching against all of history could claim an old twin for a
 *  new block. Ids are globally unique — safe at any scope. */
export function buildIdOnlyEvidence(messages: SessionHistoryMessage[]): DeltaEvidence {
  const ev = buildDeltaEvidence(messages);
  ev.texts = new Map();
  return ev;
}

/** Try to claim a text/thinking block's content from the multiset (consumes one). */
function claimText(ev: DeltaEvidence, content: string): boolean {
  const n = ev.texts.get(content);
  if (n && n > 0) {
    ev.texts.set(content, n - 1);
    return true;
  }
  return false;
}

export interface AbsorbedResult {
  /** Indices of blocks proven absorbed by persisted history (safe to hide/remove). */
  absorbed: Set<number>;
  /** Diagnostics: content-divergence or missing twins that were NOT absorbed (bugs to surface). */
  unmatched: Array<{ index: number; kind: string; reason: string }>;
}

/**
 * Core matching pass: which streaming blocks have a persisted twin?
 *
 * Returns INDICES rather than a filtered array so callers choose the policy:
 *  · promoteCompletedBlocks (below) — destructive removal at turn boundaries
 *  · stream/render-filter.ts — NON-destructive render-time hiding (blocks stay
 *    in state; the same proof just stops rendering them)
 *
 * @param blocks       current streaming blocks
 * @param delta        persisted messages that just arrived (content + id evidence)
 * @param boundary     blocks[boundary..] are a live turn — content matching never
 *                     reaches past it. Pass blocks.length to inspect everything
 *                     (id matches stay safe at any scope; ids are unique).
 * @param fullEvidence optional ID-ONLY evidence over the FULL history
 *                     (buildIdOnlyEvidence) — catches twins persisted before the
 *                     delta window + finished-background-agent lanes.
 */
export function computeAbsorbedIndices(
  blocks: readonly StreamingBlock[],
  delta: SessionHistoryMessage[],
  boundary: number,
  fullEvidence?: DeltaEvidence,
): AbsorbedResult {
  const absorbed = new Set<number>();
  const unmatched: AbsorbedResult['unmatched'] = [];
  if (blocks.length === 0) return { absorbed, unmatched };
  const ev = buildDeltaEvidence(delta);
  const full = fullEvidence;
  // Only blocks before the boundary are eligible; a live turn's blocks
  // (index >= boundary) are structurally excluded so a delta can never reach
  // into the current turn.
  const bound = Math.min(Math.max(boundary, 0), blocks.length);

  // Track whether every matchable block in the eligible window found a twin —
  // pure-UI blocks are only GC'd when their turn's real content fully promoted.
  let allMatchableMatched = true;
  const pureUiIndices: number[] = [];

  for (let i = 0; i < bound; i++) {
    const b = blocks[i];
    if (absorbed.has(i)) continue; // claimed via a join-run

    // Subagent-lane marker. Twin matching still runs FIRST (sync inline agents
    // persist children into THIS session's history via tools[].childMessages —
    // those twins must keep matching). Only on a twin MISS does lane logic
    // apply: finished background parent → promotable without a twin (content
    // stays viewable via the Agent box, which lazy-loads the subagent
    // transcript); running parent → keep SILENTLY (expected state, not a
    // divergence — no unmatched log, no pure-UI GC veto).
    const laneParent = (b.type === 'text' || b.type === 'thinking' || b.type === 'tool_call')
      ? b.parentToolUseId : undefined;
    const laneFinished = laneParent != null
      && (ev.finishedBgParents.has(laneParent) || full?.finishedBgParents.has(laneParent) === true);

    if (b.type === 'tool_call') {
      if (b.toolUseId && (ev.toolUseIds.has(b.toolUseId) || full?.toolUseIds.has(b.toolUseId))) { absorbed.add(i); continue; }
      if (laneParent) {
        if (laneFinished) absorbed.add(i);
        continue;
      }
      if (b.toolUseId) { allMatchableMatched = false; unmatched.push({ index: i, kind: 'tool_call', reason: 'no toolUseId twin in delta' }); }
      continue;
    }
    if (b.type === 'text') {
      // Id match first (ACP dialect): the persisted message with this msgId has
      // landed — it supersedes every streaming block stamped with the same id.
      // Content equality is irrelevant here; divergence (truncation, '\n'-joins,
      // image-path rewriting) is exactly what the id was introduced to bypass.
      if (b.msgId && (ev.textMsgIds.has(b.msgId) || full?.textMsgIds.has(b.msgId))) { absorbed.add(i); continue; }
      if (claimText(ev, b.content)) { absorbed.add(i); continue; }
      if (laneParent) {
        // Lane text never participates in a main-lane join-run (a subagent's
        // text joined with main text would never match history anyway).
        if (laneFinished) absorbed.add(i);
        continue;
      }
      // Join-run fallback: the history producer (session-history.ts) collapses a
      // message's multiple text parts into ONE string joined by '\n' — even when
      // tool_use blocks sat between them. Streaming kept them as separate blocks,
      // so the exact claim above fails for every multi-text-block message. Try
      // claiming the '\n'-join of this block with the FOLLOWING text blocks in
      // the window (skipping non-text blocks, which match by their own keys —
      // and lane text, which belongs to a different conversation entirely).
      const run = [b.content];
      const runIdx = [i];
      let joined = false;
      for (let j = i + 1; j < bound && run.length < 8; j++) {
        const nb = blocks[j];
        if (nb.type !== 'text' || nb.parentToolUseId) continue;
        run.push(nb.content);
        runIdx.push(j);
        if (claimText(ev, run.join('\n'))) {
          joined = true;
          break;
        }
      }
      if (joined) {
        for (const idx of runIdx) absorbed.add(idx);
        continue;
      }
      allMatchableMatched = false;
      unmatched.push({ index: i, kind: 'text', reason: 'content diverged from delta' });
      continue;
    }
    if (b.type === 'thinking') {
      // Id match only against messages whose persisted form KEPT thinking —
      // an id in textMsgIds alone means the thinking was redacted, and removing
      // the streamed copy would vanish it with nothing to replace it.
      if (b.msgId && (ev.thinkingMsgIds.has(b.msgId) || full?.thinkingMsgIds.has(b.msgId))) { absorbed.add(i); continue; }
      if (claimText(ev, b.content)) { absorbed.add(i); continue; }
      if (laneFinished) { absorbed.add(i); continue; }
      // Thinking is frequently absent from persisted history (redacted); don't
      // flag as a bug, but keep it rather than blind-delete.
      continue;
    }
    // Pure-UI block (permission/system): no possible twin; GC below iff its
    // whole window matched.
    pureUiIndices.push(i);
  }

  // Second pass: GC pure-UI blocks in the eligible window IFF all matchable content
  // in that window promoted (turn is fully archived, the UI block is truly stale).
  // `absorbed.size > 0` is a vacuous-truth guard, not an optimization: with an
  // empty delta and no id hits, allMatchableMatched stays true having proven
  // NOTHING — without positive evidence that the archive advanced, pure-UI
  // blocks must survive (blind GC on empty evidence was a vanish root cause).
  if (allMatchableMatched && absorbed.size > 0) {
    for (const i of pureUiIndices) absorbed.add(i);
  }

  return { absorbed, unmatched };
}

export interface PromoteResult {
  /** Blocks to keep (live turn + anything without a twin). Same-reference when unchanged. */
  kept: StreamingBlock[];
  /** How many blocks were removed (session-cache GC shifts its completedLen
   *  merge boundary down by this much). */
  removed: number;
  /** Diagnostics: content-divergence or missing twins that were NOT deleted (bugs to surface). */
  unmatched: Array<{ index: number; kind: string; reason: string }>;
}

/**
 * Promote (remove) streaming blocks that now have a persisted twin in `delta`.
 * Destructive wrapper over computeAbsorbedIndices — see its doc for parameters.
 */
export function promoteCompletedBlocks(
  blocks: StreamingBlock[],
  delta: SessionHistoryMessage[],
  completedLen: number,
  fullEvidence?: DeltaEvidence,
): PromoteResult {
  const { absorbed, unmatched } = computeAbsorbedIndices(blocks, delta, completedLen, fullEvidence);
  if (absorbed.size === 0) return { kept: blocks, removed: 0, unmatched };
  const kept = blocks.filter((_, i) => !absorbed.has(i));
  return { kept, removed: absorbed.size, unmatched };
}
