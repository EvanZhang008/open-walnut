/**
 * GET /:sessionId/history?tail=N — lazy history contract.
 *
 * A whale session (3000+ msgs, multi-MB payload) used to ship in full on every
 * panel open, pinning one of the browser's 6 connections for 35-150s (the
 * 2026-08-11 "STT timed out" cascade). Clients now ask for the last N only.
 *
 * Contract pinned here:
 *   · ?tail=N on a full fetch → last N messages, but total/cursor stay in the
 *     FULL count space (the client tracks the hidden prefix as baseOffset);
 *   · ?tail=N with N ≥ total → whole history, identical to no tail;
 *   · ?since= delta with an anchor is UNAFFECTED by tail (honored delta path);
 *   · declined delta (bogus anchor) falls through to the full payload, which
 *     IS tail-bounded — that fall-through was the multi-MB surprise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const historyBySid = new Map<string, unknown[]>();
const finishedIdsBySid = new Map<string, string[]>();
const windowedSids = new Set<string>();
vi.mock('../../../src/core/sessions/session-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/session-lifecycle.js')>();
  return {
    ...actual,
    readProviderSessionHistory: async (sessionId: string) => ({
      messages: historyBySid.get(sessionId) ?? [],
      sourceAvailable: true,
      windowed: windowedSids.has(sessionId),
      ...(finishedIdsBySid.has(sessionId) ? { finishedAgentIds: finishedIdsBySid.get(sessionId) } : {}),
    }),
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

function msg(i: number): unknown {
  return { role: i % 2 === 0 ? 'user' : 'assistant', text: `message-${i}`, msgId: `m${i}`, timestamp: '' };
}

describe('GET /:sessionId/history?tail=N', () => {
  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    historyBySid.clear();
    finishedIdsBySid.clear();
    windowedSids.clear();
  });

  afterEach(async () => {
    _resetSessionTrackerForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('serves the last N with total/cursor in the full count space', async () => {
    const sid = 'tail-whale-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 50 }, (_, i) => msg(i)));

    const res = await request(createApp()).get(`/api/sessions/${sid}/history?tail=10`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(10);
    expect(res.body.messages[0].msgId).toBe('m40');
    expect(res.body.messages[9].msgId).toBe('m49');
    expect(res.body.total).toBe(50);
    expect(res.body.cursor).toBe(50);
    expect(res.body.delta).toBe(false);
  });

  it('tail ≥ total returns everything (same as no tail)', async () => {
    const sid = 'tail-small-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 5 }, (_, i) => msg(i)));

    const res = await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(5);
    expect(res.body.total).toBe(5);
  });

  it('honored anchor delta ignores tail (incremental slice as before)', async () => {
    const sid = 'tail-delta-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 20 }, (_, i) => msg(i)));

    // Client holds up to m14 (cursor 15), anchored on m14.
    const res = await request(createApp())
      .get(`/api/sessions/${sid}/history?since=15&anchorMsgId=m14&anchorTail=0&tail=3`);

    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(true);
    expect(res.body.messages.map((m: { msgId: string }) => m.msgId)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19']);
    expect(res.body.cursor).toBe(20);
  });

  it('declined delta (unknown anchor) falls through to a TAIL-BOUNDED full payload', async () => {
    const sid = 'tail-declined-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 50 }, (_, i) => msg(i)));

    const res = await request(createApp())
      .get(`/api/sessions/${sid}/history?since=10&anchorMsgId=gone-forever&anchorTail=0&tail=10`);

    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(false);
    expect(res.body.messages).toHaveLength(10); // bounded, not 50
    expect(res.body.total).toBe(50);
    expect(res.body.cursor).toBe(50);
  });

  it('a windowed parse carries windowed:true so the client offers uncounted "Load earlier"', async () => {
    // inc-1786572252481: a cold tail-bounded read serves only the last window,
    // so total === messages.length even though older messages exist at the
    // source — without the flag the client hides the Load-earlier button.
    const sid = 'tail-windowed-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 12 }, (_, i) => msg(i)));
    windowedSids.add(sid);

    const res = await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);

    expect(res.status).toBe(200);
    expect(res.body.windowed).toBe(true);
    expect(res.body.total).toBe(12);
  });

  it('a normal full parse omits windowed', async () => {
    const sid = 'tail-notwindowed-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 5 }, (_, i) => msg(i)));

    const res = await request(createApp()).get(`/api/sessions/${sid}/history?tail=400`);

    expect(res.status).toBe(200);
    expect(res.body.windowed).toBeUndefined();
  });
});

// Orphan finished-agent ids (inc-1786496042099): nested agents' completion
// proof rides OUTSIDE the messages array — cursor space must not change.
describe('GET /:sessionId/history — finishedAgentIds transport', () => {
  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    historyBySid.clear();
    finishedIdsBySid.clear();
  });

  afterEach(async () => {
    _resetSessionTrackerForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('full payload carries finishedAgentIds without touching messages/total/cursor', async () => {
    const sid = 'fin-full-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 8 }, (_, i) => msg(i)));
    finishedIdsBySid.set(sid, ['toolu_nested_b', 'toolu_nested_a']);

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`);

    expect(res.status).toBe(200);
    expect(res.body.finishedAgentIds).toEqual(['toolu_nested_a', 'toolu_nested_b']); // sorted
    // Cursor-space invariant: ids ride OUTSIDE the array.
    expect(res.body.messages).toHaveLength(8);
    expect(res.body.total).toBe(8);
    expect(res.body.cursor).toBe(8);
  });

  it('delta payload carries finishedAgentIds too (may arrive with an empty slice)', async () => {
    const sid = 'fin-delta-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 8 }, (_, i) => msg(i)));
    finishedIdsBySid.set(sid, ['toolu_nested_a']);

    // Client fully caught up (cursor 8, anchored on m7) — empty delta, but the
    // id must still ride: the proving notification produces NO history row.
    const res = await request(createApp())
      .get(`/api/sessions/${sid}/history?since=8&anchorMsgId=m7&anchorTail=0`);

    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(true);
    expect(res.body.messages).toHaveLength(0);
    expect(res.body.finishedAgentIds).toEqual(['toolu_nested_a']);
  });

  it('omitted entirely when there are no orphan ids', async () => {
    const sid = 'fin-none-001';
    await createSessionRecord(sid, '', 'p');
    historyBySid.set(sid, Array.from({ length: 3 }, (_, i) => msg(i)));

    const res = await request(createApp()).get(`/api/sessions/${sid}/history`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('finishedAgentIds');
  });
});
