/**
 * The store feeds the per-task index at exactly the points it feeds the rollup:
 * live writes, the hydrate read, and (task index only) the history read of days
 * older than the hydrate window. Compaction keeps each record's session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-task-index'));

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  COMPACT_ABOVE_BYTES, getIndex, getTaskIndex, hydrate, isHistoryRead, recordTime, resetTimeStore, whenHistoryRead,
} from '../../../src/core/time-tracking/store.js';
import { localDateKey, shiftDateKey } from '../../../src/core/time-tracking/rollup.js';
import { taskTimeView } from '../../../src/core/time-tracking/task-index.js';
import type { TimeRecord } from '../../../src/core/time-tracking/types.js';

const DIR = () => path.join(WALNUT_HOME, 'time-tracking');
const NOW = new Date();
const TODAY = localDateKey(NOW);

function rec(over: Partial<TimeRecord> = {}): TimeRecord {
  return { date: TODAY, ts: NOW.toISOString(), durationMs: 60_000, kind: 'session', taskId: 't_a', sessionId: 's1', ...over };
}

async function writeDay(date: string, records: TimeRecord[]): Promise<void> {
  await fs.mkdir(DIR(), { recursive: true });
  await fs.writeFile(path.join(DIR(), `${date}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const all = () => taskTimeView(getTaskIndex(), 't_a', TODAY).totals.all;

beforeEach(async () => {
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('the per-task index in the store', () => {
  it('folds a live write and a previous process\'s day file, each exactly once', async () => {
    await writeDay(TODAY, [rec({ durationMs: 4000 }), rec({ kind: 'agent', durationMs: 9000 })]);
    resetTimeStore();
    // The real shape: a heartbeat touches the store first, the first read hydrates after.
    await recordTime([rec({ durationMs: 1000 })]);
    await hydrate(NOW);
    expect(all()).toEqual({ humanMs: 5000, agentMs: 9000 });

    // And after a restart the disk alone says the same.
    resetTimeStore();
    await hydrate(NOW);
    expect(all()).toEqual({ humanMs: 5000, agentMs: 9000 });
  });

  it('reads days older than the hydrate window into the task index only, then says so', async () => {
    const old = shiftDateKey(TODAY, -200);
    const recent = shiftDateKey(TODAY, -3);
    await writeDay(old, [rec({ date: old, durationMs: 7000 })]);
    await writeDay(recent, [rec({ date: recent, durationMs: 2000 })]);
    // A file that is not a day file must be ignored, not parsed as one.
    await fs.writeFile(path.join(DIR(), 'notes.jsonl'), `${JSON.stringify(rec({ durationMs: 999_999 }))}\n`);

    await hydrate(NOW);
    await whenHistoryRead();
    expect(isHistoryRead()).toBe(true);
    expect(all()).toEqual({ humanMs: 9000, agentMs: 0 });
    // The rollup (the summary's source) keeps its 90-day window: the old day is not in it.
    const rollupDates = [...getIndex().keys()].map((k) => k.split('\u0000')[0]);
    expect(rollupDates).toContain(recent);
    expect(rollupDates).not.toContain(old);
    const view = taskTimeView(getTaskIndex(), 't_a', TODAY);
    expect(view.days.map((d) => d.date)).toEqual([recent, old]);
  });

  it('reports history as unread until the read is done', async () => {
    const old = shiftDateKey(TODAY, -120);
    await writeDay(old, [rec({ date: old, durationMs: 7000 })]);
    resetTimeStore();
    expect(isHistoryRead()).toBe(false);
    await hydrate(NOW);
    await whenHistoryRead();
    expect(isHistoryRead()).toBe(true);
  });

  it('keeps every session through a compaction', async () => {
    const date = TODAY;
    const batch: TimeRecord[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= COMPACT_ABOVE_BYTES; i++) {
      const one = rec({ date, sessionId: `s${i % 3}`, kind: i % 2 === 0 ? 'agent' : 'session', durationMs: 1000 });
      batch.push(one);
      bytes += JSON.stringify(one).length + 1;
    }
    await recordTime(batch);
    const before = taskTimeView(getTaskIndex(), 't_a', TODAY);

    // Folded: one line per (task, session, kind), each still naming its session.
    const lines = (await fs.readFile(path.join(DIR(), `${date}.jsonl`), 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => /^s[012]$/.test(JSON.parse(l).sessionId))).toBe(true);

    resetTimeStore();
    await hydrate(NOW);
    const after = taskTimeView(getTaskIndex(), 't_a', TODAY);
    expect(after.totals).toEqual(before.totals);
    expect(after.sessions).toEqual(before.sessions);
  });
});
