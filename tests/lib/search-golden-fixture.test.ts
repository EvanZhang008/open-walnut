/**
 * The committed golden fixture (tests/search-golden.yaml) runs in the suite, against the engine
 * with PRODUCTION's kind config (SEARCH_V2_KIND_WEIGHTS). 2026-10-28: a ranking change
 * (noteOnlyCoverage) broke body-density-outranks-bare-title, and only the Mac's manual eval saw
 * it, because no test ran the fixture. Same assertions as scripts/search-eval.mjs, minus latency
 * (a wall-clock budget is the eval's to judge on a quiet machine).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';
import { SEARCH_V2_KIND_WEIGHTS } from '../../src/core/search/wiring.js';
import { isLedgerJunk } from '../../src/core/task-junk.js';

const yaml = createRequire(import.meta.url)('js-yaml') as { load(s: string): unknown };

interface Query {
  id: string; family?: string; query: string; dataset?: string;
  must_include?: string[]; must_include_any?: string[]; top1?: string; top1_kind?: string;
  must_rank_above?: [string, string][]; must_exclude?: string[]; min_coverage?: number;
}
interface CorpusDoc { kind: string; ref: string; title?: string; summary?: string; note?: string; meta?: string; project?: string; updated_at?: string; identifiers?: string[] }

const golden = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'search-golden.yaml'), 'utf8')) as { corpus: CorpusDoc[]; queries: Query[] };
const queries = golden.queries.filter((q) => q.dataset !== 'live');

let index: SearchIndex;
function fixtureIndex(): SearchIndex {
  if (index) return index;
  index = createSearchIndex({ dbPath: ':memory:', kinds: SEARCH_V2_KIND_WEIGHTS });
  for (const doc of golden.corpus) {
    // Production drops junk before it is indexed (serializers.ts); the eval does the same.
    if ((doc.kind === 'task' || doc.kind === 'session') && isLedgerJunk({ project: doc.project ?? '', title: doc.title ?? '' } as never)) continue;
    index.upsert({
      kind: doc.kind, ref: doc.ref, title: doc.title ?? '', summary: doc.summary ?? '', note: doc.note ?? '',
      meta: doc.meta ?? '', updatedAt: Date.parse(String(doc.updated_at ?? '')) || 0, identifiers: doc.identifiers,
    });
  }
  return index;
}
afterAll(() => { try { index?.close(); } catch { /* closed */ } });

function failuresOf(q: Query): string[] {
  const hits = fixtureIndex().search(q.query, { limit: 10 }).map((h) => ({ ref: `${h.kind}:${h.ref}`, coverage: h.components.coverage }));
  const rank = (ref: string) => { const i = hits.findIndex((h) => h.ref === ref); return i < 0 ? null : i + 1; };
  const out: string[] = [];
  for (const ref of q.must_include ?? []) if (rank(ref) === null) out.push(`must_include missing: ${ref}`);
  if (q.must_include_any?.length && !q.must_include_any.some((r) => rank(r) !== null)) out.push('must_include_any: none found');
  if (q.top1 && hits[0]?.ref !== q.top1) out.push(`top1 is ${hits[0]?.ref}, wanted ${q.top1}`);
  if (q.top1_kind && hits[0]?.ref.split(':')[0] !== q.top1_kind) out.push(`top1_kind is ${hits[0]?.ref}`);
  for (const [above, below] of q.must_rank_above ?? []) {
    const ra = rank(above); const rb = rank(below);
    if (ra === null) out.push(`must_rank_above: ${above} not in results`);
    else if (rb !== null && ra >= rb) out.push(`must_rank_above: ${above} (#${ra}) not above ${below} (#${rb})`);
  }
  for (const ref of q.must_exclude ?? []) if (rank(ref) !== null) out.push(`must_exclude: ${ref} at #${rank(ref)}`);
  if (typeof q.min_coverage === 'number') {
    const best = [...(q.must_include ?? []), ...(q.must_include_any ?? [])].map(rank).filter((r): r is number => r !== null).sort((a, b) => a - b)[0];
    const cov = best ? hits[best - 1]?.coverage : undefined;
    if (typeof cov === 'number' && cov < q.min_coverage) out.push(`coverage ${cov.toFixed(2)} < ${q.min_coverage}`);
  }
  return out;
}

describe('search golden fixture (tests/search-golden.yaml)', () => {
  it('has fixture queries to run', () => expect(queries.length).toBeGreaterThan(10));
  for (const q of queries) {
    it(`${q.family ?? 'case'}: ${q.id}`, () => expect(failuresOf(q)).toEqual([]));
  }
});
