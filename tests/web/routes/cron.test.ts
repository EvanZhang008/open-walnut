/**
 * Integration tests for the cron REST API routes using supertest.
 * Follows the pattern from tests/web/routes/tasks.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { createCronRouter } from '../../../src/web/routes/cron.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { CronService } from '../../../src/core/cron/service.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import type { CronServiceDeps } from '../../../src/core/cron/types.js';

// ── Helpers ──

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function createTestDeps(overrides?: Partial<CronServiceDeps>): CronServiceDeps {
  return {
    log: createMockLog(),
    storePath: path.join(WALNUT_HOME, 'cron-jobs.json'),
    cronEnabled: false,
    broadcastCronNotification: vi.fn(),
    runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' }),
    onEvent: vi.fn(),
    ...overrides,
  };
}

function createApp(service: CronService) {
  const app = express();
  app.use(express.json());
  app.use('/api/cron', createCronRouter(service));
  app.use(errorHandler);
  return app;
}

const validJob = {
  name: 'Test Job',
  schedule: { kind: 'every', everyMs: 60000 },
  sessionTarget: 'main',
  wakeMode: 'now',
  payload: { kind: 'systemEvent', text: 'test event' },
};

let service: CronService;
const storePath = path.join(WALNUT_HOME, 'cron-jobs.json');

// ── Setup / Teardown ──

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  // Pre-create an empty store file to avoid sharing the in-memory EMPTY_STORE
  // fallback object across services (which would cause cross-test mutation).
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }), 'utf-8');
  service = new CronService(createTestDeps());
});

afterEach(async () => {
  service.stop();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('GET /api/cron', () => {
  it('returns empty jobs array initially', async () => {
    const app = createApp(service);
    const res = await request(app).get('/api/cron');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
  });

  it('returns jobs after creating some', async () => {
    await service.add({
      name: 'Job A',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'a' },
    });

    const app = createApp(service);
    const res = await request(app).get('/api/cron');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].name).toBe('Job A');
  });

  it('excludes disabled jobs unless includeDisabled=true', async () => {
    const job = await service.add({
      name: 'Disable Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'a' },
    });
    await service.toggle(job.id);

    const app = createApp(service);

    const res1 = await request(app).get('/api/cron');
    expect(res1.body.jobs).toHaveLength(0);

    const res2 = await request(app).get('/api/cron?includeDisabled=true');
    expect(res2.body.jobs).toHaveLength(1);
  });
});

describe('POST /api/cron', () => {
  it('creates a job and returns 201', async () => {
    const app = createApp(service);
    const res = await request(app).post('/api/cron').send(validJob);

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
    expect(res.body.job.name).toBe('Test Job');
    expect(res.body.job.id).toBeDefined();
    expect(res.body.job.enabled).toBe(true);
    expect(res.body.job.schedule.kind).toBe('every');
  });

  it('returns 400 for invalid body', async () => {
    const app = createApp(service);
    const res = await request(app).post('/api/cron').send('not-json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for null body', async () => {
    const app = createApp(service);
    const res = await request(app)
      .post('/api/cron')
      .set('Content-Type', 'application/json')
      .send('null');
    expect(res.status).toBe(400);
  });

  it('creates job with inferred defaults', async () => {
    const app = createApp(service);
    const res = await request(app).post('/api/cron').send({
      schedule: { everyMs: 30_000 },
      payload: { kind: 'systemEvent', text: 'inferred' },
    });

    expect(res.status).toBe(201);
    expect(res.body.job.enabled).toBe(true);
    expect(res.body.job.wakeMode).toBe('now');
    expect(res.body.job.sessionTarget).toBe('main');
    expect(res.body.job.schedule.kind).toBe('every');
  });
});

describe('GET /api/cron/:id', () => {
  it('returns a specific job', async () => {
    const job = await service.add({
      name: 'Find Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'find' },
    });

    const app = createApp(service);
    const res = await request(app).get(`/api/cron/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.name).toBe('Find Me');
  });

  it('returns 404 for non-existent id', async () => {
    const app = createApp(service);
    const res = await request(app).get('/api/cron/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

describe('PATCH /api/cron/:id', () => {
  it('updates job fields', async () => {
    const job = await service.add({
      name: 'Patch Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'patch' },
    });

    const app = createApp(service);
    const res = await request(app)
      .patch(`/api/cron/${job.id}`)
      .send({ name: 'Patched Name' });

    expect(res.status).toBe(200);
    expect(res.body.job.name).toBe('Patched Name');
    expect(res.body.job.id).toBe(job.id);
  });

  it('returns 400 for invalid patch body', async () => {
    const job = await service.add({
      name: 'Patch Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'patch' },
    });

    const app = createApp(service);
    const res = await request(app)
      .patch(`/api/cron/${job.id}`)
      .send('not-json');
    expect(res.status).toBe(400);
  });

  it('returns error for non-existent id', async () => {
    const app = createApp(service);
    const res = await request(app)
      .patch('/api/cron/nonexistent')
      .send({ name: 'Nope' });
    // The service.update throws, which the error handler catches
    expect(res.status).toBe(500);
  });
});

describe('POST /api/cron/:id/toggle', () => {
  it('toggles enabled state', async () => {
    const job = await service.add({
      name: 'Toggle Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'toggle' },
    });

    const app = createApp(service);

    const res1 = await request(app).post(`/api/cron/${job.id}/toggle`);
    expect(res1.status).toBe(200);
    expect(res1.body.job.enabled).toBe(false);

    const res2 = await request(app).post(`/api/cron/${job.id}/toggle`);
    expect(res2.status).toBe(200);
    expect(res2.body.job.enabled).toBe(true);
  });
});

describe('DELETE /api/cron/:id', () => {
  it('removes a job and returns 204', async () => {
    const job = await service.add({
      name: 'Delete Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'delete' },
    });

    const app = createApp(service);
    const res = await request(app).delete(`/api/cron/${job.id}`);
    expect(res.status).toBe(204);

    // Verify it's gone
    const listRes = await request(app).get('/api/cron?includeDisabled=true');
    expect(listRes.body.jobs).toHaveLength(0);
  });

  it('returns 204 even for non-existent id (idempotent)', async () => {
    const app = createApp(service);
    const res = await request(app).delete('/api/cron/nonexistent');
    expect(res.status).toBe(204);
  });
});

describe('GET /api/cron/status', () => {
  it('returns scheduler status', async () => {
    await service.add({
      name: 'Status Job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'status' },
    });

    const app = createApp(service);
    const res = await request(app).get('/api/cron/status');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false); // cronEnabled=false in test
    expect(res.body.jobs).toBe(1);
    expect(res.body.storePath).toContain('cron-jobs.json');
  });
});

describe('POST /api/cron/:id/run', () => {
  it('manually triggers a job', async () => {
    const broadcastFn = vi.fn();
    const runMainFn = vi.fn().mockResolvedValue(undefined);

    service.stop();
    // Pre-create the store file to avoid EMPTY_STORE mutation issue
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }), 'utf-8');
    service = new CronService(
      createTestDeps({
        broadcastCronNotification: broadcastFn,
        runMainAgentWithPrompt: runMainFn,
      }),
    );

    const job = await service.add({
      name: 'Run Me',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'manual run' },
    });

    const app = createApp(service);
    const res = await request(app).post(`/api/cron/${job.id}/run`);

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(expect.objectContaining({ ok: true, ran: true }));
    expect(broadcastFn).toHaveBeenCalled();
  });

  it('returns error for non-existent job', async () => {
    const app = createApp(service);
    const res = await request(app).post('/api/cron/nonexistent/run');
    expect(res.status).toBe(500);
  });
});

describe('Full CRUD lifecycle', () => {
  it('create → get → update → toggle → delete', async () => {
    const app = createApp(service);

    // Create
    const createRes = await request(app).post('/api/cron').send(validJob);
    expect(createRes.status).toBe(201);
    const jobId = createRes.body.job.id;

    // Get
    const getRes = await request(app).get(`/api/cron/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.job.name).toBe('Test Job');

    // Update
    const patchRes = await request(app)
      .patch(`/api/cron/${jobId}`)
      .send({ name: 'Updated Job' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.job.name).toBe('Updated Job');

    // Toggle (disable)
    const toggleRes = await request(app).post(`/api/cron/${jobId}/toggle`);
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.job.enabled).toBe(false);

    // Delete
    const deleteRes = await request(app).delete(`/api/cron/${jobId}`);
    expect(deleteRes.status).toBe(204);

    // Verify gone
    const finalRes = await request(app).get(`/api/cron/${jobId}`);
    expect(finalRes.status).toBe(404);
  });
});
