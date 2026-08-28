/**
 * runMicroAgent — the lightweight-session primitive's contract: inherits
 * NOTHING (caller system prompt only, prompt cache off), tight defaults,
 * tier→catalog model resolution, timeout surfaces as `aborted`, and every
 * run is usage-accounted under the caller's source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const { loopMock, recordMock } = vi.hoisted(() => ({
  loopMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-micro-agent'));
vi.mock('../../src/agent/loop.js', () => ({ runAgentLoop: loopMock }));
vi.mock('../../src/core/usage/index.js', () => ({ usageTracker: { record: recordMock } }));

import { runMicroAgent, createMicroSession, resolveTierModel } from '../../src/agent/micro-agent.js';

const DONE = { response: 'ok', messages: [], newMessages: [] };

beforeEach(() => {
  loopMock.mockReset();
  recordMock.mockReset();
});

describe('runMicroAgent', () => {
  it('runs a bare loop: caller system prompt only, cache off, tight defaults', async () => {
    loopMock.mockResolvedValue(DONE);
    const out = await runMicroAgent({
      system: 'You are tiny.',
      userMessage: 'go',
      usageSource: 'task-search-agent',
    });
    const [userMessage, history, , options] = loopMock.mock.calls[0];
    expect(userMessage).toBe('go');
    expect(history).toEqual([]);
    expect(options.system).toBe('You are tiny.'); // custom system ⇒ loop skips CLAUDE.md/skills/memory
    expect(options.tools).toEqual([]);
    expect(options.cacheConfig).toBe(false);
    expect(options.maxToolRounds).toBe(3);
    expect(options.modelConfig).toEqual({ model: 'global.anthropic.claude-sonnet-4-6', provider: 'bedrock', maxTokens: 2000 });
    expect(options.source).toBe('task-search-agent');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual({ response: 'ok', model: 'global.anthropic.claude-sonnet-4-6', aborted: false, messages: [] });
  });

  it('threads history in and returns the updated messages for the next turn', async () => {
    const prior = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'yes' }];
    const updated = [...prior, { role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }];
    loopMock.mockResolvedValue({ ...DONE, messages: updated });
    const out = await runMicroAgent({
      system: 's', userMessage: 'go', usageSource: 'task-search-agent',
      history: prior as never,
    });
    expect(loopMock.mock.calls[0][1]).toBe(prior);
    expect(out.messages).toBe(updated);
  });

  it('an external signal aborts the loop (composed with the timeout)', async () => {
    const external = new AbortController();
    let loopSignal: AbortSignal | undefined;
    loopMock.mockImplementation(async (_u, _h, _c, options) => {
      loopSignal = options.signal;
      external.abort();
      await new Promise((r) => setTimeout(r, 10));
      return { ...DONE, aborted: loopSignal?.aborted === true };
    });
    const out = await runMicroAgent({
      system: 's', userMessage: 'u', usageSource: 'task-search-agent', signal: external.signal,
    });
    expect(loopSignal?.aborted).toBe(true);
    expect(out.aborted).toBe(true);
  });

  it('tier picks from the catalog; explicit model wins over tier', async () => {
    await expect(resolveTierModel('haiku')).resolves.toMatchObject({ provider: 'bedrock' });
    expect((await resolveTierModel('haiku')).model.toLowerCase()).toContain('haiku');
    loopMock.mockResolvedValue(DONE);
    const out = await runMicroAgent({
      system: 's', userMessage: 'u', usageSource: 'task-search-agent',
      model: 'global.anthropic.claude-opus-5', tier: 'haiku',
    });
    expect(out.model).toBe('global.anthropic.claude-opus-5');
  });

  it('surfaces an aborted loop instead of swallowing it', async () => {
    loopMock.mockResolvedValue({ ...DONE, aborted: true });
    const out = await runMicroAgent({ system: 's', userMessage: 'u', usageSource: 'task-search-agent' });
    expect(out.aborted).toBe(true);
  });

  it('records usage under the caller source AND still calls the caller onUsage', async () => {
    const callerUsage = vi.fn();
    loopMock.mockImplementation(async (_u, _h, callbacks) => {
      callbacks?.onUsage?.({ model: 'm', input_tokens: 10, output_tokens: 2 });
      return DONE;
    });
    await runMicroAgent({
      system: 's', userMessage: 'u', usageSource: 'task-search-agent',
      callbacks: { onUsage: callerUsage },
    });
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'task-search-agent', model: 'm', input_tokens: 10, output_tokens: 2,
    }));
    expect(callerUsage).toHaveBeenCalledTimes(1);
  });
});

describe('createMicroSession', () => {
  it('threads history across sends; per-send overrides apply; aborted turns do not poison history', async () => {
    const turn1 = [{ role: 'user', content: 'a' }, { role: 'assistant', content: '1' }];
    loopMock.mockResolvedValueOnce({ ...DONE, messages: turn1 });
    const session = createMicroSession({ system: 's', usageSource: 'task-search-agent' });

    await session.send('a');
    expect(loopMock.mock.calls[0][1]).toEqual([]);

    // Turn 2 times out — history must stay at turn 1.
    loopMock.mockResolvedValueOnce({ ...DONE, aborted: true, messages: [...turn1, { role: 'user', content: 'b' }] });
    await session.send('b');
    expect(loopMock.mock.calls[1][1]).toBe(turn1);
    expect(session.history()).toBe(turn1);

    // Turn 3 continues from turn 1, with a per-send model override.
    loopMock.mockResolvedValueOnce(DONE);
    await session.send('c', { model: 'global.anthropic.claude-opus-5' });
    expect(loopMock.mock.calls[2][1]).toBe(turn1);
    expect(loopMock.mock.calls[2][3].modelConfig.model).toBe('global.anthropic.claude-opus-5');
  });
});
