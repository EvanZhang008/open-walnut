/**
 * A budget for Walnut's own share of opening a remote session.
 *
 * 2026-11-09, the user: opening a conversation and sending a message must be near
 * instant; Walnut's own share must be near zero. A remote session's first paint
 * (`source=streams`) answers from the view the history route last served
 * (src/core/history-view-snapshot.ts), with no host read: about 8 ms in production.
 * sessions-history-view-snapshot.test.ts pins what it serves; this test pins that it
 * never waits on the host to do so. Every host read here never answers (a host
 * behind a dead link), so a new host round trip on the first-paint path hangs the
 * request and fails the budget, and the call itself is counted.
 *
 * Measured on this Mac at load 50 to 70 (2026-11-09): each open 4 to 43 ms (median 13) through
 * supertest, its own listen included. Budget 500 ms per open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const OPEN_BUDGET_MS = 500;
const never = <T>(): Promise<T> => new Promise<T>(() => {});

const historyBySid = new Map<string, unknown[]>();
/** Every host or daemon read the route made, by what it called. */
const hostCalls: string[] = [];
let hostHung = false;

vi.mock('../../../src/core/session-history-pages.js', () => ({
  readSessionHistoryBefore: vi.fn(async () => null),
}));
vi.mock('../../../src/core/sessions/session-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/session-lifecycle.js')>();
  return {
    ...actual,
    readProviderSessionHistory: async (sessionId: string, _rec: unknown, host?: string) => {
      if (hostHung) { hostCalls.push(`readProviderSessionHistory ${sessionId}@${host ?? 'local'}`); return never(); }
      return { messages: historyBySid.get(sessionId) ?? [], sourceAvailable: true, windowed: false };
    },
  };
});
vi.mock('../../../src/core/daemon-file-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/daemon-file-reader.js')>();
  class HungDaemonFileReader {
    constructor(host: string) {
      hostCalls.push(`DaemonFileReader ${host}`);
      return new Proxy(this, { get: (_t, prop) => (prop === 'then' ? undefined : () => never()) });
    }
  }
  return { ...actual, DaemonFileReader: HungDaemonFileReader };
});
vi.mock('../../../src/providers/daemon-connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/daemon-connection.js')>();
  return {
    ...actual,
    getDaemonConnection: (host: string) => { hostCalls.push(`getDaemonConnection ${host}`); return never(); },
    getDirectDaemonConnection: (host: string) => { hostCalls.push(`getDirectDaemonConnection ${host}`); return never(); },
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { _resetHistoryViewsForTesting, flushHistoryViewsForTesting } from '../../../src/core/history-view-snapshot.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}
const msg = (i: number) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message-${i}`, msgId: `m${i}`, timestamp: '' });

describe("Walnut's own share of opening a remote session", () => {
  beforeEach(async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    historyBySid.clear(); hostCalls.length = 0; hostHung = false;
    _resetHistoryViewsForTesting();
  });
  afterEach(async () => {
    hostHung = false;
    _resetSessionTrackerForTesting();
    _resetHistoryViewsForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  for (const kept of ['in memory', 'on disk after a restart'] as const) {
    it(`first paint with a kept view (${kept}) answers within ${OPEN_BUDGET_MS} ms with the host hung, and makes no host call`, async () => {
      const sid = `open-budget-${kept === 'in memory' ? 'mem' : 'disk'}`;
      await createSessionRecord(sid, '', 'p', '/w', { host: 'clouddev' });
      historyBySid.set(sid, Array.from({ length: 200 }, (_, i) => msg(i)));
      const app = createApp();

      // The open before this one: a full read while the host answered keeps the view.
      const full = await request(app).get(`/api/sessions/${sid}/history?tail=400`);
      expect(full.body.messages).toHaveLength(200);
      if (kept !== 'in memory') { await flushHistoryViewsForTesting(); _resetHistoryViewsForTesting(); }

      // The host stops answering: every read of it now hangs forever.
      hostHung = true;
      const times: number[] = [];
      const bodies: Array<{ messages: Array<{ msgId: string }> }> = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        // A request stuck on the hung host gives up at 4x the budget, so the checks
        // below name the host call that hung it.
        const p1 = await request(app).get(`/api/sessions/${sid}/history?source=streams&tail=50`)
          .timeout(OPEN_BUDGET_MS * 4).catch(() => null);
        times.push(Math.round(performance.now() - t0));
        if (!p1) break;
        expect(p1.status).toBe(200);
        bodies.push(p1.body);
      }
      const worst = Math.max(...times);
      console.log(`[open-budget] ${kept}: opens ${times.join(', ')} ms`);
      expect(hostCalls, `the first paint called the host (it hangs): ${hostCalls.join(', ')}`).toEqual([]);
      expect(worst, `a first paint from the kept view took ${worst} ms (budget ${OPEN_BUDGET_MS} ms); opens: ${times.join(', ')} ms`)
        .toBeLessThan(OPEN_BUDGET_MS);
      for (const body of bodies) {
        expect(body.messages).toHaveLength(50);
        expect(body.messages.at(-1)).toMatchObject({ msgId: 'm199' });
      }
    });
  }
});

