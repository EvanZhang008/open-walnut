import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import { patchLegacyTask } from '../helpers/router-history-fixtures.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-area'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js';
import { routerAreaProfile } from '../../src/core/router/session-policy.js';
import { registerRouterSource } from '../../src/core/router/source-registry.js';
import { routerKey } from '../../src/core/router/store.js';
import { disposeRouterStores } from '../../src/core/router/runtime.js';
import type { Task } from '../../src/core/types.js';

let base = '';
const personalSid = randomUUID();
const workSid = randomUUID();
let personalId = '';
let workId = '';
let stopSource = () => {};
const personal = { kind: 'mail' as const, account: 'desk@marina.example.invalid', message: 'INBOX:1:10', version: 'fixture-delivery-1' };
const work = { ...personal, message: 'INBOX:1:20' };
const itemFor = (source: typeof personal) => ({
  source, key: routerKey(source), sender: 'pat@marina.example.invalid',
  subject: source.message === personal.message ? 'PRIVATE_CANARY' : 'WORK_CANARY',
});
const resolve = vi.fn(async (source: typeof personal) => itemFor(source));
// The cache-only reader: the body is what the context route hands the router, so it carries its own canary.
const read = vi.fn(async (source: typeof personal) => ({
  item: itemFor(source),
  body: { text: source.message === personal.message ? 'PRIVATE_BODY_CANARY' : 'WORK_BODY_CANARY' },
  bodyAvailable: true,
  attachments: [{ filename: 'rota.pdf', mimeType: 'application/pdf', bytes: 2048 }],
  attachmentsAvailable: false as const,
}));
const adapter = { resolve, read };
function clearLookups() { resolve.mockClear(); read.mockClear(); }

/** Router markers as router setup persists them, written directly so no node is made or woken. */
async function markRouter(taskId: string, patch: Record<string, unknown>) {
  // `null` is the explicit-clear marker of a raw write.
  await updateTaskRaw(taskId, patch as Partial<Task>, { source: 'router-areas', emitEvent: false });
}

async function call(method: string, path: string, sid?: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { ...(sid ? { 'x-walnut-caller-sid': sid } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const contextPath = (source: typeof personal) => `/api/v1/router/context?${new URLSearchParams(source)}`;

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  personalId = (await addTask({ title: 'Personal router', project: 'Garden' })).task.id;
  workId = (await addTask({ title: 'Work router', project: 'Workshop' })).task.id;
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: [personalId], sources: [{ kind: 'mail', account: personal.account }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: [workId], sources: [{ kind: 'mail', account: work.account }] },
    ],
    routers: [{ taskId: personalId, areaId: 'personal', paused: false }, { taskId: workId, areaId: 'work', paused: false }],
    items: [{ source: personal, areaId: 'personal' }, { source: work, areaId: 'work' }],
  }));
  await markRouter(personalId, { org_role: 'router', router_area_id: 'personal', router_paused: false });
  await markRouter(workId, { org_role: 'router', router_area_id: 'work', router_paused: false });
  for (const [sid, taskId, areaId] of [[personalSid, personalId, 'personal'], [workSid, workId, 'work']]) {
    await createSessionRecord(sid, taskId, '', WALNUT_HOME, { profile: routerAreaProfile(areaId), mode: 'dontAsk' });
    await updateSessionRecord(sid, { process_status: 'stopped' });
  }
  stopSource = registerRouterSource('mail', adapter);
});

