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
 *   · text/thinking→ verbatim content equality (same model output, byte-identical)
 * Pure-UI blocks that never appear in JSONL (permission cards, system notices)
 * have no possible twin — they are collected separately, and only for turns whose
 * matchable content fully matched (so we never GC a UI block of a live turn).
 */

import type { StreamingBlock } from '@/hooks/useSessionStream';
import type { SessionHistoryMessage } from '@/types/session';

/** Blocks that can never have a JSONL twin — deletion needs a different justification. */
function isPureUiBlock(b: StreamingBlock): boolean {
  return b.type === 'permission' || b.type === 'system';
}

/** Build the set of evidence keys present in a batch of persisted messages. */
export interface DeltaEvidence {
  toolUseIds: Set<string>;
  /** Multiset of text/thinking contents (a value = remaining count still claimable). */
  texts: Map<string, number>;
}

export function buildDeltaEvidence(delta: SessionHistoryMessage[]): DeltaEvidence {
  const toolUseIds = new Set<string>();
  const texts = new Map<string, number>();
  const bump = (s: string | undefined) => {
    if (!s) return;
    texts.set(s, (texts.get(s) ?? 0) + 1);
  };
  for (const m of delta) {
    if (m.text) bump(m.text);
    if (m.thinking) bump(m.thinking);
    if (m.tools) {
      for (const t of m.tools) {
        if (t.toolUseId) toolUseIds.add(t.toolUseId);
      }
    }
  }
  return { toolUseIds, texts };
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

export interface PromoteResult {
  /** Blocks to keep (live turn + anything without a twin). Same-reference when unchanged. */
  kept: StreamingBlock[];
  /** How many blocks were removed (for shifting position anchors like blockIndexMap). */
  removed: number;
  /** Diagnostics: content-divergence or missing twins that were NOT deleted (bugs to surface). */
  unmatched: Array<{ index: number; kind: string; reason: string }>;
}

/**
 * Promote (remove) streaming blocks that now have a persisted twin in `delta`.
 *
 * @param blocks       current streaming blocks
 * @param delta        persisted messages that just arrived (the increment since last cursor)
 * @param completedLen best-known count of blocks belonging to already-ended turns; used ONLY
 *                     to bound the search window (blocks past it are a live turn and are never
 *                     inspected). Pass blocks.length if unknown — evidence still gates deletion.
 */
export function promoteCompletedBlocks(
  blocks: StreamingBlock[],
  delta: SessionHistoryMessage[],
  completedLen: number,
): PromoteResult {
  if (blocks.length === 0) return { kept: blocks, removed: 0, unmatched: [] };
  const ev = buildDeltaEvidence(delta);
  // Only completed-turn blocks are eligible; a live turn's blocks (index >= boundary)
  // are structurally excluded so a delta can never reach into the current turn.
  const boundary = Math.min(Math.max(completedLen, 0), blocks.length);

  const kept: StreamingBlock[] = [];
  const unmatched: PromoteResult['unmatched'] = [];
  let removed = 0;
  // Track whether every matchable block in the eligible window found a twin —
  // pure-UI blocks are only GC'd when their turn's real content fully promoted.
  let allMatchableMatched = true;
  // Text blocks consumed as later members of a claimed join-run (see text branch).
  const consumedByRun = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i >= boundary) { kept.push(b); continue; } // live turn — untouchable
    if (consumedByRun.has(i)) { removed++; continue; } // claimed via a join-run

    if (b.type === 'tool_call') {
      if (b.toolUseId && ev.toolUseIds.has(b.toolUseId)) { removed++; continue; }
      kept.push(b);
      if (b.toolUseId) { allMatchableMatched = false; unmatched.push({ index: i, kind: 'tool_call', reason: 'no toolUseId twin in delta' }); }
      continue;
    }
    if (b.type === 'text') {
      if (claimText(ev, b.content)) { removed++; continue; }
      // Join-run fallback: the history producer (session-history.ts) collapses a
      // message's multiple text parts into ONE string joined by '\n' — even when
      // tool_use blocks sat between them. Streaming kept them as separate blocks,
      // so the exact claim above fails for every multi-text-block message. Try
      // claiming the '\n'-join of this block with the FOLLOWING text blocks in
      // the window (skipping non-text blocks, which match by their own keys).
      const run = [b.content];
      const runIdx = [i];
      let joined = false;
      for (let j = i + 1; j < boundary && run.length < 8; j++) {
        const nb = blocks[j];
        if (nb.type !== 'text') continue;
        run.push(nb.content);
        runIdx.push(j);
        if (claimText(ev, run.join('\n'))) {
          // Consume the whole run: skip ahead past the last joined index and
          // drop every block in it (interleaved non-text blocks between them
          // are re-visited by the main loop via `consumedByRun`).
          joined = true;
          break;
        }
      }
      if (joined) {
        for (const idx of runIdx) consumedByRun.add(idx);
        removed++; // b itself (later run members hit consumedByRun below)
        continue;
      }
      kept.push(b);
      allMatchableMatched = false;
      unmatched.push({ index: i, kind: 'text', reason: 'content diverged from delta' });
      continue;
    }
    if (b.type === 'thinking') {
      if (claimText(ev, b.content)) { removed++; continue; }
      kept.push(b);
      // Thinking is frequently absent from persisted history (redacted); don't
      // flag as a bug, but keep it rather than blind-delete.
      continue;
    }
    // Pure-UI block (permission/system): keep for now; GC below if its turn matched.
    kept.push(b);
  }

  // Second pass: GC pure-UI blocks in the eligible window IFF all matchable content
  // in that window promoted (turn is fully archived, the UI block is truly stale).
  if (allMatchableMatched && removed > 0) {
    const kept2: StreamingBlock[] = [];
    let uiRemoved = 0;
    // Re-derive boundary within kept[] : kept lost `removed` completed blocks, so the
    // live-turn tail is the last (blocks.length - boundary) entries of kept.
    const liveTailLen = blocks.length - boundary;
    const keptCompletedLen = kept.length - liveTailLen;
    for (let i = 0; i < kept.length; i++) {
      if (i < keptCompletedLen && isPureUiBlock(kept[i])) { uiRemoved++; continue; }
      kept2.push(kept[i]);
    }
    if (uiRemoved > 0) return { kept: kept2, removed: removed + uiRemoved, unmatched };
  }

  if (removed === 0) return { kept: blocks, removed: 0, unmatched };
  return { kept, removed, unmatched };
}
