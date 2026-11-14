import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { RouterAreasFile } from '../../src/core/router/areas.js';
import type { SourceReaderDeps } from '../../src/core/router/source-reader.js';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('router-area-access'));

// One fake store serves the injected deps, the default deps, the HTTP belt and the raw gateway.
interface Fake {
  sessions: Record<string, { taskId?: string; legacyTaskId?: string; profile?: { areaId?: string; areaRole?: string } }>;
  tasks: Record<string, { id: string; router_area_id?: string; org_role?: string }>;
  taskSessions: Record<string, Array<{ profile?: { areaId?: string; areaRole?: string } }>>;
  file: RouterAreasFile;
  areasError?: Error;
  taskError?: Error;
}
const empty = (): RouterAreasFile => ({ version: 1, areas: [], routers: [], items: [] });
let fake: Fake = { sessions: {}, tasks: {}, taskSessions: {}, file: empty() };

vi.mock('../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/session-tracker.js')>()),
  getSessionByClaudeId: async (sid: string) => fake.sessions[sid] ?? null,
  getSessionsForTask: async (id: string) => fake.taskSessions[id] ?? [],
}));
vi.mock('../../src/core/task-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/task-manager.js')>()),
  getTask: async (id: string) => {
    if (fake.taskError) throw fake.taskError;
    const task = fake.tasks[id];
    if (!task) throw new Error(`No task found with ID "${id}"`);
    return task;
  },
}));
vi.mock('../../src/core/router/areas.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/router/areas.js')>()),
  readRouterAreas: async () => { if (fake.areasError) throw fake.areasError; return fake.file; },
}));

const { areaOpsForCaller, ROUTER_AREA_OPS, ROUTER_WORK_OPS } = await import('../../src/core/router/gateway-policy.js');
const { routerAreaAccess } = await import('../../src/web/middleware/router-area-access.js');
const { handleGatewayCapability } = await import('../../src/core/peers/capability-router.js');
const { PeerThrottle } = await import('../../src/core/peers/peer-throttle.js');
const { listOps } = await import('../../src/ops/index.js');

const injected: SourceReaderDeps = {
  async readAreas() { if (fake.areasError) throw fake.areasError; return fake.file; },
  async session(sid) { return (fake.sessions[sid] ?? null) as never; },
  async task(id) { if (fake.taskError) throw fake.taskError; return fake.tasks[id] as never; },
  async sessionsForTask(id) { return (fake.taskSessions[id] ?? []) as never; },
};

function registry(): RouterAreasFile {
  return {
    version: 1,
    areas: [
      { id: 'alpha', name: 'Alpha', host: '__local__', taskIds: ['t-listed'], sources: [] },
      { id: 'beta', name: 'Beta', host: '__local__', taskIds: ['t-assigned'], sources: [] },
    ],
    routers: [{ taskId: 't-assigned', areaId: 'beta', paused: false }],
    items: [],
  };
}

beforeEach(() => {
  fake = {
    file: registry(),
    sessions: {
      ordinary: { taskId: 't-plain' },
      legacy: { taskId: 't-new', legacyTaskId: 't-old' },
      'sibling-router': { taskId: 't-dropped-router' },
      'sibling-work': { taskId: 't-dropped-work' },
      'unassigned-router': { taskId: 't-org-router' },
      assigned: { taskId: 't-assigned' },
      listed: { taskId: 't-listed' },
      'taskless-work': { profile: { areaId: 'alpha', areaRole: 'work' } },
      'taskless-router': { profile: { areaId: 'alpha', areaRole: 'router' } },
      'role-only': { profile: { areaRole: 'router' } },
      'role-wins': { taskId: 't-org-router', profile: { areaId: 'alpha', areaRole: 'work' } },
      conflict: { taskId: 't-old', profile: { areaId: 'beta', areaRole: 'work' } },
    },
    tasks: {
      't-plain': { id: 't-plain' },
      't-new': { id: 't-new' },
      't-old': { id: 't-old', router_area_id: 'alpha' },
      't-dropped-router': { id: 't-dropped-router' },
      't-dropped-work': { id: 't-dropped-work' },
      't-org-router': { id: 't-org-router', org_role: 'router' },
      't-assigned': { id: 't-assigned' },
      't-listed': { id: 't-listed' },
    },
    taskSessions: {
      't-dropped-router': [{ profile: { areaId: 'alpha', areaRole: 'router' } }],
      't-dropped-work': [{}, { profile: { areaId: 'alpha', areaRole: 'work' } }],
    },
  };
});

