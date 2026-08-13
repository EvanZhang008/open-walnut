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
 * SUBAGENT LANE (inc-1783612454903 bg, inc-1783746028392 sync — the bulk of
 * the 226): blocks with parentToolUseId stream from an Agent whose transcript
 * persists to a SEPARATE subagents/agent-<id>.jsonl — their twins never appear
 * in THIS session's history, so twin-evidence is structurally impossible.
 * Their archival proof is the parser-stamped bgTaskFinished on the parent
 * Agent/Task tool (from a <task-notification> line for background agents, or
 * from a persisted tool_result for sync run_in_background:false agents — see
 * session-history.ts). A lane block whose parent is finished is promoted (its
 * content stays viewable via the Agent box, which lazy-loads the subagent
 * transcript); a lane block whose parent is still running is kept SILENTLY
 * (live agent — not a divergence bug, so it is neither logged as unmatched
 * nor allowed to block pure-UI GC).
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
  /** toolUseIds of Agent/Task tools whose subagent run is PROVEN over. The
   *  parser stamps bgTaskFinished from a <task-notification> line (background
   *  agents) or from a persisted tool_result on an explicit
   *  run_in_background:false call (sync agents block their turn, so a result
   *  can only exist post-run — and they never get a notification;
   *  inc-1783746028392). A subagent-lane block whose parentToolUseId is here
   *  is archived-elsewhere → promotable. */
  finishedBgParents: Set<string>;
}

/** Tool names that anchor a subagent lane in the STREAMING view (kept in sync
 *  with stream/group-blocks.ts GROUPABLE_STREAM_TOOLS and the parser's
 *  GROUPABLE_TOOL_NAMES — all three must agree on what "lane parent" means). */
const GROUPABLE_STREAM_PARENTS = new Set(['Task', 'Agent']);

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
 * @param finishedAgentIds server-transported orphan finished-agent toolUseIds
 *                     (inc-1786496042099): NESTED agents' tool_use lines never
 *                     reach the canonical JSONL, so no history row can carry
 *                     their id — but the canonical <task-notification> proof
 *                     does. The parser ships those ids OUTSIDE the messages
 *                     array; here they count as finished-parent evidence
 *                     exactly like bgTaskFinished.
 */
