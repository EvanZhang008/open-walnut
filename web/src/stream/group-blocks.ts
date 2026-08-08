/**
 * group-blocks — pure projection from a streaming block array (+ hidden set)
 * to the grouped items the timeline renders.
 *
 * Extracted from SessionChatHistory.tsx so the grouping semantics (task
 * groups, ORPHAN subagent lanes, hidden-parent asymmetry) are testable
 * headlessly — the chat lab replays production event traces through the real
 * reducer + render-filter + THIS projection and asserts on the result without
 * a browser. Same pattern as stream-reducer.ts / render-filter.ts.
 *
 * Grouping rules (the exact semantics that survived the incident chain):
 *  · A visible Task/Agent tool_call anchors a 'task-group' holding its lane
 *    children (parentToolUseId match).
 *  · A HIDDEN parent (absorbed by history — its twin renders in the persisted
 *    timeline) is treated as ABSENT: its still-visible late children must form
 *    an ORPHAN group instead of anchoring to a block that no longer renders.
 *  · Orphan children must NEVER render flat in the main conversation; they get
 *    a synthesized box at the first VISIBLE child's position (a hidden anchor
 *    index emits no timeline item, so the box would never render).
 *  · HIDDEN children are absorbed (their twin renders via the persisted
 *    message's group) — excluded so groups don't double-render content.
 */

import type { StreamingBlock } from './stream-reducer';

export type GroupedStreamItem =
  | { kind: 'block'; block: StreamingBlock; index: number }
  | { kind: 'task-group'; taskBlock: StreamingBlock & { type: 'tool_call' }; childBlocks: StreamingBlock[]; index: number }
  | { kind: 'orphan-group'; parentToolUseId: string; childBlocks: StreamingBlock[]; subagentType?: string; taskDescription?: string; index: number };

/** Tool names whose streaming child blocks should be grouped under them. */
export const GROUPABLE_STREAM_TOOLS = new Set(['Task', 'Agent']);

