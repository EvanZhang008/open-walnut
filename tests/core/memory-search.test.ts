import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

/**
 * Suite 4: Memory Search Core (Unit)
 *
 * QMD models (~2GB) may not be available. We mock the QMD store layer
 * and test the pure post-processing logic: source weights, temporal decay,
 * the 60/40 memory/notes split, collection filtering, and path-prefix scoping.
 *
 * Mock mirrors the REAL QMD store API used by memory-search.ts:
 *  - store.search({ queries, limit, rerank }) → flat ranked list across ALL
 *    collections, `file` is a virtual path `qmd://<collection>/<rel-path>`
 *  - store.internal.resolveVirtualPath(virtualPath) → absolute path
 */

type MockResult = { file: string; title: string; bestChunk: string; score: number };

vi.mock('../../src/core/qmd-store.js', () => {
  let mockMemoryResults: MockResult[] = [];
  let mockNotesResults: MockResult[] = [];
  let mockTaskResults: MockResult[] = [];

  const makeStore = (getResults: () => MockResult[], root: string) => ({
    search: vi.fn(async ({ limit }: { limit: number }) => getResults().slice(0, limit)),
    internal: {
      // qmd://daily/2026-07-01.md → /abs/<root>/daily/2026-07-01.md
      resolveVirtualPath: (vp: string) => vp.replace(/^qmd:\/\//, `${root}/`),
    },
  });

  const mockStore = makeStore(() => mockMemoryResults, '/abs/memory');
  const mockNotesStore = makeStore(() => mockNotesResults, '/abs/notes');
  const mockTaskStore = makeStore(() => mockTaskResults, '/abs/task');
  const mockSessionStore = makeStore(() => [], '/abs/session');

  return {
    getMemoryStore: vi.fn(async () => mockStore),
    getNotesStore: vi.fn(async () => mockNotesStore),
    getTaskStore: vi.fn(async () => mockTaskStore),
    getSessionStore: vi.fn(async () => mockSessionStore),
    closeQmdStores: vi.fn(),
    __setMockMemoryResults: (r: MockResult[]) => { mockMemoryResults = r; },
    __setMockNotesResults: (r: MockResult[]) => { mockNotesResults = r; },
    __setMockTaskResults: (r: MockResult[]) => { mockTaskResults = r; },
    __getMockStore: () => mockStore,
    __getMockNotesStore: () => mockNotesStore,
    __getMockTaskStore: () => mockTaskStore,
  };
});

import { memoryNotesSearch } from '../../src/core/memory-search.js';
import { reserveQmdIndexWork } from '../../src/core/qmd-work-queue.js';

const qmdStore = await import('../../src/core/qmd-store.js') as unknown as {
  __setMockMemoryResults: (r: MockResult[]) => void;
  __setMockNotesResults: (r: MockResult[]) => void;
  __setMockTaskResults: (r: MockResult[]) => void;
  __getMockStore: () => { search: ReturnType<typeof vi.fn> };
  __getMockNotesStore: () => { search: ReturnType<typeof vi.fn> };
  __getMockTaskStore: () => { search: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  qmdStore.__setMockMemoryResults([]);
  qmdStore.__setMockNotesResults([]);
  qmdStore.__setMockTaskResults([]);
  qmdStore.__getMockStore().search.mockClear();
  qmdStore.__getMockNotesStore().search.mockClear();
  qmdStore.__getMockTaskStore().search.mockClear();
});

/** Helper: virtual path in the daily collection dated N days ago. */
function dailyVPath(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const key = d.toISOString().slice(0, 10);
  return `qmd://daily/${key}.md`;
}

describe('memoryNotesSearch', () => {
  it('4.1: results carry resolved absolute paths + source/collection from virtual path', async () => {
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Today', bestChunk: 'some content', score: 0.8 },
    ]);

    const results = await memoryNotesSearch('some query', ['memory_daily']);
    expect(results).toHaveLength(1);
    expect(results[0].filepath).toMatch(/^\/abs\/memory\/daily\//);
    expect(results[0].source).toBe('memory_daily');
    expect(results[0].collection).toBe('daily');
  });

  it('4.2: default search hits memory store only (no notes)', async () => {
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Today', bestChunk: 'Memory v2 search', score: 0.8 },
    ]);
    qmdStore.__setMockNotesResults([
      { file: 'qmd://vault/Areas/Finance/tax.md', title: 'Tax', bestChunk: 'Tax filing 2025', score: 0.9 },
    ]);

    const results = await memoryNotesSearch('tax');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).not.toMatch(/^note_/);
    }
    expect(qmdStore.__getMockNotesStore().search).not.toHaveBeenCalled();
  });

  it('4.3: explicit notes search works', async () => {
    qmdStore.__setMockNotesResults([
      { file: 'qmd://vault/Areas/Finance/tax.md', title: 'Tax', bestChunk: 'Tax filing 2025', score: 0.9 },
    ]);

    const results = await memoryNotesSearch('tax', ['note_vault']);
    expect(results.length).toBe(1);
    expect(results[0].source).toBe('note_vault');
    expect(results[0].filepath).toContain('tax.md');
  });

  it('4.4: mixed memory+notes search uses 60/40 split', async () => {
    qmdStore.__setMockMemoryResults(Array.from({ length: 10 }, (_, i) => ({
      file: dailyVPath(i),
      title: `Daily ${i}`,
      bestChunk: 'infrastructure setup',
      score: 0.8 - i * 0.01,
    })));
    qmdStore.__setMockNotesResults(Array.from({ length: 10 }, (_, i) => ({
      file: `qmd://vault/Areas/notes-${i}.md`,
      title: `Note ${i}`,
      bestChunk: 'infrastructure design',
      score: 0.8 - i * 0.01,
    })));

    const results = await memoryNotesSearch('infrastructure', ['memory_daily', 'note_vault'], 10);
    const memCount = results.filter(r => r.source.startsWith('memory_')).length;
    const noteCount = results.filter(r => r.source.startsWith('note_')).length;

    expect(memCount).toBeLessThanOrEqual(6);
    expect(noteCount).toBeLessThanOrEqual(4);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('4.5: per-source weights affect ranking (skill 1.2 > daily 1.0)', async () => {
    qmdStore.__setMockMemoryResults([
      { file: 'qmd://skill/finance/tax-filing/SKILL.md', title: 'Tax filing', bestChunk: 'Kubernetes deployment pipeline', score: 0.8 },
      { file: dailyVPath(0), title: 'Today', bestChunk: 'Kubernetes deployment pipeline', score: 0.8 },
    ]);

    const results = await memoryNotesSearch('Kubernetes deployment pipeline', ['memory_skill', 'memory_daily']);
    const skillResult = results.find(r => r.source === 'memory_skill');
    const dailyResult = results.find(r => r.source === 'memory_daily');

    expect(skillResult).toBeDefined();
    expect(dailyResult).toBeDefined();
    expect(skillResult!.finalScore).toBeGreaterThan(dailyResult!.finalScore);
  });

  it('4.6: temporal decay: recent daily log outranks old one', async () => {
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Recent', bestChunk: 'Refactored search module', score: 0.8 },
      { file: dailyVPath(60), title: 'Old', bestChunk: 'Refactored search module', score: 0.8 },
    ]);

    const results = await memoryNotesSearch('Refactored search module', ['memory_daily']);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Recent');
    expect(results[0].finalScore).toBeGreaterThan(results[1].finalScore);
  });

  it('4.7: collection post-filter drops results outside requested collections', async () => {
    qmdStore.__setMockMemoryResults([
      { file: 'qmd://skill/walnut/overview/SKILL.md', title: 'Walnut overview', bestChunk: 'deployment', score: 0.9 },
      { file: dailyVPath(0), title: 'Daily', bestChunk: 'deployment', score: 0.9 },
    ]);

    const results = await memoryNotesSearch('deployment', ['memory_skill']);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('memory_skill');
  });

  it('4.8: search with no results returns empty array', async () => {
    const results = await memoryNotesSearch('xyznonexistenttermzzz');
    expect(results).toEqual([]);
  });

  it('4.9: low-score results are filtered (MIN_SCORE)', async () => {
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Noise', bestChunk: 'barely related', score: 0.05 },
    ]);
    const results = await memoryNotesSearch('some query', ['memory_daily']);
    expect(results).toEqual([]);
  });

  it('4.11: result shape has all expected fields', async () => {
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Today', bestChunk: 'some content', score: 0.8 },
    ]);

    const results = await memoryNotesSearch('some query', ['memory_daily']);
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(typeof r.filepath).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.snippet).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(typeof r.finalScore).toBe('number');
      expect(typeof r.source).toBe('string');
      expect(typeof r.collection).toBe('string');
    }
  });

  it('enables QMD reranking by default for ordinary memory search', async () => {
    await memoryNotesSearch('deployment history', ['memory_daily']);

    expect(qmdStore.__getMockStore().search).toHaveBeenCalledWith(
      expect.objectContaining({
        rerank: true,
      }),
    );
  });

  it('uses the requested low-latency QMD options for interactive task search', async () => {
    await memoryNotesSearch(
      'career accomplishments',
      ['task'],
      40,
      undefined,
      { rerank: false, overfetchMultiplier: 1 },
    );

    expect(qmdStore.__getMockTaskStore().search).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 40,
        rerank: false,
      }),
    );
  });

  it('keeps lower-ranked results when reranking is disabled', async () => {
    qmdStore.__setMockTaskResults(Array.from({ length: 10 }, (_, index) => ({
      file: `qmd://tasks/task-semantic-rank-${index + 1}`,
      title: `Semantic result ${index + 1}`,
      bestChunk: 'Conceptually related content',
      score: 1 / (index + 1),
    })));

    const results = await memoryNotesSearch(
      'conceptual query',
      ['task'],
      10,
      undefined,
      { rerank: false, overfetchMultiplier: 1 },
    );

    expect(results).toHaveLength(10);
    expect(results.at(-1)?.taskId).toBe('semantic-rank-10');
  });

  it('searches the committed snapshot while an ordinary worker is reserved', async () => {
    qmdStore.__setMockTaskResults([{
      file: 'qmd://tasks/task-existing-result',
      title: 'Existing result',
      bestChunk: 'Already committed semantic content',
      score: 1,
    }]);
    const reservation = reserveQmdIndexWork();

    try {
      await reservation.drained;
      const results = await memoryNotesSearch(
        'committed semantic content',
        ['task'],
        10,
        undefined,
        { rerank: false },
      );
      expect(results.map((result) => result.taskId))
        .toContain('existing-result');
    } finally {
      reservation.release();
    }
  });
});

