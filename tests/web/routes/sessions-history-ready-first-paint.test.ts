/**
 * The history route's first paint (source=streams) asks the session's host for its ready view
 * when no view is kept (src/core/history-ready-view.ts), and says where every first paint came
 * from (`firstPaintSource`: 'snapshot' | 'ready' | 'preview', an extra field older clients ignore).
 *
 * The host is faked at readyViewWithin (no daemon, no process); the preview reads are faked as in
 * sessions-history-cold-preview.test.ts. Pinned here:
 *   - a kept view answers first, and the host is not asked;
 *   - with none, the preview and the ready view race: a readable preview answers at once and
 *     never waits for the ready view (a host still building answers within 900 ms; the
 *     preview takes tens), remote and local; a preview with nothing to read (notices only, or
 *     empty) waits for the ready view, which is the first paint when it comes in time;
 *   - a fork is never asked for a ready view (its first paint joins its ancestors).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
const { previewRead, readyMock, localRead } = vi.hoisted(() => ({ previewRead: vi.fn(), readyMock: vi.fn(), localRead: vi.fn() }));
vi.mock('../../../src/core/session-history.js', async (original) => ({
  ...await original<typeof import('../../../src/core/session-history.js')>(),
  readSessionHistoryTailWindow: previewRead,
}));
vi.mock('../../../src/core/history-ready-view.js', async (original) => ({
  ...await original<typeof import('../../../src/core/history-ready-view.js')>(),
  readyViewWithin: readyMock,
}));
vi.mock('../../../src/core/sessions/session-lifecycle.js', async (original) => ({
  ...await original<typeof import('../../../src/core/sessions/session-lifecycle.js')>(),
  readProviderSessionHistory: localRead,
}));

import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { _resetHistoryViewsForTesting, saveHistoryView, beginHistoryViewRead } from '../../../src/core/history-view-snapshot.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function app() { const a = express(); a.use('/api/sessions', sessionsRouter); return a; }
const row = (id: string, role: 'user' | 'assistant' = 'assistant') => ({ role, text: `text ${id}`, timestamp: '2026-01-01T00:00:01Z', msgId: id });
const readyRows = (ids: string[], over: Record<string, unknown> = {}) =>
  ({ messages: ids.map((id, i) => row(id, i % 2 === 0 ? 'user' : 'assistant')), total: ids.length, windowed: true, complete: true, readable: true, key: 'k', ...over });
const ids = (body: { messages: Array<{ msgId: string }> }) => body.messages.map((m) => m.msgId);
/** A row nobody reads as the conversation: a Walnut notice. */
const NOTE = '<walnut-message kind="notification" from="Walnut" outcome="stopped">\nA subtask stopped.\n</walnut-message>';
const notice = (id: string) => ({ role: 'user' as const, text: NOTE, timestamp: '2026-01-01T00:00:01Z', msgId: id });
const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

