/**
 * The Background tasks panel reads a running subagent's lane with the MAIN chat's
 * merge rules (web/src/stream/lane-rows.ts): finished generic tools and the
 * thinking between them fold into one "Ran N commands" run, a tool still
 * executing stays its own in-flight card, thinking with no tool around it is one
 * "Thinking ›" row, transparent blocks neither render nor split a run, and a
 * nested Agent is its own row. Pins the projection the reader draws.
 */
import { describe, it, expect } from 'vitest';
import { laneRows, runToolBlocks } from '../../../web/src/stream/lane-rows';
import { groupLaneChildren, isGhostToolBlock, isMergeableToolBlock, isRunMemberBlock, isRunThinkingBlock, isTransparentBlock } from '../../../web/src/stream/group-blocks';
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

  it('thinking with words is a run member like a finished tool; blank thinking, prose and calling tools are not', () => {
    expect(isRunThinkingBlock(thinking('why not'))).toBe(true);
    expect(isRunThinkingBlock(thinking('  '))).toBe(false);
    expect(isRunMemberBlock(thinking('why not'))).toBe(true);
    expect(isRunMemberBlock(tool('a', 'done'))).toBe(true);
    expect(isRunMemberBlock(tool('a', 'calling'))).toBe(false);
    expect(isRunMemberBlock(text('prose'))).toBe(false);
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

  it('thinking before, between and after finished tools rides the SAME run, in arrival order', () => {
    // The 2026-09-15 zebra: think, fetch, think, fetch, think, run+fetch+fetch
    // used to be six rows ("Thinking › / Fetched a page › / …"); it is one.
    const rows = laneRows(groupLaneChildren(P, [
      thinking('a'), thinking('b'),
      tool('t1', 'done'),
      thinking('c'),
      tool('t2', 'done'), tool('t3', 'done'),
      thinking('d'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['run']);
    const run = rows[0];
    expect(run.kind === 'run' && run.blocks.map(b => b.type === 'thinking' ? `think:${b.content}` : b.toolUseId))
      .toEqual(['think:a', 'think:b', 't1', 'think:c', 't2', 't3', 'think:d']);
    expect(run.kind === 'run' && runToolBlocks(run.blocks).map(b => b.toolUseId)).toEqual(['t1', 't2', 't3']);
  });

  it('thinking with no tool around it stays a "Thinking ›" row, and adjacent thinking merges', () => {
    const rows = laneRows(groupLaneChildren(P, [
      thinking('a'), thinking('b'),
      text('Found it.'),
      thinking('c'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['thinking', 'block', 'thinking']);
    expect(rows[0].kind === 'thinking' && rows[0].blocks.map(b => b.content)).toEqual(['a', 'b']);
  });

  it('reasoning that led to PROSE splits off the run as its own row (the persisted twin puts it above the answer)', () => {
    const rows = laneRows(groupLaneChildren(P, [
      thinking('a'), tool('t1', 'done'), thinking('b'), tool('t2', 'done'),
      thinking('now I can answer'),
      text('Here is the answer.'),
    ]));
    expect(rows.map(r => r.kind)).toEqual(['run', 'thinking', 'block']);
    expect(rows[0].kind === 'run' && rows[0].blocks.map(b => b.type === 'thinking' ? `think:${b.content}` : b.toolUseId))
      .toEqual(['think:a', 't1', 'think:b', 't2']);
    expect(rows[1].kind === 'thinking' && rows[1].blocks.map(b => b.content)).toEqual(['now I can answer']);
  });

  it('reasoning that led to a nested Agent or a plan card splits off too; reasoning at the live tail stays in the run', () => {
    const nested = 'toolu_nested';
    const beforeAgent = laneRows(groupLaneChildren(P, [
      tool('t1', 'done'), thinking('spawn a helper'),
      { type: 'tool_call', toolUseId: nested, name: 'Agent', input: { description: 'deeper' }, status: 'calling', parentToolUseId: P },
    ]));
    expect(beforeAgent.map(r => r.kind)).toEqual(['run', 'thinking', 'agent']);
    const beforePlan = laneRows(groupLaneChildren(P, [
      tool('t1', 'done'), thinking('write the plan'),
      tool('p', 'done', { name: 'ExitPlanMode', input: { plan: 'x' } }),
    ]));
    expect(beforePlan.map(r => r.kind)).toEqual(['run', 'thinking', 'block']);
    const liveTail = laneRows(groupLaneChildren(P, [tool('t1', 'done'), thinking('still going')]));
    expect(liveTail.map(r => r.kind)).toEqual(['run']);
    expect(liveTail[0].kind === 'run' && liveTail[0].blocks.length).toBe(2);
  });

  it('a tool still executing keeps the reasoning that led to it in the run, and joins it when done', () => {
    const live = laneRows(groupLaneChildren(P, [
      thinking('a'), tool('t1', 'done'), thinking('b'),
      tool('t2', 'calling'),
    ]));
    expect(live.map(r => r.kind)).toEqual(['run', 'block']);
    expect(live[0].kind === 'run' && live[0].blocks.length).toBe(3);
    const done = laneRows(groupLaneChildren(P, [
      thinking('a'), tool('t1', 'done'), thinking('b'),
      tool('t2', 'done'),
    ]));
    expect(done.map(r => r.kind)).toEqual(['run']);
    expect(done[0].kind === 'run' && done[0].blocks.length).toBe(4);
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
