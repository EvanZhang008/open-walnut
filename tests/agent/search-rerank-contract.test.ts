/**
 * Agent search rerank contract.
 *
 * HISTORY — this file previously asserted the OPPOSITE ("preserves the core
 * default reranker"), on the reasoning that an agent tool call isn't a
 * keystroke path so it can afford the quality pass. That reasoning was wrong,
 * and measurement is why:
 *
 *   - The agent loop runs INSIDE the web server process (`src/web/server.ts`
 *     imports `agent/loop.js` directly). It is not a worker.
 *   - The reranker of the day was a native llama.cpp cross-encoder, so it
 *     BLOCKED the Node event loop while scoring — the same failure class as any
 *     sync native call.
 *   - Measured on a real vault: `memory_notes_search` 28.7s with a 2949ms
 *     event-loop stall; `task_search` 14.7s with a 609ms stall. Every Personal AI
 *     tool call therefore froze every route for every surface (web, iOS, cloud).
 *   - Quality delta was negligible where it counts: across 8 A/B probe queries
 *     the #1 result was IDENTICAL every time; only mid/tail order shifted.
 *     Total latency was 46x.
 *
 * The contract survives the engine swap: both agent search tools answer from the
 * index lane (`searchV2Lane`), whose semantic rescore runs in a worker thread
 * under a deadline, and neither may hand it any knob that reintroduces an
 * in-process scoring pass. The option surface is the guard — a future `rerank`
 * (or any other new key) reaching the lane from a tool fails these tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const mocks = vi.hoisted(() => ({
  searchV2Lane: vi.fn(),
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('search-rerank-contract-test'));

vi.mock('../../src/core/search/wiring.js', () => ({
  searchV2Lane: mocks.searchV2Lane,
  isSearchV2Enabled: () => true,
}));

import { tools } from '../../src/agent/tools.js';

const taskSearchTool = tools.find(tool => tool.name === 'task_search')!;
const memoryNotesSearchTool = tools.find(tool => tool.name === 'memory_notes_search')!;

/** Everything the lane accepts. Anything else is a new scoring knob. */
const ALLOWED_OPTION_KEYS = ['kinds', 'limit', 'semanticDeadlineMs'];

function optionsOf(call: unknown[]): Record<string, unknown> {
  return (call[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  mocks.searchV2Lane.mockReset().mockResolvedValue([]);
});

describe('agent search rerank contract', () => {
  it('task_search asks the index lane for tasks and passes no scoring knob', async () => {
    const queries = ['find the deployment task', 'deployment task'];

    await taskSearchTool.execute({ queries, limit: 7 });

    // One lane call per query (results merge on best score per task).
    expect(mocks.searchV2Lane).toHaveBeenCalledTimes(2);
    for (const [i, call] of mocks.searchV2Lane.mock.calls.entries()) {
      expect(call[0]).toBe(queries[i]);
      expect(optionsOf(call)).toEqual({ kinds: ['task'], limit: 7 });
    }
  });

  it('memory_notes_search asks the index lane and passes no scoring knob', async () => {
    const queries = ['when did we deploy', 'deployment history'];

    await memoryNotesSearchTool.execute({
      queries,
      sources: ['memory_daily'],
      limit: 6,
      path: '2026-07',
    });

    expect(mocks.searchV2Lane).toHaveBeenCalledTimes(2);
    for (const [i, call] of mocks.searchV2Lane.mock.calls.entries()) {
      expect(call[0]).toBe(queries[i]);
      // `sources` and `path` are the tool's own filters, applied to the hits —
      // they are not lane options. limit is over-fetched 2x for that filtering.
      expect(optionsOf(call)).toEqual({ kinds: ['memory'], limit: 12 });
    }
  });

  it('no agent search tool ever hands the lane an unknown option', async () => {
    // Belt-and-braces over both tools: whatever else changes about the call
    // shape, an in-process quality pass would need a new option to ride in on.
    await taskSearchTool.execute({ queries: ['a'], limit: 3 });
    await memoryNotesSearchTool.execute({ queries: ['b'], limit: 3 });

    expect(mocks.searchV2Lane.mock.calls.length).toBeGreaterThan(0);
    for (const call of mocks.searchV2Lane.mock.calls) {
      for (const key of Object.keys(optionsOf(call))) {
        expect(ALLOWED_OPTION_KEYS).toContain(key);
      }
    }
  });
});
