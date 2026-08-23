/**
 * Time tracking store — daily JSONL append + lazy rehydrate of the rollup.
 * WALNUT_HOME is redirected to a fresh tmp dir via mocked constants, so the
 * store's per-call path resolution gives isolation for free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-store'));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  COMPACT_ABOVE_BYTES, MAX_DAY_FILE_BYTES, getIndex, hydrate, recordTime, resetTimeStore,
} from '../../../src/core/time-tracking/store.js';
import { bucketKey, summarize } from '../../../src/core/time-tracking/rollup.js';
import type { TimeRecord } from '../../../src/core/time-tracking/types.js';

const DIR = () => path.join(WALNUT_HOME, 'time-tracking');

function rec(over: Partial<TimeRecord> = {}): TimeRecord {
  return {
    date: '2026-08-22',
    ts: '2026-08-22T15:00:00.000Z',
    durationMs: 60_000,
    kind: 'session',
    ...over,
  };
}

beforeEach(async () => {
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('recordTime', () => {
  it('folds into memory and appends one JSONL line per record, split by day', async () => {
    await recordTime([
      rec({ taskId: 't_alpha', durationMs: 1000 }),
      rec({ taskId: 't_alpha', durationMs: 2000 }),
      rec({ date: '2026-08-21', taskId: 't_beta', durationMs: 3000 }),
    ]);

    expect(getIndex().get(bucketKey('2026-08-22', 't_alpha', 'session'))).toBe(3000);
    expect(getIndex().get(bucketKey('2026-08-21', 't_beta', 'session'))).toBe(3000);

    const files = (await fs.readdir(DIR())).sort();
    expect(files).toEqual(['2026-08-21.jsonl', '2026-08-22.jsonl']);
    const today = await fs.readFile(path.join(DIR(), '2026-08-22.jsonl'), 'utf-8');
    expect(today.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(today.trim().split('\n')[0]!)).toMatchObject({ taskId: 't_alpha', durationMs: 1000 });
  });

  it('appends rather than truncating across calls', async () => {
    await recordTime([rec({ durationMs: 1000 })]);
    await recordTime([rec({ durationMs: 2000 })]);
    const text = await fs.readFile(path.join(DIR(), '2026-08-22.jsonl'), 'utf-8');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(getIndex().get(bucketKey('2026-08-22', '', 'session'))).toBe(3000);
  });

  it('is a no-op for an empty batch', async () => {
    await recordTime([]);
    await expect(fs.readdir(DIR())).rejects.toThrow();
  });
});

describe('compaction', () => {
  /** Enough records that ONE append crosses the compaction threshold. Measured
   *  from the lines actually written, not an estimate. */
  function bigBatch(date: string): TimeRecord[] {
    const out: TimeRecord[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= COMPACT_ABOVE_BYTES; i++) {
      const one = rec({
        date,
        taskId: i % 2 === 0 ? 't_whale' : 't_other',
        kind: i % 3 === 0 ? 'agent' : 'session',
        durationMs: 1000,
      });
      out.push(one);
      bytes += JSON.stringify(one).length + 1;
    }
    return out;
  }

  it('folds a day past the threshold into per-bucket lines, preserving every total', async () => {
    const date = '2026-08-22';
    const batch = bigBatch(date);
    await recordTime(batch);

    const before = new Map(getIndex());
    expect([...before.values()].reduce((a, b) => a + b, 0)).toBe(batch.length * 1000);

    // The file is folded, not truncated: a handful of bucket lines, well under
    // the threshold that triggered it.
    const text = await fs.readFile(path.join(DIR(), `${date}.jsonl`), 'utf-8');
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(before.size);
    expect(text.length).toBeLessThan(COMPACT_ABOVE_BYTES);
    expect(await fs.readdir(DIR())).toEqual([`${date}.jsonl`]);

    // And it is still the same day after a restart — the whole point.
    resetTimeStore();
    await hydrate(new Date(`${date}T12:00:00`));
    expect([...getIndex().entries()].sort()).toEqual([...before.entries()].sort());
  });

  it('keeps appending correctly after a compaction', async () => {
    const date = '2026-08-22';
    await recordTime(bigBatch(date));
    const folded = getIndex().get(bucketKey(date, 't_whale', 'session'))!;
    await recordTime([rec({ date, taskId: 't_whale', durationMs: 5000 })]);

    resetTimeStore();
    await hydrate(new Date(`${date}T12:00:00`));
    expect(getIndex().get(bucketKey(date, 't_whale', 'session'))).toBe(folded + 5000);
  });
});