beforeEach(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  previewRead.mockReset(); readyMock.mockReset(); localRead.mockReset();
  readyMock.mockResolvedValue(null);
  previewRead.mockResolvedValue(null);
  localRead.mockResolvedValue({ messages: [], sourceAvailable: true, windowed: false });
  _resetHistoryViewsForTesting();
});
afterEach(async () => {
  _resetSessionTrackerForTesting();
  _resetHistoryViewsForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('a remote session', () => {
  it('a kept view answers first, and the host is not asked', async () => {
    const sid = 'ready-route-kept';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
    saveHistoryView(sid, { messages: [row('v1', 'user'), row('v2')] as never, total: 2 }, beginHistoryViewRead(sid));
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(res.body.firstPaintSource).toBe('snapshot');
    expect(ids(res.body)).toEqual(['v1', 'v2']);
    expect(readyMock).not.toHaveBeenCalled();
    expect(previewRead).not.toHaveBeenCalled();
  });

  it('a dense kept view sends only the latest readable screen without a cursor', async () => {
    const sid = 'ready-route-dense-kept';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
    const messages = Array.from({ length: 400 }, (_, i) => row(`v${i}`));
    saveHistoryView(sid, { messages: messages as never, total: 400 }, beginHistoryViewRead(sid));
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400&turns=10`);
    expect(res.body.messages).toHaveLength(40);
    expect(ids(res.body).at(-1)).toBe('v399');
    expect(res.body.total).toBe(400);
    expect(res.body.cursor).toBeUndefined();
    expect(readyMock).not.toHaveBeenCalled();
  });

  it('a readable preview answers at once; a ready view still on its way (rows or none) is not waited for', async () => {
    for (const late of [null, readyRows(['r1', 'r2'])]) {
      const sid = `ready-route-fast-preview-${late ? 'rows' : 'none'}`;
      await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
      readyMock.mockReset();
      readyMock.mockImplementation(() => later(800, late));
      previewRead.mockImplementation(() => later(20, [notice('n1'), row('p1')]));
      const t0 = performance.now();
      const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400&turns=10`);
      const ms = performance.now() - t0;
      expect(res.body.firstPaintSource).toBe('preview');
      expect(ids(res.body)).toEqual(['n1', 'p1']);
      expect(ms, 'the response must not wait for the ready view').toBeLessThan(400);
      expect(readyMock).toHaveBeenCalledTimes(1);
    }
  });

  it('a preview of notices only waits for the ready view, which is the first paint', async () => {
    const sid = 'ready-route-remote';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
    let previewStartedFirst = false;
    readyMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => {
      previewStartedFirst = previewRead.mock.calls.length > 0;
      resolve(readyRows(['r1', 'r2', 'r3']));
    }, 60)));
    previewRead.mockResolvedValue([notice('n1')]);
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400&turns=10`);
    expect(res.body.firstPaintSource).toBe('ready');
    expect(ids(res.body)).toEqual(['r1', 'r2', 'r3']);
    expect(res.body.windowed).toBe(true);
    expect(res.body.total).toBe(3);
    expect(res.body.cursor).toBeUndefined();
    expect(readyMock).toHaveBeenCalledTimes(1);
    expect(previewStartedFirst).toBe(true);
  });

  it('a host with no ready view in time: the preview is the first paint, readable or not', async () => {
    for (const rows of [[row('p1')], [notice('n1')], null]) {
      const sid = `ready-route-remote-none-${rows ? rows[0]!.msgId : 'empty'}`;
      await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
      previewRead.mockResolvedValue(rows);
      const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
      expect(res.body.firstPaintSource).toBe('preview');
      expect(ids(res.body)).toEqual(rows ? rows.map((r) => r.msgId) : []);
    }
  });

  it('the ready rows are sliced to what the caller asked', async () => {
    const sid = 'ready-route-tail';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
    readyMock.mockResolvedValue(readyRows(['a', 'b', 'c', 'd'], { total: 40 }));
    previewRead.mockResolvedValue([notice('n1')]);
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=2`);
    expect(ids(res.body)).toEqual(['c', 'd']);
    expect(res.body.total).toBe(40);
  });

  it('a fork is never asked for a ready view', async () => {
    const sid = 'ready-route-fork';
    await createSessionRecord(sid, '', 'p', '/w', { host: 'remote-dev' });
    await updateSessionRecord(sid, { forkedFromSessionId: 'ready-route-parent' });
    previewRead.mockResolvedValue([row('p1')]);
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(res.status).toBe(200);
    expect(readyMock).not.toHaveBeenCalled();
  });
});

describe('a local session', () => {
  it('with no view and a preview of notices, the ready view is the first paint', async () => {
    const sid = 'ready-route-local';
    await createSessionRecord(sid, '', 'p', '/w');
    readyMock.mockImplementation(() => later(40, readyRows(['l1', 'l2'])));
    localRead.mockResolvedValue({ messages: [notice('pv')], sourceAvailable: true, windowed: true });
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(res.body.firstPaintSource).toBe('ready');
    expect(ids(res.body)).toEqual(['l1', 'l2']);
  });

  it('a readable local preview answers at once, never waiting for the ready view', async () => {
    const sid = 'ready-route-local-fast';
    await createSessionRecord(sid, '', 'p', '/w');
    readyMock.mockImplementation(() => later(800, readyRows(['l1'])));
    localRead.mockImplementation(() => later(10, { messages: [row('pv')], sourceAvailable: true, windowed: true }));
    const t0 = performance.now();
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(res.body.firstPaintSource).toBe('preview');
    expect(ids(res.body)).toEqual(['pv']);
  });

  it('no ready view: its bounded preview is the first paint', async () => {
    const sid = 'ready-route-local-none';
    await createSessionRecord(sid, '', 'p', '/w');
    localRead.mockResolvedValue({ messages: [row('pv')], sourceAvailable: true, windowed: true });
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(res.body.firstPaintSource).toBe('preview');
    expect(ids(res.body)).toEqual(['pv']);
    expect(readyMock).toHaveBeenCalledTimes(1);
  });
});
