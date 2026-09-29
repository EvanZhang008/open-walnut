/**
 * Word forms and rarity-weighted coverage (2026-09-28 robustness pass).
 *
 * scripts/search-robustness-eval.mjs rewrites the control query of real titles
 * the way people type: a typo, a plural, a word cut off mid-typing, a question
 * wrapped around the words. Keyword-only, 13-21% of docs the control query found
 * in the top 3 fell out of the top 8 for these rewrites, and the semantic lane
 * that was meant to rescue them loses its 150ms deadline on most interactive
 * queries. These cases pin the query-side forms that close the gap, and the
 * guarantees that keep them from reranking what already worked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createSearchIndex, type SearchIndex } from '../../src/lib/hybrid-search/index.js';
import { inflections } from '../../src/lib/hybrid-search/query.js';

const opened: SearchIndex[] = [];
afterEach(() => {
  for (const i of opened) { try { i.close(); } catch { /* closed */ } }
  opened.length = 0;
});

const DAY = Date.parse('2026-09-01');

function newIndex(pad: (i: number) => string, rows = 30): SearchIndex {
  const index = createSearchIndex({ dbPath: ':memory:', kinds: { task: { weight: 1 } } });
  opened.push(index);
  for (let i = 0; i < rows; i++) {
    index.upsert({ kind: 'task', ref: `pad-${i}`, title: `unrelated row ${i}`, note: pad(i), updatedAt: DAY });
  }
  return index;
}

const rank = (index: SearchIndex, query: string, ref: string) =>
  index.search(query, { limit: 40 }).findIndex((h) => h.ref === ref);

describe('inflections', () => {
  it('goes both ways between the common English endings', () => {
    expect(inflections('doctors')).toContain('doctor');
    expect(inflections('doctor')).toContain('doctors');
    expect(inflections('failed')).toEqual(expect.arrayContaining(['fail', 'failing', 'fails']));
    expect(inflections('syncing')).toContain('sync');
    expect(inflections('update')).toEqual(expect.arrayContaining(['updated', 'updating', 'updates']));
    expect(inflections('policies')).toContain('policy');
  });

  it('never strips a word down to a fragment', () => {
    // "string" is not "str" + ing, "thing" is not "th" + ing.
    expect(inflections('string')).not.toContain('str');
    expect(inflections('thing')).not.toContain('th');
    expect(inflections('status')).not.toContain('statu');
    expect(inflections('process')).not.toContain('proces');
  });
});

describe('typos', () => {
  it('finds a word the index has never seen through its one-edit spelling', () => {
    const index = newIndex((i) => `The notification queue ran for batch ${i}.`);
    index.upsert({ kind: 'task', ref: 'target', title: 'Notification error feed', updatedAt: DAY });
    expect(rank(index, 'notifcation feed', 'target')).toBe(0);
    expect(rank(index, 'notification feed', 'target')).toBe(0);
  });

  it('leaves a real rare word alone when no common word sits one edit away', () => {
    const index = newIndex((i) => `The pallet crew stacked crate ${i}.`);
    index.upsert({ kind: 'task', ref: 'rare', title: 'Quokka census', updatedAt: DAY });
    const hits = index.search('quokka', { limit: 5 });
    expect(hits.map((h) => h.ref)).toEqual(['rare']);
  });

  it('does not correct a word into a rarer one', () => {
    // "sprint" is common here; "spring" (one edit) exists but is rarer: no fix.
    const index = newIndex((i) => `sprint planning ${i}`);
    index.upsert({ kind: 'task', ref: 'spring', title: 'spring cleanup', updatedAt: DAY });
    expect(rank(index, 'sprint', 'spring')).toBe(-1);
  });
});

describe('inflections in the strict lane', () => {
  it('reaches the doc that says the word another way, below the docs that say it as typed', () => {
    const index = newIndex((i) => `The pallet crew stacked crate ${i}.`);
    index.upsert({ kind: 'task', ref: 'singular', title: 'book doctor', updatedAt: DAY });
    index.upsert({ kind: 'task', ref: 'plural', title: 'book doctors', updatedAt: DAY });
    const singular = rank(index, 'book doctors', 'singular');
    const plural = rank(index, 'book doctors', 'plural');
    expect(singular).toBeGreaterThanOrEqual(0);
    expect(plural).toBe(0);
    expect(singular).toBeGreaterThan(plural);
  });

  it('keeps the exact-word ranking of a query whose words all match as typed', () => {
    // A rarer inflection has the higher idf; in the strict lane it would have
    // outscored the docs holding the typed word.
    const index = newIndex((i) => (i % 3 === 0 ? `todo sync failed on run ${i}` : `failed attempt ${i}`));
    index.upsert({ kind: 'task', ref: 'exact', title: 'Fix: todo full sync failed', updatedAt: DAY });
    index.upsert({ kind: 'task', ref: 'variant', title: 'todo sync fails', updatedAt: DAY });
    const exact = index.search('todo sync failed', { limit: 40 });
    expect(exact.findIndex((h) => h.ref === 'exact')).toBeLessThan(exact.findIndex((h) => h.ref === 'variant'));
    const variant = exact.find((h) => h.ref === 'variant')!;
    expect(variant.components.bm25Strict).toBeLessThanOrEqual(0.8);
  });
});

