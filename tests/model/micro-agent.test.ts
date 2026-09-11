/**
 * runMicroAgent — the in-process model turn with tools.
 *
 * The provider is stubbed at `sendMessage`, so what these tests pin is the LOOP:
 * which rounds happen, what the tool_result blocks look like, when the run stops,
 * and whether a batch of read-only tools really overlaps. Nothing here touches a
 * network, a config file, or a session record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentBlock, MessageParam, ModelResult } from '../../src/model/model.js';
import type { ToolDefinition } from '../../src/model/tools.js';

/** Queue of canned provider replies, consumed one per round. */
let replies: ModelResult[] = [];
/** Every sendMessage call the loop made, in order. */
let calls: Array<{ messages: MessageParam[]; tools?: unknown[]; signal?: AbortSignal }> = [];
/** Optional per-call hook (used for the abort tests). */
let onSend: ((call: { signal?: AbortSignal }) => Promise<ModelResult> | undefined) | undefined;

vi.mock('../../src/model/model.js', () => ({
  sendMessage: vi.fn(async (opts: { messages: MessageParam[]; tools?: unknown[]; signal?: AbortSignal }) => {
    calls.push({ messages: structuredClone(opts.messages) as MessageParam[], tools: opts.tools, signal: opts.signal });
    const hooked = onSend?.({ signal: opts.signal });
    if (hooked) return hooked;
    const next = replies.shift();
    if (!next) throw new Error('sendMessage stub ran out of canned replies');
    return next;
  }),
}));

const recorded: Array<Record<string, unknown>> = [];
vi.mock('../../src/core/usage/index.js', () => ({
  usageTracker: { record: (entry: Record<string, unknown>) => { recorded.push(entry); } },
}));

import { runMicroAgent, createMicroSession, isToolResultError } from '../../src/model/micro-agent.js';

/** A provider reply carrying only text. */
function textReply(text: string): ModelResult {
  return { content: [{ type: 'text', text }] as ContentBlock[], stopReason: 'end_turn' };
}

/** A provider reply asking for one or more tools. */
function toolReply(...uses: Array<{ id: string; name: string; input?: Record<string, unknown> }>): ModelResult {
  return {
    content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} })) as ContentBlock[],
    stopReason: 'tool_use',
  };
}

/** Base options: explicit model + provider so no config/catalog lookup happens. */
function opts(extra: Partial<Parameters<typeof runMicroAgent>[0]> = {}) {
  return {
    system: 'You are a test.',
    userMessage: 'do the thing',
    model: 'test-model',
    provider: 'anthropic',
    usageSource: 'routine' as never,
    ...extra,
  } as Parameters<typeof runMicroAgent>[0];
}

/** A tool that records its calls and answers a fixed string. */
function stubTool(name: string, answer: string, parallelSafe?: boolean): ToolDefinition & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    description: `stub ${name}`,
    input_schema: { type: 'object', properties: {} },
    ...(parallelSafe ? { parallelSafe: true } : {}),
    execute: async (input) => { calls.push(input); return answer; },
    calls,
  } as ToolDefinition & { calls: unknown[] };
}

beforeEach(() => {
  replies = [];
  calls = [];
  recorded.length = 0;
  onSend = undefined;
});

