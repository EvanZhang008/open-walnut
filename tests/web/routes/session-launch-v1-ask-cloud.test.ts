/**
 * The phone's New chat through the cloud companion (REPLICA): an ask launch,
 * POST /api/v1/sessions { walnutAgent, agentId }, relays to the Mac like any
 * other launch, and the Mac runs the same ask launch the web draft does
 * (tests/e2e/mobile-launch-ask.test.ts pins that half against a real server).
 *
 * Pinned here: the ask fields ride the relay verbatim; a malformed ask body is
 * refused on the companion without a bridge round trip (an ask naming a host,
 * the companion's own included, is not something this slice runs); and a Mac
 * that predates ask launches answers its own "cwd is required", which passes
 * through as a 400 so the phone can tell (it only offers New chat as an ask
 * when the server says it can).
 *
 * Bridge mocked at its module seam, as in session-launch-v1-cloud.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-launch-v1-ask-cloud', { CLOUD_MODE: true }));

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
}));

import express from 'express';
import request from 'supertest';
import { sessionLaunchV1Router } from '../../../src/web/routes/session-launch-v1.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', sessionLaunchV1Router);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  bridgeRequestMock.mockReset();
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('POST /sessions { walnutAgent } on a REPLICA', () => {
  it('relays the ask launch to the Mac verbatim, with no cwd, and answers its 201', async () => {
    const body = { walnutAgent: true, agentId: 'mentor', message: 'plan the week', model: 'sonnet' };
    const created = { sessionId: 'sid-ask-1', taskId: 'task-ask-1', title: 'Ask Mentor' };
    bridgeRequestMock.mockResolvedValue({ ok: true, result: created });

    const res = await request(createApp()).post('/api/v1/sessions').send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1);
    const [host, cmd, payload, timeout] = bridgeRequestMock.mock.calls[0];
    expect(host).toBe('__local__');
    expect(cmd).toBe('session.launch');
    expect(payload).toEqual({ action: 'launch', params: body });
    expect(timeout).toBe(30_000);
  });

  it('refuses a malformed ask body on the companion, without a bridge round trip', async () => {
    for (const [body, message] of [
      [{ walnutAgent: true, host: '__cloud__', message: 'hi' }, 'run on the server host'],
      [{ walnutAgent: true, host: 'devbox', message: 'hi' }, 'run on the server host'],
      [{ agentId: 'mentor', cwd: '/tmp/x', message: 'hi' }, 'requires walnutAgent'],
      [{ walnutAgent: 'yes', message: 'hi' }, 'walnutAgent must be a boolean'],
    ] as const) {
      const res = await request(createApp()).post('/api/v1/sessions').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
      expect(res.body.error.message).toContain(message);
    }
    expect(bridgeRequestMock).not.toHaveBeenCalled();
  });

  it("a Mac that predates ask launches answers its own 'cwd is required', passed through as 400", async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'cwd is required', errorKind: 'bad_request' });
    const res = await request(createApp()).post('/api/v1/sessions').send({ walnutAgent: true, message: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'bad_request', message: 'cwd is required' });
  });

  it('the Mac unreachable: 503 bridge_offline, as for any launch', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'));
    const res = await request(createApp()).post('/api/v1/sessions').send({ walnutAgent: true, message: 'hi' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('bridge_offline');
  });
});
