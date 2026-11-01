/**
 * A shortened word anywhere in a multi-word query (2026-10-31).
 *
 * The reported case: a first name typed as its first three letters beside
 * "picnic" did not find the task titled with the full name and "picnic",
 * while the full name ranked it first. Only the LAST word of a query was ever
 * read as cut off, and only when the index held it in at most 20 docs. The
 * short form was the first word and a word of its own in 136 docs, so it was
 * never read as the name, and the strict lane asked for a doc holding the short
 * form and "picnic" literally. These cases pin the reading in
 * every position, the rule that picks the ending a title names beside the rest
 * of the query (not the commonest one), and the gates that keep a word as typed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

const DAY = Date.parse('2026-09-01');

/**
 * A corpus where "mar" is a common word on its own (a month in 25 standup
 * notes, two of which also say "picnic"), and the commonest word it begins,
 * "market", sits beside "picnic" more often than "marina" does (3 docs to
 * 2), so ranking the endings by co-occurrence COUNT picks the wrong one. The
 * pad rows keep both words under the df gate.
 */
function picnicIndex(extra: (index: SearchIndex) => void = () => {}, pads = 200): SearchIndex {
  const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
  opened.push(index);
  const put = (ref: string, title: string, note = '') =>
    index.upsert({ kind: 'task', ref, title, note, updatedAt: DAY });
  for (let i = 0; i < pads; i++) put(`pad-${i}`, `unrelated row ${i}`, `the crate rides the pallet ${i}`);
  for (let i = 0; i < 25; i++) {
    put(`standup-${i}`, `Standup notes ${i}`, i < 2 ? `mar ${i} agenda, budget for the picnic` : `mar ${i} agenda`);
  }
  for (let i = 0; i < 40; i++) {
    put(`market-${i}`, `Weekly report ${i}`, i < 3 ? `market numbers and the picnic plan ${i}` : `market numbers ${i}`);
  }
  for (let i = 0; i < 4; i++) put(`marina-${i}`, `Berth booking ${i}`, `marina dock fees ${i}`);
  put('packet', 'Picnic basket review', 'basket list for Marina, due next week');
  put('target', 'Marina Lopez picnic planning', 'collect the guest list');
  for (let i = 0; i < 6; i++) put(`pic-${i}`, `Picnic season notes ${i}`, `weather ${i}`);
  extra(index);
  return index;
}

const hitOf = (index: SearchIndex, query: string, ref: string) =>
  index.search(query, { limit: 40 }).find((h) => h.ref === ref);
const rankOf = (index: SearchIndex, query: string, ref: string) =>
  index.search(query, { limit: 40 }).findIndex((h) => h.ref === ref);