describe('runMicroAgent — the round loop', () => {
  it('runs one tool round, then returns the model\'s final text', async () => {
    const tool = stubTool('look', '{"found":0}');
    replies = [toolReply({ id: 'tu-1', name: 'look', input: { q: 'inbox' } }), textReply('Nothing new.')];

    const result = await runMicroAgent(opts({ tools: [tool] }));

    expect(result.response).toBe('Nothing new.');
    expect(result.aborted).toBe(false);
    expect(result.model).toBe('test-model');
    expect(tool.calls).toEqual([{ q: 'inbox' }]);
    // user → assistant(tool_use) → user(tool_result) → assistant(text)
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const toolResults = result.messages[2].content as Array<Record<string, unknown>>;
    expect(toolResults[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu-1', content: '{"found":0}' });
    expect(toolResults[0].is_error).toBeUndefined();
  });

  it('passes the tool schemas to the provider, and none when there are no tools', async () => {
    replies = [textReply('ok')];
    await runMicroAgent(opts({ tools: [stubTool('look', 'x')] }));
    expect((calls[0].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['look']);

    calls = [];
    replies = [textReply('ok')];
    await runMicroAgent(opts());
    expect(calls[0].tools).toBeUndefined();
  });

  it('marks a failing tool result is_error so the model can react to it', async () => {
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'throws',
      input_schema: { type: 'object', properties: {} },
      execute: async () => { throw new Error('disk on fire'); },
    };
    replies = [toolReply({ id: 'tu-1', name: 'boom' }), textReply('I could not read it.')];

    const result = await runMicroAgent(opts({ tools: [boom] }));

    const block = (result.messages[2].content as Array<Record<string, unknown>>)[0];
    expect(block.is_error).toBe(true);
    expect(String(block.content)).toContain('Error executing boom: disk on fire');
    expect(result.response).toBe('I could not read it.');
  });

  it('answers an unknown tool name instead of throwing', async () => {
    replies = [toolReply({ id: 'tu-1', name: 'nope' }), textReply('done')];

    const result = await runMicroAgent(opts({ tools: [stubTool('look', 'x')] }));

    const block = (result.messages[2].content as Array<Record<string, unknown>>)[0];
    expect(block.is_error).toBe(true);
    expect(String(block.content)).toContain('Unknown tool "nope"');
  });

  it('stops at maxToolRounds and SAYS the limit was hit', async () => {
    const tool = stubTool('look', 'still nothing');
    // The model never stops calling tools.
    replies = [
      toolReply({ id: 'a', name: 'look' }),
      toolReply({ id: 'b', name: 'look' }),
      toolReply({ id: 'c', name: 'look' }),
    ];

    const result = await runMicroAgent(opts({ tools: [tool], maxToolRounds: 2 }));

    expect(calls).toHaveLength(2);
    expect(tool.calls).toHaveLength(2);
    expect(result.aborted).toBe(false);
    // A caller prints `response` verbatim, so the exhaustion must be visible there.
    expect(result.response).toContain('[Tool limit reached (2 rounds)');
  });

  it('accounts every round under the caller\'s usage source', async () => {
    replies = [
      { ...toolReply({ id: 'a', name: 'look' }), usage: { input_tokens: 10, output_tokens: 5 } as never },
      { ...textReply('done'), usage: { input_tokens: 20, output_tokens: 7 } as never },
    ];
    const seen: number[] = [];

    await runMicroAgent(opts({
      tools: [stubTool('look', 'x')],
      callbacks: { onUsage: (u) => { seen.push(u.output_tokens ?? 0); } },
    }));

    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ source: 'routine', model: 'test-model', input_tokens: 10 });
    expect(seen).toEqual([5, 7]);
  });

  it('reports the callbacks a caller renders progress from', async () => {
    replies = [toolReply({ id: 'tu-1', name: 'look', input: { q: 1 } }), textReply('final')];
    const events: string[] = [];

    await runMicroAgent(opts({
      tools: [stubTool('look', 'result text')],
      callbacks: {
        onToolCall: (name, _input, id) => events.push(`call:${name}:${id}`),
        onToolResult: (name, result) => events.push(`result:${name}:${result}`),
        onText: (t) => events.push(`text:${t}`),
      },
    }));

    expect(events).toEqual(['call:look:tu-1', 'result:look:result text', 'text:final']);
  });
});

