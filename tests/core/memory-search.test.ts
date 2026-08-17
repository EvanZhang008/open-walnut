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

import { memoryNotesSearch, buildLexQueries } from '../../src/core/memory-search.js';
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

  it('4.9: low-score results are filtered (MIN_SCORE) — reranked scores only', async () => {
    // The MIN_RERANKED_BLEND_SCORE floor is meaningful ONLY for reranked scores
    // (QMD's blend of RRF position and reranker relevance). Without reranking QMD
    // scores a hit as 1/rank — 1.0, 0.5, 0.33, 0.25 … — so applying a 0.15 floor
    // there would silently truncate EVERY result set to six rows. That is why the
    // filter is gated on the rerank flag, and why this test must opt in explicitly
    // now that rerank defaults to false.
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Noise', bestChunk: 'barely related', score: 0.05 },
    ]);
    const results = await memoryNotesSearch('some query', ['memory_daily'], 15, undefined, {
      rerank: true,
    });
    expect(results).toEqual([]);
  });

  it('4.9b: the reranked-score floor is NOT applied to un-reranked 1/rank scores', async () => {
    // Guard for the inverse trap: a 1/rank score of 0.05 (rank 20) is a legitimate
    // tail result, not noise, and must survive when reranking is off.
    qmdStore.__setMockMemoryResults([
      { file: dailyVPath(0), title: 'Tail hit', bestChunk: 'still relevant', score: 0.05 },
    ]);
    const results = await memoryNotesSearch('some query', ['memory_daily']);
    expect(results.length).toBeGreaterThan(0);
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

  it('DISABLES QMD reranking by default — the safe-by-construction default', async () => {
    // This test asserted `rerank: true` until 2026-08-12. Inverted deliberately:
    // QMD's reranker is a native llama.cpp cross-encoder that BLOCKS the Node event
    // loop while scoring, and every caller lives in the web server process (the
    // agent loop is imported directly by src/web/server.ts, not run in a worker).
    // A true-by-default therefore meant any new caller silently opted the whole app
    // into a multi-second freeze. Measured: memory_notes_search 28.7s with a 2949ms
    // stall; /api/search?types=memory 13-20s with an 11026ms stall.
    //
    // Quality cost of the flip, A/B over 8 real queries: the #1 result was
    // IDENTICAL every time — only mid/tail ordering moves.
    await memoryNotesSearch('deployment history', ['memory_daily']);

    expect(qmdStore.__getMockStore().search).toHaveBeenCalledWith(
      expect.objectContaining({
        rerank: false,
      }),
    );
  });

  it('still honors an EXPLICIT opt-in to reranking', async () => {
    // Off-by-default must not mean unreachable: a caller that is genuinely off the
    // event loop (e.g. a worker) can still ask for the quality pass.
    await memoryNotesSearch('deployment history', ['memory_daily'], 15, undefined, {
      rerank: true,
    });

    expect(qmdStore.__getMockStore().search).toHaveBeenCalledWith(
      expect.objectContaining({ rerank: true }),
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

describe('buildLexQueries — mixed CJK/Latin lex splitting', () => {
  it('pure English query at the relax threshold gains a relaxed list', () => {
    // CONTRACT CHANGE (follow-up to the 2026-08-15 star hunt): 4+ content
    // words used to pass through verbatim and AND-annihilate; now the
    // original list is joined by one relaxed most-selective-words list.
    expect(buildLexQueries('hook api error timeout')).toEqual([
      'hook api error timeout',
      'hook error timeout',
    ]);
  });

  it('short pure-English query is unchanged', () => {
    expect(buildLexQueries('hook timeout')).toEqual(['hook timeout']);
  });

  it('pure CJK query is unchanged', () => {
    expect(buildLexQueries('自动重试')).toEqual(['自动重试']);
  });

  it('mixed query splits into original + latin residue + CJK runs', () => {
    expect(buildLexQueries('timeout 自动重试')).toEqual([
      'timeout 自动重试',
      'timeout',
      '自动重试',
    ]);
  });

  it('multiple CJK runs each become their own query', () => {
    expect(buildLexQueries('daemon 崩溃 重启失败')).toEqual([
      'daemon 崩溃 重启失败',
      'daemon',
      '崩溃',
      '重启失败',
    ]);
  });

  it('CJK embedded without spaces still splits', () => {
    expect(buildLexQueries('修复timeout问题')).toEqual([
      '修复timeout问题',
      'timeout',
      '修复',
      '问题',
    ]);
  });

  it('single-char CJK runs are not emitted as standalone queries', () => {
    expect(buildLexQueries('timeout 查 bedrock')).toEqual([
      'timeout 查 bedrock',
      'timeout bedrock',
    ]);
  });

  it('preserves operator queries verbatim (quotes / negation)', () => {
    expect(buildLexQueries('"exact 短语" timeout')).toEqual(['"exact 短语" timeout']);
    expect(buildLexQueries('timeout -自动')).toEqual(['timeout -自动']);
  });

  it('long pure-Latin queries get one relaxed list of the most selective words', () => {
    const out = buildLexQueries('deprecate star system use pin focus instead');
    expect(out[0]).toBe('deprecate star system use pin focus instead');
    expect(out).toHaveLength(2);
    // stopwords (use, instead) dropped; 3 longest content words, query order
    expect(out[1]).toBe('deprecate system focus');
  });

  it('short pure-Latin queries stay single-list', () => {
    expect(buildLexQueries('star system')).toEqual(['star system']);
    expect(buildLexQueries('retire star system')).toEqual(['retire star system']);
  });

  it('all-stopword Latin queries stay single-list', () => {
    expect(buildLexQueries('how to do this and that')).toEqual(['how to do this and that']);
  });

  it('empty and blank queries return []', () => {
    expect(buildLexQueries('')).toEqual([]);
    expect(buildLexQueries('   ')).toEqual([]);
  });

  it('caps the number of emitted lex queries', () => {
    const q = 'x 一二 三四 五六 七八 九十 十一 十二';
    expect(buildLexQueries(q).length).toBeLessThanOrEqual(6);
  });

  it('sends split lex queries to the QMD store for mixed input', async () => {
    qmdStore.__setMockMemoryResults([
      { file: 'qmd://global/a.md', title: 'A', bestChunk: 'x', score: 0.9 },
    ]);
    await memoryNotesSearch('timeout 自动重试', ['memory_global']);
    const store = qmdStore.__getMockStore();
    const lastCall = store.search.mock.calls.at(-1)![0];
    const lexQueries = lastCall.queries.filter((q: { type: string }) => q.type === 'lex').map((q: { query: string }) => q.query);
    const vecQueries = lastCall.queries.filter((q: { type: string }) => q.type === 'vec').map((q: { query: string }) => q.query);
    expect(lexQueries).toEqual(['timeout 自动重试', 'timeout', '自动重试']);
    // vec stays a single whole-sentence query — splitting only fixes the FTS lane
    expect(vecQueries).toEqual(['timeout 自动重试']);
  });
});

describe('cjk helpers', () => {
  it('splitQueryTerms: latin words + CJK runs, single-char fragments dropped', async () => {
    const { splitQueryTerms } = await import('../../src/core/cjk.js');
    expect(splitQueryTerms('timeout 自动重试')).toEqual(['timeout', '自动重试']);
    expect(splitQueryTerms('修复timeout问题')).toEqual(['timeout', '修复', '问题']);
    expect(splitQueryTerms('timeout 查')).toEqual(['timeout']);
    expect(splitQueryTerms('hook api')).toEqual(['hook', 'api']);
    expect(splitQueryTerms('')).toEqual([]);
  });

  it('isMixedScriptQuery: true only when CJK and non-CJK coexist', async () => {
    const { isMixedScriptQuery } = await import('../../src/core/cjk.js');
    expect(isMixedScriptQuery('timeout 自动重试')).toBe(true);
    expect(isMixedScriptQuery('自动重试')).toBe(false);
    expect(isMixedScriptQuery('timeout retry')).toBe(false);
  });
});

describe('FTS5 unicode61 tokenizer contract (root cause of mixed-query rank collapse)', () => {
  // QMD indexes with tokenize='porter unicode61' and compiles each query term
  // to `"term"* AND …`. unicode61 keeps a contiguous CJK run as ONE token, so
  // a CJK query term only matches when it PREFIXES the whole indexed run.
  // These tests pin that engine behavior; if a QMD upgrade changes tokenization
  // (e.g. adds a CJK segmenter), they fail and buildLexQueries can be retired.
  it('mixed AND query misses docs whose CJK run has a leading char, split queries hit', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='porter unicode61')");
    db.prepare('INSERT INTO t VALUES (?)').run(
      '请求 timeout 频发 — 查 Claude Code 能否自动重试;是否 bedrock proxy 引起',
    );
    const count = (m: string): number =>
      (db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(m) as { c: number }).c;

    // The doc's CJK run indexes as one token '能否自动重试'
    expect(count('"能否自动重试"*')).toBe(1);
    // …so the un-split mixed query annihilates via AND (this is the bug)
    expect(count('"timeout"* AND "自动重试"*')).toBe(0);
    // …while the split queries keep the keyword lane alive
    expect(count('"timeout"*')).toBe(1);
    db.close();
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