describe('a shortened common word', () => {
  // First, middle and last position: the reading must not depend on where the word sits.
  it.each([
    ['first', 'mar picnic'],
    ['last', 'picnic mar'],
    ['middle', 'picnic mar planning'],
  ])('in %s position finds the doc holding the longer word beside the rest', (_pos, query) => {
    const index = picnicIndex();
    expect(rankOf(index, query, 'target')).toBeGreaterThanOrEqual(0);
    expect(rankOf(index, query, 'target')).toBeLessThan(3);
    expect(hitOf(index, query, 'target')!.components.coverage).toBe(1);
  });

  it('reads two shortened words of one query, each through the other', () => {
    // No title holds "marina", "lopez" and the cut-off "pic" all three, so the
    // title must hold the longer word and one of the others.
    const index = picnicIndex();
    expect(rankOf(index, 'mar lopez pic', 'target')).toBe(0);
    expect(hitOf(index, 'mar lopez pic', 'target')!.components.coverage).toBe(1);
  });

  it('a doc holding every word as typed still ranks first', () => {
    const index = picnicIndex((i) => i.upsert({
      kind: 'task', ref: 'exact', title: 'Mar picnic calendar', updatedAt: DAY,
    }));
    const hits = index.search('mar picnic', { limit: 10 });
    expect(hits[0]?.ref).toBe('exact');
    const target = hits.find((h) => h.ref === 'target')!;
    expect(target).toBeDefined();
    // Reached through a word form: the widened lane's discounted strict score.
    expect(target.components.bm25Strict).toBeLessThanOrEqual(0.8);
    expect(target.components.bm25Strict).toBeGreaterThan(0);
  });

  it('picks the ending the rest of the query points to, not the commonest one', () => {
    // "market" sits beside "picnic" in 3 bodies, "marina" in 2, but only
    // "marina" sits beside it in a title. A market report holding "picnic"
    // somewhere in its note is not a match.
    const index = picnicIndex();
    const market = hitOf(index, 'mar picnic', 'market-0');
    expect(market?.components.bm25Strict ?? 0).toBe(0);
  });

  it('keeps the word as typed when many docs already hold it beside the rest', () => {
    // 60 as-typed matches: nothing to rescue, and no extra lane to pay for.
    // More pad rows keep "mar" (85 docs) under the df gate, so the as-typed
    // count is what decides.
    const index = picnicIndex((i) => {
      for (let k = 0; k < 60; k++) {
        i.upsert({ kind: 'task', ref: `mar-pic-${k}`, title: `Mar picnic item ${k}`, updatedAt: DAY });
      }
    }, 600);
    const target = hitOf(index, 'mar picnic', 'target');
    expect(target?.components.bm25Strict ?? 0).toBe(0);
  });

  it('never reads a one-word query as cut off', () => {
    const index = picnicIndex();
    expect(hitOf(index, 'mar', 'target')).toBeUndefined();
  });

  it('never reads a longer word that only a body holds beside the rest', () => {
    // A note saying "synchronization" and "audit" does not make "sync audit"
    // mean it: only a title names what a doc is.
    const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
    opened.push(index);
    // 200 unrelated rows keep "sync" (30 docs) under the df gate.
    for (let i = 0; i < 200; i++) index.upsert({ kind: 'task', ref: `row-${i}`, title: `unrelated row ${i}`, updatedAt: DAY });
    for (let i = 0; i < 30; i++) index.upsert({ kind: 'task', ref: `pad-${i}`, title: `nightly sync run ${i}`, updatedAt: DAY });
    for (let i = 0; i < 3; i++) {
      index.upsert({
        kind: 'task', ref: i === 0 ? 'longer' : `longer-${i}`, title: `Quarterly review ${i}`,
        note: `synchronization audit notes ${i}`, updatedAt: DAY,
      });
    }
    for (const query of ['sync audit', 'audit sync']) {
      const hit = hitOf(index, query, 'longer');
      expect(hit?.components.bm25Strict ?? 0).toBe(0);
      expect(hit?.components.coverage ?? 0).toBeLessThan(1);
    }
  });
});

describe('a shortened rare word before the last one', () => {
  function upgradeIndex(): SearchIndex {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
    opened.push(index);
    for (let i = 0; i < 30; i++) index.upsert({ kind: 'task', ref: `pad-${i}`, title: `unrelated row ${i}`, updatedAt: DAY });
    for (let i = 0; i < 12; i++) {
      index.upsert({ kind: 'task', ref: `k8s-${i}`, title: `Cluster notes ${i}`, note: `kubernetes node pool ${i}`, updatedAt: DAY });
    }
    for (let i = 0; i < 6; i++) {
      index.upsert({ kind: 'task', ref: `up-${i}`, title: `Laptop upgrade ${i}`, updatedAt: DAY });
    }
    index.upsert({ kind: 'task', ref: 'target', title: 'Kubernetes version upgrade plan', updatedAt: DAY });
    return index;
  }

  it.each([
    ['first', 'kub upgrade'],
    ['middle', 'plan kub upgrade'],
    ['last', 'upgrade kub'],
  ])('in %s position completes to the word that occurs beside the rest', (_pos, query) => {
    const index = upgradeIndex();
    expect(rankOf(index, query, 'target')).toBe(0);
    expect(hitOf(index, query, 'target')!.components.coverage).toBe(1);
  });

  it('before the last word, a completion that never occurs beside the rest is not read', () => {
    const index = upgradeIndex();
    // No "kub…" word occurs beside "laptop": the word stays as typed, so no
    // doc that only says "kubernetes" joins the results.
    expect(hitOf(index, 'kub laptop', 'k8s-0')).toBeUndefined();
  });
});
