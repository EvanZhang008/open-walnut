/**
 * Folding for a phone's timeline (spec 4.5, 4.7; C69, C84). Pure, so the
 * rules are unit tested (tests/web/tool-call-grouping.test.ts).
 *
 * - A run of consecutive tool calls is ONE 44 px row, `<n> tool calls`; text
 *   from the assistant between two calls ends the run (the timeline's own
 *   run builder already merges them; these say how a run reads and counts).
 * - A long command in a permission card shows its first and last lines, so
 *   the end (`&& rm -rf ...`) is never the part that is cut off.
 */

export interface ToolRunItem {
  /** 'tool' joins a run; 'thinking' rides inside one; anything else ends it. */
  kind: 'tool' | 'thinking' | 'text' | 'other';
}

export type ToolGroup<T extends ToolRunItem> =
  | { kind: 'single'; item: T; index: number }
  | { kind: 'tools'; items: T[]; start: number; toolCount: number };

/**
 * Group consecutive tool calls (reasoning between them stays in the run).
 * A run of one tool call is still a run: the phone shows `1 tool call`.
 * Reasoning alone, with no tool, is not a run.
 */
export function groupToolCalls<T extends ToolRunItem>(items: readonly T[]): ToolGroup<T>[] {
  const out: ToolGroup<T>[] = [];
  let run: T[] = [];
  let runStart = -1;
  let runTools = 0;
  const flush = () => {
    if (run.length === 0) return;
    if (runTools > 0) {
      out.push({ kind: 'tools', items: run, start: runStart, toolCount: runTools });
    } else {
      run.forEach((item, k) => out.push({ kind: 'single', item, index: runStart + k }));
    }
    run = [];
    runStart = -1;
    runTools = 0;
  };
  items.forEach((item, i) => {
    if (item.kind === 'tool' || item.kind === 'thinking') {
      if (run.length === 0) runStart = i;
      run.push(item);
      if (item.kind === 'tool') runTools += 1;
      return;
    }
    flush();
    out.push({ kind: 'single', item, index: i });
  });
  flush();
  // Trailing reasoning after the last tool is not part of "the calls" count
  // but stays in the run's body; nothing else to adjust.
  return out;
}

/** The phone label of a run: `1 tool call`, `20 tool calls`. */
export function toolCallsLabel(n: number): string {
  const count = Math.max(0, Math.floor(n));
  return `${count} tool call${count === 1 ? '' : 's'}`;
}

export interface FoldedCommand {
  folded: boolean;
  head: string[];
  tail: string[];
  total: number;
}

/**
 * Over `max` lines: the first `keep` and the last `keep` (the middle is the
 * ellipsis). A trailing newline is not a line of its own.
 */
export function foldLongCommand(command: string, max = 6, keep = 3): FoldedCommand {
  const lines = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const total = lines.length;
  if (total <= max || keep * 2 >= total) return { folded: false, head: lines, tail: [], total };
  return { folded: true, head: lines.slice(0, keep), tail: lines.slice(total - keep), total };
}
