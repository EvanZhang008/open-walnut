/**
 * POST /api/v1/time/heartbeats on a cloud REPLICA — the relay contract.
 *
 * The phone mostly talks to the replica, so this endpoint must NOT 501 like the
 * internal /api/time family: it forwards the batch to the primary over the
 * `session.control` lane (bridge mocked at its module seam) and answers 204 only
 * when the primary banked it. Every relay failure is 503 primary_unreachable,
 * because the client queues and retries — a 4xx would throw the samples away.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-v1-cloud', { CLOUD_MODE: true }));

const bridgeRequestMock = vi.fn();
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`); }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}));

/** A local bank would be the bug this endpoint exists to avoid — assert it never happens. */
const recordTimeMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../../src/core/time-tracking/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/time-tracking/store.js')>();
  return { ...actual, recordTime: recordTimeMock };
});

import { timeV1Router } from '../../../src/web/routes/time-v1.js';
import { MAX_SAMPLES_PER_REQUEST } from '../../../src/core/time-tracking/rollup.js';

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/v1', timeV1Router);
  return server;
}

const post = (samples: unknown) => request(app()).post('/api/v1/time/heartbeats').send({ samples });
const sample = (over: Record<string, unknown> = {}) => ({
  ts: new Date().toISOString(), durationMs: 60_000, kind: 'session', source: 'ios', ...over,
});

beforeEach(() => {
  bridgeRequestMock.mockReset();
  recordTimeMock.mockClear();
});

describe('POST /api/v1/time/heartbeats on a REPLICA', () => {
  it('relays the batch to the primary and answers 204 once it is banked there', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 2, totalMs: 90_000, durable: true } });
    await post([sample({ taskId: 't_alpha' }), sample({ durationMs: 30_000, sessionId: 'sess-1' })]).expect(204);

    expect(bridgeRequestMock).toHaveBeenCalledTimes(1);
    const [alias, command, payload, timeout] = bridgeRequestMock.mock.calls[0]!;
    expect(alias).toBe('__local__');
    expect(command).toBe('session.control');
    expect(payload).toMatchObject({ action: 'server.time.heartbeats', sessionId: '__server__' });
    expect((payload as any).params.samples).toEqual([
      expect.objectContaining({ kind: 'session', durationMs: 60_000, taskId: 't_alpha', source: 'ios' }),
      expect.objectContaining({ kind: 'session', durationMs: 30_000, sessionId: 'sess-1', source: 'ios' }),
    ]);
    expect(timeout).toBeLessThanOrEqual(30_000);
    // Nothing is banked HERE: the replica's local day would be the wrong day.
    expect(recordTimeMock).not.toHaveBeenCalled();
  });

  it('answers 503 primary_unreachable when the bridge is down (client keeps the samples)', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'));
    const res = await post([sample()]);
    expect(res.status).toBe(503);
    // The frozen v1 error envelope, so the client's existing decoder reads it.
    expect(res.body).toEqual({ error: { code: 'primary_unreachable', message: expect.any(String) } });
  });

  it('answers 503 when the primary banked in memory but could not persist', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 1, totalMs: 60_000, durable: false } });
    const res = await post([sample()]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('primary_unreachable');
  });

  it('treats a primary that predates `durable` as success (no field = old build)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 1, totalMs: 60_000 } });
    await post([sample()]).expect(204);
  });

  it('forwards each sample dedupe id, so a retry cannot double count on the primary', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 1, durable: true } });
    await post([sample({ id: 'phone1-42' })]).expect(204);
    const relayed = (bridgeRequestMock.mock.calls[0]![2] as any).params.samples;
    expect(relayed[0]).toMatchObject({ id: 'phone1-42' });
  });

  it('answers 503 when the primary answered but could not serve', async () => {
    // Old primary that predates the action: retry, never discard — it self-heals
    // on the next deploy.
    bridgeRequestMock.mockResolvedValue({
      ok: false, error: 'Unknown control action: server.time.heartbeats', errorKind: 'bad_request',
    });
    expect((await post([sample()])).status).toBe(503);

    // The primary's daemon is up but its server is not.
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'no primary server connected' });
    const res = await post([sample()]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('primary_unreachable');
  });

  it('answers 204 for an empty or junk batch WITHOUT spending a bridge RPC', async () => {
    await post([]).expect(204);
    await post('nope').expect(204);
    await post([1, 'x', null, { nope: true }]).expect(204);
    await request(app()).post('/api/v1/time/heartbeats').send({}).expect(204);
    expect(bridgeRequestMock).not.toHaveBeenCalled();
  });

  it('caps how many samples cross the bridge', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 1, totalMs: 1 } });
    await post([...Array(MAX_SAMPLES_PER_REQUEST + 25)].map(() => sample())).expect(204);
    const relayed = (bridgeRequestMock.mock.calls[0]![2] as any).params.samples;
    expect(relayed).toHaveLength(MAX_SAMPLES_PER_REQUEST);
    // One oversized frame closes the socket every in-flight RPC shares.
    expect(JSON.stringify(relayed).length).toBeLessThan(128 * 1024);
  });

  it('forwards only the known fields, at their known sizes', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 1, totalMs: 1 } });
    await post([sample({
      taskId: 'x'.repeat(4096),      // an id no store would accept
      sessionId: 'sess-ok',
      junk: 'y'.repeat(4096),        // an unknown field must not ride along
      // Not a source we know: this edge resolves it to its own default rather
      // than letting the primary count phone time as browser time.
      source: 'android',
    })]).expect(204);

    const relayed = (bridgeRequestMock.mock.calls[0]![2] as any).params.samples;
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toEqual({
      ts: expect.any(String), durationMs: 60_000, kind: 'session', sessionId: 'sess-ok', source: 'ios',
    });
  });
});
