/**
 * Tests for web/src/stream/stream-reducer.ts — the SINGLE copy of streaming
 * accumulation semantics (extracted from useSessionStream's rAF/flush paths and
 * session-cache's global listeners).
 *
 * Cases are ported from the three former mirrors so the extraction is provably
 * behavior-preserving: lane isolation (inc-1783547185298), msgId message
 * boundary (ACP dialect), completed-turn merge protection, out-of-order tool
 * results, accumulator/buffer lockstep.
 */
import { describe, it, expect } from 'vitest';
import {
  lastMainLaneIndex,
  lastMainLaneText,
  writeMainText,
  applyMainTextDelta,
  flushMainTextBuffer,
  appendMainThinking,
  appendLaneText,
  appendLaneThinking,
  appendToolCall,
  backfillToolResult,
  findToolCall,
  appendSystemBlock,
  type StreamingBlock,
} from '@/stream/stream-reducer';

// ── Builders ────────────────────────────────────────────────────────────────

const text = (content: string, msgId?: string, parentToolUseId?: string): StreamingBlock => ({
  type: 'text', content, ...(msgId ? { msgId } : {}), ...(parentToolUseId ? { parentToolUseId } : {}),
});
const thinking = (content: string, msgId?: string, parentToolUseId?: string): StreamingBlock => ({
  type: 'thinking', content, ...(msgId ? { msgId } : {}), ...(parentToolUseId ? { parentToolUseId } : {}),
});
const tool = (toolUseId: string, opts?: { parentToolUseId?: string; status?: 'calling' | 'done' | 'error' }): StreamingBlock => ({
  type: 'tool_call', toolUseId, name: 'Bash', status: opts?.status ?? 'calling',
  ...(opts?.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {}),
});

// ═══════════════════════════════════════════════════════════════════════════
// Lane anchoring
// ═══════════════════════════════════════════════════════════════════════════

describe('lastMainLaneIndex', () => {
  it('returns the last block when no lane blocks exist', () => {
    const blocks = [text('a'), tool('tu-1')];
    expect(lastMainLaneIndex(blocks)).toBe(1);
  });

  it('skips trailing subagent-lane blocks (text/thinking/tool_call)', () => {
    const blocks = [
      text('main'),
      text('sub', 'msg-s', 'parent-1'),
      thinking('sub think', undefined, 'parent-1'),
      tool('tu-sub', { parentToolUseId: 'parent-1' }),
    ];
    expect(lastMainLaneIndex(blocks)).toBe(0);
  });

  it('system/permission blocks count as main lane', () => {
    const blocks: StreamingBlock[] = [
      text('main'),
      { type: 'system', variant: 'info', message: 'note' },
      text('sub', undefined, 'p-1'),
    ];
    expect(lastMainLaneIndex(blocks)).toBe(1);
  });

  it('returns -1 when all blocks are lane blocks', () => {
    const blocks = [text('sub', undefined, 'p-1')];
    expect(lastMainLaneIndex(blocks)).toBe(-1);
  });
});

