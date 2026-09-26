/**
 * POST /api/sessions/quick-start answers the host gate's refusal with its whole
 * body (C3, C54): the draft's error bar reads `code`, `host`, `headline`,
 * `hint` and `allowOverride`, so a bare `{ error }` would leave it with only a
 * sentence and no Start anyway. Nothing is written before the gate (C49).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

// `real`: run the REAL gate over the stubbed host frame below (the route's ordering tests).
const gate = vi.hoisted(() => ({ answer: null as Record<string, unknown> | null, calls: [] as unknown[], real: false }));
vi.mock('../../../src/core/sessions/host-start-gate.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/host-start-gate.js')>();
  return {
    ...real,
    hostStartGate: async (input: Parameters<typeof real.hostStartGate>[0]) => {
      gate.calls.push(input);
      return gate.real ? real.hostStartGate(input) : gate.answer;
    },
  };
});
// Every dial and every remote mkdir is counted: a refused Start must reach neither.
const daemon = vi.hoisted(() => ({ dials: 0, sent: [] as Array<[string, Record<string, unknown>]> }));
vi.mock('../../../src/utils/session-liveness.js', () => ({ isSessionProcessAlive: async () => false }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  clearDaemonFailureCache: () => {},
  cancelReconnectBackoff: () => false,
  reconnectHostNow: () => null,
  getDaemonConnectState: (host: string) => ({ host, connected: false, phase: 'idle', phaseElapsedMs: 0, connectElapsedMs: 0 }),
  getDaemonConnection: async () => {
    daemon.dials++;
    return { send: async (cmd: string, params: Record<string, unknown>) => { daemon.sent.push([cmd, params]); return { ok: true }; } };
  },
}));
const hc = vi.hoisted(() => ({
  frame: { host: 'buildbox', connected: true, phase: 'connected' } as Record<string, unknown>,
  readiness: { problems: [] as unknown[] },
  connectHostNow: vi.fn(),
  checkHostNow: vi.fn(async () => null),
}));
vi.mock('../../../src/core/hosts/host-connect-action.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  configHostDef: async (host: string) => (host === 'buildbox' ? { hostname: 'build.example.com', user: 'alice', label: 'Build box' } : undefined),
  hostStatusFrame: () => hc.frame,
  connectHostNow: hc.connectHostNow,
  checkHostNow: hc.checkHostNow,
}));
vi.mock('../../../src/core/hosts/host-readiness.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hostReadinessForLaunch: () => hc.readiness,
}));
vi.mock('../../../src/providers/session-manager.js', () => ({ getRegisteredSessionManager: () => null }));
vi.mock('../../../src/providers/claude-code-session.js', () => ({ sessionRunner: null }));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { WALNUT_HOME, IMAGES_DIR, CONFIG_FILE } from '../../../src/constants.js';
import path from 'node:path';
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js';

const app = () => express().use(express.json()).use('/api/sessions', sessionsRouter).use(errorHandler);

let events: BusEvent[];
beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  bus.clear();
  events = [];
  bus.subscribe('test-observer', (e) => { events.push(e); }, { global: true });
  gate.answer = null;
  gate.calls = [];
  gate.real = false;
  daemon.dials = 0;
  daemon.sent = [];
  hc.frame = { host: 'buildbox', connected: true, phase: 'connected' };
  hc.readiness = { problems: [] };
  hc.connectHostNow.mockReset();
  hc.checkHostNow.mockClear();
  await fs.rm(IMAGES_DIR, { recursive: true, force: true });
});
afterEach(async () => {
  bus.clear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('POST /api/sessions/quick-start: the host gate refusal', () => {
  it('answers 409 with the gate body verbatim and writes nothing', async () => {
    gate.answer = {
      error: 'Claude Code on Build box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.',
      code: 'host_not_ready', kind: 'claude_outdated', host: 'buildbox',
      headline: 'Claude Code on Build box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.', hint: '', allowOverride: true,
    };
    const res = await request(app()).post('/api/sessions/quick-start')
      .send({ cwd: '/home/alice/work/api', host: 'buildbox', message: 'go' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(gate.answer);
    expect(gate.calls).toEqual([expect.objectContaining({ host: 'buildbox' })]);
    expect(events.filter((e) => e.name === EventNames.TASK_CREATED || e.name === EventNames.SESSION_START)).toEqual([]);
  });

  it('passes Start anyway through to the gate', async () => {
    gate.answer = { error: 'x', code: 'host_not_ready', host: 'buildbox', headline: 'x', hint: '' };
    await request(app()).post('/api/sessions/quick-start')
      .send({ cwd: '/home/alice/work/api', host: 'buildbox', message: 'go', overrideReadiness: true });
    expect(gate.calls).toEqual([expect.objectContaining({ host: 'buildbox', overrideReadiness: true })]);
  });
});

describe('POST /api/v1/sessions body: Start anyway', () => {
  it('keeps overrideReadiness only when it is literally true', async () => {
    const { validateMobileLaunchBody } = await import('../../../src/core/sessions/mobile-launch.js');
    expect(validateMobileLaunchBody({ cwd: '/srv', overrideReadiness: true }).overrideReadiness).toBe(true);
    expect(validateMobileLaunchBody({ cwd: '/srv', overrideReadiness: 'yes' }).overrideReadiness).toBeUndefined();
    expect(validateMobileLaunchBody({ cwd: '/srv' })).not.toHaveProperty('overrideReadiness');
  });
});

// ── The gate runs before the route writes anything: images, and the remote mkdir (which dials) ──

const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code on Build box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.', commands: [] };
// A 1x1 PNG: enough for processAndSaveImages to write a file if it ever ran.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function withBuildboxConfig(): Promise<void> {
  // ensureCwd reads config.hosts: with buildbox configured, a remote mkdir WOULD dial.
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, 'hosts:\n  buildbox:\n    hostname: build.example.com\n    user: alice\n    label: Build box\n', 'utf-8');
}

async function imageFiles(): Promise<string[]> {
  return fs.readdir(IMAGES_DIR, { recursive: true }).then((xs) => xs.map(String)).catch(() => []);
}

describe('POST /api/sessions/quick-start: the gate precedes images and the cwd mkdir', () => {
  beforeEach(async () => { gate.real = true; await withBuildboxConfig(); });

  it('createCwd on a failed host: 409 from ONE fresh attempt, and no mkdir ever dials', async () => {
    const failed = { host: 'buildbox', connected: false, phase: 'failed', kind: 'auth', hint: 'Check your SSH key.' };
    hc.frame = failed;
    hc.connectHostNow.mockResolvedValue({ httpStatus: 200, body: {}, outcome: 'failed', status: failed });
    const res = await request(app()).post('/api/sessions/quick-start')
      .send({ cwd: '/home/alice/new-dir', host: 'buildbox', message: 'go', createCwd: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'host_unreachable', kind: 'auth', host: 'buildbox', hint: 'Check your SSH key.' });
    expect(hc.connectHostNow).toHaveBeenCalledTimes(1);
    expect(hc.connectHostNow).toHaveBeenCalledWith('buildbox', { deadlineMs: 20_000 });
    expect(daemon.dials).toBe(0);
    expect(daemon.sent).toEqual([]);
    // Ran once, in the route: quickStartSession was told not to run it again.
    expect(gate.calls).toHaveLength(1);
  });

  it('an off host (test server): 409 host_off with no dial at all', async () => {
    hc.frame = { host: 'buildbox', connected: false, phase: 'off' };
    const res = await request(app()).post('/api/sessions/quick-start')
      .send({ cwd: '/home/alice/new-dir', host: 'buildbox', message: 'go', createCwd: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'host_off', error: 'Remote hosts are off on this test server.', host: 'buildbox' });
    expect(hc.connectHostNow).not.toHaveBeenCalled();
    expect(daemon.dials).toBe(0);
  });

  it('a not-ready host: 409 host_not_ready with no remote mkdir and no image file left behind', async () => {
    hc.readiness = { problems: [OUTDATED] };
    const res = await request(app()).post('/api/sessions/quick-start')
      .send({ cwd: '/home/alice/new-dir', host: 'buildbox', message: 'look', createCwd: true, images: [{ mediaType: 'image/png', data: PNG }] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'host_not_ready', kind: 'claude_outdated', allowOverride: true, error: OUTDATED.message });
    expect(daemon.dials).toBe(0);
    expect(daemon.sent).toEqual([]);
    expect(await imageFiles()).toEqual([]);
    expect(events.filter((e) => e.name === EventNames.TASK_CREATED || e.name === EventNames.SESSION_START)).toEqual([]);
  });

  it('a ready host goes on to the mkdir (the gate passing does not block the launch)', async () => {
    const res = await request(app()).post('/api/sessions/quick-start')
      .send({ cwd: '/home/alice/new-dir', host: 'buildbox', message: 'go', createCwd: true });
    expect(res.status).toBe(200);
    expect(daemon.sent).toEqual([['fs.mkdir', { path: '/home/alice/new-dir' }]]);
    expect(gate.calls).toHaveLength(1);
  });
});
