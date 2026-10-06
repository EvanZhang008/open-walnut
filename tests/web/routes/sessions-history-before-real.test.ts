/**
 * ?before= paging through the REAL route and the REAL window reader, over a REAL
 * transcript past the full read's byte ceiling (no mocked page reader).
 *
 * The reported failure (2026-10-04, a 38 MB session): "Load earlier messages" did
 * nothing, because the only read past the 4 MB tail was the full read, which that
 * file can never complete. Pinned here: the first read is a windowed tail, the full
 * read still only serves that tail (the bug's shape), and walking back with `before`
 * from the oldest row held yields every turn of the file exactly once, in order,
 * ending at the first bytes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-history-before-real'));
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import express from 'express';
import request from 'supertest';
import { CLAUDE_HOME } from '../../../src/constants.js';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { encodeProjectPath } from '../../../src/core/session-history.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WHALE_CEILING_BYTES, WHALE_SESSION, WHALE_TURNS, whaleJsonl } from '../../e2e/browser/whale-history-fixture.js';

const CWD = '/tmp/marina/whale';
const tmpBase = path.dirname(CLAUDE_HOME);

interface Row { role: string; text: string; msgId?: string; timestamp: string }

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

let savedCeiling: string | undefined;
beforeAll(() => {
  savedCeiling = process.env.WALNUT_MAX_FILE_READ_BYTES;
  process.env.WALNUT_MAX_FILE_READ_BYTES = String(WHALE_CEILING_BYTES);
});
afterAll(() => {
  if (savedCeiling === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = savedCeiling;
});

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${WHALE_SESSION}.jsonl`), whaleJsonl(Date.now()));
  await createSessionRecord(WHALE_SESSION, CWD, 'p');
});

afterEach(async () => {
  _resetSessionTrackerForTesting();
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

/** Prose rows of a page, as `ask:N` / `reply:N`. */
function turnsOf(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const m = /^whale (ask|reply) (\d+)$/.exec(r.text.trim());
    if (m) out.push(`${m[1]}:${m[2]}`);
  }
  return out;
}

describe('?before= over a transcript past the byte ceiling', () => {
  it('the file is past the ceiling, the first read is a windowed tail, and the full read serves the same tail', async () => {
    const file = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${WHALE_SESSION}.jsonl`);
    expect((await fsp.stat(file)).size).toBeGreaterThan(WHALE_CEILING_BYTES * 2);

    const app = createApp();
    const first = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ tail: 400 });
    expect(first.status).toBe(200);
    expect(first.body.windowed).toBe(true);
    expect(first.body.total).toBeLessThan(400);

    // The old "Load earlier": a full read. It cannot complete, so it is the tail again.
    const full = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`);
    expect(full.status).toBe(200);
    expect(full.body.windowed).toBe(true);
    expect(full.body.messages[0].msgId).toBe(first.body.messages[0].msgId);
  });

  it('walking back with before yields every turn of the file once, in order, and ends at the first bytes', async () => {
    const app = createApp();
    const tail = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ tail: 400 });
    let held: Row[] = tail.body.messages;
    let pages = 0;
    let reachedStart = false;
    while (!reachedStart) {
      const head = held.find((m) => m.timestamp)!.timestamp;
      const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ before: head });
      expect(res.status).toBe(200);
      expect(res.body.unavailable).toBeUndefined();
      const page: Row[] = res.body.messages;
      expect(page.length, 'every page before the start holds something').toBeGreaterThan(0);
      // Strictly older than the head the client sent, oldest first.
      expect(page.every((m) => m.timestamp < head)).toBe(true);
      for (let i = 1; i < page.length; i++) expect(page[i].timestamp >= page[i - 1].timestamp).toBe(true);
      held = [...page, ...held];
      reachedStart = res.body.reachedStart === true;
      expect(++pages).toBeLessThan(20);
    }
    expect(pages, 'a 17 MB file takes several bounded pages').toBeGreaterThanOrEqual(2);

    const turns = turnsOf(held);
    const expected: string[] = [];
    for (let t = 0; t < WHALE_TURNS; t++) expected.push(`ask:${t}`, `reply:${t}`);
    expect(turns).toEqual(expected);
  });

  it('a page is served without a cursor, a windowed flag or unsettled stamps', async () => {
    const app = createApp();
    const tail = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ tail: 400 });
    const head = tail.body.messages.find((m: Row) => m.timestamp).timestamp;
    const res = await request(app).get(`/api/sessions/${WHALE_SESSION}/history`).query({ before: head });
    expect(res.body).not.toHaveProperty('cursor');
    expect(res.body).not.toHaveProperty('windowed');
    expect(res.body.messages.some((m: { unsettled?: boolean }) => m.unsettled)).toBe(false);
  });
});
