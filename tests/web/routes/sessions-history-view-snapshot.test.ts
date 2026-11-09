/**
 * A remote session's open paints at once from the view the history route last served
 * (src/core/history-view-snapshot.ts; 2026-11-08, the user: "open asap, if need load more load
 * later"). Before it, a long remote session's first paint (source=streams) answered nothing,
 * because its windowed read never reaches the disk cache, and the panel read "Loading remote
 * session..." until the host answered (4.4 to 5.7 s on a link that drops large transfers).
 *
 * Pinned here:
 *   - a full read of a remote session keeps its served view, and the next source=streams read
 *     answers it with no host read, windowed flag, fork boundary and count space intact;
 *   - the first paint never carries a cursor (it must not seed a ?since= delta);
 *   - a rewind's cache invalidation forgets the view;
 *   - a delta never overwrites it, and a local session keeps none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const historyBySid = new Map<string, unknown[]>();
const windowedSids = new Set<string>();
const reads: string[] = [];
vi.mock('../../../src/core/session-history-pages.js', () => ({
  readSessionHistoryBefore: vi.fn(async () => null),
}));
vi.mock('../../../src/core/sessions/session-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/session-lifecycle.js')>();
  return {
    ...actual,
    readProviderSessionHistory: async (sessionId: string, _rec: unknown, host?: string) => {
      reads.push(`${sessionId}@${host ?? 'local'}`);
      return { messages: historyBySid.get(sessionId) ?? [], sourceAvailable: true, windowed: windowedSids.has(sessionId) };
    },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { invalidateSessionHistoryCaches } from '../../../src/core/session-history.js';
import { _resetHistoryViewsForTesting, flushHistoryViewsForTesting, readHistoryView, saveHistoryView, deleteHistoryView, historyViewGeneration, VIEW_MAX_MESSAGES } from '../../../src/core/history-view-snapshot.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}
const msg = (i: number) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message-${i}`, msgId: `m${i}`, timestamp: '' });

describe('remote first paint from the last served view', () => {
  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    historyBySid.clear(); windowedSids.clear(); reads.length = 0;
    _resetHistoryViewsForTesting();
  });
  afterEach(async () => {
    _resetSessionTrackerForTesting();
    _resetHistoryViewsForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('serves the view the full read served, with no host read and no cursor', async () => {
    const sid = 'view-remote-001';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(sid, Array.from({ length: 50 }, (_, i) => msg(i)));
    windowedSids.add(sid);

    const before = await request(createApp()).get(`/api/sessions/${sid}/history?source=streams&tail=10`);
    expect(before.body.messages).toEqual([]);

    const full = await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);
    expect(full.body.messages).toHaveLength(50);
    reads.length = 0;

    const p1 = await request(createApp()).get(`/api/sessions/${sid}/history?source=streams&tail=10`);
    expect(reads).toEqual([]);
    expect(p1.body.messages.map((m: { msgId: string }) => m.msgId)).toEqual(full.body.messages.slice(-10).map((m: { msgId: string }) => m.msgId));
    expect(p1.body.total).toBe(50);
    expect(p1.body.windowed).toBe(true);
    expect(p1.body.cursor).toBeUndefined();
    expect(typeof p1.body.snapshot).toBe('string');
  });

  it('survives a restart through its file (memory dropped)', async () => {
    const sid = 'view-remote-disk';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(sid, Array.from({ length: 5 }, (_, i) => msg(i)));
    await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);
    await flushHistoryViewsForTesting();
    _resetHistoryViewsForTesting();
    reads.length = 0;
    const p1 = await request(createApp()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(reads).toEqual([]);
    expect(p1.body.messages).toHaveLength(5);
  });

  it('a rewind invalidation forgets it', async () => {
    const sid = 'view-remote-rewind';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(sid, Array.from({ length: 5 }, (_, i) => msg(i)));
    await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);
    await flushHistoryViewsForTesting();
    await invalidateSessionHistoryCaches(sid, 'clouddev');
    expect(await readHistoryView(sid)).toBeNull();
    const p1 = await request(createApp()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(p1.body.messages).toEqual([]);
  });

  it('a delta leaves the view as it was', async () => {
    const sid = 'view-remote-delta';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(sid, Array.from({ length: 6 }, (_, i) => msg(i)));
    await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);
    historyBySid.set(sid, Array.from({ length: 8 }, (_, i) => msg(i)));
    const d = await request(createApp()).get(`/api/sessions/${sid}/history?since=6&anchorMsgId=m5`);
    expect(d.body.delta).toBe(true);
    expect((await readHistoryView(sid))?.messages).toHaveLength(6);
  });

  it('keeps no view for a local session, and caps a long one', async () => {
    const local = 'view-local-001';
    await createSessionRecord(local, '', 'p', '/w');
    historyBySid.set(local, [msg(0), msg(1)]);
    await request(createApp()).get(`/api/sessions/${local}/history?tail=400`);
    expect(await readHistoryView(local)).toBeNull();

    const big = 'view-remote-big';
    await createSessionRecord(big, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(big, Array.from({ length: VIEW_MAX_MESSAGES + 300 }, (_, i) => msg(i)));
    await request(createApp()).get(`/api/sessions/${big}/history`);
    const view = await readHistoryView(big);
    expect(view?.messages).toHaveLength(VIEW_MAX_MESSAGES);
    expect(view?.messages.at(-1)).toMatchObject({ msgId: `m${VIEW_MAX_MESSAGES + 299}` });
    expect(view?.total).toBe(VIEW_MAX_MESSAGES + 300);
  });

  it('a small-tail caller never shrinks the view', async () => {
    const sid = 'view-remote-small-tail';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(sid, Array.from({ length: 30 }, (_, i) => msg(i)));
    await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);
    await request(createApp()).get(`/api/sessions/${sid}/history?tail=3`);
    expect((await readHistoryView(sid))?.messages).toHaveLength(30);
  });

  it('a read that began before a rewind keeps nothing, in memory or on disk', async () => {
    const sid = 'view-rewind-race';
    const gen = historyViewGeneration(sid);
    saveHistoryView(sid, { messages: [msg(0) as never], total: 1 }, gen);
    await deleteHistoryView(sid);
    saveHistoryView(sid, { messages: [msg(1) as never], total: 1 }, gen);
    await flushHistoryViewsForTesting();
    _resetHistoryViewsForTesting();
    expect(await readHistoryView(sid)).toBeNull();
  });

  it('keeps the unsettled mark on a row still in flight', async () => {
    const sid = 'view-remote-unsettled';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
    historyBySid.set(sid, [msg(0), { role: 'assistant', text: '', msgId: 'agent-1', timestamp: '',
      tools: [{ name: 'Agent', input: { run_in_background: true }, result: 'Async agent launched', status: 'done' }] }]);
    const full = await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);
    const view = await readHistoryView(sid);
    const served = full.body.messages.map((m: { unsettled?: boolean }) => !!m.unsettled);
    expect(view?.messages.map((m) => !!(m as { unsettled?: boolean }).unsettled)).toEqual(served);
  });
});
