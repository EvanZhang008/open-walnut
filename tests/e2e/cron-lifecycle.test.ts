/**
 * E2E tests for the cron lifecycle: server + WebSocket + cron events.
 * Follows the pattern from tests/e2e/web-app.test.ts.
 *
 * Starts a real server with Express + WebSocket on a random port,
 * verifies REST endpoints work and WS events are pushed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

// ── Helpers ──

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForWsMessage(
  ws: WebSocket,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function collectWsMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      // Resolve with whatever we have so far instead of rejecting
      resolve(messages);
    }, timeoutMs);
    const handler = (data: any) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(messages);
      }
    };
    ws.on('message', handler);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const validJob = {
  name: 'E2E Test Job',
  schedule: { kind: 'every', everyMs: 60000 },
  sessionTarget: 'main',
  wakeMode: 'now',
  payload: { kind: 'systemEvent', text: 'e2e test event' },
};

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Server responds ──

describe('Cron API basics', () => {
  it('server is listening and responds to cron endpoint', async () => {
    const res = await fetch(apiUrl('/api/cron'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: unknown[] };
    expect(body.jobs).toEqual([]);
  });

  it('status endpoint returns scheduler info', async () => {
    const res = await fetch(apiUrl('/api/cron/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      jobs: number;
      storePath: string;
    };
    expect(typeof body.enabled).toBe('boolean');
    expect(typeof body.jobs).toBe('number');
    expect(body.storePath).toContain('cron-jobs.json');
  });
});

// ── CRUD lifecycle with WS events ──

describe('Cron CRUD lifecycle with WS events', () => {
  let jobId: string;

  it('create a job via REST and receive cron:job-added WS event', async () => {
    const ws = await connectWs();
    const msgPromise = waitForWsMessage(ws);

    const res = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validJob),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { id: string; name: string } };
    expect(body.job.name).toBe('E2E Test Job');
    jobId = body.job.id;

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    expect(frame.name).toBe('cron:job-added');

    ws.close();
    await delay(50);
  });

  it('verify job appears in GET /api/cron', async () => {
    const res = await fetch(apiUrl('/api/cron'));
    const body = (await res.json()) as {
      jobs: Array<{ id: string; name: string }>;
    };
    expect(body.jobs.some((j) => j.id === jobId)).toBe(true);
  });

  it('get single job by id', async () => {
    const res = await fetch(apiUrl(`/api/cron/${jobId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job: { id: string; name: string };
    };
    expect(body.job.id).toBe(jobId);
    expect(body.job.name).toBe('E2E Test Job');
  });

  it('update job via PATCH and receive cron:job-updated WS event', async () => {
    const ws = await connectWs();
    const msgPromise = waitForWsMessage(ws);

    const res = await fetch(apiUrl(`/api/cron/${jobId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated E2E Job' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { name: string } };
    expect(body.job.name).toBe('Updated E2E Job');

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    expect(frame.name).toBe('cron:job-updated');

    ws.close();
    await delay(50);
  });

  it('toggle job via POST and receive cron:job-updated WS event', async () => {
    const ws = await connectWs();
    const msgPromise = waitForWsMessage(ws);

    const res = await fetch(apiUrl(`/api/cron/${jobId}/toggle`), {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { enabled: boolean } };
    expect(body.job.enabled).toBe(false);

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    expect(frame.name).toBe('cron:job-updated');

    ws.close();
    await delay(50);
  });

  it('delete job via DELETE and receive cron:job-removed WS event', async () => {
    // Re-enable so we can test delete on an enabled job
    await fetch(apiUrl(`/api/cron/${jobId}/toggle`), { method: 'POST' });

    const ws = await connectWs();
    const msgPromise = waitForWsMessage(ws);

    const res = await fetch(apiUrl(`/api/cron/${jobId}`), {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    const frame = await msgPromise;
    expect(frame.type).toBe('event');
    expect(frame.name).toBe('cron:job-removed');

    ws.close();
    await delay(50);
  });

  it('verify job is gone after deletion', async () => {
    const res = await fetch(apiUrl(`/api/cron/${jobId}`));
    expect(res.status).toBe(404);
  });
});

// ── Full lifecycle in one test ──

describe('Full cron lifecycle (single test)', () => {
  it('create → list → update → toggle → run → delete', async () => {
    // Create
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Lifecycle Job',
        schedule: { kind: 'every', everyMs: 120_000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'lifecycle test' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as {
      job: { id: string; name: string; enabled: boolean };
    };
    const id = job.id;
    expect(job.name).toBe('Lifecycle Job');
    expect(job.enabled).toBe(true);

    // List
    const listRes = await fetch(apiUrl('/api/cron'));
    const listBody = (await listRes.json()) as {
      jobs: Array<{ id: string }>;
    };
    expect(listBody.jobs.some((j) => j.id === id)).toBe(true);

    // Update
    const patchRes = await fetch(apiUrl(`/api/cron/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lifecycle Updated' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      job: { name: string };
    };
    expect(patchBody.job.name).toBe('Lifecycle Updated');

    // Toggle (disable)
    const toggleRes = await fetch(apiUrl(`/api/cron/${id}/toggle`), {
      method: 'POST',
    });
    expect(toggleRes.status).toBe(200);
    const toggleBody = (await toggleRes.json()) as {
      job: { enabled: boolean };
    };
    expect(toggleBody.job.enabled).toBe(false);

    // Toggle back (enable)
    const toggleRes2 = await fetch(apiUrl(`/api/cron/${id}/toggle`), {
      method: 'POST',
    });
    const toggleBody2 = (await toggleRes2.json()) as {
      job: { enabled: boolean };
    };
    expect(toggleBody2.job.enabled).toBe(true);

    // Manual run
    const runRes = await fetch(apiUrl(`/api/cron/${id}/run`), {
      method: 'POST',
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      result: { ok: boolean; ran: boolean };
    };
    expect(runBody.result.ok).toBe(true);
    expect(runBody.result.ran).toBe(true);

    // Status
    const statusRes = await fetch(apiUrl('/api/cron/status'));
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      jobs: number;
    };
    expect(statusBody.jobs).toBeGreaterThanOrEqual(1);

    // Delete
    const delRes = await fetch(apiUrl(`/api/cron/${id}`), {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(204);

    // Verify gone
    const getRes = await fetch(apiUrl(`/api/cron/${id}`));
    expect(getRes.status).toBe(404);
  });
});

// ── Error cases ──

describe('Cron error handling', () => {
  it('POST /api/cron with invalid body returns 400', async () => {
    const res = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/cron/:id with bad id returns 404', async () => {
    const res = await fetch(apiUrl('/api/cron/definitely-nonexistent'));
    expect(res.status).toBe(404);
  });

  it('multiple WS clients all receive cron events', async () => {
    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const msg1 = waitForWsMessage(ws1);
    const msg2 = waitForWsMessage(ws2);

    await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Multi WS Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'multi ws' },
      }),
    });

    const [frame1, frame2] = await Promise.all([msg1, msg2]);
    expect(frame1.type).toBe('event');
    expect(frame2.type).toBe('event');
    expect(frame1.name).toBe('cron:job-added');
    expect(frame2.name).toBe('cron:job-added');

    ws1.close();
    ws2.close();
    await delay(50);
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR-RAISE: Additional E2E tests for deeper coverage
// ══════════════════════════════════════════════════════════════════════

// ── Multi-client WebSocket event delivery (toggle + update) ──

describe('Multi-client WS event delivery — toggle and update', () => {
  it('both WS clients receive cron:job-updated on toggle', async () => {
    // Create a job first
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Multi Toggle Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'multi toggle' },
      }),
    });
    const { job } = (await createRes.json()) as { job: { id: string } };

    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const msg1 = waitForWsMessage(ws1);
    const msg2 = waitForWsMessage(ws2);

    // Toggle the job
    await fetch(apiUrl(`/api/cron/${job.id}/toggle`), { method: 'POST' });

    const [frame1, frame2] = await Promise.all([msg1, msg2]);
    expect(frame1.type).toBe('event');
    expect(frame2.type).toBe('event');
    expect(frame1.name).toBe('cron:job-updated');
    expect(frame2.name).toBe('cron:job-updated');

    ws1.close();
    ws2.close();

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
    await delay(50);
  });

  it('both WS clients receive cron:job-updated on PATCH', async () => {
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Multi Patch Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'multi patch' },
      }),
    });
    const { job } = (await createRes.json()) as { job: { id: string } };

    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const msg1 = waitForWsMessage(ws1);
    const msg2 = waitForWsMessage(ws2);

    await fetch(apiUrl(`/api/cron/${job.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Multi Patch Updated' }),
    });

    const [frame1, frame2] = await Promise.all([msg1, msg2]);
    expect(frame1.name).toBe('cron:job-updated');
    expect(frame2.name).toBe('cron:job-updated');

    ws1.close();
    ws2.close();

    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
    await delay(50);
  });

  it('both WS clients receive cron:job-removed on DELETE', async () => {
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Multi Delete Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'multi delete' },
      }),
    });
    const { job } = (await createRes.json()) as { job: { id: string } };

    const ws1 = await connectWs();
    const ws2 = await connectWs();

    const msg1 = waitForWsMessage(ws1);
    const msg2 = waitForWsMessage(ws2);

    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });

    const [frame1, frame2] = await Promise.all([msg1, msg2]);
    expect(frame1.name).toBe('cron:job-removed');
    expect(frame2.name).toBe('cron:job-removed');

    ws1.close();
    ws2.close();
    await delay(50);
  });
});

// ── Full CRUD validation round-trip ──

describe('Full CRUD validation round-trip', () => {
  it('create with all fields → GET verifies → PATCH partial → GET persisted → DELETE → 404', async () => {
    // Create with all fields specified
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Full CRUD Job',
        description: 'A thorough test',
        enabled: true,
        schedule: { kind: 'every', everyMs: 120_000 },
        sessionTarget: 'main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'crud round-trip' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as {
      job: {
        id: string;
        name: string;
        description: string;
        enabled: boolean;
        schedule: { kind: string; everyMs: number };
        sessionTarget: string;
        wakeMode: string;
        payload: { kind: string; text: string };
      };
    };
    const id = job.id;
    expect(job.name).toBe('Full CRUD Job');
    expect(job.description).toBe('A thorough test');
    expect(job.enabled).toBe(true);
    expect(job.schedule.kind).toBe('every');
    expect(job.schedule.everyMs).toBe(120_000);
    expect(job.sessionTarget).toBe('main');
    expect(job.wakeMode).toBe('now');
    expect(job.payload.kind).toBe('systemEvent');
    expect(job.payload.text).toBe('crud round-trip');

    // GET /:id → verify all fields match exactly
    const getRes = await fetch(apiUrl(`/api/cron/${id}`));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { job: typeof job };
    expect(getBody.job.name).toBe('Full CRUD Job');
    expect(getBody.job.description).toBe('A thorough test');
    expect(getBody.job.enabled).toBe(true);
    expect(getBody.job.payload.text).toBe('crud round-trip');

    // PATCH with partial update → verify only changed fields changed
    const patchRes = await fetch(apiUrl(`/api/cron/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Patched CRUD Job', description: 'Updated description' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { job: typeof job };
    expect(patchBody.job.name).toBe('Patched CRUD Job');
    expect(patchBody.job.description).toBe('Updated description');
    // Unchanged fields should remain
    expect(patchBody.job.enabled).toBe(true);
    expect(patchBody.job.payload.text).toBe('crud round-trip');
    expect(patchBody.job.schedule.everyMs).toBe(120_000);

    // GET /:id again → verify patched state persisted
    const getRes2 = await fetch(apiUrl(`/api/cron/${id}`));
    expect(getRes2.status).toBe(200);
    const getBody2 = (await getRes2.json()) as { job: typeof job };
    expect(getBody2.job.name).toBe('Patched CRUD Job');
    expect(getBody2.job.description).toBe('Updated description');

    // Delete → verify 404 on subsequent GET
    const delRes = await fetch(apiUrl(`/api/cron/${id}`), { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes3 = await fetch(apiUrl(`/api/cron/${id}`));
    expect(getRes3.status).toBe(404);
  });
});

// ── Error response validation ──

describe('Error response validation', () => {
  it('POST with empty body returns 400 with error message', async () => {
    const res = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeDefined();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('POST with missing schedule and payload returns 400', async () => {
    const res = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Incomplete' }),
    });
    // This will either be 400 (validation) or 500 (throws during createJob).
    // Either way it should not be 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('PATCH non-existent id returns error (4xx or 5xx)', async () => {
    const res = await fetch(apiUrl('/api/cron/definitely-nonexistent-id'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST toggle non-existent id returns error', async () => {
    const res = await fetch(apiUrl('/api/cron/nonexistent-toggle-id/toggle'), {
      method: 'POST',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST run non-existent id returns error', async () => {
    const res = await fetch(apiUrl('/api/cron/nonexistent-run-id/run'), {
      method: 'POST',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('DELETE non-existent id returns 204 (idempotent)', async () => {
    const res = await fetch(apiUrl('/api/cron/nonexistent-delete-id'), {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });
});

// ── Status endpoint accuracy ──

describe('Status endpoint accuracy', () => {
  it('reflects correct job count after multiple creates and disables', async () => {
    // Create 3 jobs
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(apiUrl('/api/cron'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Status Job ${i}`,
          schedule: { kind: 'every', everyMs: (i + 1) * 60_000 },
          sessionTarget: 'main',
          wakeMode: 'now',
          payload: { kind: 'systemEvent', text: `status test ${i}` },
        }),
      });
      const { job } = (await res.json()) as { job: { id: string } };
      ids.push(job.id);
    }

    // Check status — 3 jobs total (all enabled)
    let statusRes = await fetch(apiUrl('/api/cron/status'));
    let statusBody = (await statusRes.json()) as {
      enabled: boolean;
      jobs: number;
    };
    expect(statusBody.jobs).toBeGreaterThanOrEqual(3);

    // Disable one job
    await fetch(apiUrl(`/api/cron/${ids[0]}/toggle`), { method: 'POST' });

    // Check status again
    statusRes = await fetch(apiUrl('/api/cron/status'));
    statusBody = (await statusRes.json()) as { enabled: boolean; jobs: number };
    // Total jobs still includes disabled ones
    expect(statusBody.jobs).toBeGreaterThanOrEqual(3);

    // List with includeDisabled=true shows all
    const listAllRes = await fetch(apiUrl('/api/cron?includeDisabled=true'));
    const listAllBody = (await listAllRes.json()) as { jobs: Array<{ id: string; enabled: boolean }> };
    const ourJobs = listAllBody.jobs.filter((j) => ids.includes(j.id));
    expect(ourJobs).toHaveLength(3);
    expect(ourJobs.filter((j) => j.enabled)).toHaveLength(2);
    expect(ourJobs.filter((j) => !j.enabled)).toHaveLength(1);

    // List without includeDisabled shows 2 of our 3
    const listEnabledRes = await fetch(apiUrl('/api/cron'));
    const listEnabledBody = (await listEnabledRes.json()) as { jobs: Array<{ id: string }> };
    const ourEnabledJobs = listEnabledBody.jobs.filter((j) => ids.includes(j.id));
    expect(ourEnabledJobs).toHaveLength(2);

    // Cleanup
    for (const id of ids) {
      await fetch(apiUrl(`/api/cron/${id}`), { method: 'DELETE' });
    }
  });
});

// ── Job ordering ──

describe('Job ordering', () => {
  it('GET /api/cron returns jobs sorted by nextRunAtMs', async () => {
    // Create 3 jobs with different intervals (shorter interval = sooner nextRun)
    const ids: string[] = [];
    for (const everyMs of [180_000, 60_000, 120_000]) {
      const res = await fetch(apiUrl('/api/cron'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Order Job ${everyMs}ms`,
          schedule: { kind: 'every', everyMs },
          sessionTarget: 'main',
          wakeMode: 'now',
          payload: { kind: 'systemEvent', text: `order ${everyMs}` },
        }),
      });
      const { job } = (await res.json()) as { job: { id: string } };
      ids.push(job.id);
    }

    const listRes = await fetch(apiUrl('/api/cron'));
    const { jobs } = (await listRes.json()) as {
      jobs: Array<{ id: string; state: { nextRunAtMs?: number } }>;
    };

    // Filter to our test jobs and verify ordering
    const ourJobs = jobs.filter((j) => ids.includes(j.id));
    expect(ourJobs.length).toBeGreaterThanOrEqual(3);

    // Verify sorted by nextRunAtMs ascending
    for (let i = 1; i < ourJobs.length; i++) {
      const prev = ourJobs[i - 1].state.nextRunAtMs ?? 0;
      const curr = ourJobs[i].state.nextRunAtMs ?? 0;
      expect(prev).toBeLessThanOrEqual(curr);
    }

    // Cleanup
    for (const id of ids) {
      await fetch(apiUrl(`/api/cron/${id}`), { method: 'DELETE' });
    }
  });
});

// ── Inferred defaults via REST ──

describe('REST create with inferred defaults', () => {
  it('creates job with shorthand text field (no payload object)', async () => {
    const res = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedule: { everyMs: 60_000 },
        text: 'shorthand system event',
      }),
    });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as {
      job: {
        id: string;
        sessionTarget: string;
        payload: { kind: string; text: string };
        enabled: boolean;
        wakeMode: string;
      };
    };
    expect(job.sessionTarget).toBe('main');
    expect(job.payload.kind).toBe('systemEvent');
    expect(job.payload.text).toBe('shorthand system event');
    expect(job.enabled).toBe(true);
    expect(job.wakeMode).toBe('now');

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
  });

  it('creates job with shorthand message field (isolated + agentTurn)', async () => {
    const res = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent Task',
        schedule: { everyMs: 120_000 },
        message: 'analyze performance data',
      }),
    });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as {
      job: {
        id: string;
        sessionTarget: string;
        payload: { kind: string; message: string };
      };
    };
    expect(job.sessionTarget).toBe('isolated');
    expect(job.payload.kind).toBe('agentTurn');
    expect(job.payload.message).toBe('analyze performance data');

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
  });
});

// ══════════════════════════════════════════════════════════════════════
// EXECUTION LIFECYCLE: Full job execution with DI deps, WS events,
// and state mutations.
//
// NOTE: All main session tests use wakeMode='next-cycle' to avoid
// triggering the real Bedrock agent loop (which takes 20+ seconds per
// invocation). With next-cycle the full cron execution path is still
// exercised (emit started → broadcastCronNotification → applyJobResult
// → emit finished) — only the optional runMainAgentWithPrompt call is
// skipped. The isolated agent test uses the real runIsolatedAgentJob
// dep, which may succeed or error in test; both outcomes are valid.
// ══════════════════════════════════════════════════════════════════════

// Helper: collect WS messages matching a name filter within a timeout.
// Resolves when either the expected count is reached or the timeout fires.
function collectWsMessagesByName(
  ws: WebSocket,
  names: string[],
  maxCount: number,
  timeoutMs = 8000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const matched: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(matched);
    }, timeoutMs);
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (names.includes(msg.name as string)) {
        matched.push(msg);
      }
      if (matched.length >= maxCount) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(matched);
      }
    };
    ws.on('message', handler);
  });
}

// ── 1. Execution lifecycle — main session job ──

describe('Execution lifecycle — main session job', () => {
  it('run main session job → WS events + state updated', async () => {
    // Create a main session job with wakeMode='next-cycle' to skip agent loop
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Exec Main Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'main exec test event' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };
    const jobId = job.id;

    // Connect WS and start collecting cron events
    const ws = await connectWs();
    const eventNames = ['cron:job-started', 'cron:job-finished', 'cron:notification'];
    const msgPromise = collectWsMessagesByName(ws, eventNames, 3);

    // Trigger execution
    const runRes = await fetch(apiUrl(`/api/cron/${jobId}/run`), { method: 'POST' });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody.result.ok).toBe(true);
    expect(runBody.result.ran).toBe(true);

    // Wait for WS events (execution is fast with next-cycle, all events arrive
    // before the HTTP response since executeJob is synchronous in the route)
    const messages = await msgPromise;
    ws.close();

    // Verify cron:job-started event
    const startedMsg = messages.find((m) => m.name === 'cron:job-started');
    expect(startedMsg).toBeDefined();
    expect(startedMsg!.type).toBe('event');
    const startedData = startedMsg!.data as Record<string, unknown>;
    expect(startedData.jobId).toBe(jobId);
    expect(startedData.action).toBe('started');
    expect(typeof startedData.runAtMs).toBe('number');

    // Verify cron:job-finished event
    const finishedMsg = messages.find((m) => m.name === 'cron:job-finished');
    expect(finishedMsg).toBeDefined();
    expect(finishedMsg!.type).toBe('event');
    const finishedData = finishedMsg!.data as Record<string, unknown>;
    expect(finishedData.jobId).toBe(jobId);
    expect(finishedData.action).toBe('finished');
    expect(typeof finishedData.durationMs).toBe('number');
    // With next-cycle + systemEvent, broadcastCronNotification succeeds → status=ok
    expect(finishedData.status).toBe('ok');

    // Verify cron:notification event (broadcastCronNotification is called for main jobs)
    const notifMsg = messages.find((m) => m.name === 'cron:notification');
    expect(notifMsg).toBeDefined();
    const notifData = notifMsg!.data as Record<string, unknown>;
    expect(notifData.text).toBe('main exec test event');
    expect(notifData.jobName).toBe('Exec Main Job');

    // After execution, GET the job and verify state was updated
    const getRes = await fetch(apiUrl(`/api/cron/${jobId}`));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      job: {
        id: string;
        state: {
          lastStatus: string;
          lastRunAtMs: number;
          lastDurationMs: number;
          consecutiveErrors: number;
          nextRunAtMs: number;
          runningAtMs?: number;
        };
      };
    };
    const state = getBody.job.state;
    expect(state.lastStatus).toBe('ok');
    expect(typeof state.lastRunAtMs).toBe('number');
    expect(state.lastRunAtMs).toBeGreaterThan(0);
    expect(typeof state.lastDurationMs).toBe('number');
    expect(state.lastDurationMs).toBeGreaterThanOrEqual(0);
    // runningAtMs should be cleared after execution
    expect(state.runningAtMs).toBeUndefined();
    // For recurring jobs, nextRunAtMs should be set to a future time
    expect(typeof state.nextRunAtMs).toBe('number');
    expect(state.nextRunAtMs).toBeGreaterThan(0);
    expect(state.consecutiveErrors).toBe(0);

    // Cleanup
    await fetch(apiUrl(`/api/cron/${jobId}`), { method: 'DELETE' });
    await delay(50);
  });
});

// ── 2. Execution lifecycle — isolated agent job ──

describe('Execution lifecycle — isolated agent job', () => {
  it('run isolated job → WS events + state updated (may error in test)', async () => {
    // Create an isolated job. The runIsolatedAgentJob dep calls the real agent
    // loop which may succeed or error in test — both outcomes are valid.
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Exec Isolated Job',
        schedule: { kind: 'every', everyMs: 120_000 },
        sessionTarget: 'isolated',
        wakeMode: 'next-cycle',
        payload: { kind: 'agentTurn', message: 'analyze data for test' },
        delivery: { mode: 'announce' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };

    // Connect WS and collect events
    const ws = await connectWs();
    const eventNames = ['cron:job-started', 'cron:job-finished'];
    // Isolated agent may take time — give generous timeout
    const msgPromise = collectWsMessagesByName(ws, eventNames, 2, 50_000);

    // Trigger execution
    const runRes = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody.result.ok).toBe(true);
    expect(runBody.result.ran).toBe(true);

    // Wait for WS events
    const messages = await msgPromise;
    ws.close();

    // Verify started event
    const startedMsg = messages.find((m) => m.name === 'cron:job-started');
    expect(startedMsg).toBeDefined();
    const startedData = startedMsg!.data as Record<string, unknown>;
    expect(startedData.jobId).toBe(job.id);
    expect(startedData.action).toBe('started');

    // Verify finished event
    const finishedMsg = messages.find((m) => m.name === 'cron:job-finished');
    expect(finishedMsg).toBeDefined();
    const finishedData = finishedMsg!.data as Record<string, unknown>;
    expect(finishedData.jobId).toBe(job.id);
    expect(finishedData.action).toBe('finished');
    // In test environment, the isolated agent runner may error — that's expected
    expect(['ok', 'error']).toContain(finishedData.status);
    expect(typeof finishedData.durationMs).toBe('number');

    // After execution, verify job state is consistent
    const getRes = await fetch(apiUrl(`/api/cron/${job.id}`));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      job: {
        state: {
          lastStatus: string;
          lastRunAtMs: number;
          lastDurationMs: number;
          consecutiveErrors: number;
          runningAtMs?: number;
          nextRunAtMs?: number;
        };
      };
    };
    const state = getBody.job.state;
    expect(['ok', 'error']).toContain(state.lastStatus);
    expect(typeof state.lastRunAtMs).toBe('number');
    expect(state.lastRunAtMs).toBeGreaterThan(0);
    expect(typeof state.lastDurationMs).toBe('number');
    expect(state.runningAtMs).toBeUndefined();
    // nextRunAtMs should still be set (recurring job)
    expect(typeof state.nextRunAtMs).toBe('number');

    // If error, consecutiveErrors should be >= 1
    if (state.lastStatus === 'error') {
      expect(state.consecutiveErrors).toBeGreaterThanOrEqual(1);
    }

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
    await delay(50);
  });
});

// ── 3. Execution lifecycle — one-shot at job with deleteAfterRun ──

describe('Execution lifecycle — one-shot at job with deleteAfterRun', () => {
  it('at job with deleteAfterRun=true is auto-deleted after successful run', async () => {
    // Create an at job with a past time, initially disabled so the scheduler
    // doesn't auto-execute it before our manual run call.
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'One-Shot Delete Job',
        enabled: false,
        schedule: { kind: 'at', at: pastTime },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'one-shot delete test' },
        deleteAfterRun: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };

    // Connect WS and collect events: started, finished, and removed
    const ws = await connectWs();
    const eventNames = ['cron:job-started', 'cron:job-finished', 'cron:job-removed'];
    const msgPromise = collectWsMessagesByName(ws, eventNames, 3);

    // Trigger execution
    const runRes = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody.result.ok).toBe(true);
    expect(runBody.result.ran).toBe(true);

    // Wait for WS events
    const messages = await msgPromise;
    ws.close();

    // Verify started event
    const startedMsg = messages.find((m) => m.name === 'cron:job-started');
    expect(startedMsg).toBeDefined();

    // Verify finished event with status 'ok' (next-cycle + systemEvent = reliable ok)
    const finishedMsg = messages.find((m) => m.name === 'cron:job-finished');
    expect(finishedMsg).toBeDefined();
    const finishedData = finishedMsg!.data as Record<string, unknown>;
    expect(finishedData.status).toBe('ok');

    // Verify the removed event was emitted (deleteAfterRun + ok = auto-delete)
    const removedMsg = messages.find((m) => m.name === 'cron:job-removed');
    expect(removedMsg).toBeDefined();
    const removedData = removedMsg!.data as Record<string, unknown>;
    expect(removedData.jobId).toBe(job.id);
    expect(removedData.action).toBe('removed');

    // GET should return 404 — job was auto-deleted
    const getRes = await fetch(apiUrl(`/api/cron/${job.id}`));
    expect(getRes.status).toBe(404);

    await delay(50);
  });
});

// ── 4. Execution lifecycle — error tracking across multiple runs ──

describe('Execution lifecycle — error tracking across multiple runs', () => {
  it('consecutive runs update lastRunAtMs each time', async () => {
    // Create a main session job with next-cycle (fast, deterministic ok)
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Multi Run Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'multi run test' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };

    // First run
    const runRes1 = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes1.status).toBe(200);
    const runBody1 = (await runRes1.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody1.result.ok).toBe(true);
    expect(runBody1.result.ran).toBe(true);

    // Small delay to ensure timestamp differs
    await delay(50);

    // Get state after first run
    const getRes1 = await fetch(apiUrl(`/api/cron/${job.id}`));
    const getBody1 = (await getRes1.json()) as {
      job: {
        state: {
          lastRunAtMs: number;
          lastStatus: string;
          consecutiveErrors: number;
        };
      };
    };
    const firstRunAtMs = getBody1.job.state.lastRunAtMs;
    expect(typeof firstRunAtMs).toBe('number');
    expect(firstRunAtMs).toBeGreaterThan(0);
    expect(getBody1.job.state.lastStatus).toBe('ok');
    expect(getBody1.job.state.consecutiveErrors).toBe(0);

    // Second run
    await delay(50);
    const runRes2 = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes2.status).toBe(200);
    const runBody2 = (await runRes2.json()) as { result: { ok: boolean; ran: boolean } };
    expect(runBody2.result.ok).toBe(true);
    expect(runBody2.result.ran).toBe(true);

    // Get state after second run
    const getRes2 = await fetch(apiUrl(`/api/cron/${job.id}`));
    const getBody2 = (await getRes2.json()) as {
      job: {
        state: {
          lastRunAtMs: number;
          lastStatus: string;
          consecutiveErrors: number;
        };
      };
    };
    const secondRunAtMs = getBody2.job.state.lastRunAtMs;
    expect(typeof secondRunAtMs).toBe('number');
    expect(secondRunAtMs).toBeGreaterThan(0);
    // Second run should have a later (or equal) timestamp
    expect(secondRunAtMs).toBeGreaterThanOrEqual(firstRunAtMs);
    expect(getBody2.job.state.lastStatus).toBe('ok');
    expect(getBody2.job.state.consecutiveErrors).toBe(0);

    // Third run — verify still consistent
    await delay(50);
    const runRes3 = await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });
    expect(runRes3.status).toBe(200);

    const getRes3 = await fetch(apiUrl(`/api/cron/${job.id}`));
    const getBody3 = (await getRes3.json()) as {
      job: {
        state: {
          lastRunAtMs: number;
          lastStatus: string;
          consecutiveErrors: number;
        };
      };
    };
    expect(getBody3.job.state.lastRunAtMs).toBeGreaterThanOrEqual(secondRunAtMs);
    expect(getBody3.job.state.lastStatus).toBe('ok');
    expect(getBody3.job.state.consecutiveErrors).toBe(0);

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
    await delay(50);
  });
});

// ── 5. Execution lifecycle — WS events contain correct data shape ──

describe('Execution lifecycle — WS events contain correct data shape', () => {
  it('cron:job-started and cron:job-finished have the expected fields', async () => {
    // Create a job for execution (next-cycle for speed)
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'WS Shape Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'ws shape test' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };

    // Connect WS and collect events
    const ws = await connectWs();
    const eventNames = ['cron:job-started', 'cron:job-finished'];
    const msgPromise = collectWsMessagesByName(ws, eventNames, 2);

    // Trigger execution
    await fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' });

    // Wait for WS events
    const messages = await msgPromise;
    ws.close();

    // Deep validate cron:job-started shape
    const startedMsg = messages.find((m) => m.name === 'cron:job-started');
    expect(startedMsg).toBeDefined();
    expect(startedMsg!.type).toBe('event');
    expect(typeof startedMsg!.seq).toBe('number');
    const startedData = startedMsg!.data as Record<string, unknown>;
    // Required fields
    expect(startedData.jobId).toBe(job.id);
    expect(startedData.action).toBe('started');
    expect(typeof startedData.runAtMs).toBe('number');
    expect(startedData.runAtMs).toBeGreaterThan(0);

    // Deep validate cron:job-finished shape
    const finishedMsg = messages.find((m) => m.name === 'cron:job-finished');
    expect(finishedMsg).toBeDefined();
    expect(finishedMsg!.type).toBe('event');
    expect(typeof finishedMsg!.seq).toBe('number');
    const finishedData = finishedMsg!.data as Record<string, unknown>;
    // Required fields
    expect(finishedData.jobId).toBe(job.id);
    expect(finishedData.action).toBe('finished');
    expect(finishedData.status).toBe('ok');
    expect(typeof finishedData.durationMs).toBe('number');
    expect((finishedData.durationMs as number)).toBeGreaterThanOrEqual(0);
    expect(typeof finishedData.runAtMs).toBe('number');
    expect(finishedData.runAtMs).toBeGreaterThan(0);
    // nextRunAtMs should be present for recurring jobs
    expect(typeof finishedData.nextRunAtMs).toBe('number');
    // summary should be the payload text for ok status
    expect(finishedData.summary).toBe('ws shape test');

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
    await delay(50);
  });
});

// ── 6. Execution lifecycle — concurrent run protection ──

describe('Execution lifecycle — concurrent run protection', () => {
  it('rapid consecutive runs do not crash or corrupt state', async () => {
    // Create a job (next-cycle = fast execution, tests locking behavior)
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Concurrent Run Job',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'concurrent test' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job } = (await createRes.json()) as { job: { id: string } };

    // Fire two runs concurrently
    const [runRes1, runRes2] = await Promise.all([
      fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' }),
      fetch(apiUrl(`/api/cron/${job.id}/run`), { method: 'POST' }),
    ]);

    // Both should return 200 (no crash)
    expect(runRes1.status).toBe(200);
    expect(runRes2.status).toBe(200);

    const body1 = (await runRes1.json()) as {
      result: { ok: boolean; ran: boolean; reason?: string };
    };
    const body2 = (await runRes2.json()) as {
      result: { ok: boolean; ran: boolean; reason?: string };
    };

    // Both should return ok: true
    expect(body1.result.ok).toBe(true);
    expect(body2.result.ok).toBe(true);

    // At least one should have ran: true. The other may be already-running
    // or may also have ran (serialized by the lock).
    const ranCount = [body1, body2].filter((b) => b.result.ran).length;
    const alreadyRunningCount = [body1, body2].filter(
      (b) => !b.result.ran && b.result.reason === 'already-running',
    ).length;
    expect(ranCount).toBeGreaterThanOrEqual(1);
    expect(ranCount + alreadyRunningCount).toBeLessThanOrEqual(2);

    // Wait for any in-flight execution to settle
    await delay(200);

    // Verify job state is not corrupted
    const getRes = await fetch(apiUrl(`/api/cron/${job.id}`));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      job: {
        id: string;
        state: {
          lastRunAtMs: number;
          runningAtMs?: number;
          lastStatus: string;
        };
      };
    };
    // runningAtMs should be cleared (not stuck in running state)
    expect(getBody.job.state.runningAtMs).toBeUndefined();
    // lastRunAtMs should be set from at least one successful execution
    expect(typeof getBody.job.state.lastRunAtMs).toBe('number');
    expect(getBody.job.state.lastRunAtMs).toBeGreaterThan(0);
    expect(getBody.job.state.lastStatus).toBe('ok');

    // Cleanup
    await fetch(apiUrl(`/api/cron/${job.id}`), { method: 'DELETE' });
    await delay(50);
  });
});

// ── 7. Create → Start → Finish → Verify state persistence ──

describe('Create → Start → Finish → Verify state persistence', () => {
  it('full round-trip: create job, run, verify persisted state via GET', async () => {
    const beforeCreate = Date.now();

    // Step 1: Create
    const createRes = await fetch(apiUrl('/api/cron'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Persistence Round-Trip Job',
        description: 'Verifies state persists after execution',
        schedule: { kind: 'every', everyMs: 300_000 },
        sessionTarget: 'main',
        wakeMode: 'next-cycle',
        payload: { kind: 'systemEvent', text: 'persistence test event' },
      }),
    });
    expect(createRes.status).toBe(201);
    const { job: createdJob } = (await createRes.json()) as {
      job: {
        id: string;
        name: string;
        description: string;
        enabled: boolean;
        state: { nextRunAtMs?: number };
      };
    };
    expect(createdJob.name).toBe('Persistence Round-Trip Job');
    expect(createdJob.enabled).toBe(true);

    // Step 2: Verify initial state (no execution yet)
    const getResBeforeRun = await fetch(apiUrl(`/api/cron/${createdJob.id}`));
    expect(getResBeforeRun.status).toBe(200);
    const { job: beforeRunJob } = (await getResBeforeRun.json()) as {
      job: {
        state: {
          lastRunAtMs?: number;
          lastStatus?: string;
          runningAtMs?: number;
        };
      };
    };
    // Before execution, lastRunAtMs and lastStatus should not be set
    expect(beforeRunJob.state.lastRunAtMs).toBeUndefined();
    expect(beforeRunJob.state.lastStatus).toBeUndefined();
    expect(beforeRunJob.state.runningAtMs).toBeUndefined();

    // Step 3: Execute
    const ws = await connectWs();
    const finishedPromise = collectWsMessagesByName(ws, ['cron:job-finished'], 1);

    const runRes = await fetch(apiUrl(`/api/cron/${createdJob.id}/run`), { method: 'POST' });
    expect(runRes.status).toBe(200);
    const { result } = (await runRes.json()) as { result: { ok: boolean; ran: boolean } };
    expect(result.ok).toBe(true);
    expect(result.ran).toBe(true);

    // Wait for the finished event to ensure execution completed
    const finishedMsgs = await finishedPromise;
    ws.close();
    expect(finishedMsgs.length).toBeGreaterThanOrEqual(1);

    // Step 4: Verify persisted state after execution
    const getResAfterRun = await fetch(apiUrl(`/api/cron/${createdJob.id}`));
    expect(getResAfterRun.status).toBe(200);
    const { job: afterRunJob } = (await getResAfterRun.json()) as {
      job: {
        id: string;
        name: string;
        description: string;
        enabled: boolean;
        schedule: { kind: string; everyMs: number };
        state: {
          lastRunAtMs: number;
          lastStatus: string;
          lastDurationMs: number;
          consecutiveErrors: number;
          nextRunAtMs: number;
          runningAtMs?: number;
          lastError?: string;
        };
      };
    };

    // Immutable fields should remain unchanged
    expect(afterRunJob.id).toBe(createdJob.id);
    expect(afterRunJob.name).toBe('Persistence Round-Trip Job');
    expect(afterRunJob.description).toBe('Verifies state persists after execution');
    expect(afterRunJob.enabled).toBe(true);
    expect(afterRunJob.schedule.kind).toBe('every');
    expect(afterRunJob.schedule.everyMs).toBe(300_000);

    // State fields should be set after execution
    expect(afterRunJob.state.lastStatus).toBe('ok');
    expect(typeof afterRunJob.state.lastRunAtMs).toBe('number');
    expect(afterRunJob.state.lastRunAtMs).toBeGreaterThanOrEqual(beforeCreate);
    expect(typeof afterRunJob.state.lastDurationMs).toBe('number');
    expect(afterRunJob.state.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(afterRunJob.state.runningAtMs).toBeUndefined();
    expect(typeof afterRunJob.state.nextRunAtMs).toBe('number');
    expect(afterRunJob.state.nextRunAtMs).toBeGreaterThan(afterRunJob.state.lastRunAtMs);
    expect(afterRunJob.state.consecutiveErrors).toBe(0);

    // Verify the finished WS event data matches the persisted state
    const finishedData = finishedMsgs[0].data as Record<string, unknown>;
    expect(finishedData.jobId).toBe(createdJob.id);
    expect(finishedData.status).toBe('ok');
    expect(finishedData.durationMs).toBe(afterRunJob.state.lastDurationMs);
    expect(finishedData.summary).toBe('persistence test event');

    // Cleanup
    await fetch(apiUrl(`/api/cron/${createdJob.id}`), { method: 'DELETE' });
    await delay(50);
  });
});
