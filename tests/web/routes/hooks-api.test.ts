/**
 * E2E tests for the unified /api/hooks endpoint (+ the deprecated
 * /api/task-phase-hooks alias) against a real server.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';

let server: HttpServer;
let port: number;

const apiUrl = (p: string) => `http://localhost:${port}${p}`;

interface HookInfo {
  id: string;
  name: string;
  on: string[];
  domains: string[];
  runtime: 'walnut' | 'daemon';
  source: string;
  enabled: boolean;
  priority: number;
  conditions: string[];
  mutable: string;
  configPath?: string;
  note?: string;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  // Seed a declarative config hook + a defs entry that a PATCH must not clobber.
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), yaml.dump({
    hooks: {
      defs: [{
        id: 'config-notify-complete',
        name: 'Notify on task complete',
        on: ['onTaskCompleted'],
        action: { type: 'notify', message: '{{task.title}} finished' },
      }],
    },
  }));
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/hooks', () => {
  it('returns the merged inventory: builtins + config + inline + daemon policies', async () => {
    const res = await fetch(apiUrl('/api/hooks'));
    expect(res.status).toBe(200);
    const body = await res.json() as HookInfo[];

    const ids = body.map(h => h.id);
    // session builtins
    expect(ids).toContain('turn-complete-triage');
    expect(ids).toContain('session-auto-title');
    // task builtin (ported phase hook)
    expect(ids).toContain('human-verified-auto-push');
    // config def
    expect(ids).toContain('config-notify-complete');
    // inline interventions
    expect(ids).toContain('askuserquestion-p-mode-correction');
    expect(ids).toContain('auto-deny-stale-permissions');
    // daemon policies
    expect(ids).toContain('session-only-cron-policy');
    expect(ids).toContain('foreign-cron-fire-marker');
  });

  it('daemon policies carry runtime/note/configPath and cron policy tracks config', async () => {
    const body = await (await fetch(apiUrl('/api/hooks'))).json() as HookInfo[];
    const cron = body.find(h => h.id === 'session-only-cron-policy')!;

    expect(cron.runtime).toBe('daemon');
    expect(cron.source).toBe('daemon-policy');
    expect(cron.configPath).toBe('session.cron_policy');
    expect(cron.note).toMatch(/daemon restart/i);
    expect(cron.enabled).toBe(false); // default unrestricted
    expect(cron.mutable).toBe('config-path');

    const marker = body.find(h => h.id === 'foreign-cron-fire-marker')!;
    expect(marker.mutable).toBe('readonly');
    expect(marker.enabled).toBe(true);
  });

  it('walnut entries sort before daemon entries', async () => {
    const body = await (await fetch(apiUrl('/api/hooks'))).json() as HookInfo[];
    const firstDaemon = body.findIndex(h => h.runtime === 'daemon');
    const lastWalnut = body.map(h => h.runtime).lastIndexOf('walnut');
    expect(firstDaemon).toBeGreaterThan(lastWalnut);
  });
});

describe('PATCH /api/hooks/:id', () => {
  it('override round-trip persists, live-reloads, and preserves hooks.defs', async () => {
    const patch = await fetch(apiUrl('/api/hooks/human-verified-auto-push'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);

    // config.yaml: override written AND defs preserved
    const raw = yaml.load(await fs.readFile(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')) as {
      hooks?: { overrides?: Record<string, { enabled?: boolean }>; defs?: unknown[] };
    };
    expect(raw.hooks?.overrides?.['human-verified-auto-push']?.enabled).toBe(false);
    expect(raw.hooks?.defs).toHaveLength(1);

    // Inventory reflects it (disabled hooks resurface as stubs)
    const body = await (await fetch(apiUrl('/api/hooks'))).json() as HookInfo[];
    const hook = body.find(h => h.id === 'human-verified-auto-push')!;
    expect(hook.enabled).toBe(false);

    // Re-enable for the rest of the suite
    const reEnable = await fetch(apiUrl('/api/hooks/human-verified-auto-push'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(reEnable.status).toBe(200);
    const after = await (await fetch(apiUrl('/api/hooks'))).json() as HookInfo[];
    expect(after.find(h => h.id === 'human-verified-auto-push')!.enabled).toBe(true);
  });

  it('daemon policy PATCH flips the config key and flags requiresDaemonRestart', async () => {
    const res = await fetch(apiUrl('/api/hooks/session-only-cron-policy'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { requiresDaemonRestart?: boolean };
    expect(body.requiresDaemonRestart).toBe(true);

    const raw = yaml.load(await fs.readFile(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')) as {
      session?: { cron_policy?: string };
      hooks?: { defs?: unknown[] };
    };
    expect(raw.session?.cron_policy).toBe('session-only');
    expect(raw.hooks?.defs).toHaveLength(1); // untouched

    const inventory = await (await fetch(apiUrl('/api/hooks'))).json() as HookInfo[];
    expect(inventory.find(h => h.id === 'session-only-cron-policy')!.enabled).toBe(true);
  });

  it('readonly hook → 409', async () => {
    const res = await fetch(apiUrl('/api/hooks/auto-deny-stale-permissions'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(409);
  });

  it('unknown hook → 404, bad body → 400', async () => {
    const notFound = await fetch(apiUrl('/api/hooks/no-such-hook'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(notFound.status).toBe(404);

    const badBody = await fetch(apiUrl('/api/hooks/human-verified-auto-push'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(badBody.status).toBe(400);
  });
});

describe('GET /api/task-phase-hooks (deprecated alias)', () => {
  it('keeps the legacy byte shape for human-verified-auto-push', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{
      id: string; triggerPhase: string; actionType: string;
      actionDetail: string; conditions: string[]; priority: number;
    }>;

    const hook = body.find(h => h.id === 'human-verified-auto-push')!;
    expect(hook).toBeDefined();
    expect(hook.triggerPhase).toBe('HUMAN_VERIFIED');
    expect(hook.actionType).toBe('send_message');
    expect(hook.actionDetail).toMatch(/^Send message:/);
    expect(hook.conditions).toEqual(['Requires active session']);
    expect(hook.priority).toBe(100);
  });
});