describe('an over-cap day file', () => {
  it('reads its TAIL instead of vanishing from the summary', async () => {
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await fs.mkdir(DIR(), { recursive: true });

    // A file written by a build that had no compaction: bigger than the read cap.
    const pad = JSON.stringify(rec({ date: today, taskId: 't_pad', durationMs: 1000 }));
    const chunk = `${[...Array(1000)].map(() => pad).join('\n')}\n`;
    const file = path.join(DIR(), `${today}.jsonl`);
    const handle = await fs.open(file, 'w');
    let written = 0;
    let padLines = 0;
    while (written <= MAX_DAY_FILE_BYTES) {
      await handle.write(chunk);
      written += chunk.length;
      padLines += 1000;
    }
    await handle.write(`${JSON.stringify(rec({ date: today, taskId: 't_tail', durationMs: 7000 }))}\n`);
    await handle.close();
    expect((await fs.stat(file)).size).toBeGreaterThan(MAX_DAY_FILE_BYTES);

    resetTimeStore();
    await hydrate(now);
    // The newest records are there (the tail was read)…
    expect(getIndex().get(bucketKey(today, 't_tail', 'session'))).toBe(7000);
    // …and the day is no longer silently empty, just partial.
    const padMs = getIndex().get(bucketKey(today, 't_pad', 'session'))!;
    expect(padMs).toBeGreaterThan(0);
    expect(padMs).toBeLessThan(padLines * 1000);
  });
});

describe('hydrate', () => {
  it('rebuilds the rollup from JSONL written by a previous process', async () => {
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${today}.jsonl`),
      [
        JSON.stringify(rec({ date: today, taskId: 't_alpha', durationMs: 4000 })),
        JSON.stringify(rec({ date: today, taskId: 't_alpha', durationMs: 1000, kind: 'agent' })),
      ].join('\n') + '\n',
      'utf-8',
    );

    resetTimeStore();
    await hydrate(now);
    expect(getIndex().get(bucketKey(today, 't_alpha', 'session'))).toBe(4000);
    expect(getIndex().get(bucketKey(today, 't_alpha', 'agent'))).toBe(1000);

    const out = summarize(getIndex(), { days: [today], today });
    expect(out.days[0]).toMatchObject({ humanMs: 4000, agentMs: 1000 });
  });

  it('skips a torn tail line instead of throwing', async () => {
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${today}.jsonl`),
      JSON.stringify(rec({ date: today, durationMs: 2500 })) + '\n{"date":"' + today + '","durat',
      'utf-8',
    );
    resetTimeStore();
    await hydrate(now);
    expect(getIndex().get(bucketKey(today, '', 'session'))).toBe(2500);
  });

  it('tolerates a missing store directory', async () => {
    resetTimeStore();
    await expect(hydrate(new Date())).resolves.toBeUndefined();
    expect(getIndex().size).toBe(0);
  });

  it('runs its disk read only once even under concurrent callers', async () => {
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(path.join(DIR(), `${today}.jsonl`), JSON.stringify(rec({ date: today, durationMs: 1500 })) + '\n', 'utf-8');
    resetTimeStore();
    await Promise.all([hydrate(now), hydrate(now), hydrate(now)]);
    expect(getIndex().get(bucketKey(today, '', 'session'))).toBe(1500);
  });
});
