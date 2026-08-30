/**
 * POST /api/v1/time/heartbeats on the PRIMARY — the phone banking human time
 * into the SAME store the web console feeds.
 *
 * Both real routers on a throwaway express app over a real (temp) store: the v1
 * router writes, the internal /api/time router reads the summary back. That pair
 * is the whole point of the feature, so the test asserts it end to end rather
 * than inspecting the rollup directly. Only the session→task lookup is stubbed
 * (it would otherwise need a real sessions table).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-v1'));

const sessionTaskIds = new Map<string, string>();
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-tracker.js')>();
  return {
    ...actual,
    getSessionByClaudeId: async (sid: string) => {
      const taskId = sessionTaskIds.get(sid);
      return taskId ? { claudeSessionId: sid, taskId } : null;
    },
  };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { timeV1Router } from '../../../src/web/routes/time-v1.js';
import { timeRouter } from '../../../src/web/routes/time.js';
import { resetTimeStore } from '../../../src/core/time-tracking/store.js';
import { resetHeartbeatDedupe } from '../../../src/core/time-tracking/ingest.js';
import { localDateKey } from '../../../src/core/time-tracking/rollup.js';

const TODAY = localDateKey(new Date());
const DIR = () => path.join(WALNUT_HOME, 'time-tracking');

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/v1', timeV1Router);
  server.use('/api/time', timeRouter);
  return server;
}

interface Sample {
  id?: string;
  ts?: string;
  durationMs?: number;
  kind?: string;
  taskId?: string;
  sessionId?: string;
  source?: unknown;
}

const post = (samples: unknown) => request(app()).post('/api/v1/time/heartbeats').send({ samples });
const sample = (over: Sample = {}): Sample => ({
  ts: new Date().toISOString(), durationMs: 60_000, kind: 'session', ...over,
});

async function summary(days = 7): Promise<any> {
  const res = await request(app()).get(`/api/time/summary?days=${days}`).expect(200);
  return res.body;
}

/** The JSONL append settles behind the response; poll rather than sleep blind. */
async function dayLines(date = TODAY): Promise<any[]> {
  let text = '';
  for (let i = 0; i < 40 && !text; i++) {
    text = await fs.readFile(path.join(DIR(), `${date}.jsonl`), 'utf-8').catch(() => '');
    if (!text) await new Promise((r) => setTimeout(r, 25));
  }
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  sessionTaskIds.clear();
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

describe('POST /api/v1/time/heartbeats (primary)', () => {
  it('banks a batch as iOS time and shows it in the shared day summary', async () => {
    await post([
      sample({ durationMs: 60_000, taskId: 't_alpha' }),
      sample({ durationMs: 30_000, kind: 'triage', taskId: 't_alpha', source: 'ios' }),
      sample({ durationMs: 15_000, kind: 'chat' }),
    ]).expect(204);

    const out = await summary();
    expect(out.totalHumanMs).toBe(105_000);
    expect(out.totalIosMs).toBe(105_000);
    const today = out.days.at(-1);
    expect(today.date).toBe(TODAY);
    expect(today.iosMs).toBe(105_000);
    expect(today.tasks.find((t: any) => t.taskId === 't_alpha')).toMatchObject({
      humanMs: 90_000, byKind: { session: 60_000, triage: 30_000, chat: 0 },
    });

    // Persisted with the source, into the same day file the browser writes.
    const lines = await dayLines();
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.source === 'ios')).toBe(true);
  });

  it('honours an explicit source: web — the endpoint default never overrides a client', async () => {
    await post([sample({ durationMs: 20_000, taskId: 't_alpha', source: 'web' })]).expect(204);
    const out = await summary();
    expect(out.totalHumanMs).toBe(20_000);
    expect(out).not.toHaveProperty('totalIosMs');
    expect(out.days.at(-1)).not.toHaveProperty('iosMs');
    expect((await dayLines())[0]).not.toHaveProperty('source');
  });

  it('resolves taskId from sessionId server-side (the client is not the authority)', async () => {
    sessionTaskIds.set('sess-1111-2222', 't_resolved');
    await post([sample({ durationMs: 45_000, sessionId: 'sess-1111-2222' })]).expect(204);
    const today = (await summary()).days.at(-1);
    expect(today.tasks.map((t: any) => t.taskId)).toEqual(['t_resolved']);
    expect(today.iosMs).toBe(45_000);
  });

  it('keeps a task row whole across sources — the phone never splits a task total', async () => {
    // Same task, same kind, one window from each client.
    await request(app()).post('/api/time/heartbeats')
      .send({ samples: [sample({ durationMs: 60_000, taskId: 't_shared' })] })
      .expect(204);
    await post([sample({ durationMs: 40_000, taskId: 't_shared' })]).expect(204);

    const today = (await summary()).days.at(-1);
    expect(today.tasks).toHaveLength(1);
    expect(today.tasks[0]).toMatchObject({
      taskId: 't_shared', humanMs: 100_000, byKind: { session: 100_000, triage: 0, chat: 0 },
    });
    // Only the DAY-level split records where it came from.
    expect(today.humanMs).toBe(100_000);
    expect(today.iosMs).toBe(40_000);
  });

  it('folds a day file written before `source` existed, then layers phone time on it', async () => {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(
      path.join(DIR(), `${TODAY}.jsonl`),
      [
        // An old per-window line, and an old COMPACTED bucket line (ts at UTC
        // midnight, no source) — both must keep parsing exactly as before.
        JSON.stringify({ date: TODAY, ts: `${TODAY}T09:00:00.000Z`, durationMs: 70_000, kind: 'session', taskId: 't_legacy' }),
        JSON.stringify({ date: TODAY, ts: `${TODAY}T00:00:00.000Z`, durationMs: 30_000, kind: 'chat' }),
      ].join('\n') + '\n',
      'utf-8',
    );
    resetTimeStore(); // next read hydrates from what we just wrote

    await post([sample({ durationMs: 10_000, taskId: 't_legacy' })]).expect(204);

    const today = (await summary()).days.at(-1);
    expect(today.humanMs).toBe(110_000);
    expect(today.iosMs).toBe(10_000); // pre-source history counts as web
    expect(today.tasks.find((t: any) => t.taskId === 't_legacy')).toMatchObject({ humanMs: 80_000 });
    expect(today.tasks.find((t: any) => t.taskId === '')).toMatchObject({ humanMs: 30_000 });
  });

  it('banks a resent batch once (the lost-ack path the client retries on)', async () => {
    const batch = [
      sample({ id: 'phone1-1', durationMs: 60_000, taskId: 't_alpha' }),
      sample({ id: 'phone1-2', durationMs: 30_000, taskId: 't_alpha' }),
    ];
    await post(batch).expect(204);
    await post(batch).expect(204); // the ack was lost; same batch again
    await post([...batch, sample({ id: 'phone1-3', durationMs: 10_000, taskId: 't_alpha' })]).expect(204);

    const today = (await summary()).days.at(-1);
    expect(today.humanMs).toBe(100_000);
    expect(today.tasks).toEqual([expect.objectContaining({ taskId: 't_alpha', humanMs: 100_000 })]);
    expect(await dayLines()).toHaveLength(3);
  });

  it('answers 503 in the frozen error envelope when the day file cannot be written', async () => {
    // A FILE where the store's directory belongs: the fold lands, the append cannot.
    await fs.writeFile(DIR(), 'not a directory', 'utf-8');
    const res = await post([sample({ id: 'phone1-9', taskId: 't_alpha' })]);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: 'primary_unreachable', message: expect.any(String) } });

    // The client retries once the disk recovers, and the retry is not a double count.
    await fs.rm(DIR(), { force: true });
    await post([sample({ id: 'phone1-9', taskId: 't_alpha' })]).expect(204);
    expect((await summary()).days.at(-1).humanMs).toBe(60_000);
    expect(await dayLines()).toHaveLength(1);
  });

  it('answers 204 for an empty, junk, or missing batch, and writes nothing', async () => {
    await post([]).expect(204);
    await post('nope').expect(204);
    await post([{ nope: true }, { ts: 'not-a-date', durationMs: 5, kind: 'session' },
      { ts: new Date().toISOString(), durationMs: 5, kind: 'agent' }]).expect(204);
    await request(app()).post('/api/v1/time/heartbeats').send({}).expect(204);
    expect((await summary()).totalHumanMs).toBe(0);
    await expect(fs.readdir(DIR())).rejects.toThrow();
  });
});
