/**
 * Stored typos: the right spellings of the words a person mistyped in text a caller stores
 * (2026-11-19: a task written "permisison" was missed by a search for "permission"). The query
 * side fixes only its own typos, so the index names the fix for the caller to store beside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

function newIndex(dbPath = ':memory:'): SearchIndex {
  const index = createSearchIndex({ dbPath, kinds: { task: { weight: 1 } } });
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

  // 2026-11-25: the server restarted every few minutes and looked every word up again (about 600
  // vocabulary lookups a rare word): 55 s of held loop in 3.5 hours of stall profiles.
  it('a restart keeps what it learned within the hour: no word is looked up again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-typos-'));
    try {
      const file = path.join(dir, 'search.sqlite');
      const text = 'the quorvade step and the permisson for ledger';
      const first = newIndex(file);
      expect(first.spellingCorrections(text).fixes.sort()).toEqual(['permission', 'quorvane']);
      first.close();
      const again = createSearchIndex({ dbPath: file, kinds: { task: { weight: 1 } } });
      opened.push(again);
      const lookups: string[] = [];
      const prepare = again.db.prepare.bind(again.db);
      vi.spyOn(again.db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes('hybrid_search_vocab')) lookups.push(sql);
        return prepare(sql);
      }) as typeof again.db.prepare);
      expect(again.spellingCorrections(text).fixes.sort()).toEqual(['permission', 'quorvane']);
      expect(lookups).toEqual([]);
      // A rebuild changes the vocabulary: the kept verdicts go with it.
      vi.restoreAllMocks();
      await again.rebuildAll([]);
      expect(again.db.prepare('SELECT COUNT(*) AS n FROM spelling_fix').get()).toEqual({ n: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
