/**
 * /api/hosts — the hydrate + retry endpoints behind the host status UI.
 *
 * Two contracts pinned here: the GET is CHEAP and side-effect free (a status
 * read that dialled would turn every render into an ssh storm), and the POST is
 * the deliberate human retry (clear the throttle cache, hand the host to the
 * warmup, answer immediately — progress arrives over the WS).
 *
 * The daemon is faked at the module boundary: no ssh is spawned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

let cloudMode = false;
vi.mock('../../../src/constants.js', () => {
  const base = createMockConstants('walnut-hosts-route');
  return { ...base, get CLOUD_MODE() { return cloudMode; } };
});

// Where each host's connect stands, per test.
let states: Record<string, { connected?: boolean; phase?: string; phaseElapsedMs?: number; connectElapsedMs?: number; error?: string; retryInMs?: number }> = {};
const clearFailureCache = vi.fn();
const getDaemonConnection = vi.fn(async () => ({}));

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  clearDaemonFailureCache: (host?: string) => clearFailureCache(host),
  getDaemonConnection,
  getDaemonConnectState: (host: string) => ({
    host,
    connected: states[host]?.connected ?? false,
    phase: states[host]?.phase ?? 'idle',
    phaseElapsedMs: states[host]?.phaseElapsedMs ?? 0,
    connectElapsedMs: states[host]?.connectElapsedMs ?? 0,
    ...(states[host]?.error ? { error: states[host]!.error } : {}),
    ...(states[host]?.retryInMs !== undefined ? { retryInMs: states[host]!.retryInMs } : {}),
  }),
}));

let bridgeConnected = new Set<string>();
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeForHost: (alias: string) => ({ connected: bridgeConnected.has(alias) }),
}));

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({
    hosts: {
      devbox: { hostname: 'devbox.example.test', user: 'builder', label: 'Big dev box' },
      marina: { hostname: 'marina.example.test' },
      off: { hostname: 'off.example.test', enabled: false },
      'acme-1': { hostname: 'acme-1.example.test', discovered: true },
      __local__: { hostname: 'localhost' },
    },
  }),
}));

import express from 'express';
import request from 'supertest';
import { hostsRouter } from '../../../src/web/routes/hosts.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { setHostWarmup } from '../../../src/core/hosts/host-warmup-registry.js';
import type { HostWarmup } from '../../../src/core/hosts/host-warmup.js';
import type { HostStatus } from '../../../src/core/hosts/host-status.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hosts', hostsRouter);
  app.use(errorHandler);
  return app;
}

const kick = vi.fn(async () => {});
function installWarmup(snapshot: Record<string, { state: string; at: number }> = {}) {
  setHostWarmup({
    kick,
    snapshot: () => snapshot,
    stateOf: (key: string) => snapshot[key]?.state,
  } as unknown as HostWarmup);
}

function byHost(hosts: HostStatus[]): Record<string, HostStatus> {
  return Object.fromEntries(hosts.map((h) => [h.host, h]));
}

beforeEach(() => {
  cloudMode = false;
  states = {};
  bridgeConnected = new Set();
  clearFailureCache.mockClear();
  getDaemonConnection.mockClear();
  kick.mockClear();
  setHostWarmup(null);
});

describe('GET /api/hosts/status', () => {
  it('lists the picker hosts: disabled excluded, discovered included, __local__ never', async () => {
    const res = await request(createApp()).get('/api/hosts/status');
    expect(res.status).toBe(200);
    expect(res.body.hosts.map((h: HostStatus) => h.host).sort()).toEqual(['acme-1', 'devbox', 'marina']);
  });

  it('never starts a connect (a status read must not dial)', async () => {
    await request(createApp()).get('/api/hosts/status');
    expect(getDaemonConnection).not.toHaveBeenCalled();
  });

  it('answers idle for a host nothing has touched yet', async () => {
    const res = await request(createApp()).get('/api/hosts/status');
    const devbox = byHost(res.body.hosts).devbox;
    expect(devbox).toMatchObject({
      host: 'devbox', label: 'Big dev box', hostname: 'devbox.example.test',
      user: 'builder', connected: false, phase: 'idle',
    });
    expect(devbox.steps.every((s) => s.status === 'todo')).toBe(true);
    expect(devbox.note).toBeUndefined();
  });

  it('answers a mid-connect host with its step list and the first-connect note', async () => {
    states.devbox = { phase: 'install-runtime', phaseElapsedMs: 8_000, connectElapsedMs: 21_000 };
    const res = await request(createApp()).get('/api/hosts/status');
    const devbox = byHost(res.body.hosts).devbox;
    expect(devbox.phase).toBe('install-runtime');
    expect(devbox.phaseLabel).toContain('Big dev box');
    expect(devbox.steps.find((s) => s.phase === 'install-runtime')?.status).toBe('active');
    expect(devbox.steps.find((s) => s.phase === 'ssh')?.status).toBe('done');
    expect(devbox.steps.find((s) => s.phase === 'tunnel')?.status).toBe('todo');
    expect(devbox.note).toContain('minute');
    expect(devbox.connectElapsedMs).toBe(21_000);
  });

  it('answers a failed host with the cause, the next step and the retry clock', async () => {
    states.devbox = { phase: 'failed', error: 'Permission denied (publickey)', retryInMs: 38_000 };
    const res = await request(createApp()).get('/api/hosts/status');
    const devbox = byHost(res.body.hosts).devbox;
    expect(devbox).toMatchObject({
      phase: 'failed', kind: 'auth', error: 'Permission denied (publickey)', retryInMs: 38_000,
    });
    expect(devbox.hint).toContain('ssh builder@devbox.example.test');
  });

  it('answers a connected host with every step done', async () => {
    states.marina = { connected: true, phase: 'connected' };
    const res = await request(createApp()).get('/api/hosts/status');
    const marina = byHost(res.body.hosts).marina;
    expect(marina.connected).toBe(true);
    expect(marina.steps.every((s) => s.status === 'done')).toBe(true);
    expect(marina.label).toBe('marina');   // no label configured → the alias
  });

  it('reflects the warmup snapshot, including a discovered host it deliberately skips', async () => {
    installWarmup({
      'acme-1': { state: 'skipped', at: 1 },
      devbox: { state: 'running', at: 2 },
    });
    const res = await request(createApp()).get('/api/hosts/status');
    const hosts = byHost(res.body.hosts);
    expect(hosts['acme-1']).toMatchObject({ warmup: 'skipped', discovered: true });
    expect(hosts.devbox.warmup).toBe('running');
    expect(hosts.marina.warmup).toBeUndefined();  // no snapshot entry → no field
  });

  it('omits warmup entirely when no warmup is running (vitest / ephemeral / replica)', async () => {
    const res = await request(createApp()).get('/api/hosts/status');
    expect(res.body.hosts.every((h: HostStatus) => h.warmup === undefined)).toBe(true);
  });
});

describe('POST /api/hosts/:host/connect', () => {
  it('rejects __local__ and a blank host with 400', async () => {
    installWarmup();
    expect((await request(createApp()).post('/api/hosts/__local__/connect')).status).toBe(400);
    expect((await request(createApp()).post('/api/hosts/%20/connect')).status).toBe(400);
    expect(kick).not.toHaveBeenCalled();
    expect(clearFailureCache).not.toHaveBeenCalled();
  });

  it('404s an unknown host, prototype keys included', async () => {
    installWarmup();
    const res = await request(createApp()).post('/api/hosts/nope/connect');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('nope');
    // `hosts['__proto__']` is a truthy lookup; it must not read as a configured host.
    expect((await request(createApp()).post('/api/hosts/__proto__/connect')).status).toBe(404);
    expect((await request(createApp()).post('/api/hosts/constructor/connect')).status).toBe(404);
    expect(kick).not.toHaveBeenCalled();
    expect(clearFailureCache).not.toHaveBeenCalled();
  });

  it('409s a disabled host with the reason (the warmup would skip it silently)', async () => {
    installWarmup();
    const res = await request(createApp()).post('/api/hosts/off/connect');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('host_disabled');
    expect(res.body.error).toMatch(/enable it/i);
    expect(kick).not.toHaveBeenCalled();
  });

  it('connects a ~/.ssh/config host on request — the human asked for this one', async () => {
    installWarmup();
    const res = await request(createApp()).post('/api/hosts/acme-1/connect');
    expect(res.status).toBe(200);
    expect(kick).toHaveBeenCalledWith('acme-1');
  });

  it('answers "queued" once the warmup has taken the host, not the idle it was a moment ago', async () => {
    const snapshot: Record<string, { state: string; at: number }> = {};
    setHostWarmup({
      kick: vi.fn(async (host: string) => { snapshot[host] = { state: 'queued', at: Date.now() }; }),
      snapshot: () => snapshot,
      stateOf: (key: string) => snapshot[key]?.state,
    } as unknown as HostWarmup);
    const res = await request(createApp()).post('/api/hosts/marina/connect');
    expect(res.status).toBe(200);
    expect(res.body.status.phase).toBe('queued');
    expect(res.body.status.phaseLabel).toMatch(/another host/i);
    expect(res.body.status.warmup).toBe('queued');
  });

  it('clears the failure throttle, kicks the warmup, and answers the current status', async () => {
    states.devbox = { phase: 'failed', error: 'no route to host', retryInMs: 12_000 };
    installWarmup();
    const res = await request(createApp()).post('/api/hosts/devbox/connect');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(clearFailureCache).toHaveBeenCalledWith('devbox');
    expect(kick).toHaveBeenCalledWith('devbox');
    // The reply is the CURRENT state; progress arrives over the host:status WS event.
    expect(res.body.status).toMatchObject({ host: 'devbox', label: 'Big dev box' });
  });

  it('dials the host itself when no warmup exists to kick (WALNUT_HOST_WARMUP=0)', async () => {
    const res = await request(createApp()).post('/api/hosts/devbox/connect');
    expect(res.status).toBe(200);
    expect(clearFailureCache).toHaveBeenCalledWith('devbox');
    // A deliberate connect with nobody to hand it to must still connect something.
    expect(getDaemonConnection).toHaveBeenCalledWith('devbox', { hostname: 'devbox.example.test', user: 'builder', port: undefined });
  });

  it('never dials directly while a warmup exists (one connect at a time is the warmup\'s job)', async () => {
    installWarmup();
    await request(createApp()).post('/api/hosts/devbox/connect');
    expect(getDaemonConnection).not.toHaveBeenCalled();
  });
});

describe('cloud replica', () => {
  beforeEach(() => { cloudMode = true; });

  it('reads reachability from the host bridge, not from a daemon it does not have', async () => {
    bridgeConnected.add('devbox');
    const res = await request(createApp()).get('/api/hosts/status');
    expect(res.status).toBe(200);
    const hosts = byHost(res.body.hosts);
    expect(hosts.devbox).toMatchObject({ connected: true, phase: 'connected' });
    expect(hosts.marina).toMatchObject({ connected: false, phase: 'idle' });
    // A replica runs no warmup, so it must never claim a warmup state.
    expect(res.body.hosts.every((h: HostStatus) => h.warmup === undefined)).toBe(true);
  });

  it('refuses to connect a host — that is the primary\'s job', async () => {
    installWarmup();
    const res = await request(createApp()).post('/api/hosts/devbox/connect');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/primary/);
    expect(clearFailureCache).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });
});
