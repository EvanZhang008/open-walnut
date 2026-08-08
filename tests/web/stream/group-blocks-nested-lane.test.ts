/**
 * Nested subagent lanes (inc-1786138083302 — "subagent messages spill over
 * to main agent").
 *
 * New CLI behavior: a subagent can itself spawn subagents. The grandchild
 * agent's lines carry parent_tool_use_id = the GRANDCHILD Agent tool_use id —
 * which is itself a lane block (child of the top-level Agent). The incident
 * session had 185 such grandchild blocks; every one rendered FLAT in the main
 * conversation because:
 *   · the grandchild Agent tool_call (a lane block) was collected into
 *     parentToolUseIds, so its children were judged "not orphans", yet
 *   · that tool_call is consumed into the top-level box and never emits a
 *     task-group, so the children never joined any group either.
 *
 * The fix resolves every child's parent CHAIN to its top-level root: all
 * descendant blocks land inside the top-level Agent's group (or its orphan
 * box when the top parent has left the buffer).
 */
import { describe, it, expect } from 'vitest';
import { groupStreamingBlocks, groupLaneChildren, countAgentTree } from '@/stream/group-blocks';
import type { StreamingBlock } from '@/stream/stream-reducer';

const TOP = 'toolu_top_agent';
const MID = 'toolu_mid_agent';

/** Blocks mirroring the incident shape: top-level Agent → child Agent → grandchild output. */
function nestedBlocks(): StreamingBlock[] {
  return [
    { type: 'text', content: 'main answer' },
    // Top-level Agent tool_call (main lane)
    { type: 'tool_call', toolUseId: TOP, name: 'Agent', status: 'calling', input: { description: 'Review CR' } },
    // Child agent's own output (lane = TOP)
    { type: 'text', content: 'child narration', parentToolUseId: TOP, subagentType: 'general-purpose' },
    // Child agent spawns ANOTHER Agent — this tool_call is itself a lane block
    { type: 'tool_call', toolUseId: MID, name: 'Agent', status: 'calling', parentToolUseId: TOP, input: { description: 'Trace Account.id' } },
    // Grandchild output — parent_tool_use_id points at MID, not TOP
    { type: 'text', content: "I'll search the pulled CR workspace", parentToolUseId: MID, subagentType: 'Explore' },
    { type: 'tool_call', toolUseId: 'toolu_gc_bash', name: 'Bash', status: 'done', parentToolUseId: MID, input: { command: 'ls' } },
    { type: 'text', content: 'No node_modules there.', parentToolUseId: MID },
  ];
}

