/**
 * lane-rows — the main chat's merge passes, applied to ONE subagent lane.
 *
 * The Background tasks panel reads a running agent straight out of the streaming
 * buffer, and it must read the way the main conversation reads: finished generic
 * tools AND the thinking that led to them fold into one "Ran 3 commands, read a
 * file ›" run (the reasoning sits next to its call inside the run), thinking that
 * led to prose (or to an Agent, or to nothing yet) is its own "Thinking ›" row,
 * transparent blocks (an empty live tail, a ghost placeholder) neither render nor
 * split a run. Everything else — prose, a tool still executing (the in-flight
 * card), a plan card, a nested Agent — is its own row. Pure, so the projection is
 * unit-testable without a browser.
 */

import type { StreamingBlock } from './stream-reducer';
import { isRunMemberBlock, isTransparentBlock, trailingThinkingStart, type GroupedStreamItem } from './group-blocks';

export type ToolBlock = StreamingBlock & { type: 'tool_call' };
export type ThinkingBlock = StreamingBlock & { type: 'thinking' };
/** A run member, in arrival order: a finished tool or the reasoning before it. */
export type RunBlock = ToolBlock | ThinkingBlock;

export type LaneRow =
  /** At least one tool; thinking members interleave in arrival order. */
  | { kind: 'run'; blocks: RunBlock[] }
  | { kind: 'thinking'; blocks: ThinkingBlock[] }
  | { kind: 'block'; block: StreamingBlock }
  | { kind: 'agent'; item: GroupedStreamItem & { kind: 'task-group' } };

/** The tools of a run — what its collapsed phrase and failure count are about. */
export function runToolBlocks(blocks: readonly RunBlock[]): ToolBlock[] {
  return blocks.filter((b): b is ToolBlock => b.type === 'tool_call');
}

export function laneRows(items: readonly GroupedStreamItem[]): LaneRow[] {
  const rows: LaneRow[] = [];
  let run: RunBlock[] = [];
  const pushStretch = (blocks: RunBlock[]) => {
    if (!blocks.length) return;
    // Reasoning alone is a thinking row; the moment a tool joins, the whole
    // stretch is one run and the row reads as the tools it ran.
    if (runToolBlocks(blocks).length > 0) rows.push({ kind: 'run', blocks });
    else rows.push({ kind: 'thinking', blocks: blocks as ThinkingBlock[] });
  };
  /** `next` is the visible non-member that ends the run (undefined at the tail). */
  const flushRun = (next: StreamingBlock | 'other' | undefined) => {
    const split = trailingThinkingStart(run, next);
    pushStretch(run.slice(0, split));
    pushStretch(run.slice(split));
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'task-group') {
      flushRun('other');
      rows.push({ kind: 'agent', item });
      continue;
    }
    const b = item.block;
    if (isTransparentBlock(b)) continue;
    if (isRunMemberBlock(b)) { run.push(b); continue; }
    flushRun(b);
    rows.push({ kind: 'block', block: b });
  }
  flushRun(undefined);
  return rows;
}
