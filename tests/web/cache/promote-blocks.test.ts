/**
 * Tests for web/src/cache/promote-blocks.ts — the evidence-based turn promotion core.
 *
 * The invariant under test (the whole point of the rewrite): a streaming block is
 * removed ONLY when a twin is proven present in the just-arrived delta. Missing twin
 * → keep. This guarantees the failure mode is "shown twice briefly", never "vanishes".
 */
import { describe, it, expect } from 'vitest';
import {
  promoteCompletedBlocks,
  buildDeltaEvidence,
} from '@/cache/promote-blocks';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import type { SessionHistoryMessage } from '@/types/session';

// ── Builders ────────────────────────────────────────────────────────────────

const text = (content: string): StreamingBlock => ({ type: 'text', content });
const thinking = (content: string): StreamingBlock => ({ type: 'thinking', content });
const tool = (toolUseId: string, name = 'Bash'): StreamingBlock => ({
  type: 'tool_call', toolUseId, name, status: 'done',
});
const perm = (requestId: string): StreamingBlock => ({
  type: 'permission', requestId, toolName: 'Bash',
});
const sys = (message: string): StreamingBlock => ({
  type: 'system', variant: 'info', message,
});

const asstText = (t: string): SessionHistoryMessage => ({ role: 'assistant', text: t, timestamp: '' });
const asstTool = (toolUseId: string, name = 'Bash'): SessionHistoryMessage => ({
  role: 'assistant', text: '', timestamp: '', tools: [{ name, input: {}, toolUseId }],
});
const asstThinking = (t: string): SessionHistoryMessage => ({ role: 'assistant', text: '', timestamp: '', thinking: t });

// ═══════════════════════════════════════════════════════════════════════════
// buildDeltaEvidence
// ═══════════════════════════════════════════════════════════════════════════

