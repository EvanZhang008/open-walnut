/**
 * A fork read as a window of its own transcript never gets its ancestors joined above that
 * window (2026-11-17: two forks past the byte ceiling were served as [parent][4 MB tail],
 * months of the fork's own turns missing between the two; each turn moved the tail's start, so
 * every refresh took rows out of the middle of what the reader saw). The ancestors come with the
 * older page that reaches the fork's own start, in the web route and the /api/v1 rich history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

type Row = { msgId: string; role: string; text: string; timestamp: string };
const own = new Map<string, { messages: Row[]; windowed: boolean }>();
const reads: string[] = [];
let pageAnswer: { messages: Row[]; reachedStart: boolean } = { messages: [], reachedStart: false };

const windowedArrays = new WeakSet<object>();
vi.mock('../../../src/core/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-history.js')>();
  return {
    ...actual,
    readSessionHistory: async (sessionId: string) => {
      reads.push(sessionId);
      const h = own.get(sessionId) ?? { messages: [], windowed: false };
      const arr = [...h.messages];
      if (h.windowed) windowedArrays.add(arr);
      return arr;
    },
    isWindowedHistory: (messages: object) => windowedArrays.has(messages),
  };
});
vi.mock('../../../src/core/session-history-pages.js', () => ({
  readSessionHistoryBefore: async () => pageAnswer,
  olderPageRead: async () => 'windows-only' as const,
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { readSessionRichHistory } from '../../../src/core/sessions/session-lifecycle.js';
import { joinForkPrefix } from '../../../src/core/sessions/fork-prefix.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/sessions', sessionsRouter);
  a.use(errorHandler);
  return a;
}
const row = (id: string, minute: number): Row => ({
  msgId: id, role: minute % 2 ? 'assistant' : 'user', text: `row ${id}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
});
const parent = [row('p1', 1), row('p2', 2), row('p3', 3)];
const forkTail = [row('f80', 80), row('f81', 81), row('f82', 82)];

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  _resetSessionTrackerForTesting?.();
  own.clear(); reads.length = 0;
  await createSessionRecord('fw-parent', 'task-parent', 'proj');
  await createSessionRecord('fw-child', 'task-child', 'proj', undefined, { forkedFromSessionId: 'fw-parent' });
  own.set('fw-parent', { messages: parent, windowed: false });
});
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a windowed fork', () => {
  it('the full read is the fork\'s own window: no ancestors above it, no read of them', async () => {
    own.set('fw-child', { messages: forkTail, windowed: true });
    const res = await request(app()).get('/api/sessions/fw-child/history?tail=400');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: Row) => m.msgId)).toEqual(['f80', 'f81', 'f82']);
    expect(res.body.windowed).toBe(true);
    expect(res.body.forkBoundaryIndex).toBeUndefined();
    expect(res.body.forkedFromSessionId).toBe('fw-parent');
    expect(reads).not.toContain('fw-parent');
  });

  it('a fork read whole still has its ancestors above it', async () => {
    own.set('fw-child', { messages: [row('f1', 10), ...forkTail], windowed: false });
    const res = await request(app()).get('/api/sessions/fw-child/history?tail=400');
    expect(res.body.messages.map((m: Row) => m.msgId)).toEqual(['p1', 'p2', 'p3', 'f1', 'f80', 'f81', 'f82']);
    expect(res.body.forkBoundaryIndex).toBe(3);
  });

  it('an older page pages the fork\'s own transcript; the one that reaches its start carries the ancestors', async () => {
    pageAnswer = { messages: [row('f40', 40), row('f41', 41)], reachedStart: false };
    const mid = await request(app()).get('/api/sessions/fw-child/history').query({ before: forkTail[0]!.timestamp });
    expect(mid.body).toEqual({ messages: pageAnswer.messages, reachedStart: false });
    pageAnswer = { messages: [row('f1', 10), row('f2', 11)], reachedStart: true };
    const start = await request(app()).get('/api/sessions/fw-child/history').query({ before: row('f40', 40).timestamp });
    expect(start.body.messages.map((m: Row) => m.msgId)).toEqual(['p1', 'p2', 'p3', 'f1', 'f2']);
    expect(start.body.forkBoundaryIndex).toBe(3);
    expect(start.body.reachedStart).toBe(true);
  });

  it('the /api/v1 rich history follows the same rule', async () => {
    own.set('fw-child', { messages: forkTail, windowed: true });
    const windowed = await readSessionRichHistory('fw-child', 400);
    expect(windowed.messages.map((m) => m.msgId)).toEqual(['f80', 'f81', 'f82']);
    expect(windowed.forkBoundaryIndex).toBeUndefined();
    own.set('fw-child', { messages: forkTail, windowed: false });
    const whole = await readSessionRichHistory('fw-child', 400);
    expect(whole.messages.map((m) => m.msgId)).toEqual(['p1', 'p2', 'p3', 'f80', 'f81', 'f82']);
    expect(whole.forkBoundaryIndex).toBe(3);
  });
});

describe('joinForkPrefix', () => {
  it('a fork that copied its parent into its own transcript is not given the parent twice', () => {
    const embedded = [...parent, row('f1', 10)];
    expect(joinForkPrefix(parent, embedded)).toEqual({ messages: embedded, forkBoundaryIndex: 3 });
    expect(joinForkPrefix([], forkTail)).toEqual({ messages: forkTail });
    // An older page of a long fork: the start of its copy of the parent, the copy's end not on it.
    const pageOfCopy = [parent[0]!, parent[1]!];
    expect(joinForkPrefix(parent, pageOfCopy)).toEqual({ messages: pageOfCopy });
  });
});

describe('every reader that joins a fork\'s ancestors', () => {
  it('goes through fork-prefix.ts (find keeps its own walk, paging the fork first)', () => {
    // Each joiner cuts the ancestors at a rewind point; a new joiner shows up as a new caller.
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    });
    walk('src');
    const callers = files.filter((f) => /cutAncestorHistoryAtRewindPoint\(/.test(readFileSync(f, 'utf8'))
      && !f.endsWith('session-rewind.ts')).map((f) => f.split(path.sep).join('/')).sort();
    expect(callers).toEqual(['src/core/sessions/fork-prefix.ts', 'src/core/sessions/session-find.ts']);
  });
});
