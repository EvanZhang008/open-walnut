/**
 * The stream block predicates the live rows read (web/src/stream/group-blocks.ts):
 * a ghost placeholder and empty text or reasoning draw nothing, generic tools
 * merge into a run running or done, Agent anchors and plan cards stand alone,
 * and reasoning with words is a run member like a tool. A subagent's lane is
 * drawn from these blocks as its transcript (tests/web/stream/lane-messages.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { isGhostToolBlock, isMergeableToolBlock, isRunMemberBlock, isRunThinkingBlock, isTransparentBlock } from '../../../web/src/stream/group-blocks';
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

  it('a generic tool merges running or done; Agent anchors, plan cards and plan writes stay cards', () => {
    expect(isMergeableToolBlock(tool('a', 'done'))).toBe(true);
    expect(isMergeableToolBlock(tool('a', 'error'))).toBe(true);
    expect(isMergeableToolBlock(tool('a', 'calling'))).toBe(true);
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

  it('thinking with words is a run member like a tool; blank thinking and prose are not', () => {
    expect(isRunThinkingBlock(thinking('why not'))).toBe(true);
    expect(isRunThinkingBlock(thinking('  '))).toBe(false);
    expect(isRunMemberBlock(thinking('why not'))).toBe(true);
    expect(isRunMemberBlock(tool('a', 'done'))).toBe(true);
    expect(isRunMemberBlock(tool('a', 'calling'))).toBe(true);
    expect(isRunMemberBlock(text('prose'))).toBe(false);
  });
});