describe('an unfinished last word', () => {
  it('completes to the words it begins that occur with the rest of the query', () => {
    const index = newIndex((i) => (i < 12 ? `spending report ${i}` : `specification draft ${i}`));
    index.upsert({ kind: 'task', ref: 'target', title: 'card spend', updatedAt: DAY });
    expect(rank(index, 'card spe', 'target')).toBe(0);
  });

  // In both cases below the doc still arrives through its other word; what
  // must not happen is the cut-off word counting as present.
  const covered = (index: SearchIndex, query: string, ref: string) =>
    index.search(query, { limit: 40 }).find((h) => h.ref === ref)?.components;

  it('never completes a word the index holds into a commoner one', () => {
    // Real data: "quest" (3 docs) completed to "question" (thousands) and the
    // task about the quest fell out of the top 20.
    const index = newIndex((i) => `a question about the question ${i}`);
    index.upsert({ kind: 'task', ref: 'q1', title: 'When will quest 4 ship', updatedAt: DAY });
    index.upsert({ kind: 'task', ref: 'q2', title: 'quest log', updatedAt: DAY });
    index.upsert({ kind: 'task', ref: 'q3', title: 'side quest ideas', updatedAt: DAY });
    const hits = index.search('quest', { limit: 10 });
    expect(hits.slice(0, 3).map((h) => h.ref).sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it('a doc reached only through a word form ranks below the one holding the typed word', () => {
    // The title itself carries the rare spelling; the query types it exactly.
    const index = newIndex((i) => `take the electric kettle ${i}, pot on the stove`);
    index.upsert({ kind: 'task', ref: 'exact', title: 'take out electic pot', updatedAt: DAY });
    const hits = index.search('take electic pot', { limit: 10 });
    expect(hits[0]?.ref).toBe('exact');
  });

  it('leaves a finished word as typed', () => {
    const index = newIndex((i) => `nightly sync run ${i}`);
    index.upsert({ kind: 'task', ref: 'longer', title: 'synchronization audit', updatedAt: DAY });
    const hit = covered(index, 'audit sync', 'longer');
    expect(hit?.bm25Strict).toBe(0);
    expect(hit?.coverage).toBeLessThan(1);
  });

  it('only the last word is treated as unfinished', () => {
    const index = newIndex((i) => `spending report ${i}`);
    index.upsert({ kind: 'task', ref: 'target', title: 'spend card', updatedAt: DAY });
    const hit = covered(index, 'spe card', 'target');
    expect(hit?.bm25Strict).toBe(0);
    expect(hit?.coverage).toBeLessThan(1);
    expect(covered(index, 'card spe', 'target')?.coverage).toBe(1);
  });
});

describe('coverage weighted by rarity', () => {
  it('a doc holding the rare words outranks one holding only the common ones', () => {
    // Common words everywhere, the rare ones in one task: the reported shape was
    // "where is the cook rice task" ranking a daily log above "Cook Rice".
    const index = newIndex((i) => `where is the task list for day ${i}, the task board is where it is`);
    index.upsert({
      kind: 'task', ref: 'log', title: 'Daily log',
      note: 'where is the task I wrote about, the one where the cook task is', updatedAt: DAY,
    });
    index.upsert({ kind: 'task', ref: 'target', title: 'Cook Rice', updatedAt: DAY });
    const hits = index.search('where is the cook rice task', { limit: 10 });
    expect(hits.findIndex((h) => h.ref === 'target')).toBeLessThan(hits.findIndex((h) => h.ref === 'log'));
    const target = hits.find((h) => h.ref === 'target')!;
    expect(target.components.coverage).toBeGreaterThan(0.8);
  });

  it('a query of equally common words stays uniform', () => {
    const index = newIndex((i) => `alpha beta gamma ${i}`);
    index.upsert({ kind: 'task', ref: 'two', title: 'alpha beta', updatedAt: DAY });
    const two = index.search('alpha beta gamma', { limit: 40 }).find((h) => h.ref === 'two')!;
    expect(two.components.coverage).toBeCloseTo(2 / 3, 2);
  });
});

describe('a query word no doc holds', () => {
  it('counts as an average word, so it cannot sink the words that did match', () => {
    // Real shape: "<Chinese phrase no doc holds> filing" put "filing" at 1% coverage.
    const index = newIndex((i) => `quarterly report ${i}`);
    index.upsert({ kind: 'task', ref: 'target', title: 'Filing checklist', updatedAt: DAY });
    const hit = index.search('zqxvw filing', { limit: 5 }).find((h) => h.ref === 'target')!;
    expect(hit.components.coverage).toBeCloseTo(0.5, 2);
  });
});

describe('inflections that are another word in practice', () => {
  it('does not read "filing" as the far commoner "file"', () => {
    // "file" is in every pad (over the df gate, 10x "filing"): another word.
    const index = newIndex((i) => (i < 3 ? `court filing ${i}` : `open the file list ${i}`));
    index.upsert({ kind: 'task', ref: 'filing', title: 'Tax filing', updatedAt: DAY });
    index.upsert({ kind: 'task', ref: 'files', title: 'Tax file export', updatedAt: DAY });
    const hits = index.search('tax filing', { limit: 10 });
    expect(hits[0]?.ref).toBe('filing');
    const files = hits.find((h) => h.ref === 'files');
    expect(files?.components.coverage ?? 0).toBeLessThan(0.9);
  });

  it('still reads a plural as its singular when both are about as common', () => {
    const index = newIndex((i) => (i % 2 === 0 ? `the alarm fired ${i}` : `alarms raised ${i}`));
    index.upsert({ kind: 'task', ref: 'target', title: 'ddb ticket, lost the alarm', updatedAt: DAY });
    const hit = index.search('ddb alarms', { limit: 10 }).find((h) => h.ref === 'target')!;
    expect(hit.components.coverage).toBe(1);
  });

  it('reads a word the index has never seen through its commonest form', () => {
    const index = newIndex((i) => `job failure on run ${i}`);
    index.upsert({ kind: 'task', ref: 'target', title: 'Investigate DumpJob run failure', updatedAt: DAY });
    expect(rank(index, 'dumpjob failuring', 'target')).toBe(0);
  });
});

describe('a fixed spelling written apart', () => {
  it('matches the fix the way the typed word would: as one token or two words', () => {
    // "dockhub" exists (camelCase in the pads); the target writes "Dock Hub".
    const index = newIndex((i) => `DockHub deploy ${i}`);
    index.upsert({ kind: 'task', ref: 'target', title: 'Dock Hub KB sync', updatedAt: DAY });
    const hit = index.search('dockhuub sync', { limit: 40 }).find((h) => h.ref === 'target')!;
    expect(hit.components.coverage).toBe(1);
  });
});

describe('a long query with common words', () => {
  // Every pad holds the glue words; only the target holds the words that matter.
  const glue = (i: number) => `where is the task board for sprint ${i}, the task is where it is`;

  it('passes the strict lane on the words that discriminate', () => {
    const index = newIndex(glue);
    index.upsert({ kind: 'task', ref: 'target', title: 'Per-user upload/download reference', updatedAt: DAY });
    const hits = index.search('where is the upload download task', { limit: 10 });
    expect(hits[0]?.ref).toBe('target');
    expect(hits[0]!.components.bm25Strict).toBeGreaterThan(0);
    expect(hits[0]!.components.bm25Strict).toBeLessThanOrEqual(0.8);
  });

  it('a short query keeps every word required: the common word may be a name', () => {
    const index = newIndex((i) => `walnut deploy notes ${i}`);
    index.upsert({ kind: 'task', ref: 'other', title: 'acme deploy', updatedAt: DAY });
    const hit = index.search('walnut deploy', { limit: 40 }).find((h) => h.ref === 'other');
    expect(hit?.components.bm25Strict ?? 0).toBe(0);
  });
});

describe('versions and dates', () => {
  it('matches a version whatever the separator', () => {
    const index = newIndex((i) => `model notes ${i}`);
    index.upsert({ kind: 'task', ref: 'dotted', title: 'Opus 4.8 upgrade', updatedAt: DAY });
    index.upsert({ kind: 'task', ref: 'joined', title: 'set claude-opus-4-8 as default', updatedAt: DAY });
    expect(rank(index, 'opus-4-8', 'dotted')).toBeGreaterThanOrEqual(0);
    expect(rank(index, 'opus-4-8', 'dotted')).toBeLessThan(2);
    expect(rank(index, 'opus 4-8', 'dotted')).toBeLessThan(2);
    expect(rank(index, 'opus 4.8', 'joined')).toBeLessThan(2);
  });

  it('never runs the digit groups together', () => {
    const index = newIndex((i) => `model notes ${i}`);
    index.upsert({ kind: 'task', ref: 'fortyeight', title: 'wait 48 hours', updatedAt: DAY });
    const hit = index.search('4.8 hours', { limit: 40 }).find((h) => h.ref === 'fortyeight')!;
    expect(hit.components.coverage).toBeLessThan(1);
    expect(index.search('4-8', { limit: 40 }).find((h) => h.ref === 'fortyeight')).toBeUndefined();
  });
});

describe('full-width input', () => {
  it('folds letters and digits typed in full-width mode', () => {
    const index = newIndex((i) => `release notes ${i}`);
    index.upsert({ kind: 'task', ref: 'target', title: 'iOS 18 crash', updatedAt: DAY });
    // Full-width "iOS 18" with an ideographic space (test data, escaped).
    expect(rank(index, '\uff49\uff2f\uff33\u3000\uff11\uff18', 'target')).toBe(0);
  });
});

describe('completions past the commonest endings', () => {
  it('finds the rare ending that occurs with the rest of the query', () => {
    // Sixteen commoner "wee…" words, none with the other query words.
    const common = Array.from({ length: 16 }, (_, k) => `wee${String.fromCharCode(97 + k)}x`).join(' ');
    const index = newIndex((i) => (i < 12 ? common : `pantry list ${i}`));
    index.upsert({ kind: 'task', ref: 'target', title: 'Buy teeth floss, pull weeds', updatedAt: DAY });
    expect(rank(index, 'teeth floss wee', 'target')).toBe(0);
    const hit = index.search('teeth floss wee', { limit: 5 }).find((h) => h.ref === 'target')!;
    expect(hit.components.coverage).toBe(1);
  });
});

describe('a doc titled exactly the query', () => {
  it('is not asked for the words in its body too', () => {
    // Four docs discuss the words in title and body (few enough to pass the df
    // gate); the target is only its title. Asked for body presence, it scores
    // ~0.71 against their ~0.86.
    const index = newIndex((i) => `other text ${i}`);
    for (let i = 0; i < 4; i++) {
      index.upsert({
        kind: 'task', ref: `review-${i}`, title: `Open knowledge base review ${i}`,
        note: `open the knowledge base notes, base knowledge for run ${i}`, updatedAt: DAY,
      });
    }
    index.upsert({ kind: 'task', ref: 'target', title: 'Open Knowledge base', updatedAt: DAY });
    const hit = index.search('open knowledge base', { limit: 40 }).find((h) => h.ref === 'target')!;
    expect(hit.components.bodyCoverage).toBe(1);
    expect(rank(index, 'Open Knowledge base', 'target')).toBe(0);
  });

  it('nor is a doc whose title begins with the query, the last word perhaps unfinished', () => {
    // A task's note rarely repeats its own title; the four chats say the words
    // in title and body, so the body demand alone ranked the task #4.
    const index = newIndex((i) => `other text ${i}`);
    for (let i = 0; i < 4; i++) {
      index.upsert({
        kind: 'task', ref: `chat-${i}`, title: `Customer talk notes ${i}`,
        note: `talk to the customer about renewals; the customer asked us to talk again ${i}`, updatedAt: DAY,
      });
    }
    index.upsert({
      kind: 'task', ref: 'target', title: 'Talk to customer about the backfill plan',
      note: 'schedule the call for friday', updatedAt: DAY,
    });
    expect(rank(index, 'Talk to customer', 'target')).toBe(0);
    expect(rank(index, 'talk to cust', 'target')).toBe(0);
    // The same words in another order do not name it.
    const reordered = index.search('customer talk to', { limit: 40 }).find((h) => h.ref === 'target')!;
    expect(reordered.components.bodyCoverage).toBe(0);
  });

  it('a title with a word the query lacks still needs the body', () => {
    const index = newIndex((i) => (i < 4 ? `open the knowledge base notes ${i}` : `other text ${i}`));
    index.upsert({ kind: 'task', ref: 'stub', title: 'Test open knowledge base', updatedAt: DAY });
    const hits = index.search('open knowledge base', { limit: 40 });
    expect(hits.find((h) => h.ref === 'stub')!.components.bodyCoverage).toBe(0);
    // The component is live for this query: the docs saying it get full credit.
    expect(hits.find((h) => h.ref === 'pad-0')!.components.bodyCoverage).toBe(1);
  });
});

describe('a last word a few docs hold', () => {
  it('is also read as cut off when far commoner words begin with it', () => {
    // "fai" sits in 3 stray docs, rarer than "todo" and "sync" (12 each), so
    // on rarity alone the stray docs outrank the target (#3 before the fix);
    // "failed" is everywhere.
    const index = newIndex((i) => (
      i < 3 ? `fai notes ${i}`
        : i < 15 ? `todo list ${i}`
          : i < 27 ? `sync job ${i}`
            : `the job failed on run ${i}`), 100);
    index.upsert({ kind: 'task', ref: 'target', title: 'Fix: todo full sync failed', updatedAt: DAY });
    expect(rank(index, 'todo sync fai', 'target')).toBe(0);
  });
});