describe('runMicroAgent — parallel tool batches', () => {
  /** A tool that reports the peak number of concurrent executions. */
  function overlapProbe(names: string[], parallelSafe: boolean): { tools: ToolDefinition[]; peak: () => number } {
    let active = 0;
    let peak = 0;
    const waiters: Array<() => void> = [];
    const tools = names.map((name) => ({
      name,
      description: `probe ${name}`,
      input_schema: { type: 'object', properties: {} },
      ...(parallelSafe ? { parallelSafe: true } : {}),
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        // Let every already-started sibling proceed, then yield once so a
        // concurrent batch really overlaps rather than finishing instantly.
        await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 5); });
        active -= 1;
        return 'ok';
      },
    } as ToolDefinition));
    return { tools, peak: () => peak };
  }

  it('runs a batch concurrently when EVERY tool is parallelSafe', async () => {
    const probe = overlapProbe(['ro_a', 'ro_b', 'ro_c'], true);
    replies = [
      toolReply({ id: '1', name: 'ro_a' }, { id: '2', name: 'ro_b' }, { id: '3', name: 'ro_c' }),
      textReply('done'),
    ];

    const result = await runMicroAgent(opts({ tools: probe.tools }));

    expect(probe.peak()).toBe(3);
    // tool_result order still matches the tool_use order the model sent.
    const blocks = result.messages[2].content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['1', '2', '3']);
  });

  it('falls back to sequential when ONE tool in the batch is unmarked', async () => {
    const safe = overlapProbe(['ro_a'], true);
    const unsafe = overlapProbe(['rw_b'], false);
    replies = [toolReply({ id: '1', name: 'ro_a' }, { id: '2', name: 'rw_b' }), textReply('done')];

    await runMicroAgent(opts({ tools: [...safe.tools, ...unsafe.tools] }));

    expect(safe.peak()).toBe(1);
    expect(unsafe.peak()).toBe(1);
  });
});

describe('runMicroAgent — cancellation', () => {
  it('reports aborted when the wall clock runs out mid-call', async () => {
    // The provider adapter answers { aborted: true } when its signal fires;
    // the stub does the same so the loop sees a realistic reply.
    onSend = (call) => new Promise<ModelResult>((resolve) => {
      call.signal?.addEventListener('abort', () => resolve({ content: [], stopReason: null, aborted: true }), { once: true });
    });

    const result = await runMicroAgent(opts({ timeoutMs: 20 }));

    expect(result.aborted).toBe(true);
    expect(result.response).toBe('');
  });

  it('keeps partial text from an aborted round', async () => {
    onSend = () => Promise.resolve({
      content: [{ type: 'text', text: 'I was saying' }] as ContentBlock[],
      stopReason: null,
      aborted: true,
    });

    const result = await runMicroAgent(opts());

    expect(result.aborted).toBe(true);
    expect(result.response).toBe('I was saying');
  });

  it('never calls the provider when the caller\'s signal is already aborted', async () => {
    const result = await runMicroAgent(opts({ signal: AbortSignal.abort() }));

    expect(calls).toHaveLength(0);
    expect(result.aborted).toBe(true);
  });

  it('aborts on the caller\'s signal, not only on the timeout', async () => {
    const controller = new AbortController();
    onSend = (call) => new Promise<ModelResult>((resolve) => {
      call.signal?.addEventListener('abort', () => resolve({ content: [], stopReason: null, aborted: true }), { once: true });
      setTimeout(() => controller.abort(), 10);
    });

    const result = await runMicroAgent(opts({ signal: controller.signal, timeoutMs: 60_000 }));

    expect(result.aborted).toBe(true);
  });
});

describe('createMicroSession', () => {
  it('threads history across sends', async () => {
    replies = [textReply('first'), textReply('second')];
    const session = createMicroSession(opts({ userMessage: undefined as never }) as never);

    const a = await session.send('question one');
    const b = await session.send('question two');

    expect(a.response).toBe('first');
    expect(b.response).toBe('second');
    // Turn 2 saw turn 1: user, assistant, user.
    expect(calls[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(session.history()).toHaveLength(4);
  });

  it('does NOT commit history from an aborted turn', async () => {
    replies = [textReply('first')];
    const session = createMicroSession(opts({ userMessage: undefined as never }) as never);
    await session.send('question one');
    const committed = session.history().length;

    onSend = () => Promise.resolve({ content: [], stopReason: null, aborted: true });
    const aborted = await session.send('question two');

    expect(aborted.aborted).toBe(true);
    expect(session.history()).toHaveLength(committed);
  });
});

describe('isToolResultError', () => {
  it('treats an Error-prefixed string or text block as an error', () => {
    expect(isToolResultError('Error: nope')).toBe(true);
    expect(isToolResultError('Error executing thing: nope')).toBe(true);
    expect(isToolResultError([{ type: 'text', text: 'error: lowercase counts' }])).toBe(true);
    expect(isToolResultError('{"ok":true}')).toBe(false);
    // "Errors" mid-sentence is data, not a failure.
    expect(isToolResultError('3 Errors found in the log')).toBe(false);
  });
});
