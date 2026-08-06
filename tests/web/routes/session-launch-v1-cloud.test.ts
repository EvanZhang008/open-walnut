/**
 * /api/v1 session launch — CLOUD_MODE (REPLICA) behavior. Session records
 * live on the primary box, so both launch endpoints RELAY through the
 * primary's daemon bridge (narrow `session.launch` command → `launch-request`
 * event → the primary's walnut server runs the shared mobile-launch core).
 *
 * Bridge mocked at its module seam (same pattern as
 * api-v1-session-talk-cloud.test.ts); the real relay protocol is covered by
 * tests/e2e/daemon-bridge-session-launch-e2e.test.ts against the real daemon.
 *
 * Covers: options + launch relay to '__local__', validation fast-fail without
 * a bridge round trip, the failure ladder (old daemon → 400
 * session_launch_needs_upgrade, bridge down → 503 bridge_offline, primary
 * server down → 503 bridge_offline), and errorKind → HTTP status passthrough.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-launch-v1-cloud', { CLOUD_MODE: true }));

// Bridge seam: the cloud route talks to the primary's daemon exclusively
// through bridgeRequest(). Keep the real BridgeOfflineError shape.
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

describe('GET /sessions/launch-options on a REPLICA', () => {
  it('relays to the primary daemon (__local__) and returns its result', async () => {
    const options = {
      hosts: [{ alias: '', label: 'This Mac' }, { alias: 'devbox', label: 'Dev Box' }],
      dirs: [{ cwd: '/home/user/repo', host: 'devbox', lastUsed: '2026-08-06T00:00:00Z', count: 3 }],
    };
    bridgeRequestMock.mockResolvedValue({ ok: true, result: options });

    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(options);
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.launch', { action: 'options' }, undefined,
    );
  });

  it('503 bridge_offline when no live bridge to the primary', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'));
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('bridge_offline');
  });

  it('400 session_launch_needs_upgrade on a pre-session.launch daemon', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'unknown command: session.launch' });
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('session_launch_needs_upgrade');
  });

  it('400 session_launch_needs_upgrade when the daemon allowlist rejects the command', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'command not permitted over bridge: session.launch' });
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('session_launch_needs_upgrade');
  });

  it('503 bridge_offline when the daemon has no connected primary server', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session.launch: no primary server connected' });
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('bridge_offline');
  });
});

describe('POST /sessions on a REPLICA', () => {
  const goodBody = { cwd: '/home/user/repo', host: 'devbox', message: 'hi', mode: 'plan' };

  it('relays the launch to the primary and returns 201 with its result', async () => {
    const created = { sessionId: 'sid-123', taskId: 'task-456', title: 'Session: repo' };
    bridgeRequestMock.mockResolvedValue({ ok: true, result: created });

    const res = await request(createApp()).post('/api/v1/sessions').send(goodBody);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1);
    const [host, cmd, payload, timeout] = bridgeRequestMock.mock.calls[0];
    expect(host).toBe('__local__');
    expect(cmd).toBe('session.launch');
    expect(payload).toEqual({ action: 'launch', params: goodBody });
    expect(timeout).toBe(30_000);
  });

  it('fast-fails validation locally without a bridge round trip', async () => {
    for (const [body, msg] of [
      [{ message: 'hi' }, 'cwd is required'],
      [{ cwd: 'relative/path' }, 'cwd must be an absolute path'],
      [{ cwd: '/tmp/x', mode: 'yolo' }, 'Invalid mode'],
      [{ cwd: '/tmp/x', taskId: '' }, 'taskId must be a non-empty string'],
    ] as const) {
      const res = await request(createApp()).post('/api/v1/sessions').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
      expect(res.body.error.message).toContain(msg);
    }
    expect(bridgeRequestMock).not.toHaveBeenCalled();
  });

  it('passes the primary\'s validation errors through with their errorKind status', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: false, error: 'Task "nope" not found', errorKind: 'not_found',
    });
    const res = await request(createApp()).post('/api/v1/sessions').send(goodBody);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toContain('not found');
  });

  it('400 session_launch_needs_upgrade on a pre-session.launch daemon', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'unknown command: session.launch' });
    const res = await request(createApp()).post('/api/v1/sessions').send(goodBody);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('session_launch_needs_upgrade');
  });

  it('503 bridge_offline when the bridge is down', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'));
    const res = await request(createApp()).post('/api/v1/sessions').send(goodBody);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('bridge_offline');
  });

  it('503 bridge_offline when the primary server is disconnected from its daemon', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session.launch: no primary server connected' });
    const res = await request(createApp()).post('/api/v1/sessions').send(goodBody);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('bridge_offline');
  });
});
