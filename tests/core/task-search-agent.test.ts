/**
 * Orchestration pipeline of the agent task search with a scripted engine:
 * gates, cache, in-flight dedup, slot gate, error mapping, usage accounting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const { aiDisabledRef, usageRecordMock } = vi.hoisted(() => ({
  aiDisabledRef: { value: false },
  usageRecordMock: vi.fn(),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-search-agent'));
// backgroundAiDisabled() is unconditionally true under vitest — swap in a
// controllable gate while keeping fastModelFor real (importOriginal pattern).
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => aiDisabledRef.value,
}));
vi.mock('../../src/core/usage/index.js', () => ({
  usageTracker: { record: usageRecordMock },
}));

import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';
import { _resetForTesting, addTask } from '../../src/core/task-manager.js';
import {
  AgentSearchError,
  runTaskSearchAgent,
  _resetAgentSearchStateForTesting,
  type AgentSearchEngine,
} from '../../src/core/task-search-agent.js';

function jsonEngine(payload: unknown, extra: { costUsd?: number } = {}): AgentSearchEngine {
  return async () => ({ response: JSON.stringify(payload), ...extra });
}

beforeEach(async () => {
  aiDisabledRef.value = false;
  usageRecordMock.mockReset();
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('runTaskSearchAgent', () => {
  it('returns the enriched 200 shape', async () => {
    const { task } = await addTask({ title: 'Fix preview pipeline' });
    const res = await runTaskSearchAgent('which task fixes preview', {
      engine: jsonEngine({ summary: 'Found it.', results: [{ task_id: task.id, evidence: 'preview pipeline', confidence: 'high' }] }),
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ taskId: task.id, title: 'Fix preview pipeline', confidence: 'high' });
    expect(res.summary).toBe('Found it.');
    expect(res.model).toBeTruthy();
    expect(res.cached).toBe(false);
  });

  it('maps query-length violations to 400', async () => {
    await expect(runTaskSearchAgent('ab', { engine: jsonEngine({ results: [] }) }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(runTaskSearchAgent('x'.repeat(401), { engine: jsonEngine({ results: [] }) }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('maps ai-disabled to 503 {code:ai_disabled}', async () => {
    aiDisabledRef.value = true;
    await expect(runTaskSearchAgent('some real query', { engine: jsonEngine({ results: [] }) }))
      .rejects.toMatchObject({ statusCode: 503, extra: { code: 'ai_disabled' } });
  });

  it('maps an unparseable answer to 502 {code:unparseable}', async () => {
    await expect(runTaskSearchAgent('some real query', {
      engine: async () => ({ response: 'I could not find anything, sorry!' }),
    })).rejects.toMatchObject({ statusCode: 502, extra: { code: 'unparseable' } });
  });

  it('maps an engine failure to 502 {code:agent_failed}', async () => {
    await expect(runTaskSearchAgent('some real query', {
      engine: async () => { throw new Error('spawn ENOENT'); },
    })).rejects.toMatchObject({ statusCode: 502, extra: { code: 'agent_failed' } });
    expect((await runTaskSearchAgent('some real query', { engine: jsonEngine({ results: [] }) })).results)
      .toEqual([]); // a failure never poisons later runs (slot released, inflight cleared)
  });

  it('returns empty results as a valid 200', async () => {
    const res = await runTaskSearchAgent('nothing matches this', { engine: jsonEngine({ results: [] }) });
    expect(res.results).toEqual([]);
  });

  it('shares one engine run between concurrent identical queries', async () => {
    let calls = 0;
    const engine: AgentSearchEngine = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { response: '{"results":[]}' };
    };
    const [a, b] = await Promise.all([
      runTaskSearchAgent('Same Query here', { engine }),
      runTaskSearchAgent('same   query here', { engine }), // normalization joins them
    ]);
    expect(calls).toBe(1);
    expect(a.results).toEqual(b.results);
  });

  it('serves a second call from cache with cached:true', async () => {
    let calls = 0;
    const engine: AgentSearchEngine = async () => { calls += 1; return { response: '{"results":[]}' }; };
    await runTaskSearchAgent('cache me please', { engine });
    const second = await runTaskSearchAgent('cache me please', { engine });
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
  });

  it('rejects overflow beyond 2 active + 4 queued with 429 {code:busy}', async () => {
    const never: AgentSearchEngine = () => new Promise(() => {});
    const hung = Array.from({ length: 6 }, (_, i) =>
      runTaskSearchAgent(`distinct hung query ${i}`, { engine: never }));
    hung.forEach((p) => p.catch(() => {})); // leaked rejections fail the suite
    await new Promise((r) => setTimeout(r, 10));
    await expect(runTaskSearchAgent('one query too many', { engine: never }))
      .rejects.toMatchObject({ statusCode: 429, extra: { code: 'busy' } });
  });

  it('records usage when the engine reports a cost', async () => {
    await runTaskSearchAgent('bill this query', {
      engine: jsonEngine({ results: [] }, { costUsd: 0.0123 }),
    });
    expect(usageRecordMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'task-search-agent',
      external_cost_usd: 0.0123,
    }));
  });

  it('exposes AgentSearchError with statusCode for the route layer', () => {
    const err = new AgentSearchError('boom', 429, { code: 'busy' });
    expect(err.statusCode).toBe(429);
    expect(err.extra).toEqual({ code: 'busy' });
  });
});
