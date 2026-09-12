/**
 * The Background tasks panel's Command reader (web/src/stream/command-view.ts):
 * a `local_bash` ledger row points at its Bash tool_use by tool_use_id, and the
 * command plus its output are read from the conversation, stream buffer first,
 * persisted history second, TaskOutput reads keyed by the task id. Pins the
 * lookup order, the background launch note rule, and the history/stream dedup.
 */
import { describe, it, expect } from 'vitest';
import { commandOutput, commandView, collectTaskOutputs, findToolInHistory } from '../../../web/src/stream/command-view';
import type { StreamingBlock } from '../../../web/src/stream/stream-reducer';
import type { SessionHistoryMessage } from '../../../web/src/types/session';

const TASK = 'bycw5u19d';
const BASH = 'toolu_bash_1';

const bashBlock = (status: 'calling' | 'done' | 'error', result?: string): StreamingBlock => ({
  type: 'tool_call', toolUseId: BASH, name: 'Bash', status, result,
  input: { command: 'npm test -- --run', description: 'Run the quick tier', run_in_background: status === 'calling' ? undefined : false },
});
const outputBlock = (id: string, result: string): StreamingBlock => ({
  type: 'tool_call', toolUseId: id, name: 'TaskOutput', status: 'done', result, input: { task_id: TASK, block: true },
});
const msg = (tools: NonNullable<SessionHistoryMessage['tools']>): SessionHistoryMessage => ({
  role: 'assistant', text: '', timestamp: '2026-01-01T00:00:00.000Z', tools,
});

describe('commandView', () => {
  it('reads the command and its output off the Bash tool block in the stream', () => {
    const view = commandView({ toolUseId: BASH, taskId: TASK }, { blocks: [bashBlock('done', '306 passed')], messages: [] });
    expect(view).toMatchObject({ command: 'npm test -- --run', description: 'Run the quick tier', status: 'done', result: '306 passed', outputs: [] });
    expect(commandOutput(view!)).toBe('306 passed');
  });

  it('falls back to the persisted history, at any depth, when the stream no longer holds the block', () => {
    const nested = msg([{ name: 'Agent', input: {}, toolUseId: 'toolu_agent', childMessages: [
      msg([{ name: 'Bash', input: { command: 'ls' }, toolUseId: BASH, result: 'a.ts', isError: true }]),
    ] }]);
    expect(findToolInHistory([nested], BASH)).toMatchObject({ name: 'Bash', status: 'error', result: 'a.ts' });
    const view = commandView({ toolUseId: BASH, taskId: TASK }, { blocks: [], messages: [nested] });
    expect(view?.command).toBe('ls');
    expect(view?.status).toBe('error');
  });

  it('the newest stream block with the id wins over an older replayed twin', () => {
    const stale: StreamingBlock = { ...bashBlock('calling'), result: undefined };
    const view = commandView({ toolUseId: BASH, taskId: TASK }, { blocks: [stale, bashBlock('done', 'ok')], messages: [] });
    expect(view?.status).toBe('done');
    expect(view?.result).toBe('ok');
  });

  it('a backgrounded command shows its TaskOutput reads, never the launch note', () => {
    const launch = `Command running in background with ID: ${TASK}. Output is being written to: /tmp/x`;
    const source = {
      blocks: [bashBlock('done', launch), outputBlock('toolu_out_2', 'second read')],
      messages: [msg([{ name: 'TaskOutput', input: { task_id: TASK }, toolUseId: 'toolu_out_1', result: 'first read' }])],
    };
    const view = commandView({ toolUseId: BASH, taskId: TASK }, source);
    expect(view?.outputs).toEqual(['first read', 'second read']);
    expect(commandOutput(view!)).toBe('first read\nsecond read');
    // Launch note alone (no read yet) → nothing to print.
    const early = commandView({ toolUseId: BASH, taskId: TASK }, { blocks: [bashBlock('done', launch)], messages: [] });
    expect(commandOutput(early!)).toBeUndefined();
  });

  it('a stream TaskOutput that is the twin of a history one is counted once', () => {
    const source = {
      blocks: [outputBlock('toolu_out_1', 'same read')],
      messages: [msg([{ name: 'TaskOutput', input: { task_id: TASK }, toolUseId: 'toolu_out_1', result: 'same read' }])],
    };
    expect(collectTaskOutputs(source, TASK)).toEqual(['same read']);
    // A read of ANOTHER task never leaks in.
    expect(collectTaskOutputs({ blocks: [outputBlock('toolu_out_9', 'other')], messages: [] }, 'other-task')).toEqual([]);
  });

  it('is undefined when the conversation holds neither the tool call nor a read', () => {
    expect(commandView({ toolUseId: BASH, taskId: TASK }, { blocks: [], messages: [] })).toBeUndefined();
    expect(commandView({ taskId: TASK }, { blocks: [bashBlock('done', 'x')], messages: [] })).toBeUndefined();
  });
});