describe('lastMainLaneText', () => {
  it('finds the last MAIN text even past tool calls and lane text', () => {
    const blocks = [text('first'), text('main-last'), tool('tu-1'), text('sub', undefined, 'p-1')];
    expect(lastMainLaneText(blocks)).toBe(blocks[1]);
  });

  it('undefined when only lane text exists', () => {
    expect(lastMainLaneText([text('sub', undefined, 'p-1')])).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Main-lane text
// ═══════════════════════════════════════════════════════════════════════════

describe('writeMainText', () => {
  it('rewrites the live main text block with the full accumulated content', () => {
    const blocks = [text('Hel')];
    const next = writeMainText(blocks, 'Hello World', undefined, 0);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ type: 'text', content: 'Hello World' });
  });

  it('pushes a new block after a tool_call (text flow interrupted)', () => {
    const blocks = [text('before'), tool('tu-1')];
    const next = writeMainText(blocks, 'after', undefined, 0);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ type: 'text', content: 'after' });
  });

  it('msgId change = new message = new block (ACP boundary)', () => {
    const blocks = [text('first message', 'msg-1')];
    const next = writeMainText(blocks, 'second', 'msg-2', 0);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ type: 'text', content: 'second', msgId: 'msg-2' });
  });

  it('id-less side merges freely (legacy compat)', () => {
    const withId = writeMainText([text('acc', 'msg-1')], 'acc more', undefined, 0);
    expect(withId).toHaveLength(1);
    expect(withId[0]).toEqual({ type: 'text', content: 'acc more' });

    const gainsId = writeMainText([text('acc')], 'acc more', 'msg-1', 0);
    expect(gainsId).toHaveLength(1);
    expect(gainsId[0]).toEqual({ type: 'text', content: 'acc more', msgId: 'msg-1' });
  });

  it('never merges into a completed-turn block (index < completedLen)', () => {
    const blocks = [text('finished turn text', 'msg-1')];
    const next = writeMainText(blocks, 'new turn', 'msg-1', 1);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'text', content: 'finished turn text', msgId: 'msg-1' });
    expect(next[1]).toEqual({ type: 'text', content: 'new turn', msgId: 'msg-1' });
  });

  it('boundary check uses the merge TARGET index, not array length: trailing lane blocks past the boundary must not re-open a completed main block', () => {
    // Completed turn = [main text, lane text]; completedLen = 1 (main text only).
    // The lane block sits past the boundary, so blocks.length > completedLen —
    // but the main text block itself is completed and must not be rewritten.
    const blocks = [text('completed main', 'msg-1'), text('late sub', undefined, 'p-1')];
    const next = writeMainText(blocks, 'next turn', undefined, 1);
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual({ type: 'text', content: 'completed main', msgId: 'msg-1' });
    expect(next[2]).toEqual({ type: 'text', content: 'next turn' });
  });

  it('merges into the last MAIN block even when lane blocks trail it (interleave)', () => {
    const blocks = [text('main so far', 'msg-1'), text('sub line', 'msg-s', 'p-1')];
    const next = writeMainText(blocks, 'main so far and more', 'msg-1', 0);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'text', content: 'main so far and more', msgId: 'msg-1' });
    expect(next[1]).toEqual(blocks[1]); // lane block untouched
  });
});

describe('applyMainTextDelta (blocks + buffer lockstep)', () => {
  it('accumulates into buffer while merging', () => {
    let state = { blocks: [] as StreamingBlock[], textBuffer: '' };
    state = applyMainTextDelta(state.blocks, state.textBuffer, 'Hello', undefined, 0);
    state = applyMainTextDelta(state.blocks, state.textBuffer, ' World', undefined, 0);
    expect(state.textBuffer).toBe('Hello World');
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toEqual({ type: 'text', content: 'Hello World' });
  });

  it('restarts the buffer when a new block is opened (msgId change)', () => {
    let state = { blocks: [] as StreamingBlock[], textBuffer: '' };
    state = applyMainTextDelta(state.blocks, state.textBuffer, 'first', 'msg-1', 0);
    state = applyMainTextDelta(state.blocks, state.textBuffer, 'second', 'msg-2', 0);
    expect(state.textBuffer).toBe('second');
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toEqual({ type: 'text', content: 'first', msgId: 'msg-1' });
    expect(state.blocks[1]).toEqual({ type: 'text', content: 'second', msgId: 'msg-2' });
  });

  it('restarts the buffer after a tool_call interrupt', () => {
    let state = { blocks: [text('before'), tool('tu-1')] as StreamingBlock[], textBuffer: '' };
    state = applyMainTextDelta(state.blocks, state.textBuffer, 'after', undefined, 0);
    expect(state.textBuffer).toBe('after');
    expect(state.blocks[2]).toEqual({ type: 'text', content: 'after' });
  });
});