afterAll(async () => {
  stopSource();
  await disposeRouterStores();
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('area routing on the real server', () => {
  it('rejects work reading personal before the source adapter sees it', async () => {
    clearLookups();
    const response = await call('GET', contextPath(personal), workSid);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain('PRIVATE_CANARY');
    expect(text).not.toContain('PRIVATE_BODY_CANARY');
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('returns only the matching area context with its cached body, no other task titles, subject or body', async () => {
    clearLookups();
    const response = await call('GET', contextPath(personal), personalSid);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      router: { id: 'personal' },
      item: { source: personal, key: routerKey(personal), subject: 'PRIVATE_CANARY' },
      body: { text: 'PRIVATE_BODY_CANARY' },
      bodyAvailable: true,
      attachments: [{ filename: 'rota.pdf', mimeType: 'application/pdf', bytes: 2048 }],
      attachmentsAvailable: false,
      trust: expect.stringMatching(/never authorization/),
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(personal);
    expect(text).not.toContain('Work router');
    expect(text).not.toContain('WORK_CANARY');
    expect(text).not.toContain('WORK_BODY_CANARY');
    expect(text).not.toContain(workId);
  });

  it('returns no content if the active router is paused while its source is being read', async () => {
    const original = read.getMockImplementation()!;
    read.mockImplementationOnce(async (source) => {
      await markRouter(personalId, { router_paused: true });
      return original(source);
    });
    try {
      const response = await call('GET', contextPath(personal), personalSid);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('PRIVATE_BODY_CANARY');
    } finally {
      await markRouter(personalId, { router_paused: false });
    }
  });

  it('a person cannot make a new routing decision after the area router was paused', async () => {
    await updateRouterAreas(WALNUT_HOME, (file) => ({ ...file, routers: file.routers.map((one) => one.taskId === personalId ? { ...one, paused: true } : one) }));
    try {
      const response = await call('POST', '/api/v1/router/route', undefined, { source: personal, not_routed: true, reason: 'No action needed' });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('PRIVATE_BODY_CANARY');
      const { routerStore } = await import('../../src/core/router/runtime.js');
      expect(await routerStore('personal').getSource(personal)).toBeUndefined();
    } finally {
      await updateRouterAreas(WALNUT_HOME, (file) => ({ ...file, routers: file.routers.map((one) => one.taskId === personalId ? { ...one, paused: false } : one) }));
    }
  });

  it('rejects an unclassified item before a source lookup or read', async () => {
    clearLookups();
    const response = await call('GET', contextPath({ ...personal, message: 'INBOX:1:99' }), personalSid);
    expect(response.status).toBe(409);
    expect(resolve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('lets a person with no session header read their own registry\'s item', async () => {
    clearLookups();
    const response = await call('GET', contextPath(work));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ router: { id: 'work' }, body: { text: 'WORK_BODY_CANARY' } });
  });

  it('says the reader is missing instead of falling back to another lookup', async () => {
    const resolveOnly = registerRouterSource('mail', { resolve });
    try {
      clearLookups();
      const response = await call('GET', contextPath(personal), personalSid);
      expect(response.status).toBe(503);
      const json = await response.json();
      expect(json.error.code).toBe('source_unavailable');
      expect(JSON.stringify(json)).not.toContain('PRIVATE_BODY_CANARY');
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolveOnly();
      stopSource = registerRouterSource('mail', adapter);
    }
  });

  // `legacy`: a scope change the write guard refuses, so it is fault-injected (and undone) by raw SQL.
  const notLive: Array<[string, Record<string, unknown>, boolean]> = [
    ['is paused on its task', { router_paused: true }, false],
    ['has no paused flag at all', { router_paused: null }, false],
    ['names another area on its task', { router_area_id: 'work' }, true],
    ['is no longer a router task', { org_role: null }, true],
  ];
  for (const [name, patch, legacy] of notLive) {
    it(`refuses a router that ${name}, before any lookup`, async () => {
      if (legacy) patchLegacyTask(personalId, patch as Partial<Task>);
      else await markRouter(personalId, patch);
      try {
        clearLookups();
        const response = await call('GET', contextPath(personal), personalSid);
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain('PRIVATE_BODY_CANARY');
        expect(resolve).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        const restore: Partial<Task> = { org_role: 'router', router_area_id: 'personal', router_paused: false };
        if (legacy) patchLegacyTask(personalId, restore);
        else await markRouter(personalId, restore);
      }
    });
  }

  const blocked: Array<[string, string, unknown?]> = [
    ['GET', '/api/v1/tasks'], ['GET', `/api/v1/search?q=PRIVATE_CANARY`],
    ['GET', '/api/v1/router/areas'], ['GET', '/api/config'],
    ['POST', '/api/v1/tasks', { title: 'Escape attempt' }],
    ['POST', '/api/v1/tasks/send', { to: 'other', text: 'PRIVATE_CANARY' }],
    ['GET', '/api/plugins/mail/accounts'],
  ];
  for (const [method, path, body] of blocked) {
    it(`denies the unscoped ${method} ${path} path`, async () => {
      const response = await call(method, path, workSid, body);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('PRIVATE_CANARY');
    });
  }

  it('refuses an area session widening its own registry and leaves it unchanged', async () => {
    const before = await readRouterAreas(WALNUT_HOME);
    const response = await call('PUT', '/api/v1/router/areas', workSid, { ...before, items: [] });
    expect(response.status).toBe(403);
    expect(await readRouterAreas(WALNUT_HOME)).toEqual(before);
  });

  it('an ordinary session (a VP) reads a task an older build marked into an area, in its list, search and the org', async () => {
    const vpSid = randomUUID();
    const vpId = (await addTask({ title: 'Garden VP', project: 'Garden' })).task.id;
    await createSessionRecord(vpSid, vpId, '', WALNUT_HOME, { mode: 'dontAsk' });
    await updateSessionRecord(vpSid, { process_status: 'stopped' });
    const routedId = (await addTask({ title: 'ROUTED_ROTA_CANARY', project: 'Garden' })).task.id;
    // The mark an older build left on the work a router handed an item to; that build hid it from the VP.
    patchLegacyTask(routedId, { router_area_id: 'personal' } as Partial<Task>);
    const one = await call('GET', `/api/tasks/${routedId}`, vpSid);
    expect(one.status).toBe(200);
    expect(await one.text()).toContain('ROUTED_ROTA_CANARY');
    const list = await call('GET', '/api/tasks?slim=1', vpSid);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(routedId);
    const org = await call('GET', '/api/v1/org', vpSid);
    expect(org.status).toBe(200);
    // A router's own session is still held to its two tools.
    expect((await call('GET', `/api/tasks/${routedId}`, personalSid)).status).toBe(403);
  });

  it('records no-action without a model run or delivery and shows the same ledger on reread', async () => {
    const response = await call('POST', '/api/v1/router/route', personalSid, { source: personal, not_routed: true, reason: 'No action needed' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ route: { areaId: 'personal', status: 'not_routed', reason: 'No action needed' } });
    const reread = await call('GET', contextPath(personal), personalSid);
    expect(await reread.json()).toMatchObject({ route: { status: 'not_routed' } });
  });
});