describe('groupStreamingBlocks — nested subagent lanes', () => {
  it('grandchild blocks land inside the top-level task group, never flat', () => {
    const grouped = groupStreamingBlocks(nestedBlocks());

    const flatTexts = grouped
      .filter((g): g is Extract<typeof g, { kind: 'block' }> => g.kind === 'block')
      .map((g) => (g.block.type === 'text' ? g.block.content : ''));
    // The spill: grandchild text must NOT appear as a top-level block
    expect(flatTexts).not.toContain("I'll search the pulled CR workspace");
    expect(flatTexts).not.toContain('No node_modules there.');

    const top = grouped.find((g) => g.kind === 'task-group');
    expect(top).toBeDefined();
    if (top?.kind !== 'task-group') throw new Error('unreachable');
    expect(top.taskBlock.toolUseId).toBe(TOP);
    // All descendants — child narration, grandchild Agent tool_call, grandchild output
    const childContents = top.childBlocks.map((b) =>
      b.type === 'text' ? b.content : b.type === 'tool_call' ? b.toolUseId : '');
    expect(childContents).toContain('child narration');
    expect(childContents).toContain(MID);
    expect(childContents).toContain("I'll search the pulled CR workspace");
    expect(childContents).toContain('toolu_gc_bash');
    expect(childContents).toContain('No node_modules there.');
    // No orphan group — everything anchored to the visible top parent
    expect(grouped.some((g) => g.kind === 'orphan-group')).toBe(false);
  });

  it('grandchild blocks whose top parent left the buffer form ONE orphan box', () => {
    const blocks = nestedBlocks().slice(2); // top-level Agent tool_call gone (turn ended)
    const grouped = groupStreamingBlocks(blocks);

    const flat = grouped.filter((g) => g.kind === 'block');
    expect(flat).toHaveLength(0);
    const orphans = grouped.filter((g) => g.kind === 'orphan-group');
    expect(orphans).toHaveLength(1);
    if (orphans[0].kind !== 'orphan-group') throw new Error('unreachable');
    expect(orphans[0].parentToolUseId).toBe(TOP);
    expect(orphans[0].childBlocks).toHaveLength(5);
  });

  it('a hidden grandchild parent does not strand its children (they stay in the top group)', () => {
    const blocks = nestedBlocks();
    // Hide the grandchild Agent tool_call (index 3) — e.g. absorbed by history
    const grouped = groupStreamingBlocks(blocks, new Set([3]));
    const top = grouped.find((g) => g.kind === 'task-group');
    if (top?.kind !== 'task-group') throw new Error('top group must exist');
    const texts = top.childBlocks.map((b) => (b.type === 'text' ? b.content : ''));
    expect(texts).toContain("I'll search the pulled CR workspace");
    // And still nothing flat
    const flatTexts = grouped
      .filter((g): g is Extract<typeof g, { kind: 'block' }> => g.kind === 'block')
      .map((g) => (g.block.type === 'text' ? g.block.content : ''));
    expect(flatTexts).not.toContain("I'll search the pulled CR workspace");
  });

  it('groupLaneChildren renders the box interior NESTED: inner Agent boxes its own subtree', () => {
    const grouped = groupStreamingBlocks(nestedBlocks());
    const top = grouped.find((g) => g.kind === 'task-group');
    if (top?.kind !== 'task-group') throw new Error('top group must exist');

    const inner = groupLaneChildren(TOP, top.childBlocks);
    // Direct child text renders flat inside the box
    const flatTexts = inner
      .filter((g): g is Extract<typeof g, { kind: 'block' }> => g.kind === 'block')
      .map((g) => (g.block.type === 'text' ? g.block.content : ''));
    expect(flatTexts).toContain('child narration');
    // The nested Agent becomes an INNER task-group holding the grandchild subtree
    expect(flatTexts).not.toContain("I'll search the pulled CR workspace");
    const innerGroup = inner.find((g) => g.kind === 'task-group');
    expect(innerGroup).toBeDefined();
    if (innerGroup?.kind !== 'task-group') throw new Error('unreachable');
    expect(innerGroup.taskBlock.toolUseId).toBe(MID);
    const gcTexts = innerGroup.childBlocks.map((b) => (b.type === 'text' ? b.content : b.type === 'tool_call' ? b.toolUseId : ''));
    expect(gcTexts).toContain("I'll search the pulled CR workspace");
    expect(gcTexts).toContain('toolu_gc_bash');
    expect(gcTexts).toContain('No node_modules there.');
  });

  it('groupLaneChildren works for the orphan variant (top parent gone)', () => {
    const blocks = nestedBlocks().slice(2);
    const grouped = groupStreamingBlocks(blocks);
    const orphan = grouped.find((g) => g.kind === 'orphan-group');
    if (orphan?.kind !== 'orphan-group') throw new Error('orphan must exist');
    const inner = groupLaneChildren(orphan.parentToolUseId, orphan.childBlocks);
    const innerGroup = inner.find((g) => g.kind === 'task-group');
    expect(innerGroup).toBeDefined();
    if (innerGroup?.kind !== 'task-group') throw new Error('unreachable');
    expect(innerGroup.taskBlock.toolUseId).toBe(MID);
    expect(innerGroup.childBlocks).toHaveLength(3);
  });

  it('countAgentTree reports direct vs total spawns (the "3 then 3 = 6" readout)', () => {
    const grouped = groupStreamingBlocks(nestedBlocks());
    const top = grouped.find((g) => g.kind === 'task-group');
    if (top?.kind !== 'task-group') throw new Error('top group must exist');
    // Top-level agent spawned 1 directly (MID); subtree total is also 1
    expect(countAgentTree(TOP, top.childBlocks)).toEqual({ direct: 1, total: 1 });

    // Deeper tree: TOP spawns 2 direct, one of them spawns 2 more → 2 direct, 4 total
    const blocks: StreamingBlock[] = [
      { type: 'tool_call', toolUseId: TOP, name: 'Agent', status: 'calling', input: {} },
      { type: 'tool_call', toolUseId: 'toolu_c1', name: 'Agent', status: 'done', parentToolUseId: TOP },
      { type: 'tool_call', toolUseId: 'toolu_c2', name: 'Agent', status: 'done', parentToolUseId: TOP },
      { type: 'tool_call', toolUseId: 'toolu_gc1', name: 'Agent', status: 'done', parentToolUseId: 'toolu_c1' },
      { type: 'tool_call', toolUseId: 'toolu_gc2', name: 'Task', status: 'done', parentToolUseId: 'toolu_c1' },
      { type: 'tool_call', toolUseId: 'toolu_bash', name: 'Bash', status: 'done', parentToolUseId: 'toolu_c2' },
    ];
    const g2 = groupStreamingBlocks(blocks).find((g) => g.kind === 'task-group');
    if (g2?.kind !== 'task-group') throw new Error('unreachable');
    expect(countAgentTree(TOP, g2.childBlocks)).toEqual({ direct: 2, total: 4 });
  });

  it('self-referential parent chain does not loop forever', () => {
    const blocks: StreamingBlock[] = [
      { type: 'tool_call', toolUseId: 'toolu_a', name: 'Agent', status: 'calling', parentToolUseId: 'toolu_b' },
      { type: 'tool_call', toolUseId: 'toolu_b', name: 'Agent', status: 'calling', parentToolUseId: 'toolu_a' },
      { type: 'text', content: 'cyclic', parentToolUseId: 'toolu_a' },
    ];
    const grouped = groupStreamingBlocks(blocks); // must terminate
    expect(grouped.length).toBeGreaterThan(0);
  });
});
