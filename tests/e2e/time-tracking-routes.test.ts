/**
 * Time tracking HTTP surface through a REAL server: POST /api/time/heartbeats,
 * GET /api/time/summary and GET /api/time/blocks. No mocks beyond the data dir.
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

// ── GET /api/time/blocks ──

interface Block {
  taskId: string;
  kind: string;
  startTs: string;
  endTs: string;
  ms: number;
  trackedMs: number;
}

async function getBlocks(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`http://127.0.0.1:${port}/api/time/blocks${qs ? `?${qs}` : ''}`);
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Where to seed the windows this suite folds into blocks.
 *
 * Two constraints collide: every window must land inside ONE local day (the fold
 * clips at midnight), and none may be in the future (the sanitizer rejects that).
 * Within the first ~90 minutes after midnight there is no room on today for a
 * spread of windows, so seed YESTERDAY instead — the endpoint takes an explicit
 * date, and samples up to a week old are accepted.
 */
function seedAnchor(): { date: string; baseMs: number } {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (now.getTime() - midnight.getTime() > 90 * 60_000) {
    return { date: localToday(), baseMs: now.getTime() - 70 * 60_000 };
  }
  const yesterday = new Date(midnight.getTime() - 12 * 60 * 60_000);
  yesterday.setHours(9, 0, 0, 0);
  const key = [
    yesterday.getFullYear(),
    String(yesterday.getMonth() + 1).padStart(2, '0'),
    String(yesterday.getDate()).padStart(2, '0'),
  ].join('-');
  return { date: key, baseMs: yesterday.getTime() };
}

describe('GET /api/time/blocks', () => {
  const anchor = seedAnchor();
  const TASK = 't_blocks';
  const iso = (offsetMs: number): string => new Date(anchor.baseMs + offsetMs).toISOString();

  beforeAll(async () => {
    const res = await postHeartbeats({
      samples: [
        // Two adjacent windows on one task → ONE merged block.
        { ts: iso(0), durationMs: 60_000, kind: 'session', taskId: TASK },
        { ts: iso(60_000), durationMs: 60_000, kind: 'session', taskId: TASK },
        // Twenty minutes later, past the merge gap → a SECOND block.
        { ts: iso(20 * 60_000), durationMs: 120_000, kind: 'session', taskId: TASK },
        // A different kind at the same instant → its own block, never merged in.
        { ts: iso(0), durationMs: 180_000, kind: 'chat', taskId: TASK },
        // Under the one-minute floor → drawn nowhere, reported as unplaced.
        { ts: iso(40 * 60_000), durationMs: 20_000, kind: 'triage', taskId: TASK },
      ],
    });
    expect(res.status).toBe(204);
  });

  const mine = (body: any, kind?: string): Block[] =>
    (body.blocks as Block[]).filter((b) => b.taskId === TASK && (!kind || b.kind === kind));

  it('merges adjacent windows and splits past the merge gap', async () => {
    const body = await getBlocks({ date: anchor.date });
    const session = mine(body, 'session');
    expect(session).toHaveLength(2);
    expect(session[0]!.ms).toBe(120_000);
    expect(session[0]!.trackedMs).toBe(120_000);
    expect(new Date(session[0]!.startTs).getTime()).toBe(anchor.baseMs);
    expect(session[1]!.ms).toBe(120_000);
    expect(new Date(session[1]!.startTs).getTime()).toBe(anchor.baseMs + 20 * 60_000);
  });

  it('keeps kinds in separate blocks and never blends them', async () => {
    const body = await getBlocks({ date: anchor.date });
    expect(mine(body, 'chat')).toHaveLength(1);
    expect(mine(body, 'chat')[0]!.ms).toBe(180_000);
    // The sub-minute triage window is not drawn at all.
    expect(mine(body, 'triage')).toHaveLength(0);
    expect(body.unplacedMs).toBeGreaterThanOrEqual(20_000);
  });

  it('returns blocks ascending by start', async () => {
    const starts = (await getBlocks({ date: anchor.date })).blocks.map((b: Block) => b.startTs);
    expect([...starts].sort()).toEqual(starts);
  });

  it('filters by kind', async () => {
    const body = await getBlocks({ date: anchor.date, kinds: 'chat' });
    expect(body.blocks.every((b: Block) => b.kind === 'chat')).toBe(true);
    expect(mine(body, 'chat')).toHaveLength(1);
    // Junk in the filter means "no filter", never "nothing".
    const junk = await getBlocks({ date: anchor.date, kinds: 'nope,,' });
    expect(mine(junk, 'session')).toHaveLength(2);
  });

  it('joins task titles server-side', async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Blocks title join', source: 'local' }),
    });
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as any).task.id as string;
    expect((await postHeartbeats({
      samples: [{ ts: iso(45 * 60_000), durationMs: 120_000, kind: 'session', taskId }],
    })).status).toBe(204);

    const body = await getBlocks({ date: anchor.date });
    expect(body.blocks.some((b: Block) => b.taskId === taskId)).toBe(true);
    expect(body.titles[taskId]).toBe('Blocks title join');
    // An id with no task row is simply absent — never a fabricated label.
    expect(body.titles[TASK]).toBeUndefined();
  });

  it('defaults to today and answers an empty day with an empty list', async () => {
    expect((await getBlocks()).date).toBe(localToday());
    const quiet = await getBlocks({ date: '2020-01-02' });
    expect(quiet).toMatchObject({ date: '2020-01-02', blocks: [], unplacedMs: 0, titles: {} });
  });

  it('rejects a date it cannot answer for instead of quietly answering another day', async () => {
    for (const bad of ['nope', '2026-02-31', '2026-13-01', '../../etc/passwd', '2026-8-2']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/time/blocks?date=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as any).error).toBe('invalid_date');
    }
  });
});