const NONE = new Set<string>();
const cases: Array<[string, ReadonlySet<string> | undefined]> = [
  ['ordinary', undefined],
  ['legacy', ROUTER_WORK_OPS],
  ['sibling-router', ROUTER_AREA_OPS],
  ['sibling-work', ROUTER_WORK_OPS],
  ['unassigned-router', ROUTER_AREA_OPS],
  ['assigned', ROUTER_AREA_OPS],
  ['listed', ROUTER_WORK_OPS],
  ['taskless-work', ROUTER_WORK_OPS],
  ['taskless-router', ROUTER_AREA_OPS],
  ['role-only', ROUTER_AREA_OPS],
  ['role-wins', ROUTER_WORK_OPS],
  ['conflict', NONE],
];

describe('areaOpsForCaller', () => {
  for (const [sid, want] of cases) {
    it(`${sid}: ${want === undefined ? 'full tools' : [...want].join(', ') || 'no op'}`, async () => {
      expect(await areaOpsForCaller(sid, injected)).toEqual(want);
    });
  }

  it('an ordinary session still gets full tools with no registry file at all', async () => {
    fake.file = empty();
    expect(await areaOpsForCaller('ordinary', injected)).toBeUndefined();
  });

  it('an unknown or external id is an outside caller, even while the registry is broken', async () => {
    fake.areasError = new Error('Unexpected token');
    for (const sid of ['nobody', 'external', '']) expect(await areaOpsForCaller(sid, injected)).toBeUndefined();
  });

  it('a missing exact task never inherits a different task returned by a prefix lookup', async () => {
    fake.file = empty();
    fake.tasks['t-plain'] = { id: 't-plain-other', router_area_id: 'alpha', org_role: 'router' };
    expect(await areaOpsForCaller('ordinary')).toBeUndefined();
    fake.file = registry();
    fake.sessions.listed = { taskId: 't-listed' };
    fake.tasks['t-listed'] = { id: 't-listed-other', router_area_id: 'beta', org_role: 'router' };
    expect(await areaOpsForCaller('listed')).toEqual(ROUTER_WORK_OPS);
  });

  it('a known session gets no op while the registry or its task cannot be read, ordinary ones included', async () => {
    fake.areasError = new Error('Unexpected token');
    expect(await areaOpsForCaller('ordinary', injected)).toEqual(NONE);
    expect(await areaOpsForCaller('taskless-work', injected)).toEqual(NONE);
    fake.areasError = undefined;
    fake.taskError = new Error('database is locked');
    expect(await areaOpsForCaller('ordinary', injected)).toEqual(NONE);
  });
});

// The HTTP tool belt and the raw gateway both ask areaOpsForCaller, so they agree on every case.
const ROUTER_PATHS: Array<[string, string, string]> = [
  ['router_context', 'GET', '/v1/router/context'], ['router_route', 'POST', '/v1/router/route'],
  ['router_item', 'GET', '/v1/router/item'], ['router_work', 'POST', '/v1/router/work'],
];

async function beltAllows(sid: string, method: string, path: string): Promise<boolean> {
  let passed = false;
  let status = 0;
  const req = { headers: { 'x-walnut-caller-sid': sid }, method, path } as unknown as Request;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  await routerAreaAccess(req, res, (error?: unknown) => { if (error) throw error; passed = true; });
  return passed && status === 0;
}

describe('the HTTP belt and the raw gateway', () => {
  const deps = () => ({ throttle: new PeerThrottle(), cloudMode: false });
  for (const [sid, want] of cases) {
    it(`agree for ${sid}`, async () => {
      // The default deps (real module graph, mocked stores) give the same answer as the injected ones.
      expect(await areaOpsForCaller(sid)).toEqual(await areaOpsForCaller(sid, injected));
      for (const [op, method, path] of ROUTER_PATHS) {
        expect(await beltAllows(sid, method, path)).toBe(want === undefined || want.has(op));
      }
      expect(await beltAllows(sid, 'GET', '/v1/tasks')).toBe(want === undefined);
      const listed = await handleGatewayCapability('tools.list', sid, {}, '__local__', deps());
      if (!listed.ok) throw new Error(listed.error.message);
      const names = new Set((listed.result.ops as Array<{ name: string }>).map((o) => o.name));
      const catalog = listOps().map((o) => o.name);
      expect(names).toEqual(new Set(want === undefined ? catalog : catalog.filter((n) => want.has(n))));
      if (want !== undefined) {
        const refused = await handleGatewayCapability('tools.call', sid, { name: 'task_list', args: {} }, '__local__', deps());
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.message).toMatch(/only its area routing tools/);
      }
    });
  }
});
