/**
 * Inbox Triage's routine, end to end: the real server, the real config route, the
 * real cron engine and the real routines API.
 *
 * What only this layer can prove: a fresh server has NO triage routine, a
 * PUT /api/config that enables triage makes one appear without a restart (the
 * config:changed subscriber the server starts), enabling creates no SESSION, and
 * disabling leaves the routine in place, merely disabled.
 *
 * No model is ever called: enabling only writes a routine definition. The run
 * path (which would start a session) is never triggered here — nothing forces the
 * job, and its interval is 30 minutes.
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

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path));
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function put(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Every routine, including disabled ones. */
async function routines(): Promise<any[]> {
  const { json } = await get('/api/routines?includeDisabled=true');
  return json?.jobs ?? [];
}

function triageRoutine(jobs: any[]): any | undefined {
  return jobs.find((j) => j?.initProcessor?.actionId === 'inbox-triage-batch');
}

async function waitForTriageRoutine(predicate: (job: any) => boolean): Promise<any> {
  let last: any;
  await vi.waitFor(async () => {
    last = triageRoutine(await routines());
    expect(last).toBeDefined();
    expect(predicate(last)).toBe(true);
  }, { timeout: 20_000, interval: 100 });
  return last;
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
});

describe('Inbox Triage bootstrap, end to end', () => {
  it('is absent on a fresh server, and the agent + skill are still there', async () => {
    expect(triageRoutine(await routines())).toBeUndefined();

    // The console agent exists whether or not triage is enabled — it is how the
    // user can ask it a question from the drawer.
    const agents = await get('/api/agents');
    expect(agents.status).toBe(200);
    const list: any[] = agents.json?.agents ?? agents.json ?? [];
    const triage = list.find((a) => a?.id === 'triage');
    expect(triage, JSON.stringify(list.map((a) => a?.id))).toBeDefined();
    expect(triage.name).toBe('Inbox Triage');
    expect(triage.console).toBe(true);
    // The skill's own presence is asserted against the shipped file in
    // tests/core/triage-bootstrap.test.ts: this tier mocks BUILTIN_SKILLS_DIR to a
    // temp directory, so /api/skills here cannot see anything Walnut ships.
  }, 30_000);

  it('enabling triage in config creates exactly one routine, and no session', async () => {
    const before = await get('/api/sessions');
    const sessionsBefore = (before.json?.sessions ?? before.json ?? []).length;

    const saved = await put('/api/config', {
      triage: {
        enabled: true, every: '30m', every_messages: 20,
        sources: ['mail', 'slack'], mode: 'ask',
      },
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);

    const job = await waitForTriageRoutine((j) => j?.enabled === true);
    expect(job.name).toBe('Inbox Triage');
    expect(job.schedule).toEqual(expect.objectContaining({ kind: 'every', everyMs: 30 * 60_000 }));
    expect(job.wake).toEqual(expect.objectContaining({
      events: ['plugin:mail:messages-received', 'plugin:slack:messages-received'],
      countField: 'count',
      threshold: 20,
      skipWhenIdle: true,
    }));
    expect(job.executor.type).toBe('claude-code');
    expect(job.executor.config).toEqual(expect.objectContaining({
      walnutAgent: true, agentId: 'triage', project: 'Ask Inbox Triage',
    }));
    // Exactly one, no matter how many config writes landed.
    expect((await routines()).filter((j) => j?.initProcessor?.actionId === 'inbox-triage-batch'))
      .toHaveLength(1);

    // Enabling mints no session: each RUN starts its own (decision D2), and no
    // run has happened.
    const after = await get('/api/sessions');
    expect((after.json?.sessions ?? after.json ?? []).length).toBe(sessionsBefore);
  }, 40_000);

  it('a hot config change re-patches the same routine instead of adding one', async () => {
    const saved = await put('/api/config', {
      triage: {
        enabled: true, every: '15m', every_messages: 5,
        sources: ['slack'], mode: 'assist',
      },
    });
    expect(saved.status).toBe(200);

    const job = await waitForTriageRoutine((j) => j?.schedule?.everyMs === 15 * 60_000);
    expect(job.wake.threshold).toBe(5);
    expect(job.wake.events).toEqual(['plugin:slack:messages-received']);
    expect((await routines()).filter((j) => j?.initProcessor?.actionId === 'inbox-triage-batch'))
      .toHaveLength(1);
  }, 40_000);

  it('disabling disables the routine and keeps it (its runs and notes are the memory)', async () => {
    const saved = await put('/api/config', { triage: { enabled: false } });
    expect(saved.status).toBe(200);

    const job = await waitForTriageRoutine((j) => j?.enabled === false);
    expect(job.initProcessor.actionId).toBe('inbox-triage-batch');
    // Still listed (with includeDisabled), so its history survives.
    expect((await routines()).filter((j) => j?.initProcessor?.actionId === 'inbox-triage-batch'))
      .toHaveLength(1);
  }, 40_000);
});
