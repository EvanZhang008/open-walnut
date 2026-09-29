/**
 * Compound spellings: one name written as one word or as two.
 *
 * The reported case (2026-09-28): a task titled "... CRON - Dock Hub KB sync"
 * was unreachable from "dockhub sync", because the index held `dock`, `hub`
 * and the query asked for `dockhub`. The AI search judges only rows this
 * engine hands it, so it missed the task too. These cases pin
 * both directions of the query-side fix and the adjacency that keeps a split
 * from matching two unrelated words.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

const FILLER = 'The crate rides the pallet and the dock crew stacks it before the round. ';

function newIndex(): SearchIndex {
  const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
  opened.push(index);
  // Enough unrelated rows that the df gate sees real terms as discriminative.
  for (let i = 0; i < 20; i++) {
    index.upsert({
      kind: 'task', ref: `pad-${i}`, title: `unrelated row ${i}`,
      note: `${FILLER}${i}`, updatedAt: Date.parse('2026-01-01'),
    });
  }
  return index;
}

function hit(index: SearchIndex, query: string, ref: string) {
  return index.search(query, { limit: 30 }).find((h) => h.ref === ref);
}

describe('compound spellings', () => {
  it('finds a two-word title from the one-word query (the reported case)', () => {
    const index = newIndex();
    index.upsert({
      kind: 'task', ref: 'target', title: 'Walnut Trigger · CRON - Dock Hub KB sync',
      updatedAt: Date.parse('2026-09-20'),
    });
    const found = hit(index, 'dockhub sync', 'target');
    expect(found).toBeDefined();
    // Both terms count: the strict AND lane matched, not a one-term OR scrap.
    expect(found!.components.coverage).toBe(1);
    expect(found!.components.bm25Strict).toBeGreaterThan(0);
  });

  it('finds a one-word spelling from two typed words, crediting both terms', () => {
    const index = newIndex();
    index.upsert({
      kind: 'task', ref: 'joined', title: 'dockhub sync job',
      updatedAt: Date.parse('2026-09-20'),
    });
    const found = hit(index, 'dock hub sync', 'joined');
    expect(found).toBeDefined();
    expect(found!.components.coverage).toBe(1);
    expect(found!.components.bm25Strict).toBeGreaterThan(0);
  });

  it('treats camelCase, kebab and snake spellings as the same name', () => {
    const index = newIndex();
    index.upsert({ kind: 'task', ref: 'spaced', title: 'Dock Hub KB sync', updatedAt: 1 });
    for (const query of ['DockHub sync', 'dock-hub sync', 'dock_hub sync']) {
      expect(hit(index, query, 'spaced')?.components.coverage, query).toBe(1);
    }
  });

  it('matches a split only as ADJACENT words, never two words anywhere', () => {
    const index = newIndex();
    index.upsert({
      kind: 'task', ref: 'apart', title: 'Dock inspection sync',
      note: 'The hub was repainted.', updatedAt: 1,
    });
    const found = hit(index, 'dockhub sync', 'apart');
    // "sync" alone may still pull it into the relaxed lane; "dockhub" must not count.
    expect(found?.components.coverage ?? 0).toBeLessThan(1);
    expect(found?.components.bm25Strict ?? 0).toBe(0);
  });

  it('ranks the compound hit above a row that only shares the common word', () => {
    const index = newIndex();
    index.upsert({ kind: 'task', ref: 'target', title: 'Dock Hub KB sync', updatedAt: 1 });
    index.upsert({ kind: 'task', ref: 'other', title: 'Calendar sync cleanup', updatedAt: 1 });
    const order = index.search('dockhub sync', { limit: 10 }).map((h) => h.ref);
    expect(order[0]).toBe('target');
  });

  it('leaves a plain one-word match alone', () => {
    const index = newIndex();
    index.upsert({ kind: 'task', ref: 'plain', title: 'dockhub rollout', updatedAt: 1 });
    expect(hit(index, 'dockhub', 'plain')?.components.bm25Strict).toBeGreaterThan(0);
  });

  it('still answers a long pasted query (compound expansion is skipped there)', () => {
    const index = newIndex();
    index.upsert({
      kind: 'task', ref: 'long', title: 'Dock Hub KB sync',
      note: 'nightly export of the pallet ledger to the warehouse archive bucket', updatedAt: 1,
    });
    const found = hit(index, 'nightly export pallet ledger warehouse archive bucket sync kb', 'long');
    expect(found).toBeDefined();
  });
});
