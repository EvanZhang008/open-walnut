/**
 * Time tracking HTTP surface through a REAL server: POST /api/time/heartbeats
 * and GET /api/time/summary. No mocks beyond the data dir.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-time-routes'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

const localToday = (): string => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

async function postHeartbeats(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/time/heartbeats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getSummary(days?: number): Promise<any> {
  const qs = days === undefined ? '' : `?days=${days}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/time/summary${qs}`);
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
}, 60_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('POST /api/time/heartbeats', () => {
  it('accepts a batch, answers 204, and shows up in the summary', async () => {
    const ts = new Date().toISOString();
    const res = await postHeartbeats({
      samples: [
        { ts, durationMs: 60_000, kind: 'session', taskId: 't_alpha' },
        { ts, durationMs: 30_000, kind: 'triage', taskId: 't_alpha' },
        { ts, durationMs: 15_000, kind: 'chat' },
      ],
    });
    expect(res.status).toBe(204);

    const summary = await getSummary(7);
    expect(summary.today).toBe(localToday());
    expect(summary.days).toHaveLength(7);
    expect(summary.totalHumanMs).toBe(105_000);
    expect(summary.totalAgentMs).toBe(0);

    const today = summary.days.at(-1);
    expect(today.date).toBe(summary.today);
    const alpha = today.tasks.find((t: any) => t.taskId === 't_alpha');
    expect(alpha).toMatchObject({ humanMs: 90_000, byKind: { session: 60_000, triage: 30_000, chat: 0 } });
    // Taskless chat time buckets under the empty task id, not a fake task.
    expect(today.tasks.find((t: any) => t.taskId === '')).toMatchObject({ humanMs: 15_000 });
  });

  it('persists to a daily JSONL under the data dir', async () => {
    const dir = path.join(WALNUT_HOME, 'time-tracking');
    // The append settles behind the 204; poll briefly rather than sleeping blind.
    let text = '';
    for (let i = 0; i < 40 && !text; i++) {
      text = await fs.readFile(path.join(dir, `${localToday()}.jsonl`), 'utf-8').catch(() => '');
      if (!text) await new Promise((r) => setTimeout(r, 50));
    }
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ date: localToday(), kind: 'session' });
  });

  it('silently drops unusable samples instead of failing the request', async () => {
    const before = (await getSummary(7)).totalHumanMs;
    const res = await postHeartbeats({
      samples: [
        { ts: 'not-a-date', durationMs: 5_000, kind: 'session' },
        { ts: new Date().toISOString(), durationMs: 0, kind: 'session' },
        { ts: new Date().toISOString(), durationMs: 5_000, kind: 'agent' }, // never client-supplied
        { nope: true },
      ],
    });
    expect(res.status).toBe(204);
    expect((await getSummary(7)).totalHumanMs).toBe(before);
  });

  it('tolerates a missing or malformed body', async () => {
    expect((await postHeartbeats({})).status).toBe(204);
    expect((await postHeartbeats({ samples: 'nope' })).status).toBe(204);
  });
});

describe('GET /api/time/summary', () => {
  it('defaults to a 7-day window and clamps the days param', async () => {
    expect((await getSummary()).days).toHaveLength(7);
    expect((await getSummary(1)).days).toHaveLength(1);
    // Non-positive / junk is invalid input, not "one day" — fall back to default.
    expect((await getSummary(0)).days).toHaveLength(7);
    expect((await getSummary(-3)).days).toHaveLength(7);
    const junk = await fetch(`http://127.0.0.1:${port}/api/time/summary?days=abc`);
    expect(((await junk.json()) as any).days).toHaveLength(7);
    expect((await getSummary(9999)).days).toHaveLength(90);
  });

  it('returns ascending dates ending at today, with no gaps', async () => {
    const summary = await getSummary(5);
    const dates: string[] = summary.days.map((d: any) => d.date);
    expect(dates.at(-1)).toBe(summary.today);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(5);
  });

  it('carries the focus-share stat and the focus id list', async () => {
    const summary = await getSummary(7);
    expect(typeof summary.focusShare).toBe('number');
    expect(summary.focusShare).toBeGreaterThanOrEqual(0);
    expect(summary.focusShare).toBeLessThanOrEqual(1);
    expect(Array.isArray(summary.focusTaskIds)).toBe(true);
  });
});