export function computeAbsorbedIndices(
  blocks: readonly StreamingBlock[],
  delta: SessionHistoryMessage[],
  boundary: number,
  fullEvidence?: DeltaEvidence,
  finishedAgentIds?: ReadonlySet<string>,
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
  // Groupable Task/Agent parents whose absorption is decided AFTER the main
  // pass (atomic with their lane children — see the tool_call branch).
  const deferredParents: number[] = [];

  // NESTED lanes (a subagent spawned its own Agent — inc-1786138083302): a
  // grandchild block's parentToolUseId is the nested Agent's tool_use id, but
  // archival proof (bgTaskFinished) only ever lands on the TOP-LEVEL parent —
  // the whole nested run persists into that one subagents/agent-<id>.jsonl.
  // Map each nested groupable tool_call to its own parent so lane checks can
  // resolve any block's ancestry chain to its top-level root (cycle-guarded).
  const laneParentOf = new Map<string, string>();
  for (const b of blocks) {
    if (b.type === 'tool_call' && b.parentToolUseId && GROUPABLE_STREAM_PARENTS.has(b.name)) {
      laneParentOf.set(b.toolUseId, b.parentToolUseId);
    }
  }
  const resolveLaneRoot = (pid: string): string => {
    let cur = pid;
    const seen = new Set<string>();
    while (laneParentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = laneParentOf.get(cur)!;
    }
    return cur;
  };
  // Finished-parent proof for a single id: bgTaskFinished on a history row
  // (delta or full scope), or a server-transported orphan finished-agent id
  // (nested agents have NO history row to stamp — see finishedAgentIds).
  const idFinished = (id: string): boolean =>
    ev.finishedBgParents.has(id) || full?.finishedBgParents.has(id) === true
    || finishedAgentIds?.has(id) === true;
  // A lane chain is finished when ANY id along it (starting pid → … → root) is
  // provably finished, not only the final root: when intermediate Agent
  // tool_call blocks are gone (streamed before page load / prior reset),
  // laneParentOf can't walk to the true top-level root — the chain stops at an
  // id no history row carries. A provably-finished INTERMEDIATE is sufficient:
  // its whole nested run archives into the top-level agent's transcript.
  const laneRootFinished = (pid: string): boolean => {
    let cur = pid;
    const seen = new Set<string>();
    while (true) {
      if (idFinished(cur)) return true;
      if (!laneParentOf.has(cur) || seen.has(cur)) return false;
      seen.add(cur);
      cur = laneParentOf.get(cur)!;
    }
  };

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
    const laneFinished = laneParent != null && laneRootFinished(laneParent);

    if (b.type === 'tool_call') {
      // GROUPABLE PARENT (Task/Agent, main lane): its absorption is decided
      // ATOMICALLY with its lane children in a post-pass below — absorbing it
      // on the bare toolUseId twin while children are still live removes the
      // anchor those children need and the grouping layer synthesizes an
      // anonymous "Subagent (continued)" orphan box at the bottom
      // (inc-1785965937858's amplifier, the phantom-box incident shape).
      if (!laneParent && GROUPABLE_STREAM_PARENTS.has(b.name)) {
        deferredParents.push(i);
        continue;
      }
      if (b.toolUseId && (ev.toolUseIds.has(b.toolUseId) || full?.toolUseIds.has(b.toolUseId))) { absorbed.add(i); continue; }
      if (laneParent) {
        // Chain check starts at laneParent, NOT at this block's own id: a
        // nested Agent tool_call absorbing on its OWN finished proof while its
        // top-level parent still runs would let the deferred-parent pass see
        // "all children absorbed" and absorb the running anchor too — the
        // phantom-box shape (inc-1785965937858). Its own children DO absorb
        // (their pid is this id); this box stays as their anchor until the
        // chain above it is proven finished.
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

  // Deferred groupable parents — parent/child ATOMICITY + completion proof.
  // A parent absorbs iff it has its own twin, NO live lane child (anywhere in
  // blocks, live tail included), AND the run is proven over by either:
  //  · finishedBgParents (bgTaskFinished from a task-notification, or a sync
  //    agent's persisted result) — the authoritative proof; or
  //  · at least one lane child, ALL absorbed (a sync agent's children persist
  //    inline via childMessages, so each has its own id twin).
  // The childCount>0 requirement is the phantom-box guard: an agent that has
  // produced NO lane output yet has nothing to anchor, and absorbing its
  // parent lets the physical reset drop the array — the NEXT lane block then
  // arrives parentless and the grouping layer synthesizes an anonymous
  // "Subagent (continued)" orphan box at the bottom (inc-1785965937858's
  // amplifier, reproduced in tests/web/chat-lab). A RUNNING agent keeps its
  // parent SILENTLY — expected live state, not a divergence: worst case is a
  // brief labeled duplicate next to the history card (the safe direction).
  for (const i of deferredParents) {
    const b = blocks[i] as StreamingBlock & { type: 'tool_call' };
    const hasTwin = !!b.toolUseId
      && (ev.toolUseIds.has(b.toolUseId) || full?.toolUseIds.has(b.toolUseId) === true);
    if (!hasTwin) {
      if (b.toolUseId) { allMatchableMatched = false; unmatched.push({ index: i, kind: 'tool_call', reason: 'no toolUseId twin in delta' }); }
      continue;
    }
    const finished = !!b.toolUseId && idFinished(b.toolUseId);
    let childCount = 0;
    let liveChild = false;
    for (let j = 0; j < blocks.length; j++) {
      const c = blocks[j];
      // Root-resolved: nested agents' grandchildren belong to THIS parent's
      // run — a live grandchild must keep the top-level anchor alive too.
      if ((c.type === 'text' || c.type === 'thinking' || c.type === 'tool_call')
        && c.parentToolUseId && resolveLaneRoot(c.parentToolUseId) === b.toolUseId) {
        childCount++;
        if (!absorbed.has(j)) { liveChild = true; break; }
      }
    }
    if (!liveChild && (finished || childCount > 0)) absorbed.add(i);
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
  finishedAgentIds?: ReadonlySet<string>,
): PromoteResult {
  const { absorbed, unmatched } = computeAbsorbedIndices(blocks, delta, completedLen, fullEvidence, finishedAgentIds);
  if (absorbed.size === 0) return { kept: blocks, removed: 0, unmatched };
  const kept = blocks.filter((_, i) => !absorbed.has(i));
  return { kept, removed: absorbed.size, unmatched };
}
