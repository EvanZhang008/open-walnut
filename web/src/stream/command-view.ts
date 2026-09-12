/**
 * A background shell command as the Background tasks panel reads it.
 *
 * The ledger row for a `local_bash` task carries only a title and a status; the
 * command itself and what it printed live in the conversation, as the Bash
 * tool_use the row's `tool_use_id` names (verified on a live stream: the CLI's
 * task_started for a shell task points at the Bash tool call). A backgrounded
 * command's Bash result is just the launch note ("Command running in background
 * with ID …"); its real output arrives through later TaskOutput / BashOutput
 * reads keyed by the task id. Both are looked up here, in the stream buffer while
 * the turn runs and in the persisted history after it, so the reader shows the
 * same command and output in either state.
 */

import type { StreamingBlock } from './stream-reducer';
import type { SessionHistoryMessage, SessionHistoryTool } from '@/types/session';

export interface ToolView {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  status: 'calling' | 'done' | 'error';
}

export interface CommandView {
  command: string;
  description?: string;
  status: ToolView['status'];
  /** The Bash tool's own result: the output of a foreground command, the launch
   *  note of a backgrounded one. */
  result?: string;
  /** Later reads of the task's output (TaskOutput / BashOutput), oldest first. */
  outputs: string[];
}

/** Where the conversation is read from: the live stream and the persisted rows. */
export interface ToolSource {
  blocks: readonly StreamingBlock[];
  messages: readonly SessionHistoryMessage[];
}

export const EMPTY_TOOL_SOURCE: ToolSource = { blocks: [], messages: [] };

const OUTPUT_TOOLS = new Set(['TaskOutput', 'BashOutput']);
const BACKGROUND_LAUNCH = /^Command running in background/;

function historyToolView(t: SessionHistoryTool): ToolView {
  return { name: t.name, input: t.input ?? {}, result: t.result, status: t.isError ? 'error' : 'done' };
}

/** Newest stream block with this id (a replayed buffer can hold the same id twice;
 *  the later one carries the result). */
export function findToolInBlocks(blocks: readonly StreamingBlock[], toolUseId: string): ToolView | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'tool_call' && b.toolUseId === toolUseId) {
      return { name: b.name, input: b.input ?? {}, result: b.result, status: b.status };
    }
  }
  return undefined;
}

/** First history tool with this id, at any depth (a subagent's own shell task
 *  lives under the Agent tool's childMessages). */
export function findToolInHistory(messages: readonly SessionHistoryMessage[], toolUseId: string): ToolView | undefined {
  for (const m of messages) {
    for (const t of m.tools ?? []) {
      if (t.toolUseId === toolUseId) return historyToolView(t);
      if (t.childMessages?.length) {
        const nested = findToolInHistory(t.childMessages, toolUseId);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

function readsTask(input: Record<string, unknown> | undefined, taskId: string): boolean {
  if (!input) return false;
  return input.task_id === taskId || input.bash_id === taskId || input.shell_id === taskId;
}

/** Every TaskOutput / BashOutput result for this task, history first (older),
 *  then stream blocks not already seen as a history twin. */
export function collectTaskOutputs(source: ToolSource, taskId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (messages: readonly SessionHistoryMessage[]) => {
    for (const m of messages) {
      for (const t of m.tools ?? []) {
        if (OUTPUT_TOOLS.has(t.name) && readsTask(t.input, taskId) && t.result) {
          if (t.toolUseId) seen.add(t.toolUseId);
          out.push(t.result);
        }
        if (t.childMessages?.length) visit(t.childMessages);
      }
    }
  };
  visit(source.messages);
  for (const b of source.blocks) {
    if (b.type !== 'tool_call' || !OUTPUT_TOOLS.has(b.name) || !readsTask(b.input, taskId) || !b.result) continue;
    if (seen.has(b.toolUseId)) continue;
    out.push(b.result);
  }
  return out;
}

/** The command behind a ledger row, or undefined when the conversation holds
 *  neither its Bash tool call nor any output read (nothing to show but the title). */
export function commandView(
  target: { toolUseId?: string; taskId: string },
  source: ToolSource,
): CommandView | undefined {
  const tool = target.toolUseId
    ? findToolInBlocks(source.blocks, target.toolUseId) ?? findToolInHistory(source.messages, target.toolUseId)
    : undefined;
  const outputs = collectTaskOutputs(source, target.taskId);
  if (!tool && outputs.length === 0) return undefined;
  const input = tool?.input ?? {};
  return {
    command: typeof input.command === 'string' ? input.command : '',
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined,
    status: tool?.status ?? 'done',
    result: tool?.result,
    outputs,
  };
}

/** What the reader prints under "Output": the output reads when there are any,
 *  else the Bash result unless it is only the background launch note. */
export function commandOutput(view: CommandView): string | undefined {
  if (view.outputs.length > 0) return view.outputs.join('\n');
  if (view.result && !BACKGROUND_LAUNCH.test(view.result)) return view.result;
  return undefined;
}
