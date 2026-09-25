/**
 * Heartbeat ingest — idempotency (a lost ack must not double count) and honest
 * durability (204 may only be said when the day file has it).
 *
 * Real store, real disk, no mocks: the append failure is injected by putting a
 * FILE where the store's directory belongs, which is exactly what the code sees
 * when the data dir is unwritable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-ingest'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { bankHeartbeatSamples, narrowRelaySamples, resetHeartbeatDedupe } from '../../../src/core/time-tracking/ingest.js';
import { getIndex, resetTimeStore } from '../../../src/core/time-tracking/store.js';
import { bucketKey, localDateKey } from '../../../src/core/time-tracking/rollup.js';

const TODAY = localDateKey(new Date());
const DIR = () => path.join(WALNUT_HOME, 'time-tracking');
const DAY_FILE = () => path.join(DIR(), `${TODAY}.jsonl`);

function sample(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: new Date().toISOString(), durationMs: 60_000, kind: 'session', taskId: 't_alpha', ...over };
}

const bankedMs = (taskId = 't_alpha', source: 'ios' | undefined = undefined) =>
  getIndex().get(bucketKey(TODAY, taskId, 'session', source)) ?? 0;

async function dayLines(): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(DAY_FILE(), 'utf-8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  resetTimeStore();
  resetHeartbeatDedupe();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  resetTimeStore();
  resetHeartbeatDedupe();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('idempotency by sample id', () => {
  it('banks a resent batch exactly once', async () => {
    const batch = [sample({ id: 'inst1-1' }), sample({ id: 'inst1-2', durationMs: 30_000 })];

    const first = await bankHeartbeatSamples(batch);
    expect(first).toMatchObject({ banked: 2, deduped: 0, durable: true });
    expect(bankedMs()).toBe(90_000);

    // The ack was lost, so the client sends the very same batch again.
    const second = await bankHeartbeatSamples(batch);
    expect(second).toMatchObject({ banked: 0, deduped: 2, durable: true });
    expect(bankedMs()).toBe(90_000);
    expect(await dayLines()).toHaveLength(2);
  });

  it('banks only the new samples of a partially overlapping batch', async () => {
    await bankHeartbeatSamples([sample({ id: 'inst1-1' })]);
    const out = await bankHeartbeatSamples([
      sample({ id: 'inst1-1' }),                        // already banked
      sample({ id: 'inst1-2', durationMs: 15_000 }),    // new
    ]);
    expect(out).toMatchObject({ banked: 1, deduped: 1, durable: true });
    expect(bankedMs()).toBe(75_000);
    expect(await dayLines()).toHaveLength(2);
  });

  it('banks every time when samples carry no id (legacy client, unchanged)', async () => {
    const batch = [sample()];
    await bankHeartbeatSamples(batch);
    const out = await bankHeartbeatSamples(batch);
    expect(out).toMatchObject({ banked: 1, deduped: 0 });
    expect(bankedMs()).toBe(120_000);
  });

  it('folds once when two concurrent requests carry the same id', async () => {
    const batch = [sample({ id: 'inst1-9' })];
    const [a, b] = await Promise.all([bankHeartbeatSamples(batch), bankHeartbeatSamples(batch)]);
    expect(a.banked + b.banked).toBe(1);
    expect(a.deduped + b.deduped).toBe(1);
    expect(bankedMs()).toBe(60_000);
    // Both callers still get an honest durability verdict.
    expect(a.durable && b.durable).toBe(true);
  });

  it('ignores an unusable id rather than the sample carrying it', async () => {
    // Too long / wrong charset: the sample still banks, it just cannot be deduped.
    const batch = [sample({ id: 'x'.repeat(65) }), sample({ id: 'has space', durationMs: 10_000 })];
    const out = await bankHeartbeatSamples(batch);
    expect(out.banked).toBe(2);
    expect(await bankHeartbeatSamples(batch)).toMatchObject({ banked: 2, deduped: 0 });
  });
});

describe('durability', () => {
  it('reports durable: false when the append cannot land, and never says 0 was banked in memory', async () => {
    // A FILE where the store's directory belongs: mkdir fails, so does every append.
    await fs.writeFile(DIR(), 'not a directory', 'utf-8');

    const out = await bankHeartbeatSamples([sample({ id: 'inst1-1' })]);
    expect(out).toMatchObject({ banked: 1, durable: false });
    // The rollup HAS it (the fold is synchronous and cannot fail)…
    expect(bankedMs()).toBe(60_000);
  });

  it('re-appends a known-failed batch WITHOUT folding it again', async () => {
    await fs.writeFile(DIR(), 'not a directory', 'utf-8');
    const batch = [sample({ id: 'inst1-1' })];
    expect(await bankHeartbeatSamples(batch)).toMatchObject({ banked: 1, durable: false });
    expect(bankedMs()).toBe(60_000);

    // The disk recovers and the client retries the same batch.
    await fs.rm(DIR(), { force: true });
    const retry = await bankHeartbeatSamples(batch);
    expect(retry.durable).toBe(true);
    // Exactly-once in memory…
    expect(bankedMs()).toBe(60_000);
    // …and the line is on disk exactly once.
    expect(await dayLines()).toEqual([
      expect.objectContaining({ date: TODAY, kind: 'session', taskId: 't_alpha', durationMs: 60_000 }),
    ]);
  });

  it('keeps the client id out of the day file', async () => {
    await bankHeartbeatSamples([sample({ id: 'inst1-1' })]);
    const [line] = await dayLines();
    expect(line).not.toHaveProperty('id');
  });

  it('answers durable for an empty or all-junk batch, banking nothing', async () => {
    for (const batch of [[], 'nope', [{ nope: true }], [sample({ kind: 'agent' })]]) {
      expect(await bankHeartbeatSamples(batch)).toMatchObject({ banked: 0, durable: true });
    }
    await expect(fs.readdir(DIR())).rejects.toThrow();
  });

  it('stamps the endpoint default source without touching an explicit one', async () => {
    await bankHeartbeatSamples([
      sample({ id: 'inst1-1' }),
      sample({ id: 'inst1-2', source: 'web', durationMs: 20_000 }),
    ], { defaultSource: 'ios' });
    expect(bankedMs('t_alpha', 'ios')).toBe(60_000);
    expect(bankedMs('t_alpha')).toBe(20_000);
  });
});

describe('narrowRelaySamples', () => {
  it('carries a valid id and drops an invalid one', () => {
    const [ok, bad] = narrowRelaySamples([
      sample({ id: 'inst1-1' }),
      sample({ id: 'nope\u0000-1' }),
    ], 'ios');
    expect(ok).toMatchObject({ id: 'inst1-1', source: 'ios' });
    expect(bad).not.toHaveProperty('id');
  });
});

describe('time:banked presence event', () => {
  it('announces exactly the records this call accepted, and nothing for a deduped resend', async () => {
    const { bus, EventNames } = await import('../../../src/core/event-bus.js');
    const events: Array<{ records: Array<Record<string, unknown>> }> = [];
    bus.subscribe('ingest-presence', (e) => { events.push(e.data as { records: Array<Record<string, unknown>> }); }, {
      global: true, interest: [EventNames.TIME_BANKED],
    });
    try {
      const batch = [sample({ id: 'p-1' }), sample({ id: 'p-2', durationMs: 30_000, kind: 'chat', taskId: undefined })];
      await bankHeartbeatSamples(batch, { defaultSource: 'ios' });
      expect(events).toHaveLength(1);
      expect(events[0].records).toEqual([
        expect.objectContaining({ durationMs: 60_000, kind: 'session', taskId: 't_alpha', source: 'ios' }),
        expect.objectContaining({ durationMs: 30_000, kind: 'chat', source: 'ios' }),
      ]);
      expect(typeof events[0].records[0].ts).toBe('string');

      await bankHeartbeatSamples(batch, { defaultSource: 'ios' }); // the lost-ack resend
      expect(events).toHaveLength(1);
    } finally {
      bus.unsubscribe('ingest-presence');
    }
  });
});
