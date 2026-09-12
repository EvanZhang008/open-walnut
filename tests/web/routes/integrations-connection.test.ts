/**
 * /api/integrations connection routes: what Settings reads to show a plugin's
 * account link, and the button that starts a device-code sign-in.
 *
 * A fixture plugin is registered straight into the global registry with a
 * scripted PluginConnection; no real provider, no real home directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registry } from '../../../src/core/integration-registry.js';
import { integrationsRouter } from '../../../src/web/routes/integrations.js';
import { createMockPlugin } from '../../core/plugin-test-utils.js';
import {
  recordSyncFailure,
  recordSyncSuccess,
  _resetSyncHealthForTesting,
} from '../../../src/core/plugin-sync-health.js';
import type { PluginConnection, PluginConnectionStatus, PluginSignInPrompt } from '../../../src/core/integration-types.js';

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn().mockResolvedValue({ version: 1, plugins: {} }),
}));
vi.mock('../../../src/core/integration-loader.js', () => ({
  getUnconfiguredPlugins: () => [],
}));

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/integrations', integrationsRouter);
  return a;
}

const LINKED = 'linked-fixture';
const PLAIN = 'plain-fixture';

let status: PluginConnectionStatus;
let signIn: (() => Promise<PluginSignInPrompt>) | undefined;

beforeEach(() => {
  _resetSyncHealthForTesting();
  status = { state: 'connected', account: 'someone@example.com', credentialExpiresAt: new Date(Date.now() + 3600_000).toISOString() };
  signIn = async () => ({
    userCode: 'WXYZ-9876',
    verificationUri: 'https://example.com/device',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  const connection: PluginConnection = {
    status: async () => status,
    // Forwarded at call time so a test can drop signIn after registration.
    signIn: async () => {
      if (!signIn) throw new Error('unreachable');
      return signIn();
    },
  };
  registry.register(LINKED, createMockPlugin({ id: LINKED, name: 'Linked Fixture', connection }));
  registry.register(PLAIN, createMockPlugin({ id: PLAIN, name: 'Plain Fixture' }));
});

afterEach(() => {
  registry.unregister(LINKED);
  registry.unregister(PLAIN);
});

describe('GET /api/integrations/settings', () => {
  it('flags which plugins have an account link', async () => {
    const res = await request(app()).get('/api/integrations/settings');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body as Array<{ id: string; connection?: boolean }>).map((p) => [p.id, p]));
    expect(byId[LINKED].connection).toBe(true);
    expect(byId[PLAIN].connection).toBe(false);
  });
});

describe('GET /api/integrations/connections', () => {
  it('lists only linked plugins, merging the plugin status with Walnut sync health', async () => {
    recordSyncFailure(LINKED, Object.assign(new Error('token endpoint 503'), { authKind: 'unreachable', authCode: 'service_unavailable' }));
    recordSyncFailure(LINKED, new Error('again'));
    const res = await request(app()).get('/api/integrations/connections');
    expect(res.status).toBe(200);
    const list = res.body.connections as Array<Record<string, unknown>>;
    const ids = list.map((c) => c.pluginId);
    expect(ids).toContain(LINKED);
    expect(ids).not.toContain(PLAIN);
    const mine = list.find((c) => c.pluginId === LINKED)!;
    expect(mine.pluginName).toBe('Linked Fixture');
    expect(mine.state).toBe('connected');
    expect(mine.account).toBe('someone@example.com');
    expect(mine.canSignIn).toBe(true);
    expect((mine.sync as { consecutiveFailures: number; lastError: string }).consecutiveFailures).toBe(2);
    expect((mine.sync as { lastError: string }).lastError).toBe('again');
  });

  it('a plugin whose status() throws does not blank the list', async () => {
    registry.register('broken-fixture', createMockPlugin({
      id: 'broken-fixture', name: 'Broken',
      connection: { status: async () => { throw new Error('cache unreadable'); } },
    }));
    try {
      const res = await request(app()).get('/api/integrations/connections');
      expect(res.status).toBe(200);
      const list = res.body.connections as Array<Record<string, unknown>>;
      expect(list.find((c) => c.pluginId === LINKED)?.state).toBe('connected');
      const broken = list.find((c) => c.pluginId === 'broken-fixture')!;
      expect(broken.state).toBe('unreachable');
      expect(broken.canSignIn).toBe(false);
    } finally {
      registry.unregister('broken-fixture');
    }
  });
});

describe('GET /api/integrations/:id/connection', () => {
  it('returns the merged report, sync null when the loop never ticked', async () => {
    const res = await request(app()).get(`/api/integrations/${LINKED}/connection`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pluginId: LINKED, state: 'connected', canSignIn: true, sync: null });
  });

  it('reflects a sign-in-required status and the last good sync', async () => {
    recordSyncSuccess(LINKED);
    status = { state: 'sign-in-required', account: 'someone@example.com', detail: 'Microsoft refused to renew the credential (invalid_grant).' };
    const res = await request(app()).get(`/api/integrations/${LINKED}/connection`);
    expect(res.body.state).toBe('sign-in-required');
    expect(res.body.detail).toContain('invalid_grant');
    expect(res.body.sync.lastOkAt).toBeTruthy();
    expect(res.body.sync.consecutiveFailures).toBe(0);
  });

  it('404 for a plugin without a link, an unknown plugin, and local', async () => {
    expect((await request(app()).get(`/api/integrations/${PLAIN}/connection`)).status).toBe(404);
    expect((await request(app()).get('/api/integrations/nope/connection')).status).toBe(404);
    expect((await request(app()).get('/api/integrations/local/connection')).status).toBe(404);
  });

  it('502 when the plugin cannot answer', async () => {
    registry.unregister(LINKED);
    registry.register(LINKED, createMockPlugin({
      id: LINKED, name: 'Linked Fixture',
      connection: { status: async () => { throw new Error('boom'); } },
    }));
    const res = await request(app()).get(`/api/integrations/${LINKED}/connection`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Could not read the connection status.');
  });
});

describe('POST /api/integrations/:id/connection/sign-in', () => {
  it('202 with the device-code prompt', async () => {
    const res = await request(app()).post(`/api/integrations/${LINKED}/connection/sign-in`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pluginId: LINKED, userCode: 'WXYZ-9876', verificationUri: 'https://example.com/device' });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('405 when the plugin has a link but no sign-in; 404 without a link', async () => {
    registry.unregister(LINKED);
    registry.register(LINKED, createMockPlugin({
      id: LINKED, name: 'Linked Fixture',
      connection: { status: async () => status },
    }));
    const noSignIn = await request(app()).post(`/api/integrations/${LINKED}/connection/sign-in`);
    expect(noSignIn.status).toBe(405);
    expect(noSignIn.body.error).toContain('Linked Fixture');
    expect((await request(app()).post(`/api/integrations/${PLAIN}/connection/sign-in`)).status).toBe(404);
  });

  it('502 with the plugin\'s own message when the flow cannot start', async () => {
    signIn = async () => { throw new Error('Microsoft To-Do has no client_id yet.'); };
    const res = await request(app()).post(`/api/integrations/${LINKED}/connection/sign-in`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Microsoft To-Do has no client_id yet.');
  });
});
