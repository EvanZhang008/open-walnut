/**
 * Outside-activity store — daily JSONL append, lazy rehydrate, compaction, and
 * the one-day read. WALNUT_HOME is redirected to a fresh tmp dir via mocked
 * constants, so the store's per-call path resolution gives isolation for free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-outside-store'));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  COMPACT_ABOVE_BYTES, COMPACT_MERGE_GAP_MS, compactRecords, getOutsideIndex, hydrateOutside, outsideBucketKey,
  outsideDayRecords, outsideDayRows,
  peekNextCompactAt, recordOutside, resetOutsideStore, type OutsideRecord,
} from '../../../src/core/time-tracking/outside-store.js';
import { localDateKey, shiftDateKey } from '../../../src/core/time-tracking/rollup.js';

const DIR = () => path.join(WALNUT_HOME, 'time-tracking', 'outside');
const TODAY = localDateKey(new Date());

function rec(over: Partial<OutsideRecord> = {}): OutsideRecord {
  return {
    date: TODAY,
    ts: `${TODAY}T15:00:00.000Z`,
    durationMs: 5000,
    app: 'Slack',
    bundleId: 'com.tinyspeck.slackmacgap',
    ...over,
  };
}

beforeEach(async () => {
  resetOutsideStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetOutsideStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('recordOutside', () => {
  it('folds by (date, bundleId, host) and appends one JSONL line per record', async () => {
    await recordOutside([
      rec({ durationMs: 5000 }),
      rec({ durationMs: 5000 }),
      rec({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com', durationMs: 5000 }),
      rec({ date: shiftDateKey(TODAY, -1), durationMs: 5000 }),
    ]);

    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.tinyspeck.slackmacgap', ''))).toEqual({
      app: 'Slack', ms: 10_000,
    });
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.google.Chrome', 'github.com'))).toEqual({
      app: 'Google Chrome', ms: 5000,
    });

    const files = (await fs.readdir(DIR())).sort();
    expect(files).toEqual([`${shiftDateKey(TODAY, -1)}.jsonl`, `${TODAY}.jsonl`]);
    const text = await fs.readFile(path.join(DIR(), `${TODAY}.jsonl`), 'utf-8');
    expect(text.trim().split('\n')).toHaveLength(3);
  });

  it('keeps the browser host out of the app bucket (a site is not a second app)', async () => {
    await recordOutside([
      rec({ app: 'Safari', bundleId: 'com.apple.Safari', host: 'github.com', durationMs: 5000 }),
      rec({ app: 'Safari', bundleId: 'com.apple.Safari', host: 'news.ycombinator.com', durationMs: 5000 }),
    ]);
    const rows = await outsideDayRows(TODAY);
    expect(rows.map((r) => [r.host, r.ms]).sort()).toEqual([
      ['github.com', 5000], ['news.ycombinator.com', 5000],
    ]);
  });

  it('is a no-op for an empty batch', async () => {
    await recordOutside([]);
    await expect(fs.readdir(DIR())).rejects.toThrow();
  });
});

describe('hydrateOutside', () => {
  it('rebuilds the rollup from JSONL written by a previous process', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${TODAY}.jsonl`),
      [
        JSON.stringify(rec({ durationMs: 15_000 })),
        JSON.stringify(rec({ app: 'Arc', bundleId: 'company.thebrowser.Browser', host: 'openai.com', durationMs: 5000 })),
      ].join('\n') + '\n',
      'utf-8',
    );
    resetOutsideStore();
    await hydrateOutside(new Date());
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.tinyspeck.slackmacgap', ''))?.ms).toBe(15_000);
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'company.thebrowser.Browser', 'openai.com'))?.ms).toBe(5000);
  });

  it('folds a hand-edited mixed-case host into the one real bucket', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${TODAY}.jsonl`),
      [
        JSON.stringify(rec({ app: 'Safari', bundleId: 'com.apple.Safari', host: 'GitHub.com', durationMs: 5000 })),
        JSON.stringify(rec({ app: 'Safari', bundleId: 'com.apple.Safari', host: 'github.com', durationMs: 5000 })),
      ].join('\n') + '\n',
      'utf-8',
    );
    resetOutsideStore();
    await hydrateOutside(new Date());
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.apple.Safari', 'github.com'))?.ms).toBe(10_000);
    expect(getOutsideIndex().size).toBe(1);
  });

  it('skips a torn tail line instead of throwing', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${TODAY}.jsonl`),
      JSON.stringify(rec({ durationMs: 2500 })) + '\n{"date":"' + TODAY + '","durat',
      'utf-8',
    );
    resetOutsideStore();
    await hydrateOutside(new Date());
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.tinyspeck.slackmacgap', ''))?.ms).toBe(2500);
  });

  it('counts a record exactly once when a write races the hydration read', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(path.join(DIR(), `${TODAY}.jsonl`), JSON.stringify(rec({ durationMs: 5000 })) + '\n', 'utf-8');
    resetOutsideStore();
    // No await between: the record is parked until the read finishes.
    const hydrating = hydrateOutside(new Date());
    const writing = recordOutside([rec({ durationMs: 5000 })]);
    await Promise.all([hydrating, writing]);
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.tinyspeck.slackmacgap', ''))?.ms).toBe(10_000);

    // …and the same total survives a restart, which is what double counting breaks.
    resetOutsideStore();
    await hydrateOutside(new Date());
    expect(getOutsideIndex().get(outsideBucketKey(TODAY, 'com.tinyspeck.slackmacgap', ''))?.ms).toBe(10_000);
  });

  it('tolerates a missing store directory', async () => {
    resetOutsideStore();
    await expect(hydrateOutside(new Date())).resolves.toBeUndefined();
    expect(getOutsideIndex().size).toBe(0);
  });
});

describe('compaction', () => {
  /** Enough records that ONE append crosses the compaction threshold. */
  function bigBatch(): OutsideRecord[] {
    const out: OutsideRecord[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= COMPACT_ABOVE_BYTES; i++) {
      const one = i % 2 === 0
        ? rec({ durationMs: 5000 })
        : rec({ app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com', durationMs: 5000 });
      out.push(one);
      bytes += JSON.stringify(one).length + 1;
    }
    return out;
  }

  it('folds a day past the threshold into per-bucket lines, preserving every total', async () => {
    const batch = bigBatch();
    await recordOutside(batch);
    const before = new Map([...getOutsideIndex()].map(([k, v]) => [k, v.ms]));
    expect([...before.values()].reduce((a, b) => a + b, 0)).toBe(batch.length * 5000);

    const text = await fs.readFile(path.join(DIR(), `${TODAY}.jsonl`), 'utf-8');
    expect(text.length).toBeLessThan(COMPACT_ABOVE_BYTES);
    expect(await fs.readdir(DIR())).toEqual([`${TODAY}.jsonl`]);

    // And it is still the same day after a restart — the whole point.
    resetOutsideStore();
    await hydrateOutside(new Date());
    const after = new Map([...getOutsideIndex()].map(([k, v]) => [k, v.ms]));
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it('keeps appending correctly after a compaction', async () => {
    await recordOutside(bigBatch());
    const key = outsideBucketKey(TODAY, 'com.tinyspeck.slackmacgap', '');
    const folded = getOutsideIndex().get(key)!.ms;
    await recordOutside([rec({ durationMs: 5000 })]);
    resetOutsideStore();
    await hydrateOutside(new Date());
    expect(getOutsideIndex().get(key)?.ms).toBe(folded + 5000);
  });

  it('does not re-compact an incompressible day on every append (watermark)', async () => {
    // Five buckets rotating slower than the merge gap: NOTHING can merge, so a
    // compaction cannot shrink the file. Without the watermark this day sits just
    // above the threshold and is rewritten wholesale on EVERY subsequent append.
    const spin: OutsideRecord[] = [];
    const stepMs = COMPACT_MERGE_GAP_MS + 5000;
    const base = new Date(`${TODAY}T00:10:00`).getTime();
    for (let i = 0, bytes = 0; bytes <= COMPACT_ABOVE_BYTES; i++) {
      const one = rec({
        ts: new Date(base + i * stepMs).toISOString(),
        app: `App${i % 5}`,
        bundleId: `com.example.app${i % 5}`,
      });
      spin.push(one);
      bytes += JSON.stringify(one).length + 1;
    }
    await recordOutside(spin);

    const file = path.join(DIR(), `${TODAY}.jsonl`);
    const compacted = await fs.readFile(file, 'utf-8');
    // The compaction really could not shrink it…
    expect(compacted.length).toBeGreaterThan(COMPACT_ABOVE_BYTES * 0.9);
    // …so the next compaction must wait for ANOTHER threshold of growth.
    expect(peekNextCompactAt(TODAY)).toBeGreaterThan(COMPACT_ABOVE_BYTES);

    // A later small append lands as a raw line: no rewrite, no re-fold.
    await recordOutside([rec({ ts: `${TODAY}T23:59:00.000Z`, app: 'Straggler', bundleId: 'com.example.late' })]);
    const after = await fs.readFile(file, 'utf-8');
    expect(after.startsWith(compacted)).toBe(true);
    expect(after.trim().split('\n')).toHaveLength(compacted.trim().split('\n').length + 1);
  });
});

describe('outsideDayRows', () => {
  it('answers a day older than the hydrate window from disk', async () => {
    const old = shiftDateKey(TODAY, -60);
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${old}.jsonl`),
      JSON.stringify(rec({ date: old, ts: `${old}T10:00:00.000Z`, durationMs: 5000 })) + '\n',
      'utf-8',
    );
    resetOutsideStore();
    const rows = await outsideDayRows(old);
    expect(rows).toEqual([{ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', host: '', ms: 5000 }]);
    // Reading an old day must NOT fold it into the live rollup (double count).
    expect(getOutsideIndex().size).toBe(0);
  });

  it('returns an empty list for a day with no data', async () => {
    expect(await outsideDayRows(shiftDateKey(TODAY, -3))).toEqual([]);
  });

  it('still answers from memory for a day that began AFTER hydration', async () => {
    // The server hydrated yesterday and kept running past midnight. Today's
    // records exist only in the rollup + the file this process appended; when the
    // window was a frozen SET of hydrated dates, today fell outside it forever.
    const yesterday = shiftDateKey(TODAY, -1);
    resetOutsideStore();
    await hydrateOutside(new Date(`${yesterday}T12:00:00`));
    await recordOutside([rec({ date: TODAY, durationMs: 5000 })]);

    // Remove the day file: only the in-memory rollup can answer now.
    await fs.rm(path.join(DIR(), `${TODAY}.jsonl`), { force: true });
    const rows = await outsideDayRows(TODAY);
    expect(rows).toEqual([{ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', host: '', ms: 5000 }]);
  });

  it('prunes buckets that fall out of the window when the day rolls', async () => {
    resetOutsideStore();
    await hydrateOutside(new Date(`${TODAY}T12:00:00`));
    await recordOutside([rec({ durationMs: 5000 })]);
    expect(getOutsideIndex().size).toBe(1);

    // 40 days later, TODAY is older than the 30-day window: dropped from memory,
    // but still readable from its file.
    const later = new Date(new Date(`${TODAY}T12:00:00`).getTime() + 40 * 24 * 3600 * 1000);
    const rows = await outsideDayRows(TODAY, later);
    expect(getOutsideIndex().size).toBe(0);
    expect(rows).toEqual([{ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', host: '', ms: 5000 }]);
  });
});

describe('compactRecords', () => {
  const at = (sec: number, over: Partial<OutsideRecord> = {}): OutsideRecord =>
    rec({ ts: `${TODAY}T15:00:${String(sec).padStart(2, '0')}.000Z`, ...over });

  it('merges adjacent samples of one bucket into one interval, preserving the total', () => {
    const out = compactRecords([at(0), at(5), at(10)], TODAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.ts).toBe(`${TODAY}T15:00:00.000Z`);
    expect(out[0]!.durationMs).toBe(15_000);
  });

  it('splits at a gap wider than COMPACT_MERGE_GAP_MS and never merges across buckets', () => {
    const out = compactRecords([
      at(0), at(5),
      at(7, { app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'github.com' }),
      at(40), // 30s after the second Slack sample ended → its own interval
    ], TODAY);
    const slack = out.filter((r) => r.bundleId === 'com.tinyspeck.slackmacgap');
    expect(slack).toHaveLength(2);
    expect(out.filter((r) => r.bundleId === 'com.google.Chrome')).toHaveLength(1);
    expect(out.reduce((sum, r) => sum + r.durationMs, 0)).toBe(20_000);
  });

  it('is idempotent: compacting the compaction changes nothing', () => {
    const once = compactRecords([at(0), at(5), at(40), at(50)], TODAY);
    expect(compactRecords(once, TODAY)).toEqual(once);
  });

  it('folds ts-less records to one TS-LESS line per bucket, never a fake midnight', () => {
    const out = compactRecords([rec({ ts: '' }), rec({ ts: '' })], TODAY);
    // A synthesized timestamp would later draw as a real bar at a fictional hour.
    expect(out).toEqual([expect.objectContaining({ ts: '', durationMs: 10_000, app: 'Slack' })]);
  });

  it('emits chronological output, ts-less lines first', () => {
    const out = compactRecords([at(40), rec({ ts: '' }), at(0)], TODAY);
    expect(out.map((r) => r.ts)).toEqual(['', `${TODAY}T15:00:00.000Z`, `${TODAY}T15:00:40.000Z`]);
  });
});

describe('outsideDayRecords', () => {
  it('returns the raw records of one day, ts and all', async () => {
    await recordOutside([
      rec({ durationMs: 5000 }),
      rec({ ts: `${TODAY}T15:10:00.000Z`, durationMs: 4000 }),
      rec({ date: shiftDateKey(TODAY, -1), durationMs: 3000 }),
    ]);
    const records = await outsideDayRecords(TODAY);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.durationMs)).toEqual([5000, 4000]);
    expect(records[0]!.ts).toBe(`${TODAY}T15:00:00.000Z`);
  });

  it('answers an empty day with an empty list, not an error', async () => {
    expect(await outsideDayRecords(shiftDateKey(TODAY, -3))).toEqual([]);
  });

  it('re-serves an unchanged file without re-parsing, and sees a later append', async () => {
    await recordOutside([rec({ durationMs: 5000 })]);
    const first = await outsideDayRecords(TODAY);
    // Unchanged stat → the SAME parsed array back (the memo, not a lookalike).
    expect(await outsideDayRecords(TODAY)).toBe(first);
    await recordOutside([rec({ ts: `${TODAY}T16:00:00.000Z`, durationMs: 4000 })]);
    const second = await outsideDayRecords(TODAY);
    expect(second).toHaveLength(2);
  });
});
