/**
 * /api/v1 session launch — CLOUD_MODE with `cloud.exec` enabled, i.e. the
 * companion as a REAL execution host rather than a pure relay.
 *
 * The behaviors under test are the ones that decide whether this feature is
 * safe, not just whether it works:
 *
 *  1. A launch on the CLOUD alias runs HERE (never relayed to the Mac).
 *  2. An absent host still relays — no silent fallback to this box.
 *  3. A cwd outside `cloud.exec.cwd_roots` is refused, without echoing the roots.
 *  4. `launch-options` merges our own host onto the primary's answer.
 *  5. With the primary offline we still answer with our host + primaryOffline,
 *     instead of the bare 503 that told the user "you can't start anything".
 *
 * The launch CORE is mocked (performMobileLaunch) — spawning a real CLI is the
 * live layer's job (tests/e2e/cloud-mobile-journey.live.test.ts). What matters
 * here is the ROUTING decision, which is exactly what a mock can prove.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-launch-cloud-exec', { CLOUD_MODE: true }));

const bridgeRequestMock = vi.hoisted(() => vi.fn());
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

// The launch core: assert WHAT the route asked it to do (especially the host it
// passed), without spawning anything. vi.hoisted because vi.mock factories are
// lifted above ordinary top-level consts.
const performMobileLaunchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/core/sessions/mobile-launch.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  performMobileLaunch: performMobileLaunchMock,
}));

import express from 'express';
import request from 'supertest';
import { sessionLaunchV1Router } from '../../../src/web/routes/session-launch-v1.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { CLOUD_HOST_ALIAS } from '../../../src/core/cloud-exec.js';

const EXEC_ROOT = path.join(os.tmpdir(), 'walnut-cloud-exec-root');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', sessionLaunchV1Router);
  app.use(errorHandler);
  return app;
}

/** Write a config.yaml. getConfig() reads the file each call — no cache to drop. */
async function writeConfig(yaml: string): Promise<void> {
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), yaml, 'utf-8');
}

const EXEC_ON = `version: 1
user: {}
cloud:
  exec:
    enabled: true
    cwd_roots:
      - ${EXEC_ROOT}
`;

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await fs.mkdir(EXEC_ROOT, { recursive: true });
  bridgeRequestMock.mockReset();
  performMobileLaunchMock.mockReset();
  performMobileLaunchMock.mockResolvedValue({ sessionId: 'sid-cloud-1', taskId: 'task-1', title: 'Cloud work' });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('POST /sessions with cloud.exec enabled', () => {
  it('runs a CLOUD-alias launch on this box and never touches the bridge', async () => {
    await writeConfig(EXEC_ON);
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: path.join(EXEC_ROOT, 'proj'), host: CLOUD_HOST_ALIAS, message: 'go',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionId: 'sid-cloud-1', taskId: 'task-1' });
    expect(bridgeRequestMock).not.toHaveBeenCalled();
    expect(performMobileLaunchMock).toHaveBeenCalledTimes(1);
    // The alias is EDGE-ONLY: the core must receive undefined so the existing
    // local-spawn path takes over with no new branch in the session core.
    const [input] = performMobileLaunchMock.mock.calls[0];
    expect(input.host).toBeUndefined();
    expect(input.cwd).toBe(path.join(EXEC_ROOT, 'proj'));
  });

  it('seeds id→host so this box\'s own follow-up calls resolve to the cloud host', async () => {
    await writeConfig(EXEC_ON);
    await request(createApp()).post('/api/v1/sessions').send({
      cwd: EXEC_ROOT, host: CLOUD_HOST_ALIAS, message: 'go',
    });
    const { getLaunchSeed } = await import('../../../src/core/sessions/launch-seed.js');
    expect(getLaunchSeed('sid-cloud-1')).toMatchObject({ host: CLOUD_HOST_ALIAS });
  });

  it('RELAYS an absent host — running on the wrong machine is worse than an error', async () => {
    await writeConfig(EXEC_ON);
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { sessionId: 'mac-1', taskId: 't', title: 'x' } });
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: EXEC_ROOT, message: 'go',
    });
    expect(res.status).toBe(201);
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1);
    expect(bridgeRequestMock.mock.calls[0][0]).toBe('__local__');
    expect(performMobileLaunchMock).not.toHaveBeenCalled();
  });

  it('RELAYS a named config host untouched', async () => {
    await writeConfig(EXEC_ON);
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { sessionId: 'r-1', taskId: 't', title: 'x' } });
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: '/somewhere/else', host: 'devbox', message: 'go',
    });
    expect(res.status).toBe(201);
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1);
    expect(performMobileLaunchMock).not.toHaveBeenCalled();
  });

  it('refuses a cwd outside the roots, without leaking the allowed roots', async () => {
    await writeConfig(EXEC_ON);
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: '/etc/secrets', host: CLOUD_HOST_ALIAS, message: 'go',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cloud_exec_unavailable');
    expect(res.body.error.message).not.toContain(EXEC_ROOT);
    expect(performMobileLaunchMock).not.toHaveBeenCalled();
    expect(bridgeRequestMock).not.toHaveBeenCalled();
  });

  it('refuses a traversal escape out of an allowed root', async () => {
    await writeConfig(EXEC_ON);
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: path.join(EXEC_ROOT, '..', '..', 'etc'), host: CLOUD_HOST_ALIAS, message: 'go',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cloud_exec_unavailable');
    expect(performMobileLaunchMock).not.toHaveBeenCalled();
  });

  it('refuses the cloud alias when exec is NOT enabled (the default posture)', async () => {
    await writeConfig('version: 1\nuser: {}\n');
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: EXEC_ROOT, host: CLOUD_HOST_ALIAS, message: 'go',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cloud_exec_unavailable');
    expect(res.body.error.message).toMatch(/cloud\.exec\.enabled/);
    expect(performMobileLaunchMock).not.toHaveBeenCalled();
  });

  it('refuses the cloud alias when enabled but no roots are configured', async () => {
    await writeConfig('version: 1\nuser: {}\ncloud:\n  exec:\n    enabled: true\n');
    const res = await request(createApp()).post('/api/v1/sessions').send({
      cwd: EXEC_ROOT, host: CLOUD_HOST_ALIAS, message: 'go',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cwd_roots/);
  });
});