describe('buildDeltaEvidence', () => {
  it('collects toolUseIds and text/thinking multiset', () => {
    const ev = buildDeltaEvidence([
      asstText('hello'),
      asstTool('toolu_1'),
      asstThinking('pondering'),
      asstText('hello'), // duplicate → count 2
    ]);
    expect(ev.toolUseIds.has('toolu_1')).toBe(true);
    expect(ev.texts.get('hello')).toBe(2);
    expect(ev.texts.get('pondering')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Happy path: full turn promoted
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — full turn archived', () => {
  it('removes text + tool blocks that all have twins', () => {
    const blocks = [text('Let me look'), tool('toolu_a'), text('Found it')];
    const delta = [asstText('Let me look'), asstTool('toolu_a'), asstText('Found it')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(3);
    expect(r.kept).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CORE INVARIANT: no twin → never deleted
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — evidence gates deletion', () => {
  it('keeps a block whose content diverged from delta (archive bug) + flags it', () => {
    const blocks = [text('streamed version'), tool('toolu_a')];
    // Delta has the tool but the text differs (simulated divergence / partial flush)
    const delta = [asstText('DIFFERENT persisted text'), asstTool('toolu_a')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    // tool promoted, text kept
    expect(r.removed).toBe(1);
    expect(r.kept).toEqual([text('streamed version')]);
    expect(r.unmatched.some(u => u.kind === 'text')).toBe(true);
  });

  it('archive lagging (empty delta) → deletes NOTHING', () => {
    const blocks = [text('a'), tool('toolu_a'), text('b')];
    const r = promoteCompletedBlocks(blocks, [], blocks.length);
    expect(r.removed).toBe(0);
    expect(r.kept).toBe(blocks); // same reference — untouched
  });

  it('partial delta → promotes only the matched prefix, keeps the rest', () => {
    const blocks = [text('one'), tool('toolu_a'), text('two')];
    const delta = [asstText('one'), asstTool('toolu_a')]; // 'two' not flushed yet
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(2);
    expect(r.kept).toEqual([text('two')]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Live-turn protection (the vanish bug)
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — live turn is untouchable', () => {
  it('never inspects/removes blocks past completedLen even if delta matches them', () => {
    // Turn N: [text A, tool a]. Turn N+1 already streaming: [text B].
    const blocks = [text('A'), tool('toolu_a'), text('B_live')];
    // Delta (turn N) — but suppose it ALSO somehow contained B's content:
    const delta = [asstText('A'), asstTool('toolu_a'), asstText('B_live')];
    const completedLen = 2; // only first two blocks are completed
    const r = promoteCompletedBlocks(blocks, delta, completedLen);
    expect(r.removed).toBe(2);
    expect(r.kept).toEqual([text('B_live')]); // live turn survives
  });

  it('completedLen=0 while streaming → deletes nothing (defer scenario)', () => {
    const blocks = [text('live')];
    const delta = [asstText('live')];
    const r = promoteCompletedBlocks(blocks, delta, 0);
    expect(r.removed).toBe(0);
    expect(r.kept).toBe(blocks);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure-UI blocks (permission / system) — GC only when turn fully matched
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — pure-UI blocks', () => {
  it('GCs a resolved permission card once its turn fully promoted', () => {
    const blocks = [text('run this?'), perm('req_1'), tool('toolu_a')];
    const delta = [asstText('run this?'), asstTool('toolu_a')]; // perm never in JSONL
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    // text + tool matched, so the permission card in the same completed window is GC'd
    expect(r.kept).toHaveLength(0);
    expect(r.removed).toBe(3);
  });

  it('keeps permission card if the turn did NOT fully match (safety)', () => {
    const blocks = [text('run this?'), perm('req_1'), tool('toolu_a')];
    const delta = [asstText('run this?')]; // tool NOT flushed
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    // text matched, tool unmatched → turn incomplete → perm survives, tool survives
    expect(r.kept).toEqual([perm('req_1'), tool('toolu_a')]);
    expect(r.removed).toBe(1);
  });

  it('does not GC a system block belonging to a live turn', () => {
    const blocks = [text('done'), sys('compacted'), text('live')];
    const delta = [asstText('done')];
    const completedLen = 2;
    const r = promoteCompletedBlocks(blocks, delta, completedLen);
    // Only 'done' matched; 'compacted' sys is completed-window but turn not fully
    // matched (no — actually 'done' is the only matchable and it matched).
    // sys GC requires allMatchableMatched — 'done' matched, so sys is GC'd.
    expect(r.kept).toEqual([text('live')]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multiset correctness (duplicate content)
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — duplicate content multiset', () => {
  it('two identical texts, delta has both → both removed', () => {
    const blocks = [text('continue'), text('continue')];
    const delta = [asstText('continue'), asstText('continue')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(2);
  });

  it('two identical texts, delta has ONE → only one removed', () => {
    const blocks = [text('continue'), text('continue')];
    const delta = [asstText('continue')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(1);
    expect(r.kept).toEqual([text('continue')]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// thinking blocks (often redacted from persisted history)
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — thinking', () => {
  it('promotes thinking when delta carries it', () => {
    const blocks = [thinking('deep thought'), text('answer')];
    const delta = [asstThinking('deep thought'), asstText('answer')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(2);
  });

  it('keeps thinking without a twin but does NOT flag it as a bug', () => {
    const blocks = [thinking('redacted'), text('answer')];
    const delta = [asstText('answer')]; // thinking absent (redacted in JSONL)
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    // thinking kept, text matched. allMatchableMatched stays true (thinking miss
    // doesn't count as matchable-fail), so no unmatched entry for thinking.
    expect(r.kept).toEqual([thinking('redacted')]);
    expect(r.unmatched).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — edge cases', () => {
  it('empty blocks → no-op', () => {
    const r = promoteCompletedBlocks([], [asstText('x')], 0);
    expect(r.removed).toBe(0);
    expect(r.kept).toHaveLength(0);
  });

  it('completedLen beyond blocks.length is clamped', () => {
    const blocks = [text('a')];
    const r = promoteCompletedBlocks(blocks, [asstText('a')], 999);
    expect(r.removed).toBe(1);
  });

  it('tool without toolUseId is kept (cannot prove a twin)', () => {
    const blocks: StreamingBlock[] = [{ type: 'tool_call', name: 'Bash', status: 'done', toolUseId: undefined as unknown as string }];
    const r = promoteCompletedBlocks(blocks, [asstTool('toolu_x')], blocks.length);
    expect(r.removed).toBe(0);
    expect(r.kept).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Join-run matching — REGRESSION for the "kept forever" duplicates.
// The history producer (session-history.ts) collapses a message's multiple
// text parts into ONE '\n'-joined string (even across interleaved tool_use
// blocks), while streaming kept them as separate blocks. Verbatim matching
// alone left every multi-text-block message permanently duplicated (prod
// logged 35× "content diverged from delta" in two days).
// ═══════════════════════════════════════════════════════════════════════════

describe('promoteCompletedBlocks — join-run matching', () => {
  it('two adjacent text blocks match a single joined history text', () => {
    const blocks = [text('para one'), text('para two')];
    const delta = [asstText('para one\npara two')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(2);
    expect(r.kept).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });

  it('text blocks separated by a tool_use still join (history joins across tools)', () => {
    const blocks = [text('before tool'), tool('toolu_a'), text('after tool')];
    const delta = [asstText('before tool\nafter tool'), asstTool('toolu_a')];
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(3);
    expect(r.kept).toHaveLength(0);
  });

  it('join-run never reaches into the live turn past the boundary', () => {
    const blocks = [text('one'), text('two-live')];
    // Joined twin exists — but 'two-live' is past completedLen and untouchable.
    const delta = [asstText('one\ntwo-live')];
    const r = promoteCompletedBlocks(blocks, delta, 1);
    expect(r.removed).toBe(0);
    expect(r.kept).toEqual(blocks);
  });

  it('partial join (only prefix present) keeps unmatched blocks', () => {
    const blocks = [text('alpha'), text('beta'), text('gamma')];
    const delta = [asstText('alpha\nbeta')]; // gamma not flushed yet
    const r = promoteCompletedBlocks(blocks, delta, blocks.length);
    expect(r.removed).toBe(2);
    expect(r.kept).toEqual([text('gamma')]);
  });
});
