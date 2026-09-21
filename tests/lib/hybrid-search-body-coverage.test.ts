/**
 * `bodyCoverage`, the component that stops a bare title outranking a real body.
 *
 * Why it exists: FTS5's bm25() hardcodes b=0.75 and normalizes by WHOLE-ROW
 * token count, so a 12-character title reaches ~97% of the per-phrase ceiling on
 * one hit while a 22KB note is penalized 6-28x. The stub is therefore the bm25
 * BEST whatever the column weights are, which is why no weight vector fixed the
 * reported bug and why score mass had to move into a component that presence,
 * not frequency, drives.
 *
 * Ranking otherwise lives in the golden eval (scripts/search-eval.mjs), which
 * needs a corpus and a model. These cases pin the component's own contract so a
 * future weight change cannot quietly turn it into a document-length bonus.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';
import {
  BODY_COVERAGE_MIN_TERMS,
  W_BODY_COVERAGE,
} from '../../src/lib/hybrid-search/query.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

function newIndex(): SearchIndex {
  const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
  opened.push(index);
  return index;
}

/** Neutral prose, deliberately free of the query terms used below. */
const FILLER = 'The crate rides the pallet and the dock crew stacks it before the round. ';

/**
 * A corpus with a REPRESENTATIVE average row length, which these cases need for
 * two independent reasons.
 *
 * 1. The df gate is 15% of the corpus, so with a handful of docs every term is
 *    corpus-wide, `bodyCoverage` is neutral by design, and the cases go vacuous.
 * 2. bm25 normalizes by whole-row length against the CORPUS AVERAGE, so "does a
 *    long body outrank a bare stub" is meaningless without controlling that
 *    average. Measured for the stub-vs-body case below:
 *
 *      avgdl   36    stub wins
 *      avgdl   89    stub wins
 *      avgdl  177    body wins
 *      avgdl  262    body wins   <- this corpus
 *      avgdl 1830    body wins   (the real index this was diagnosed on)
 *
 * A few long rows among short ones is the real shape: 3,692 of 12,188 rows there
 * are session transcripts. A fixture of only short rows over-penalizes long
 * bodies by ~7x and mismeasures every ranking change made against it.
 */
const SHORT_ROWS = 14;
const LONG_ROWS = 6;

function padCorpus(index: SearchIndex): void {
  for (let i = 0; i < SHORT_ROWS; i++) {
    index.upsert({
      kind: 'task', ref: `pad-${i}`, title: `unrelated row ${i}`,
      note: `${FILLER}${i}`, updatedAt: Date.parse('2026-01-01'),
    });
  }
  for (let i = 0; i < LONG_ROWS; i++) {
    index.upsert({
      kind: 'task', ref: `log-${i}`, title: `shift handover ${i}`,
      note: FILLER.repeat(60) + i, updatedAt: Date.parse('2026-01-02'),
    });
  }
}

/** The pathological miniature: only short rows, i.e. a nearly empty index. */
function padCorpusShortOnly(index: SearchIndex): void {
  for (let i = 0; i < 20; i++) {
    index.upsert({
      kind: 'task', ref: `pad-${i}`, title: `unrelated row ${i}`,
      note: `${FILLER}${i}`, updatedAt: Date.parse('2026-01-01'),
    });
  }
}

function rank(index: SearchIndex, query: string): string[] {
  return index.search(query, { limit: 10 }).map((h) => h.ref);
}

function componentFor(index: SearchIndex, query: string, ref: string): number {
  const hit = index.search(query, { limit: 20 }).find((h) => h.ref === ref);
  if (!hit) throw new Error(`${ref} not in results for "${query}"`);
  return hit.components.bodyCoverage;
}

