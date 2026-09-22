/**
 * `wake` end to end: a routine stored over /api/routines, real bus events, the
 * real subscriber, the real cron engine, and the audit row the run leaves behind.
 *
 * What only this layer can prove: the subscriber the SERVER starts picks a new
 * routine up (no restart), an event nobody declared reaches nothing, the run
 * happens through the engine's own force path, and the state the API serves back
 * carries the counter and the fire's injected preview.
 *
 * The routine uses the main-agent executor with `wakeMode: 'next-cycle'`, which
 * broadcasts + queues and never calls a model — the run is real, the spend is not.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { startServer, stopServer } from '../../src/web/server.js';
import { bus } from '../../src/core/event-bus.js';
import { getRoutineWakeHandleForTesting } from '../../src/core/routines/wake-events.js';

const ITEMS_EVENT = 'plugin:walnuttest:items-received';
const OTHER_EVENT = 'plugin:walnuttest:draft-changed';

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

async function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function patch(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path));
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Emit under an arbitrary name (the typed overload wants a known payload). */
function emitRaw(name: string, data: unknown): void {
  bus.emit(name, data, ['web-ui']);
}

/** The subscriber re-arms on a debounce after a cron mutation; wait for it. */
async function waitForInterest(eventName: string): Promise<void> {
  await vi.waitFor(() => {
    const stats = getRoutineWakeHandleForTesting()?.stats();
    expect(stats?.interest ?? []).toContain(eventName);
  }, { timeout: 10_000, interval: 50 });
}

async function createWakeRoutine(name: string, wake: unknown): Promise<any> {
  const { status, json } = await post('/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 3_600_000 },
    wakeMode: 'next-cycle',
    sessionTarget: 'main',
    payload: { kind: 'systemEvent', text: `Triage: ${name}` },
    wake,
  });
  expect(status, JSON.stringify(json)).toBe(201);
  return json.job;
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
});

describe('routine wake, end to end', () => {
  it('stores the counter, counts real bus events, and runs the routine once the threshold is crossed', async () => {
    const name = `E2E wake ${Date.now()}`;
    const created = await createWakeRoutine(name, {
      events: [ITEMS_EVENT], countField: 'count', threshold: 20,
    });
    expect(created.wake).toEqual({ events: [ITEMS_EVENT], countField: 'count', threshold: 20 });
    await waitForInterest(ITEMS_EVENT);

    // An event nobody declared must not count, even from the same plugin.
    emitRaw(OTHER_EVENT, { count: 50 });
    // Three reports, 22 items: the third crosses the threshold.
    emitRaw(ITEMS_EVENT, { count: 7 });
    emitRaw(ITEMS_EVENT, { count: 7 });
    emitRaw(ITEMS_EVENT, { count: 8 });

    // The flush is a 5s trailing timer, then the engine runs the routine.
    await vi.waitFor(async () => {
      const { json } = await get(`/api/routines/${created.id}`);
      expect(json.job.state.lastStatus).toBe('ok');
    }, { timeout: 30_000, interval: 250 });

    const { json } = await get(`/api/routines/${created.id}`);
    // The batch was consumed, not left to fire again on the next event.
    expect(json.job.state.wakeCount).toBe(0);
    // One audit row for the fire, carrying what the run injected.
    expect(json.job.state.fireLog).toHaveLength(1);
    expect(json.job.state.fireLog[0]).toMatchObject({ outcome: 'fired', items: 22 });
    expect(json.job.state.fireLog[0].injected.preview).toContain(`Triage: ${name}`);

    await fetch(apiUrl(`/api/routines/${created.id}`), { method: 'DELETE' });
  }, 60_000);

  it('skipWhenIdle answers a run with an empty counter as skipped', async () => {
    const created = await createWakeRoutine(`E2E wake idle ${Date.now()}`, {
      events: [ITEMS_EVENT], threshold: 5, skipWhenIdle: true,
    });
    expect(created.wake.skipWhenIdle).toBe(true);

    const { status, json } = await post(`/api/routines/${created.id}/run`);
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ ok: true, ran: true });

    const after = await get(`/api/routines/${created.id}`);
    expect(after.json.job.state.lastStatus).toBe('skipped');
    expect(after.json.job.state.lastError ?? '').not.toContain('requires');
    expect(after.json.job.state.fireLog).toBeUndefined();

    await fetch(apiUrl(`/api/routines/${created.id}`), { method: 'DELETE' });
  }, 30_000);

  it('a save that omits wake leaves it intact; an explicit null clears it', async () => {
    const created = await createWakeRoutine(`E2E wake keep ${Date.now()}`, {
      events: [ITEMS_EVENT], threshold: 9,
    });

    // Exactly the body RoutineForm sends: name, schedule, executor. No `wake`.
    const saved = await patch(`/api/routines/${created.id}`, {
      name: `${created.name} (edited)`,
      schedule: { kind: 'every', everyMs: 1_800_000 },
      executor: { type: 'main-agent', config: { instructions: 'Triage again.' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.job.wake).toEqual({ events: [ITEMS_EVENT], threshold: 9 });

    const cleared = await patch(`/api/routines/${created.id}`, { wake: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.job.wake).toBeUndefined();

    await fetch(apiUrl(`/api/routines/${created.id}`), { method: 'DELETE' });
  }, 30_000);

  it('refuses a wake counter on a check trigger with a 400', async () => {
    const { status, json } = await post('/api/routines', {
      name: `E2E wake+check ${Date.now()}`,
      schedule: { kind: 'every', everyMs: 300_000 },
      executor: { type: 'main-agent', config: { instructions: 'go' } },
      check: { run: `echo '{"fire": false}'`, host: '__local__' },
      wake: { events: [ITEMS_EVENT], threshold: 5 },
    });
    expect(status).toBe(400);
    expect(json.error).toContain('wake events cannot be combined with a check');
  }, 30_000);
});