describe('GET /sessions/launch-options with cloud.exec enabled', () => {
  const primaryOptions = {
    hosts: [{ alias: '', label: 'This Mac' }, { alias: 'devbox', label: 'Dev Box' }],
    dirs: [{ cwd: '/home/u/repo', host: 'devbox', lastUsed: '2026-08-06T00:00:00Z', count: 3 }],
  };

  it('appends OUR host to the primary\'s list (the Mac cannot know we can execute)', async () => {
    await writeConfig(EXEC_ON);
    bridgeRequestMock.mockResolvedValue({ ok: true, result: primaryOptions });
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    expect(res.body.hosts).toHaveLength(3);
    expect(res.body.hosts.at(-1)).toMatchObject({ alias: CLOUD_HOST_ALIAS });
    // The primary's own data is preserved verbatim.
    expect(res.body.dirs).toEqual(primaryOptions.dirs);
    expect(res.body.hosts.slice(0, 2)).toEqual(primaryOptions.hosts);
  });

  it('does NOT append our host when exec is off — the picker never offers a refusal', async () => {
    await writeConfig('version: 1\nuser: {}\n');
    bridgeRequestMock.mockResolvedValue({ ok: true, result: primaryOptions });
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual(primaryOptions.hosts);
  });

  it('answers locally with primaryOffline when the Mac is unreachable and we CAN execute', async () => {
    // Previously a bare 503: "you cannot start anything", no reason, no option.
    await writeConfig(EXEC_ON);
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'));
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ primaryOffline: true, degraded: true });
    expect(res.body.hosts).toEqual([{ alias: CLOUD_HOST_ALIAS, label: expect.any(String) }]);
    // No invented dirs for machines we cannot reach.
    expect(res.body.dirs).toEqual([]);
  });

  it('keeps the honest 503 when the Mac is unreachable and we CANNOT execute', async () => {
    await writeConfig('version: 1\nuser: {}\n');
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'));
    const res = await request(createApp()).get('/api/v1/sessions/launch-options');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('bridge_offline');
  });
});