describe('memoryNotesSearch path prefix filter', () => {
  const skillResults: MockResult[] = [
    { file: 'qmd://skill/walnut/overview/SKILL.md', title: 'Walnut overview', bestChunk: 'project direction', score: 0.9 },
    { file: 'qmd://skill/walnut/overview/history/log.md', title: 'Walnut history', bestChunk: 'migration abandoned plan A', score: 0.85 },
    { file: 'qmd://skill/finance/tax-filing/SKILL.md', title: 'Tax filing', bestChunk: 'tax deadlines', score: 0.8 },
  ];

  it('path narrows to a category subtree (collection-relative)', async () => {
    qmdStore.__setMockMemoryResults(skillResults);

    const results = await memoryNotesSearch('anything', ['memory_skill'], 15, 'walnut/');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.filepath).toContain('/walnut/');
    }
  });

  it('path narrows to overview history only', async () => {
    qmdStore.__setMockMemoryResults(skillResults);

    const results = await memoryNotesSearch('anything', ['memory_skill'], 15, 'walnut/overview/history/');
    expect(results).toHaveLength(1);
    expect(results[0].filepath).toContain('history/log.md');
  });

  it('leading ./ and / are normalized off the prefix', async () => {
    qmdStore.__setMockMemoryResults(skillResults);

    const a = await memoryNotesSearch('anything', ['memory_skill'], 15, './walnut/');
    const b = await memoryNotesSearch('anything', ['memory_skill'], 15, '/walnut/');
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });

  it('date prefix on daily acts as a time filter', async () => {
    qmdStore.__setMockMemoryResults([
      { file: 'qmd://daily/2026-06-15.md', title: 'June', bestChunk: 'x', score: 0.8 },
      { file: 'qmd://daily/2026-07-01.md', title: 'July', bestChunk: 'x', score: 0.8 },
    ]);

    const results = await memoryNotesSearch('x', ['memory_daily'], 15, '2026-06');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('June');
  });

  it('empty/undefined path is a no-op', async () => {
    qmdStore.__setMockMemoryResults(skillResults);

    const none = await memoryNotesSearch('anything', ['memory_skill'], 15, undefined);
    const blank = await memoryNotesSearch('anything', ['memory_skill'], 15, '');
    expect(none).toHaveLength(3);
    expect(blank).toHaveLength(3);
  });

  it('non-matching prefix returns empty, not an error', async () => {
    qmdStore.__setMockMemoryResults(skillResults);

    const results = await memoryNotesSearch('anything', ['memory_skill'], 15, 'gaming/');
    expect(results).toEqual([]);
  });

  it('applies to notes store too', async () => {
    qmdStore.__setMockNotesResults([
      { file: 'qmd://vault/Areas/Health/sleep.md', title: 'Sleep', bestChunk: 'x', score: 0.8 },
      { file: 'qmd://vault/Projects/walnut.md', title: 'Walnut', bestChunk: 'x', score: 0.8 },
    ]);

    const results = await memoryNotesSearch('x', ['note_vault'], 15, 'Areas/Health/');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Sleep');
  });
});
