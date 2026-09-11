/**
 * lane-rows — the main chat's merge passes, applied to ONE subagent lane.
 *
 * The Background tasks panel reads a running agent straight out of the streaming
 * buffer, and it must read the way the main conversation reads: finished generic
 * tools fold into one "Ran 3 commands, read a file ›" run, adjacent thinking into
 * one "Thinking ›" row, transparent blocks (an empty live tail, a ghost
 * placeholder) neither render nor split a run. Everything else — prose, a tool
 * still executing (the in-flight card), a plan card, a nested Agent — is its own
 * row. Pure, so the projection is unit-testable without a browser.
 */

import type { StreamingBlock } from './stream-reducer';
import { isMergeableToolBlock, isTransparentBlock, type GroupedStreamItem } from './group-blocks';

export type ToolBlock = StreamingBlock & { type: 'tool_call' };
export type ThinkingBlock = StreamingBlock & { type: 'thinking' };

export type LaneRow =
  | { kind: 'run'; blocks: ToolBlock[] }
  | { kind: 'thinking'; blocks: ThinkingBlock[] }
  | { kind: 'block'; block: StreamingBlock }
  | { kind: 'agent'; item: GroupedStreamItem & { kind: 'task-group' } };

export function laneRows(items: readonly GroupedStreamItem[]): LaneRow[] {
  const rows: LaneRow[] = [];
  let run: ToolBlock[] = [];
  let thinking: ThinkingBlock[] = [];
  const flushRun = () => { if (run.length) rows.push({ kind: 'run', blocks: run }); run = []; };
  const flushThinking = () => { if (thinking.length) rows.push({ kind: 'thinking', blocks: thinking }); thinking = []; };
  for (const item of items) {
    if (item.kind === 'task-group') {
      flushRun(); flushThinking();
      rows.push({ kind: 'agent', item });
      continue;
    }
    const b = item.block;
    if (isTransparentBlock(b)) continue;
    if (isMergeableToolBlock(b)) { flushThinking(); run.push(b); continue; }
    if (b.type === 'thinking') { flushRun(); thinking.push(b); continue; }
    flushRun(); flushThinking();
    rows.push({ kind: 'block', block: b });
  }
  flushRun(); flushThinking();
  return rows;
}
