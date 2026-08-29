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
 *   - QMD's reranker is a native llama.cpp cross-encoder, so it BLOCKS the Node
 *     event loop while scoring — the same failure class as any sync native call.
 *   - Measured on a real vault: `memory_notes_search` 28.7s with a 2949ms
 *     event-loop stall; `task_search` 14.7s with a 609ms stall. Every Personal AI
 *     tool call therefore froze every route for every surface (web, iOS, cloud).
 *   - Quality delta was negligible where it counts: across 8 A/B probe queries
 *     the #1 result was IDENTICAL every time; only mid/tail order shifted.
 *     Total latency was 46x.
 *
 * So the contract is now the reverse: interactive AND agent callers must not
 * rerank. `MemorySearchOptions.rerank` defaults to false for this reason, and
 * these tests pin BOTH the explicit flag at the call sites and the safe default
 * in the core — either alone can regress silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The contract under test is the QMD lane's rerank:false; search v2 went
// default-ON (f395723a) and routes task_search elsewhere. Pin the flag so the
// QMD path stays covered until Phase 4 retires it.
process.env.WALNUT_SEARCH_V2 = '0';
import { createMockConstants } from '../helpers/mock-constants.js';

const mocks = vi.hoisted(() => ({
  memoryNotesSearch: vi.fn(),
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('search-rerank-contract-test'));

vi.mock('../../src/core/memory-search.js', () => ({
  memoryNotesSearch: mocks.memoryNotesSearch,
}));

import { tools } from '../../src/agent/tools.js';

const taskSearchTool = tools.find(tool => tool.name === 'task_search')!;
const memoryNotesSearchTool = tools.find(tool => tool.name === 'memory_notes_search')!;

/** The options object every event-loop-bound caller must pass. */
function optionsOf(call: unknown[]): unknown {
  return call[4];
}

beforeEach(() => {
  mocks.memoryNotesSearch.mockReset().mockResolvedValue([]);
});

describe('agent search rerank contract', () => {
  it('task_search disables the reranker (it would stall the shared event loop)', async () => {
    const queries = ['find the deployment task', 'deployment task'];

    await taskSearchTool.execute({ queries, limit: 7 });

    expect(mocks.memoryNotesSearch).toHaveBeenCalledOnce();
    const call = mocks.memoryNotesSearch.mock.calls[0];
    expect(call.slice(0, 3)).toEqual([queries, ['task'], 7]);
    expect(optionsOf(call)).toMatchObject({ rerank: false });
  });

  it('memory_notes_search disables the reranker (worst measured offender: 28.7s)', async () => {
    const queries = ['when did we deploy', 'deployment history'];

    await memoryNotesSearchTool.execute({
      queries,
      sources: ['memory_daily'],
      limit: 6,
      path: '2026-07',
    });

    expect(mocks.memoryNotesSearch).toHaveBeenCalledOnce();
    const call = mocks.memoryNotesSearch.mock.calls[0];
    expect(call.slice(0, 4)).toEqual([queries, ['memory_daily'], 6, '2026-07']);
    expect(optionsOf(call)).toMatchObject({ rerank: false });
  });

  it('no agent search tool ever enables the reranker', async () => {
    // Belt-and-braces over both tools: whatever else changes about the call
    // shape, `rerank: true` must never reach the core from an agent tool.
    await taskSearchTool.execute({ queries: ['a'], limit: 3 });
    await memoryNotesSearchTool.execute({ queries: ['b'], limit: 3 });

    for (const call of mocks.memoryNotesSearch.mock.calls) {
      const opts = optionsOf(call) as { rerank?: boolean } | undefined;
      expect(opts?.rerank).not.toBe(true);
    }
  });
});

describe('core default is safe-by-construction', () => {
  it('rerank defaults to FALSE so a new caller cannot accidentally freeze the app', async () => {
    // The real module (not the mock) — this is the guard that matters most: the
    // old default was `true`, so every future caller that forgets the flag used
    // to opt itself into an app-wide event-loop stall.
    vi.resetModules();
    vi.doUnmock('../../src/core/memory-search.js');

    const storeSearch = vi.fn().mockResolvedValue([]);
    vi.doMock('../../src/core/qmd-store.js', () => {
      const store = {
        search: storeSearch,
        internal: { resolveVirtualPath: (p: string) => p },
      };
      return {
        getMemoryStore: vi.fn(async () => store),
        getNotesStore: vi.fn(async () => store),
        getTaskStore: vi.fn(async () => store),
        getSessionStore: vi.fn(async () => store),
      };
    });

    const { memoryNotesSearch } = await import('../../src/core/memory-search.js');
    await memoryNotesSearch('anything', ['task'], 5); // no options passed at all

    expect(storeSearch).toHaveBeenCalled();
    expect(storeSearch.mock.calls[0][0]).toMatchObject({ rerank: false });
  });
});