describe('flushMainTextBuffer', () => {
  it('empty buffer → same reference (no-op)', () => {
    const blocks = [text('a')];
    expect(flushMainTextBuffer(blocks, '', 0)).toBe(blocks);
  });

  it('rewrites the live main text block, PRESERVING its msgId', () => {
    const blocks = [text('partial', 'msg-1')];
    const next = flushMainTextBuffer(blocks, 'partial complete', 0);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ type: 'text', content: 'partial complete', msgId: 'msg-1' });
  });

  it('pushes a new block when the last main block is not text', () => {
    const blocks = [tool('tu-1')];
    const next = flushMainTextBuffer(blocks, 'buffered', 0);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ type: 'text', content: 'buffered' });
  });

  it('never rewrites a completed-turn text block', () => {
    const blocks = [text('done', 'msg-1')];
    const next = flushMainTextBuffer(blocks, 'new turn text', 1);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ type: 'text', content: 'done', msgId: 'msg-1' });
    expect(next[1]).toEqual({ type: 'text', content: 'new turn text' });
  });

  it('skips trailing lane blocks and flushes into the main block', () => {
    const blocks = [text('main', 'msg-1'), text('sub', undefined, 'p-1')];
    const next = flushMainTextBuffer(blocks, 'main full', 0);
    expect(next[0]).toEqual({ type: 'text', content: 'main full', msgId: 'msg-1' });
    expect(next[1]).toEqual(blocks[1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Main-lane thinking
// ═══════════════════════════════════════════════════════════════════════════

describe('appendMainThinking', () => {
  it('appends increments to the live thinking block of the same message', () => {
    let blocks: StreamingBlock[] = [];
    blocks = appendMainThinking(blocks, 'thinking', 'msg-1', 0);
    blocks = appendMainThinking(blocks, ' more', 'msg-1', 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'thinking', content: 'thinking more', msgId: 'msg-1' });
  });

  it('msgId change starts a new thinking block', () => {
    let blocks: StreamingBlock[] = [thinking('seg1', 'msg-1')];
    blocks = appendMainThinking(blocks, 'seg2', 'msg-2', 0);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: 'thinking', content: 'seg2', msgId: 'msg-2' });
  });

  it('a text block between thinking segments starts a new block', () => {
    const blocks = appendMainThinking([thinking('seg1'), text('answer')], 'seg2', undefined, 0);
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toEqual({ type: 'thinking', content: 'seg2' });
  });

  it('never appends into a completed-turn thinking block', () => {
    const blocks = appendMainThinking([thinking('old turn', 'msg-1')], 'new', 'msg-1', 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'thinking', content: 'old turn', msgId: 'msg-1' });
  });

  it('skips trailing lane blocks when locating the merge target', () => {
    const blocks = appendMainThinking(
      [thinking('main think', 'msg-1'), text('sub', undefined, 'p-1')],
      ' continues', 'msg-1', 0,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'thinking', content: 'main think continues', msgId: 'msg-1' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Subagent lanes (inc-1783547185298: interleaved lines must not split main text)
// ═══════════════════════════════════════════════════════════════════════════

describe('appendLaneText', () => {
  it('merges into this lane\'s open text block (same msgId)', () => {
    let blocks: StreamingBlock[] = [text('main')];
    blocks = appendLaneText(blocks, { delta: 'sub line 1', msgId: 'msg-s', parentToolUseId: 'p-1' });
    blocks = appendLaneText(blocks, { delta: ' + line 2', msgId: 'msg-s', parentToolUseId: 'p-1' });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', content: 'main' }); // main untouched
    expect(blocks[1]).toEqual({ type: 'text', content: 'sub line 1 + line 2', msgId: 'msg-s', parentToolUseId: 'p-1' });
  });

  it('different msgId in the same lane → new block', () => {
    let blocks: StreamingBlock[] = [text('sub m1', 'msg-1', 'p-1')];
    blocks = appendLaneText(blocks, { delta: 'sub m2', msgId: 'msg-2', parentToolUseId: 'p-1' });
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ content: 'sub m2', msgId: 'msg-2', parentToolUseId: 'p-1' });
  });

  it('a lane tool_call interrupts the lane\'s text flow', () => {
    let blocks: StreamingBlock[] = [
      text('sub text', 'msg-1', 'p-1'),
      tool('tu-sub', { parentToolUseId: 'p-1' }),
    ];
    blocks = appendLaneText(blocks, { delta: 'after tool', msgId: 'msg-1', parentToolUseId: 'p-1' });
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toMatchObject({ content: 'after tool', parentToolUseId: 'p-1' });
  });

  it('other lanes and main-lane blocks do NOT interrupt this lane', () => {
    let blocks: StreamingBlock[] = [
      text('lane A', 'msg-a', 'p-a'),
      text('lane B', 'msg-b', 'p-b'),
      text('main continues', 'msg-m'),
      tool('tu-main'),
    ];
    blocks = appendLaneText(blocks, { delta: ' more A', msgId: 'msg-a', parentToolUseId: 'p-a' });
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: 'text', content: 'lane A more A', msgId: 'msg-a', parentToolUseId: 'p-a' });
  });

  it('carries subagentType/taskDescription onto new lane blocks (orphan-group labels)', () => {
    const blocks = appendLaneText([], {
      delta: 'bg output', msgId: 'msg-1', parentToolUseId: 'p-1',
      subagentType: 'Explore', taskDescription: 'scan files',
    });
    expect(blocks[0]).toEqual({
      type: 'text', content: 'bg output', msgId: 'msg-1', parentToolUseId: 'p-1',
      subagentType: 'Explore', taskDescription: 'scan files',
    });
  });

  it('id-less lane events merge into the lane\'s open block', () => {
    let blocks: StreamingBlock[] = [];
    blocks = appendLaneText(blocks, { delta: 'a', parentToolUseId: 'p-1' });
    blocks = appendLaneText(blocks, { delta: 'b', parentToolUseId: 'p-1' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ content: 'ab', parentToolUseId: 'p-1' });
  });
});

describe('appendLaneThinking', () => {
  it('merges within the lane; lane text interrupts the thinking flow', () => {
    let blocks: StreamingBlock[] = [];
    blocks = appendLaneThinking(blocks, { delta: 'think1', msgId: 'msg-1', parentToolUseId: 'p-1' });
    blocks = appendLaneThinking(blocks, { delta: '+2', msgId: 'msg-1', parentToolUseId: 'p-1' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'thinking', content: 'think1+2', msgId: 'msg-1', parentToolUseId: 'p-1' });

    blocks = appendLaneText(blocks, { delta: 'text', msgId: 'msg-1', parentToolUseId: 'p-1' });
    blocks = appendLaneThinking(blocks, { delta: 'think3', msgId: 'msg-1', parentToolUseId: 'p-1' });
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toMatchObject({ type: 'thinking', content: 'think3' });
  });

  it('does not touch main-lane thinking', () => {
    const blocks = appendLaneThinking([thinking('main think', 'msg-m')], {
      delta: 'sub think', msgId: 'msg-s', parentToolUseId: 'p-1',
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'thinking', content: 'main think', msgId: 'msg-m' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool calls
// ═══════════════════════════════════════════════════════════════════════════

describe('appendToolCall / backfillToolResult / findToolCall', () => {
  it('appends with status calling and optional identity fields', () => {
    const blocks = appendToolCall([], {
      toolUseId: 'tu-1', toolName: 'Agent', input: { prompt: 'x' },
      parentToolUseId: 'p-0', subagentType: 'Explore', taskDescription: 'scan',
    });
    expect(blocks[0]).toEqual({
      type: 'tool_call', toolUseId: 'tu-1', name: 'Agent', input: { prompt: 'x' },
      status: 'calling', parentToolUseId: 'p-0', subagentType: 'Explore', taskDescription: 'scan',
    });
  });

  it('backfills results out of order, matching only status=calling', () => {
    let blocks: StreamingBlock[] = [];
    blocks = appendToolCall(blocks, { toolUseId: 'tu-1', toolName: 'Read' });
    blocks = appendToolCall(blocks, { toolUseId: 'tu-2', toolName: 'Grep' });
    blocks = appendToolCall(blocks, { toolUseId: 'tu-3', toolName: 'Glob' });

    blocks = backfillToolResult(blocks, 'tu-3', 'ok3', false);
    blocks = backfillToolResult(blocks, 'tu-1', 'Error: boom', true);

    expect(blocks.map(b => (b as { status?: string }).status)).toEqual(['error', 'calling', 'done']);
    expect((blocks[0] as { result?: string }).result).toBe('Error: boom');
  });

  it('no matching calling block → same reference (no-op)', () => {
    const blocks = [tool('tu-1', { status: 'done' })];
    expect(backfillToolResult(blocks, 'tu-1', 'late', false)).toBe(blocks);
    expect(backfillToolResult(blocks, 'tu-unknown', 'x', false)).toBe(blocks);
  });

  it('findToolCall locates duplicates for diagnostics', () => {
    const blocks = appendToolCall([], { toolUseId: 'tu-1', toolName: 'Bash' });
    expect(findToolCall(blocks, 'tu-1')?.name).toBe('Bash');
    expect(findToolCall(blocks, 'tu-2')).toBeUndefined();
  });
});

describe('appendSystemBlock', () => {
  it('appends a system notice', () => {
    const blocks = appendSystemBlock([], { variant: 'compact', message: 'Compacted', detail: 'ctx' });
    expect(blocks[0]).toEqual({ type: 'system', variant: 'compact', message: 'Compacted', detail: 'ctx' });
  });
});
