/**
 * The Background tasks panel reads a running subagent's lane with the MAIN chat's
 * merge rules (web/src/stream/lane-rows.ts): finished generic tools fold into one
 * "Ran N commands" run, a tool still executing stays its own in-flight card,
 * adjacent thinking merges, transparent blocks neither render nor split a run,
 * and a nested Agent is its own row. Pins the projection the reader draws.
 */
import { describe, it, expect } from 'vitest';
import { laneRows } from '../../../web/src/stream/lane-rows';
import { groupLaneChildren, isGhostToolBlock, isMergeableToolBlock, isTransparentBlock } from '../../../web/src/stream/group-blocks';
import type { StreamingBlock } from '../../../web/src/stream/stream-reducer';

const P = 'toolu_parent';
const tool = (id: string, status: 'calling' | 'done' | 'error', extra: Partial<StreamingBlock & { type: 'tool_call' }> = {}): StreamingBlock => ({
  type: 'tool_call', toolUseId: id, name: 'Bash', input: { command: `cmd ${id}` }, status, parentToolUseId: P, ...extra,
});
const text = (content: string): StreamingBlock => ({ type: 'text', content, parentToolUseId: P });
const thinking = (content: string): StreamingBlock => ({ type: 'thinking', content, parentToolUseId: P });

describe('block predicates', () => {
  it('a calling tool with no input and no result is a ghost, and transparent', () => {
    const ghost: StreamingBlock = { type: 'tool_call', toolUseId: 'g', name: 'Bash', status: 'calling', input: {} };
    expect(isGhostToolBlock(ghost)).toBe(true);
    expect(isTransparentBlock(ghost)).toBe(true);
    expect(isMergeableToolBlock(ghost)).toBe(false);
    expect(isGhostToolBlock(tool('a', 'calling'))).toBe(false);
  });

  it('empty text/thinking is transparent; words are not', () => {
    expect(isTransparentBlock(text('  '))).toBe(true);
    expect(isTransparentBlock(thinking(''))).toBe(true);
    expect(isTransparentBlock(text('hi'))).toBe(false);
  });

  it('only a FINISHED generic tool merges: calling tools, Agent anchors, plan cards and plan writes stay cards', () => {
    expect(isMergeableToolBlock(tool('a', 'done'))).toBe(true);
    expect(isMergeableToolBlock(tool('a', 'error'))).toBe(true);
    expect(isMergeableToolBlock(tool('a', 'calling'))).toBe(false);
    expect(isMergeableToolBlock(tool('a', 'done', { name: 'Agent' }))).toBe(false);
    expect(isMergeableToolBlock(tool('a', 'done', { name: 'ExitPlanMode', input: { plan: 'x' } }))).toBe(false);
    expect(isMergeableToolBlock(tool('a', 'done', { name: 'Write', input: { file_path: '/h/.claude/plans/p.md' } }))).toBe(false);
    expect(isMergeableToolBlock(tool('a', 'done', { name: 'Write', input: { file_path: '/h/src/p.ts' } }))).toBe(true);
  });

  it('a finished tool with empty input and no result is a placeholder: not merged, whatever its status', () => {
    expect(isMergeableToolBlock(tool('a', 'done', { input: {}, result: undefined }))).toBe(false);
    expect(isMergeableToolBlock(tool('a', 'error', { input: undefined, result: undefined }))).toBe(false);
    expect(isMergeableToolBlock(tool('a', 'done', { input: {}, result: 'out' }))).toBe(true);
  });
});

describe('laneRows', () => {
  it('folds finished tools into one run and keeps the in-flight tool as its own card', () => {
    const rows = laneRows(groupLaneChildren(P, [
      text('Looking.'),
      tool('a', 'done'), tool('b', 'done'),
      tool('c', 'calling'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['block', 'run', 'block']);
    expect(rows[1].kind === 'run' && rows[1].blocks.map(b => b.toolUseId)).toEqual(['a', 'b']);
    expect(rows[2].kind === 'block' && rows[2].block.type === 'tool_call' && rows[2].block.status).toBe('calling');
  });

  it('a run continues across transparent blocks but breaks on prose', () => {
    const rows = laneRows(groupLaneChildren(P, [
      tool('a', 'done'), text(''), tool('b', 'done'),
      text('Found it.'),
      tool('c', 'done'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['run', 'block', 'run']);
    expect(rows[0].kind === 'run' && rows[0].blocks.length).toBe(2);
  });

  it('adjacent thinking merges into one row; thinking and tools never share a row', () => {
    const rows = laneRows(groupLaneChildren(P, [
      thinking('a'), thinking('b'),
      tool('t1', 'done'),
      thinking('c'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['thinking', 'run', 'thinking']);
    expect(rows[0].kind === 'thinking' && rows[0].blocks.map(b => b.content)).toEqual(['a', 'b']);
  });

  it('a nested Agent is its own row and its lane stays under it', () => {
    const nested = 'toolu_nested';
    const rows = laneRows(groupLaneChildren(P, [
      tool('a', 'done'),
      { type: 'tool_call', toolUseId: nested, name: 'Agent', input: { description: 'deeper' }, status: 'calling', parentToolUseId: P },
      { type: 'tool_call', toolUseId: 'n1', name: 'Read', input: { file_path: 'x' }, status: 'done', parentToolUseId: nested },
      tool('b', 'done'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['run', 'agent', 'run']);
    expect(rows[1].kind === 'agent' && rows[1].item.childBlocks.map(b => b.type === 'tool_call' && b.toolUseId)).toEqual(['n1']);
  });

  it('an empty lane is no rows (the caller draws the working indicator alone)', () => {
    expect(laneRows(groupLaneChildren(P, []))).toEqual([]);
    expect(laneRows(groupLaneChildren(P, [text(''), thinking(' ')]))).toEqual([]);
  });
});
