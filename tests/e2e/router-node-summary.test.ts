/**
 * GET /api/v1/router/nodes/:id/summary: what a router's Org page shows above its chat (2026-11-11,
 * the person, on a router page that said only "No conversation history found": "why it is empty
 * that is weird it is not working or what"). Counts and the newest route's target only, never an
 * item's words; a session caller is refused like every other read of an area.
 */
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-summary'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { ensureProjectLead } from '../../src/core/org/org-store.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { isHistoryStartupWindow } from '../../src/core/sessions/session-lifecycle.js';
import { routerAreaProfile } from '../../src/core/router/session-policy.js';
import { routerStore } from '../../src/core/router/runtime.js';
import { routerKey, routerMessageId } from '../../src/core/router/store.js';
import type { RouterItem, RouterSource } from '../../src/core/router/types.js';

let base = '';
let vpId = '';
beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vpId = (await ensureProjectLead('Garden')).id;
});
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

async function createRouter(area: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/org/routers`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${area} router`, area_id: area, area_name: area === 'garden' ? 'Garden' : area, host: '__local__', links: [vpId], sources: [] }) });
  expect(response.status).toBe(201);
  return (await response.json()).task.id as string;
}
async function summary(id: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/router/nodes/${encodeURIComponent(id)}/summary`, { headers });
}
const mail = (message: string): RouterSource => ({ kind: 'mail', account: 'router-fixture@example.com', message });
const item = (source: RouterSource): RouterItem => ({ source, key: routerKey(source), sender: 'pat@marina-desk.example.invalid', subject: 'Dock schedule' });

describe('the router node summary', () => {
  it('says a new router is paused, has nothing assigned and has routed nothing', async () => {
    const id = await createRouter('garden');
    const response = await summary(id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      areaId: 'garden', areaName: 'Garden', paused: true, sources: 0, assigned: 0, waiting: 0,
      counts: { routed: 0, not_routed: 0, routing: 0, failed: 0, unknown: 0 },
      session: { started: false },
    });
    expect(body.latest).toBeUndefined();
  });

  it('counts routes and names the newest one by its task title, never by the item words', async () => {
    const id = await createRouter('workshop');
    const target = await addTask({ title: 'Fix the dock schedule' });
    const ledger = routerStore('workshop', WALNUT_HOME);
    const first = await ledger.claim(item(mail('m1')), { status: 'routing', taskId: target.task.id, reason: 'thread match' }, 1_000);
    await ledger.claim(item(mail('m2')), { status: 'not_routed', reason: 'newsletter' }, 2_000);
    await ledger.settle(first.route.key, routerMessageId('workshop', first.route.key, target.task.id), { status: 'routed' }, 3_000);
    const body = await (await summary(id)).json();
    expect(body.counts).toEqual({ routed: 1, not_routed: 1, routing: 0, failed: 0, unknown: 0 });
    expect(body.latest).toEqual({ at: 3_000, status: 'routed', taskId: target.task.id, taskTitle: 'Fix the dock schedule' });
    const text = JSON.stringify(body);
    expect(text).not.toContain('Dock schedule');
    expect(text).not.toContain('marina-desk');
  });

  it('answers 404 not_router for a task that is no router, and refuses a session caller', async () => {
    const plain = await addTask({ title: 'Plain task' });
    const missing = await summary(plain.task.id);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).toContain('not_router');
    const id = await createRouter('kitchen');
    const refused = await summary(id, { 'x-walnut-caller-sid': 'session-of-another-task' });
    expect(refused.status).toBe(403);
  });

  it('a router session with no transcript yet reads as no conversation, never History unavailable', async () => {
    const id = await createRouter('cellar');
    // No startedIdle flag: the routers started before it was recorded (the prod Personal router).
    const sid = '7b0c9a1e-0000-4000-8000-00000000c111';
    await createSessionRecord(sid, id, '', WALNUT_HOME, { title: 'cellar router', initialProcessStatus: 'idle', profile: routerAreaProfile('cellar', 'router'), mode: 'dontAsk' });
    // Hours past the launch grace, as the prod router was.
    const old = new Date(Date.now() - 6 * 3600_000).toISOString();
    await updateSessionRecord(sid, { startedAt: old, last_status_change: old } as Parameters<typeof updateSessionRecord>[1]);
    // The launch grace is out of play: only the router rule can answer an empty history here.
    const stored = await getSessionByClaudeId(sid);
    expect(stored && isHistoryStartupWindow(stored)).toBe(false);
    for (const query of ['', '?tail=400&turns=10']) {
      const response = await fetch(`${base}/api/sessions/${sid}/history${query}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.messages).toEqual([]);
      expect(body.historyUnavailable, query).toBeUndefined();
    }
  });
});
