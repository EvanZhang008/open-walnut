import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants());
const previewRead = vi.hoisted(() => vi.fn());
vi.mock('../../../src/core/session-history.js', async (original) => ({
  ...await original<typeof import('../../../src/core/session-history.js')>(),
  readSessionHistoryTailWindow: previewRead,
}));
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { _resetHistoryViewsForTesting } from '../../../src/core/history-view-snapshot.js';
import { HISTORY_OPEN_PREVIEW_BYTES, HISTORY_OPEN_PREVIEW_MS } from '../../../src/core/history-open-preview.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function app() { const a = express(); a.use('/api/sessions', sessionsRouter); return a; }
beforeEach(async () => { await fs.mkdir(WALNUT_HOME, { recursive: true }); previewRead.mockReset(); _resetHistoryViewsForTesting(); });
afterEach(async () => { _resetSessionTrackerForTesting(); _resetHistoryViewsForTesting(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('first open without a saved remote view', () => {
  it('serves live bounded rows with no cursor and no older-turn backfill', async () => {
    const sid = 'cold-remote-preview';
    await createSessionRecord(sid, '', 'p', '/work/project', { host: 'remote-dev' });
    previewRead.mockResolvedValue([{ role: 'assistant', text: 'latest answer', timestamp: '2026-01-01T00:00:01Z', msgId: 'last' }]);
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400&turns=10`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].msgId).toBe('last');
    expect(res.body.windowed).toBe(true);
    expect(res.body.cursor).toBeUndefined();
    expect(res.body.firstPaintSource).toBe('preview');
    expect(previewRead).toHaveBeenCalledExactlyOnceWith(sid, '/work/project', 'remote-dev', HISTORY_OPEN_PREVIEW_BYTES);
  });

  it('a rewound session never gets an unfiltered cold preview', async () => {
    const sid = 'cold-remote-rewind';
    await createSessionRecord(sid, '', 'p', '/work/project', { host: 'remote-dev' });
    await updateSessionRecord(sid, { inPlaceRewinds: [{ uuid: 'cut', lastUuidAtCommit: 'old-tip', at: '2026-01-01T00:00:00Z' }] });
    previewRead.mockResolvedValue([{ role: 'assistant', text: 'ABANDONED reply', timestamp: '', msgId: 'old-tip' }]);
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(previewRead).not.toHaveBeenCalled();
  });

  it('a missing or hung host does not hold the first paint indefinitely', async () => {
    const sid = 'cold-remote-hung';
    await createSessionRecord(sid, '', 'p', '/work/project', { host: 'remote-dev' });
    previewRead.mockImplementation(() => new Promise(() => {}));
    const t = performance.now();
    const res = await request(app()).get(`/api/sessions/${sid}/history?source=streams&tail=400`).timeout(HISTORY_OPEN_PREVIEW_MS + 3000);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(performance.now() - t).toBeLessThan(HISTORY_OPEN_PREVIEW_MS + 2000);
    expect(res.body.cursor).toBeUndefined();
  });
});
