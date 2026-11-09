/**
 * Area routing rules through the real HTTP entry: GET/POST /api/v1/router/rules, the router's
 * context and router_route with rule_id. Real server, areas file, rules file, ledger, tasks and
 * session records; faked only the session send, the receiver start and the slack cache adapter.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionSendInput } from '../../src/core/sessions/session-send-core.js';
import type { SessionStartParams } from '../../src/core/sessions/task-start.js';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-rules'));

const fake = vi.hoisted(() => ({
  send: vi.fn<(input: SessionSendInput) => Promise<unknown>>(async () => ({ delivered: true })),
  start: vi.fn<(params: SessionStartParams) => Promise<unknown>>(),
}));
vi.mock('../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/session-send-core.js')>()),
  performSessionSend: (input: SessionSendInput) => fake.send(input),
}));
vi.mock('../../src/core/sessions/task-start.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/task-start.js')>()),
  startSessionForTask: (params: SessionStartParams) => fake.start(params),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { readRouterAreas, updateRouterAreas } from '../../src/core/router/areas.js';
import { routerAreaProfile, type RouterAreaRole } from '../../src/core/router/session-policy.js';
import { registerRouterSource } from '../../src/core/router/source-registry.js';
import { routerKey } from '../../src/core/router/store.js';
import { disposeRouterStores } from '../../src/core/router/runtime.js';
import { setRoutingRule, type TriageRoutingRule } from '../../src/core/triage/routing-rules.js';
import type { Task } from '../../src/core/types.js';
import type { RouterItem, RouterSource } from '../../src/core/router/types.js';

const PERSONAL = 'desk@marina.example.invalid';
const WORK = 'workshop@marina.example.invalid';
const BAKERY = { kind: 'slack' as const, account: PERSONAL, message: 'C1:5001' };
const LUNCH = { kind: 'slack' as const, account: PERSONAL, message: 'C1:5002' };
const W_ITEM = { kind: 'slack' as const, account: WORK, message: 'C2:6001' };
const senders: Record<string, [string, string]> = {
  [BAKERY.message]: ['desk@bakery.example.invalid', 'Pickup reminder'],
  [LUNCH.message]: ['pat@marina.example.invalid', 'Lunch'],
  [W_ITEM.message]: ['desk@bakery.example.invalid', 'Pickup reminder'],
};
const itemOf = (source: RouterSource): RouterItem => ({
  source, key: routerKey(source), sender: senders[source.message]![0], subject: senders[source.message]![1],
});
const resolve = vi.fn(async (source: RouterSource) => itemOf(source));
const read = vi.fn(async (source: RouterSource) => ({
  item: itemOf(source), body: { text: 'BODY' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false as const,
}));

let base = '';
let stopSource = () => {};
const ids = { router: '', florist: '', workRouter: '', invoices: '', loose: '' };
const sids = { router: randomUUID(), florist: randomUUID(), workRouter: randomUUID(), invoices: randomUUID() };
let bakeryRule: TriageRoutingRule;
let workRule: TriageRoutingRule;
let looseRule: TriageRoutingRule;

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const asRouter = { 'x-walnut-caller-sid': sids.router };
function codeOf(json: { code?: string; error?: unknown }): string | undefined {
  return typeof json.error === 'object' && json.error ? (json.error as { code?: string }).code : json.code;
}
async function rules() {
  const response = await call('GET', '/api/v1/router/rules');
  expect(response.status).toBe(200);
  return response.json() as Promise<{ rules: Array<{ id: string; revision: string; confirmed: boolean; areaId?: string; taskTitle?: string }>;
    bindings: Array<{ ruleId: string; revision: string; areaId: string }>; fileRevision: string }>;
}
async function seedSession(sid: string, taskId: string, areaId: string, role: RouterAreaRole) {
  await createSessionRecord(sid, taskId, '', WALNUT_HOME, { profile: routerAreaProfile(areaId, role), mode: 'dontAsk' });
  await updateSessionRecord(sid, { process_status: 'stopped' });
}
async function mark(taskId: string, patch: Record<string, unknown>) {
  await updateTaskRaw(taskId, patch as Partial<Task>, { source: 'router-areas', emitEvent: false });
}
const route = (source: RouterSource, extra: Record<string, unknown>) => call('POST', '/api/v1/router/route', asRouter,
  { source, reason: 'The bakery rule covers it.', text: 'A pickup reminder arrived.', ...extra });

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ids.router = (await addTask({ title: 'Personal router', project: 'Garden' })).task.id;
  ids.florist = (await addTask({ title: 'Florist visits', description: 'DESCRIPTION_CANARY', project: 'Garden' })).task.id;
  ids.workRouter = (await addTask({ title: 'Work router', project: 'Workshop' })).task.id;
  ids.invoices = (await addTask({ title: 'Dock invoices', project: 'Workshop' })).task.id;
  ids.loose = (await addTask({ title: 'Loose notes', project: 'Harbourside' })).task.id;
  await updateRouterAreas(WALNUT_HOME, () => ({
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: [ids.router, ids.florist], sources: [{ kind: 'slack', account: PERSONAL }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: [ids.workRouter, ids.invoices], sources: [{ kind: 'slack', account: WORK }] },
    ],
    routers: [{ taskId: ids.router, areaId: 'personal', paused: false }, { taskId: ids.workRouter, areaId: 'work', paused: false }],
    items: [{ source: BAKERY, areaId: 'personal' }, { source: LUNCH, areaId: 'personal' },
      { source: W_ITEM, areaId: 'work' }],
  }));
  await mark(ids.router, { org_role: 'router', router_area_id: 'personal', router_paused: false });
  await mark(ids.workRouter, { org_role: 'router', router_area_id: 'work', router_paused: false });
  await mark(ids.florist, { router_area_id: 'personal' });
  await mark(ids.invoices, { router_area_id: 'work' });
  await seedSession(sids.router, ids.router, 'personal', 'router');
  await seedSession(sids.florist, ids.florist, 'personal', 'work');
  await seedSession(sids.workRouter, ids.workRouter, 'work', 'router');
  await seedSession(sids.invoices, ids.invoices, 'work', 'work');
  bakeryRule = await setRoutingRule(WALNUT_HOME, { from: 'bakery.example.invalid', taskId: ids.florist }, { by: 'human' });
  workRule = await setRoutingRule(WALNUT_HOME, { subject: 'pickup', taskId: ids.invoices }, { by: 'human' });
  looseRule = await setRoutingRule(WALNUT_HOME, { subject: 'reminder', taskId: ids.loose }, { by: 'human' });
  stopSource = registerRouterSource('slack', { resolve, read });
});

afterAll(async () => {
  try {
    stopSource();
    await disposeRouterStores();
    await stopServer();
  } finally {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  }
});

describe('area rules on the real server', () => {
  it('lists rules with target titles only, unconfirmed before any binding', async () => {
    const response = await call('GET', '/api/v1/router/rules');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('DESCRIPTION_CANARY');
    const json = JSON.parse(text);
    expect(json.bindings).toEqual([]);
    expect(json.rules.find((rule: { id: string }) => rule.id === bakeryRule.id)).toMatchObject({
      taskId: ids.florist, taskTitle: 'Florist visits', enabled: true, confirmed: false,
    });
    expect(json.rules[0]).not.toHaveProperty('areaId');
  });

  it('refuses every session, automation and external caller, reading or confirming', async () => {
    const view = await rules();
    const body = { bindings: [{ ruleId: bakeryRule.id, revision: view.rules[0]!.revision, areaId: 'personal' }], expectedRevision: view.fileRevision };
    for (const headers of [asRouter, { 'x-walnut-caller-sid': 'external' }, { 'x-walnut-caller-kind': 'automation' },
      { 'x-walnut-caller-kind': ' Automation ' }, { 'x-walnut-caller-sid': sids.florist }]) {
      expect((await call('GET', '/api/v1/router/rules', headers)).ok).toBe(false);
      const response = await call('POST', '/api/v1/router/rules', headers, body);
      expect(response.ok).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect((await call('POST', '/api/v1/router/rules', asRouter, body)).status).toBe(403);
    expect((await readRouterAreas(WALNUT_HOME)).ruleBindings).toBeUndefined();
  });

  it('confirms a binding, returns the full view, and refuses a second save at the old revision', async () => {
    const view = await rules();
    const revisionOf = (id: string) => view.rules.find((rule) => rule.id === id)!.revision;
    const body = { bindings: [{ ruleId: bakeryRule.id, revision: revisionOf(bakeryRule.id), areaId: 'personal' },
      { ruleId: workRule.id, revision: revisionOf(workRule.id), areaId: 'work' },
      { ruleId: looseRule.id, revision: revisionOf(looseRule.id), areaId: 'personal' }], expectedRevision: view.fileRevision };
    const response = await call('POST', '/api/v1/router/rules', {}, body);
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.fileRevision).not.toBe(view.fileRevision);
    expect(saved.rules.find((rule: { id: string }) => rule.id === bakeryRule.id)).toMatchObject({ areaId: 'personal', confirmed: true });
    const again = await call('POST', '/api/v1/router/rules', {}, body);
    expect(again.status).toBe(409);
    expect(codeOf(await again.json())).toBe('rules_changed');
  });

  it('keeps the bindings across an area save that omits them', async () => {
    const { ruleBindings, ...areas } = await readRouterAreas(WALNUT_HOME);
    const response = await call('PUT', '/api/v1/router/areas', {}, areas);
    expect(response.status).toBe(200);
    expect((await readRouterAreas(WALNUT_HOME)).ruleBindings).toEqual(ruleBindings);
  });

  it('gives the router only this area\'s confirmed rules that match the item', async () => {
    const bakery = await (await call('GET', `/api/v1/router/context?${new URLSearchParams(BAKERY)}`, asRouter)).json();
    expect(bakery.rules.map((rule: { id: string }) => rule.id)).toEqual([bakeryRule.id, looseRule.id]);
    expect(JSON.stringify(bakery.rules)).not.toContain(workRule.id);
    const lunch = await (await call('GET', `/api/v1/router/context?${new URLSearchParams(LUNCH)}`, asRouter)).json();
    expect(lunch.rules).toEqual([]);
  });

  it('refuses a rule route that is not this area\'s, does not match, or names another target', async () => {
    let response = await route(BAKERY, { rule_id: workRule.id });
    expect(response.status).toBe(409);
    expect(codeOf(await response.json())).toBe('rule_unavailable');
    response = await route(LUNCH, { rule_id: bakeryRule.id });
    expect(response.status).toBe(409);
    expect(codeOf(await response.json())).toBe('rule_unavailable');
    response = await route(BAKERY, { rule_id: bakeryRule.id, task_id: ids.invoices });
    expect(response.status).toBe(400);
    expect(codeOf(await response.json())).toBe('rule_target');
    response = await route(BAKERY, { rule_id: bakeryRule.id, not_routed: true, text: undefined });
    expect(response.status).toBe(400);
    expect(codeOf(await response.json())).toBe('bad_decision');
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('routes with a confirmed rule to its own task and records the rule', async () => {
    const response = await route(BAKERY, { rule_id: bakeryRule.id });
    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json.route).toMatchObject({ status: 'routed', taskId: ids.florist, ruleId: bakeryRule.id });
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(String(fake.send.mock.calls[0]![0].text)).toContain(`Routing rule: ${bakeryRule.id}`);
  });
});