describe('bodyCoverage', () => {
  /** The reported bug, in miniature. */
  function seedStubVsBody(index: SearchIndex, pad = padCorpus): void {
    pad(index);
    index.upsert({
      kind: 'task', ref: 'stub', title: 'Test tablet reader', note: '',
      meta: 'project:app', updatedAt: Date.parse('2026-08-06'),
    });
    index.upsert({
      kind: 'task', ref: 'body', title: 'Warehouse label printer firmware',
      note: Array.from({ length: 4 }, (_, i) =>
        `${FILLER.repeat(7)}The tablet reader app build for round ${i} shipped.`).join(' '),
      meta: 'project:logistics', updatedAt: Date.parse('2026-08-05'),
    });
  }

  it('lets a substantive body outrank an empty stub whose title is the query', () => {
    const index = newIndex();
    seedStubVsBody(index);
    const order = rank(index, 'tablet reader app');
    expect(order.indexOf('body')).toBeLessThan(order.indexOf('stub'));
  });

  it('scores the body doc 1 and the empty stub 0', () => {
    const index = newIndex();
    seedStubVsBody(index);
    expect(componentFor(index, 'tablet reader app', 'body')).toBe(1);
    expect(componentFor(index, 'tablet reader app', 'stub')).toBe(0);
  });

  it('is blind to title and meta — that is the whole point', () => {
    // Every query term is present on this doc, just never in summary or note.
    const index = newIndex();
    padCorpus(index);
    index.upsert({
      kind: 'task', ref: 'handle-only', title: 'tablet reader', note: '',
      meta: 'project:app', updatedAt: Date.parse('2026-08-06'),
    });
    expect(componentFor(index, 'tablet reader app', 'handle-only')).toBe(0);
  });

  it('counts a term in the summary, not just the note', () => {
    const index = newIndex();
    padCorpus(index);
    index.upsert({
      kind: 'task', ref: 'summarised', title: 'Unrelated handle',
      summary: 'The tablet reader app rollout plan.', note: '',
      updatedAt: Date.parse('2026-08-06'),
    });
    expect(componentFor(index, 'tablet reader app', 'summarised')).toBe(1);
  });

  it('is off below the term gate, so a handle lookup still favours a bare task', () => {
    // A 1-2 term query IS the handle. Demanding body presence there would rank a
    // transcript that mentions a project above the task actually named after it.
    const index = newIndex();
    seedStubVsBody(index);
    expect(BODY_COVERAGE_MIN_TERMS).toBe(3);
    expect(componentFor(index, 'tablet reader', 'body')).toBe(0);
    expect(componentFor(index, 'tablet reader', 'stub')).toBe(0);
    const order = rank(index, 'tablet reader');
    expect(order[0]).toBe('stub');
  });

  it('ignores corpus-wide terms, so a long body cannot farm coverage from glue', () => {
    // "the" and "crate" are in every padded row, i.e. over the df cap. A doc that
    // contains ONLY those must score 0, otherwise the component degrades into
    // "is this document long".
    const index = newIndex();
    padCorpus(index);
    index.upsert({
      kind: 'task', ref: 'gluey', title: 'Long unrelated body',
      note: FILLER.repeat(30), updatedAt: Date.parse('2026-08-06'),
    });
    expect(componentFor(index, 'the crate pallet', 'gluey')).toBe(0);
  });

  it('works for CJK, where a hardcoded stopword list would do nothing', () => {
    const index = newIndex();
    padCorpus(index);
    index.upsert({
      kind: 'task', ref: 'cjk-body', title: '仓库运维手册',
      note: '灰度发布的开关由值班人员确认。'
        + '回滚流程需要审批。',
      updatedAt: Date.parse('2026-08-06'),
    });
    // Three CJK runs, so the term gate is satisfied.
    expect(componentFor(index, '灰度发布 开关 回滚', 'cjk-body'))
      .toBe(1);
  });

  it('cannot rescue a long body on a nearly EMPTY index — a known limitation', () => {
    // FTS5 hardcodes b=0.75 and normalizes by whole-row length against the corpus
    // average, so on a corpus of only short rows a long body is penalized ~7x
    // harder than on a real index and 0.2 of body coverage cannot close the gap.
    // Documented, not fixed: the principled cure is an additive doc_len table
    // feeding a length-aware correction, deliberately deferred (a third ranking
    // change in one release). A real index measures avgdl 1830, so this corner is
    // only reachable on a nearly empty one. If a future change makes the body win
    // here, that is an improvement — update this test rather than weaken it.
    const index = newIndex();
    seedStubVsBody(index, padCorpusShortOnly);
    const order = rank(index, 'tablet reader app');
    expect(order.indexOf('stub')).toBeLessThan(order.indexOf('body'));
  });

  it('carries enough weight to overturn a full bm25 deficit', () => {
    // The stub is the bm25 best by construction, so it takes the whole strict and
    // relaxed mass. bodyCoverage must exceed what that lead can be worth once the
    // mass moved out of bm25, or the component is decorative.
    expect(W_BODY_COVERAGE).toBeGreaterThan(0.1);
  });
});
