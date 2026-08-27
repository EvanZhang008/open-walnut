/**
 * agentSearchController behavior with fake timers: debounce, nonce, abort,
 * the ai_disabled permanent latch, retry, dispose. Framework-free on purpose
 * (the root vitest tier has no jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentSearchController,
  _resetAgentSearchLatchForTesting,
  clearAgentSearchLatch,
  type AgentSearchSnapshot,
} from '@/hooks/agentSearchController';
import { AGENT_SEARCH_DEBOUNCE_MS } from '@/hooks/agentSearchTrigger';
import type { AgentSearchPayload } from '@/api/agentSearch';

const PAYLOAD: AgentSearchPayload = {
  results: [{ taskId: 't1', title: 'T', evidence: 'e' }],
  model: 'haiku',
  tookMs: 5,
};

function apiError(status: number, code?: string): Error {
  const err = new Error('api') as Error & { status: number; body?: unknown };
  err.status = status;
  if (code) err.body = { code };
  return err;
}

function setup(overrides: {
  fetcher?: ReturnType<typeof vi.fn>;
  peek?: (q: string) => AgentSearchPayload | undefined;
  enabled?: { value: boolean };
} = {}) {
  const fetcher = overrides.fetcher ?? vi.fn().mockResolvedValue(PAYLOAD);
  const enabled = overrides.enabled ?? { value: true };
  const states: AgentSearchSnapshot[] = [];
  const controller = createAgentSearchController({
    fetcher,
    peek: overrides.peek ?? (() => undefined),
    onState: (s) => states.push(s),
    isEnabled: () => enabled.value,
  });
  return { controller, fetcher, states, enabled };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetAgentSearchLatchForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

const QUERY = 'which task adds docx support';

describe('agentSearchController', () => {
  it('debounces: three keystrokes produce one fetch', async () => {
    const { controller, fetcher } = setup();
    controller.setQuery('which task ad');
    controller.setQuery('which task adds doc');
    controller.setQuery(QUERY);
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(QUERY);
  });

  it('drops an older generation response (nonce)', async () => {
    let resolveFirst!: (v: AgentSearchPayload) => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<AgentSearchPayload>((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ ...PAYLOAD, model: 'second' });
    const { controller, states } = setup({ fetcher });
    controller.setQuery(QUERY);
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    controller.setQuery('a totally different question');
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    resolveFirst(PAYLOAD); // stale response lands late
    await vi.runAllTimersAsync();
    const done = states.filter((s) => s.state === 'done');
    expect(done).toHaveLength(1);
    expect(done[0].data?.model).toBe('second');
  });

  it('aborts the in-flight request when the query changes', async () => {
    const seenSignals: AbortSignal[] = [];
    const fetcher = vi.fn().mockImplementation((_q: string, opts: { signal?: AbortSignal }) => {
      if (opts.signal) seenSignals.push(opts.signal);
      return new Promise(() => {});
    });
    const { controller } = setup({ fetcher });
    controller.setQuery(QUERY);
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    controller.setQuery('another eligible question');
    expect(seenSignals[0]?.aborted).toBe(true);
  });

  it('fetches nothing for ineligible queries or when disabled', async () => {
    const { controller, fetcher, states, enabled } = setup();
    controller.setQuery('abc');
    await vi.runAllTimersAsync();
    enabled.value = false;
    controller.setQuery(QUERY);
    await vi.runAllTimersAsync();
    expect(fetcher).not.toHaveBeenCalled();
    expect(states.every((s) => s.state === 'hidden')).toBe(true);
  });

  it('serves a cached payload synchronously without fetching', async () => {
    const { controller, fetcher, states } = setup({ peek: () => PAYLOAD });
    controller.setQuery(QUERY);
    await vi.runAllTimersAsync();
    expect(fetcher).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ state: 'done', data: PAYLOAD });
  });

  it('latches permanently on 503 ai_disabled until the latch is cleared', async () => {
    const fetcher = vi.fn().mockRejectedValue(apiError(503, 'ai_disabled'));
    const { controller, states } = setup({ fetcher });
    controller.setQuery(QUERY);
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    expect(states.at(-1)?.state).toBe('hidden');
    controller.setQuery('another eligible question entirely');
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1); // latched — no second attempt
    clearAgentSearchLatch(); // the toggle re-enable path
    controller.setQuery('third eligible question here');
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shows error (not hidden) on transient failures, and retry() refetches', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(apiError(502, 'agent_failed'))
      .mockResolvedValueOnce(PAYLOAD);
    const { controller, states } = setup({ fetcher });
    controller.setQuery(QUERY);
    await vi.advanceTimersByTimeAsync(AGENT_SEARCH_DEBOUNCE_MS + 10);
    expect(states.at(-1)?.state).toBe('error');
    controller.retry();
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.state).toBe('done');
  });

  it('dispose() cancels the pending debounce', async () => {
    const { controller, fetcher } = setup();
    controller.setQuery(QUERY);
    controller.dispose();
    await vi.runAllTimersAsync();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
