/**
 * GET /api/time/task/:taskId and GET /api/time/session/:sessionId through a REAL
 * server: heartbeats banked over HTTP, a previous process's day files read at boot,
 * and a day older than the hydrate window read by the history pass. No mocks beyond
 * the data dir.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-time-task-routes'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { localDateKey, shiftDateKey } from '../../src/core/time-tracking/rollup.js';

let server: HttpServer;
let base: string;

const TODAY = localDateKey(new Date());
const YESTERDAY = shiftDateKey(TODAY, -1);
const LONG_AGO = shiftDateKey(TODAY, -200);
const SEEDED = 't_seeded';

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  const dir = path.join(WALNUT_HOME, 'time-tracking');
  await fs.mkdir(dir, { recursive: true });
  // A previous process's days: yesterday (inside the hydrate window) and one far older.
  await fs.writeFile(path.join(dir, `${YESTERDAY}.jsonl`), [
    { date: YESTERDAY, ts: `${YESTERDAY}T10:00:00.000Z`, durationMs: 45 * 60_000, kind: 'agent', taskId: SEEDED, sessionId: 'sess-old' },
    { date: YESTERDAY, ts: `${YESTERDAY}T11:00:00.000Z`, durationMs: 5 * 60_000, kind: 'session', taskId: SEEDED, sessionId: 'sess-old' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(dir, `${LONG_AGO}.jsonl`),
    `${JSON.stringify({ date: LONG_AGO, ts: `${LONG_AGO}T10:00:00.000Z`, durationMs: 20 * 60_000, kind: 'triage', taskId: SEEDED })}\n`);

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/time/task/:taskId', () => {
  let taskId = '';

  it('answers a live task: today, each session, the time outside any session, and its title', async () => {
    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Time per task e2e' }),
    });
    expect(created.status).toBe(201);
    taskId = ((await created.json()) as { task: { id: string } }).task.id;

    const ts = new Date().toISOString();
    const beat = await fetch(`${base}/api/time/heartbeats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        samples: [
          { ts, durationMs: 60_000, kind: 'session', taskId, sessionId: 'sess-live' },
          { ts, durationMs: 30_000, kind: 'session', taskId, sessionId: 'sess-live' },
          { ts, durationMs: 15_000, kind: 'triage', taskId },
          // A client cannot bank agent time: this sample must not appear anywhere.
          { ts, durationMs: 99_000, kind: 'agent', taskId, sessionId: 'sess-live' },
        ],
      }),
    });
    expect(beat.status).toBe(204);

    const { status, body } = await getJson(`/api/time/task/${encodeURIComponent(taskId)}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      taskId,
      title: 'Time per task e2e',
      today: TODAY,
      weekStart: shiftDateKey(TODAY, -6),
      totals: {
        all: { humanMs: 105_000, agentMs: 0 },
        today: { humanMs: 105_000, agentMs: 0 },
        week: { humanMs: 105_000, agentMs: 0 },
      },
    });
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({
      date: TODAY,
      sessions: [{ sessionId: 'sess-live', humanMs: 90_000, agentMs: 0 }],
      other: { humanMs: 15_000, agentMs: 0 },
    });
    expect(body.sessions.map((s: any) => s.sessionId)).toEqual(['sess-live']);
    expect(body.degraded).toBeUndefined();
  });

  it('answers a task from a previous process\'s files, history included once it is read', async () => {
    let body: any = null;
    for (let i = 0; i < 50; i++) {
      body = (await getJson(`/api/time/task/${SEEDED}`)).body;
      if (body.historyComplete) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(body.historyComplete).toBe(true);
    expect(body.totals.all).toEqual({ humanMs: 25 * 60_000, agentMs: 45 * 60_000 });
    expect(body.totals.today).toEqual({ humanMs: 0, agentMs: 0 });
    expect(body.totals.week).toEqual({ humanMs: 5 * 60_000, agentMs: 45 * 60_000 });
    expect(body.days.map((d: any) => d.date)).toEqual([YESTERDAY, LONG_AGO]);
    // The long-ago day is the task's own time, not a session's.
    expect(body.days[1]).toMatchObject({ sessions: [], other: { humanMs: 20 * 60_000, agentMs: 0 } });
  });

  it('answers zeros, not an error, for a task with no time', async () => {
    const { status, body } = await getJson('/api/time/task/t_nothing_here');
    expect(status).toBe(200);
    expect(body).toMatchObject({ days: [], sessions: [], totals: { all: { humanMs: 0, agentMs: 0 } } });
  });

  it('refuses an id with a control character or past the length cap', async () => {
    expect((await getJson('/api/time/task/t_bad%01id')).status).toBe(400);
    expect((await getJson(`/api/time/task/${'x'.repeat(129)}`)).status).toBe(400);
    expect((await getJson('/api/time/session/s%00x')).status).toBe(400);
  });

  it('keeps the summary unchanged: the long-ago day stays outside its window', async () => {
    const { body } = await getJson('/api/time/summary?days=90');
    expect(body.days.some((d: any) => d.date === LONG_AGO)).toBe(false);
    const yesterday = body.days.find((d: any) => d.date === YESTERDAY);
    expect(yesterday.tasks.find((t: any) => t.taskId === SEEDED)).toMatchObject({ humanMs: 5 * 60_000, agentMs: 45 * 60_000 });
  });

  describe('GET /api/time/session/:sessionId', () => {
    it('answers one session with the titles of the tasks it was filed under', async () => {
      const { status, body } = await getJson('/api/time/session/sess-live');
      expect(status).toBe(200);
      expect(body).toMatchObject({
        sessionId: 'sess-live',
        taskIds: [taskId],
        taskTitles: { [taskId]: 'Time per task e2e' },
        totals: { all: { humanMs: 90_000, agentMs: 0 } },
        days: [{ date: TODAY, humanMs: 90_000, agentMs: 0 }],
      });
    });

    it('answers zeros for a session with no time', async () => {
      const { status, body } = await getJson('/api/time/session/sess-none');
      expect(status).toBe(200);
      expect(body).toMatchObject({ taskIds: [], days: [] });
    });
  });
});
