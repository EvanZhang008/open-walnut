/**
 * E2E tests for the Routines API layer: /api/routines (canonical) +
 * /api/cron (back-compat alias), executor discovery, executor-shaped CRUD,
 * and the claude-code executor run path (task created + SESSION_START).
 *
 * Real server via startServer({ port: 0, dev: true }); only the model/CLI
 * layer is out of scope (no live session spawn asserted — we assert the task
 * that quick-start core creates, which is the observable server-side effect).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path));
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
});

describe('routines API', () => {
  it('GET /api/routines/executors returns the three built-ins + options', async () => {
    const { status, json } = await get('/api/routines/executors');
    expect(status).toBe(200);
    const types = json.executors.map((e: any) => e.type).sort();
    expect(types).toEqual(['claude-code', 'main-agent', 'walnut-agent']);
    // configSchema drives the dynamic form
    const cc = json.executors.find((e: any) => e.type === 'claude-code');
    expect(cc.configSchema.some((f: any) => f.name === 'cwd' && f.required)).toBe(true);
    expect(cc.configSchema.some((f: any) => f.name === 'host' && f.optionsKey === 'hosts')).toBe(true);
    expect(json.options).toHaveProperty('hosts');
    expect(json.options).toHaveProperty('models');
  });

  it('creates a routine with executor shape via /api/routines', async () => {
    const { status, json } = await post('/api/routines', {
      name: 'E2E walnut routine',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      enabled: false,
      executor: { type: 'walnut-agent', config: { instructions: 'summarize things' } },
    });
    expect(status).toBe(201);
    expect(json.job.executor.type).toBe('walnut-agent');
    // Legacy fields derived for back-compat
    expect(json.job.sessionTarget).toBe('isolated');
    expect(json.job.payload.message).toBe('summarize things');
  });

  it('same routine is visible through the /api/cron alias', async () => {
    const { json: created } = await post('/api/cron', {
      name: 'E2E alias routine',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      enabled: false,
      executor: { type: 'main-agent', config: { instructions: 'ping' } },
    });
    const { json: viaRoutines } = await get('/api/routines?includeDisabled=true');
    const found = viaRoutines.jobs.find((j: any) => j.id === created.job.id);
    expect(found).toBeTruthy();
    expect(found.executor.type).toBe('main-agent');
  });

  it('legacy sessionTarget/payload create still works and gains an executor', async () => {
    const { status, json } = await post('/api/routines', {
      name: 'E2E legacy shape',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      enabled: false,
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'legacy ping' },
    });
    expect(status).toBe(201);
    expect(json.job.executor).toEqual({ type: 'main-agent', config: { instructions: 'legacy ping' } });
  });

  it('claude-code routine run-now creates a Routines task (quick-start core path)', async () => {
    const { status, json: created } = await post('/api/routines', {
      name: 'E2E CC routine',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      enabled: true,
      executor: {
        type: 'claude-code',
        config: { instructions: 'run the E2E check', cwd: '/tmp' },
      },
    });
    expect(status).toBe(201);

    const runRes = await post(`/api/routines/${created.job.id}/run`, {});
    expect(runRes.status).toBe(200);

    // The observable effect: a task in project "Routines" with our title
    const { json: tasks } = await get('/api/tasks');
    const list = Array.isArray(tasks) ? tasks : tasks.tasks;
    const routineTask = list.find((t: any) =>
      (t.title === 'Routine: E2E CC routine' || t.title?.includes('E2E CC routine')));
    expect(routineTask).toBeTruthy();
    expect(routineTask.project).toBe('Routines');

    // Job state recorded ok with a session-start summary
    const { json: jobRes } = await get(`/api/routines/${created.job.id}`);
    expect(jobRes.job.state.lastStatus).toBe('ok');
    expect(jobRes.job.state.lastError).toBeUndefined();
  });

  it('claude-code routine with unknown host fails the run with a clear error', async () => {
    const { json: created } = await post('/api/routines', {
      name: 'E2E CC bad host',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      enabled: true,
      executor: {
        type: 'claude-code',
        config: { instructions: 'x', cwd: '/tmp', host: 'no-such-host' },
      },
    });
    await post(`/api/routines/${created.job.id}/run`, {});
    const { json: jobRes } = await get(`/api/routines/${created.job.id}`);
    expect(jobRes.job.state.lastStatus).toBe('error');
    expect(jobRes.job.state.lastError).toContain('unknown host');
  });

  it('POST /api/routines/draft without text returns 400', async () => {
    const { status } = await post('/api/routines/draft', {});
    expect(status).toBe(400);
  });
});