export function groupStreamingBlocks(blocks: StreamingBlock[], hidden?: Set<number>): GroupedStreamItem[] {
  // Find groupable tool_call blocks (Task, Agent). Only MAIN-LANE ones are
  // group anchors — a groupable tool_call that itself carries parentToolUseId
  // is a NESTED agent (a subagent spawned its own Agent): it is a lane child
  // consumed into an ancestor's box and must never anchor its own top-level
  // group (inc-1786138083302: treating it as an anchor left its grandchild
  // blocks judged "not orphans" yet joined to nothing → rendered flat in the
  // main conversation). laneParentOf records each nested agent's own parent so
  // descendants can be resolved to their top-level ROOT below.
  // A HIDDEN parent is treated as ABSENT (see module doc).
  const parentToolUseIds = new Set<string>();
  const laneParentOf = new Map<string, string>();
  let hasLaneChildren = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'tool_call' && GROUPABLE_STREAM_TOOLS.has(b.name)) {
      if (b.parentToolUseId) laneParentOf.set(b.toolUseId, b.parentToolUseId);
      else if (!hidden?.has(i)) parentToolUseIds.add(b.toolUseId);
    }
    if ((b.type === 'tool_call' || b.type === 'text' || b.type === 'thinking') && b.parentToolUseId) {
      hasLaneChildren = true;
    }
  }

  if (parentToolUseIds.size === 0 && !hasLaneChildren) {
    // No groupable blocks — return flat list
    return blocks.map((block, index) => ({ kind: 'block', block, index }));
  }

  // Walk a child's parent CHAIN to its top-level root (cycle-guarded — a
  // malformed stream must degrade to "some grouping", never an infinite loop).
  const resolveRoot = (pid: string): string => {
    let cur = pid;
    const seen = new Set<string>();
    while (laneParentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = laneParentOf.get(cur)!;
    }
    return cur;
  };

  // Group child blocks under their ROOT parent. Children are tool_calls AND
  // text/thinking — the CLI inlines the subagent's whole conversation
  // (assistant text included) with parent_tool_use_id set; nested agents'
  // descendants resolve to the top-level Agent's box. Children whose root
  // tool_call is NOT in blocks form an orphan lane. HIDDEN children are
  // absorbed — exclude them so groups don't double-render content.
  const childBlocksByParent = new Map<string, StreamingBlock[]>();
  const consumedIndices = new Set<number>();
  const rootOfIndex = new Map<number, string>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const childParent = (b.type === 'tool_call' || b.type === 'text' || b.type === 'thinking')
      ? b.parentToolUseId : undefined;
    if (childParent) {
      consumedIndices.add(i);
      const root = resolveRoot(childParent);
      rootOfIndex.set(i, root);
      if (hidden?.has(i)) continue;
      const arr = childBlocksByParent.get(root);
      if (arr) arr.push(b);
      else childBlocksByParent.set(root, [b]);
    }
  }

  // Build grouped result. Orphan lanes surface at their FIRST child's position.
  const emittedOrphans = new Set<string>();
  const result: GroupedStreamItem[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (consumedIndices.has(i)) {
      // Root (not the raw parentToolUseId): nested agents' children must orphan
      // under the TOP-LEVEL agent when its tool_call left the buffer, forming
      // one box rather than one per nesting level.
      const pid = rootOfIndex.get(i);
      // Anchor an orphan group at its first VISIBLE child — a hidden anchor
      // index emits no timeline item, so the box would never render.
      if (pid && !parentToolUseIds.has(pid) && !emittedOrphans.has(pid) && !hidden?.has(i)) {
        emittedOrphans.add(pid);
        const children = childBlocksByParent.get(pid) ?? [];
        if (children.length === 0) continue; // all children absorbed — nothing to box
        // Label from whichever child carries the subagent identity
        let subagentType: string | undefined;
        let taskDescription: string | undefined;
        for (const c of children) {
          if ((c.type === 'text' || c.type === 'tool_call') && (c.subagentType || c.taskDescription)) {
            subagentType = c.subagentType;
            taskDescription = c.taskDescription;
            break;
          }
        }
        result.push({ kind: 'orphan-group', parentToolUseId: pid, childBlocks: children, subagentType, taskDescription, index: i });
      }
      continue;
    }
    // parentToolUseIds membership already excludes HIDDEN parents — a hidden
    // parent falls through to a plain 'block' (skipped at render), and its
    // visible children boxed via the orphan path above.
    if (b.type === 'tool_call' && parentToolUseIds.has(b.toolUseId)) {
      result.push({
        kind: 'task-group',
        taskBlock: b,
        childBlocks: childBlocksByParent.get(b.toolUseId) ?? [],
        index: i,
      });
    } else {
      result.push({ kind: 'block', block: b, index: i });
    }
  }
  return result;
}

/**
 * Project a box's childBlocks (ALL descendants, root-flattened — what
 * groupStreamingBlocks puts in task-group/orphan-group.childBlocks) into the
 * box's OWN nested view: direct children render flat, a nested Agent/Task
 * tool_call becomes an inner task-group holding ITS descendants, recursively.
 *
 * Mechanism: within this box, "main lane" = blocks whose parentToolUseId is
 * the box itself — strip that marker and reuse groupStreamingBlocks, which
 * then treats the nested agent as a groupable anchor and its subtree as lane
 * children. Depth-N nesting falls out of the recursion (each level strips one
 * link). Matches the persisted-history rendering, where childMessages nest
 * per level (SessionMessage TaskGroup).
 */
export function groupLaneChildren(selfId: string, children: StreamingBlock[]): GroupedStreamItem[] {
  const promoted = children.map((b) =>
    (b.type === 'text' || b.type === 'thinking' || b.type === 'tool_call') && b.parentToolUseId === selfId
      ? ({ ...b, parentToolUseId: undefined } as StreamingBlock)
      : b);
  return groupStreamingBlocks(promoted);
}

/** Subagent-tree summary for a box header: how many agents did THIS agent
 *  spawn directly, and how many live in its whole subtree. childBlocks are
 *  root-flattened (all descendants), so `total` is exact: every Agent/Task
 *  tool_call in there is one spawned agent at SOME depth; `direct` is the
 *  subset parented by the box itself. */
export function countAgentTree(selfId: string, children: readonly StreamingBlock[]): { direct: number; total: number } {
  let direct = 0;
  let total = 0;
  for (const b of children) {
    if (b.type === 'tool_call' && GROUPABLE_STREAM_TOOLS.has(b.name)) {
      total++;
      if (b.parentToolUseId === selfId) direct++;
    }
  }
  return { direct, total };
}
