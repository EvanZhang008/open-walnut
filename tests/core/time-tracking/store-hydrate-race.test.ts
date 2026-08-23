/**
 * Regression: hydrate() vs recordTime() must never count the same millisecond
 * twice.
 *
 * recordTime() folds a record into the in-memory rollup AND appends it to that
 * day's JSONL. hydrate() rebuilds the rollup by reading those same files. So a
 * record that lands after hydration starts but before hydration reads its day
 * gets folded once live and once from the file — the panel then reports double
 * the time until the process restarts. The boot-time warm hydrate hides it; a
 * lazy hydrate triggered by the first /api/time/summary under live traffic does
 * not.
 *
 * The race is made deterministic by gating the store's read of ONE day file:
 * the test holds hydration inside that read, records a heartbeat, and only then
 * lets the read finish.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-race'));

/** One-shot pause on the read of a single day file. */
const gate: {
  file: string | null;
  reached: Promise<void>;
  signalReached: () => void;
  release: () => void;
  released: Promise<void>;
} = {
  file: null,
  reached: Promise.resolve(),
  signalReached: () => {},
  release: () => {},
  released: Promise.resolve(),
};

function armGate(file: string): void {
  gate.file = file;
  gate.reached = new Promise<void>((resolve) => { gate.signalReached = resolve; });
  gate.released = new Promise<void>((resolve) => { gate.release = resolve; });
}

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const passthrough = actual.readFile as unknown as (...args: unknown[]) => Promise<unknown>;
  const readFile = (async (file: unknown, ...rest: unknown[]) => {
    if (gate.file !== null && file === gate.file) {
      gate.file = null; // one shot — the test's own reads must not block
      gate.signalReached();
      await gate.released;
    }
    return passthrough(file, ...rest);
  }) as unknown as typeof actual.readFile;
  const api = { ...actual, readFile };
  return { ...api, default: api };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { getIndex, hydrate, recordTime, resetTimeStore } from '../../../src/core/time-tracking/store.js';
import { bucketKey, localDateKey } from '../../../src/core/time-tracking/rollup.js';
import type { TimeRecord } from '../../../src/core/time-tracking/types.js';

const DIR = () => path.join(WALNUT_HOME, 'time-tracking');
const NOW = new Date();
const TODAY = localDateKey(NOW);

function rec(durationMs: number): TimeRecord {
  return { date: TODAY, ts: NOW.toISOString(), durationMs, kind: 'session', taskId: 't_alpha' };
}

const KEY = () => bucketKey(TODAY, 't_alpha', 'session');

/** A day file left behind by a previous process. */
async function seedDayFile(durationMs: number): Promise<string> {
  await fs.mkdir(DIR(), { recursive: true });
  const file = path.join(DIR(), `${TODAY}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify(rec(durationMs))}\n`, 'utf-8');
  return file;
}

async function dayLines(): Promise<string[]> {
  const text = await fs.readFile(path.join(DIR(), `${TODAY}.jsonl`), 'utf-8');
  return text.split('\n').filter((l) => l.trim().length > 0);
}

beforeEach(async () => {
  gate.file = null;
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  gate.file = null;
  gate.release();
  resetTimeStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('hydrate / recordTime overlap', () => {
  it('counts a heartbeat that lands mid-hydration exactly once', async () => {
    const file = await seedDayFile(4000);
    resetTimeStore();
    armGate(file);

    const hydrating = hydrate(NOW);
    await gate.reached; // hydration is now suspended inside today's read

    const recording = recordTime([rec(1000)]);
    // Give an append every chance to reach the disk before the read resumes:
    // that interleaving is precisely what used to double count.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.release();

    await Promise.all([hydrating, recording]);

    expect(getIndex().get(KEY())).toBe(5000);
    expect(await dayLines()).toHaveLength(2);
  });

  it('counts a heartbeat recorded before the first hydrate exactly once', async () => {
    // The real-world shape: a heartbeat is the first thing to touch the store,
    // and the first /api/time/summary hydrates afterwards.
    await seedDayFile(4000);
    resetTimeStore();

    await recordTime([rec(1000)]);
    await hydrate(NOW);

    expect(getIndex().get(KEY())).toBe(5000);
    expect(await dayLines()).toHaveLength(2);
  });

  it('keeps the fast path exact once hydration has settled', async () => {
    await seedDayFile(4000);
    resetTimeStore();

    await hydrate(NOW);
    await recordTime([rec(1000)]);
    await recordTime([rec(500)]);
    // A hydrate() after the fact is a no-op, not a re-read.
    await hydrate(NOW);

    expect(getIndex().get(KEY())).toBe(5500);
    expect(await dayLines()).toHaveLength(3);
  });
});
