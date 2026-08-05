/**
 * Custom focus tiers E2E — full REST flow through a real server.
 *
 * POST /api/focus/tiers (create) → GET (list) → pin a task → PUT
 * /api/focus/tasks/:id/tier with the ct_* id → GET /api/focus/tasks shows the
 * task under custom_tier_tasks → DELETE the tier → the task self-heals back to
 * satellite_tasks. Garbage tier ids on the tier route stay a 400.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string) { return `http://localhost:${port}${path}`; }

async function api(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(apiUrl(path), opts);
  return { status: r.status, data: await r.json() };
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('Custom tiers API', () => {
  let taskId: string;
  let tierId: string;

  it('GET /api/focus/tiers is empty initially', async () => {
    const r = await api('GET', '/api/focus/tiers');
    expect(r.status).toBe(200);
    expect(r.data.tiers).toEqual([]);
  });

  it('GET /api/focus/tasks includes an empty custom_tier_tasks map', async () => {
    const r = await api('GET', '/api/focus/tasks');
    expect(r.status).toBe(200);
    expect(r.data.custom_tier_tasks).toEqual({});
  });

  it('POST /api/focus/tiers creates a tier', async () => {
    const r = await api('POST', '/api/focus/tiers', { label: 'Icebox' });
    expect(r.status).toBe(200);
    expect(r.data.tier.id).toMatch(/^ct_[a-z0-9]{8}$/);
    expect(r.data.tier.label).toBe('Icebox');
    expect(r.data.tiers).toHaveLength(1);
    tierId = r.data.tier.id;
  });

  it('POST /api/focus/tiers validation errors return 400', async () => {
    expect((await api('POST', '/api/focus/tiers', { label: '' })).status).toBe(400);
    expect((await api('POST', '/api/focus/tiers', { label: 'icebox' })).status).toBe(400);
    expect((await api('POST', '/api/focus/tiers', { label: 'wait' })).status).toBe(400);
    // Backlog joined the built-ins (2026-08) — its label is banned like the rest.
    expect((await api('POST', '/api/focus/tiers', { label: 'Backlog' })).status).toBe(400);
    expect((await api('POST', '/api/focus/tiers', { label: 'x'.repeat(41) })).status).toBe(400);
  });

  it('GET /api/focus/tiers lists the created tier', async () => {
    const r = await api('GET', '/api/focus/tiers');
    expect(r.data.tiers).toEqual([{ id: tierId, label: 'Icebox' }]);
  });

  it('PUT /api/focus/tiers/:id renames; 404 on unknown id', async () => {
    const r = await api('PUT', `/api/focus/tiers/${tierId}`, { label: 'Cold Storage' });
    expect(r.status).toBe(200);
    expect(r.data.tier).toEqual({ id: tierId, label: 'Cold Storage' });

    expect((await api('PUT', '/api/focus/tiers/ct_nosuchid', { label: 'Nope' })).status).toBe(404);
    expect((await api('PUT', `/api/focus/tiers/${tierId}`, { label: '' })).status).toBe(400);
  });

  it('pin a task and move it into the custom tier', async () => {
    const create = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Custom tier task', priority: 'none', category: 'Test', project: 'Test' }),
    });
    expect(create.status).toBe(201);
    taskId = (await create.json()).task.id;

    const pin = await api('POST', `/api/focus/tasks/${taskId}`);
    expect(pin.status).toBe(200);

    const r = await api('PUT', `/api/focus/tasks/${taskId}/tier`, { tier: tierId });
    expect(r.status).toBe(200);
    expect(r.data.custom_tier_tasks[tierId]).toContain(taskId);
    expect(r.data.satellite_tasks).not.toContain(taskId);
  });

  it('GET /api/focus/tasks shows the task under custom_tier_tasks', async () => {
    const r = await api('GET', '/api/focus/tasks');
    expect(r.status).toBe(200);
    expect(r.data.custom_tier_tasks[tierId]).toEqual([taskId]);
    expect(r.data.satellite_tasks).not.toContain(taskId);
    expect(r.data.pinned_tasks).toContain(taskId);
  });

  it('PUT tier with a garbage id returns 400 listing valid tiers', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskId}/tier`, { tier: 'ct_bogus123' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('focus');
    expect(r.data.error).toContain(tierId);
  });

  it('DELETE /api/focus/tiers/:id moves the task back to satellite', async () => {
    const r = await api('DELETE', `/api/focus/tiers/${tierId}`);
    expect(r.status).toBe(200);
    expect(r.data.tiers).toEqual([]);
    expect(r.data.moved).toBe(1);

    const g = await api('GET', '/api/focus/tasks');
    expect(g.data.satellite_tasks).toContain(taskId);
    expect(g.data.custom_tier_tasks).toEqual({});
  });

  it('DELETE of an unknown tier returns 404', async () => {
    const r = await api('DELETE', '/api/focus/tiers/ct_nosuchid');
    expect(r.status).toBe(404);
  });

  it('the deleted tier id is no longer a valid tier value', async () => {
    const r = await api('PUT', `/api/focus/tasks/${taskId}/tier`, { tier: tierId });
    expect(r.status).toBe(400);
  });
});
