/**
 * Stored typos: the right spellings of the words a person mistyped in text a caller stores
 * (2026-11-19: a task written "permisison" was missed by a search for "permission"). The query
 * side fixes only its own typos, so the index names the fix for the caller to store beside it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

function newIndex(): SearchIndex {
  const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
  opened.push(index);
  for (let i = 0; i < 30; i++) {
    index.upsert({ kind: 'task', ref: `v-${i}`, title: `Quorvane permission ledger courier ${i}`, updatedAt: Date.parse('2026-01-01') });
  }
  return index;
}

describe('stored typos', () => {
  it('names the common spelling one edit away, and nothing for words spelled right', () => {
    const index = newIndex();
    const { fixes, complete } = index.spellingCorrections('the quorvade step and the permisson for ledger');
    expect(complete).toBe(true);
    expect(fixes.sort()).toEqual(['permission', 'quorvane']);
    expect(index.spellingCorrections('ledger courier permission').fixes).toEqual([]);
  });

  it('a call out of budget stops after one look, and calls again finish the same fixes', () => {
    const index = newIndex();
    const text = 'the quorvade step, the permisson, the ledgre and the couirer';
    let found = index.spellingCorrections(text, { budgetMs: 0 });
    expect(found.complete).toBe(false);
    let calls = 1;
    while (!found.complete && calls < 10) { found = index.spellingCorrections(text, { budgetMs: 0 }); calls++; }
    expect(found.complete).toBe(true);
    expect(calls).toBe(4);
    expect(found.fixes.sort()).toEqual(['courier', 'ledger', 'permission', 'quorvane']);
  });
});
