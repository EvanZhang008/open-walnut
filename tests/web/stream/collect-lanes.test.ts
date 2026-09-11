/**
 * collectLanes — every subagent lane in the stream buffer, keyed by its ROOT
 * Agent tool_call, whether or not the anchor renders. This is what the Background
 * tasks panel reads for a running agent (the live stream, no fetch): a background
 * agent's tool_call is absorbed by history seconds after the spawn while the agent
 * runs on for minutes, so a lane must survive its anchor being hidden — the one
 * place where this projection deliberately differs from groupStreamingBlocks.
 */
import { describe, it, expect } from 'vitest';
import { collectLanes, groupStreamingBlocks } from '@/stream/group-blocks';
import type { StreamingBlock } from '@/stream/stream-reducer';

const A = 'toolu_agent_a';
const B = 'toolu_agent_b';
const NESTED = 'toolu_nested';

function blocks(): StreamingBlock[] {
  return [
    { type: 'text', content: 'main' },
    { type: 'tool_call', toolUseId: A, name: 'Agent', status: 'done', input: { description: 'a' } },
    { type: 'tool_call', toolUseId: B, name: 'Agent', status: 'calling', input: { description: 'b' } },
    { type: 'text', content: 'a says', parentToolUseId: A },
    { type: 'tool_call', toolUseId: NESTED, name: 'Agent', status: 'calling', parentToolUseId: A, input: { description: 'a-child' } },
    { type: 'text', content: 'grandchild of a', parentToolUseId: NESTED },
    { type: 'tool_call', toolUseId: 'toolu_b_bash', name: 'Bash', status: 'done', parentToolUseId: B, input: { command: 'ls' } },
    { type: 'text', content: 'orphan lane', parentToolUseId: 'toolu_gone' },
  ];
}

describe('collectLanes', () => {
  it('groups every lane child under its root anchor, nested agents flattened to the root', () => {
    const lanes = collectLanes(blocks());
    expect([...lanes.keys()].sort()).toEqual([A, B, 'toolu_gone'].sort());
    const a = lanes.get(A)!;
    expect(a.anchor?.toolUseId).toBe(A);
    expect(a.children.map(c => (c.type === 'text' ? c.content : c.type === 'tool_call' ? c.toolUseId : ''))).toEqual(['a says', NESTED, 'grandchild of a']);
    expect(lanes.get(B)!.children).toHaveLength(1);
  });

  it('keeps a lane whose anchor the chat hides (history absorbed the tool_call)', () => {
    const src = blocks();
    const hidden = new Set([1]); // anchor A absorbed
    // The chat projection drops A's group entirely…
    expect(groupStreamingBlocks(src, hidden).some(g => g.kind === 'task-group' && g.taskBlock.toolUseId === A)).toBe(false);
    // …the lane registry still owns the lane, anchor included.
    const lanes = collectLanes(src);
    expect(lanes.get(A)?.anchor?.toolUseId).toBe(A);
    expect(lanes.get(A)?.children).toHaveLength(3);
  });

  it('records an anchorless lane (agent spawned before this page loaded) without an anchor', () => {
    const lane = collectLanes(blocks()).get('toolu_gone')!;
    expect(lane.anchor).toBeUndefined();
    expect(lane.children.map(c => (c.type === 'text' ? c.content : ''))).toEqual(['orphan lane']);
  });

  it('is empty for a stream with no agents and no lane traffic', () => {
    expect(collectLanes([{ type: 'text', content: 'hi' }]).size).toBe(0);
  });
});
