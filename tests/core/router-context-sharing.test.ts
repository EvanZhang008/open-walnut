import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import type { RouterAreasFile } from '../../src/core/router/areas.js';

// A temp data home: nothing here may read the real one.
vi.mock('../../src/constants.js', () => createMockConstants('router-context-sharing'));

import { WALNUT_HOME } from '../../src/constants.js';
import { mayShareTaskContext, type ContextSharingDeps } from '../../src/core/router/context-sharing.js';

type FakeTask = { id: string; router_area_id?: string; org_role?: string };
const h = {
  tasks: new Map<string, FakeTask>(),
  sessions: new Map<string, Array<{ profile?: { areaId?: string; areaRole?: string } }>>(),
  areas: null as unknown as RouterAreasFile,
  broken: false,
  sessionsBroken: new Set<string>(),
  areaHomes: [] as string[],
  taskReads: [] as string[],
  sessionReads: [] as string[],
};

// The real stores' contract: getTask throws on an unknown id, the session store returns rows.
const deps: ContextSharingDeps = {
  async readAreas(home) {
    h.areaHomes.push(home);
    if (h.broken) throw new Error('Registry unreadable');
    return h.areas;
  },
  async getTask(id) {
    h.taskReads.push(id);
    const task = h.tasks.get(id);
    if (!task) throw new Error(`No task found with ID "${id}"`);
    return task;
  },
  async sessionsForTask(taskId) {
    h.sessionReads.push(taskId);
    if (h.sessionsBroken.has(taskId)) throw new Error('Session store unreadable');
    return (h.sessions.get(taskId) ?? []) as Awaited<ReturnType<ContextSharingDeps['sessionsForTask']>>;
  },
};

const share = (from: string, to: string | undefined) => mayShareTaskContext(from, to, deps);
const profile = (taskId: string, areaRole: string | undefined, ...areaIds: string[]) =>
  h.sessions.set(taskId, areaIds.map((areaId) => ({ profile: { areaId, ...(areaRole ? { areaRole } : {}) } })));

// Since 2026-11-14 only a router is scoped: the work it hands items to is ordinary work, whatever
// an older build marked on it (router_area_id, area membership, a 'work' session profile).
beforeEach(() => {
  h.tasks.clear(); h.sessions.clear(); h.sessionsBroken.clear();
  h.broken = false; h.areaHomes.length = 0; h.taskReads.length = 0; h.sessionReads.length = 0;
  for (const id of ['plain', 'plain2', 'marked']) h.tasks.set(id, { id });
  h.tasks.get('marked')!.router_area_id = 'personal';
  h.tasks.set('rp', { id: 'rp', org_role: 'router' });
  h.tasks.set('rw', { id: 'rw', org_role: 'router' });
  h.areas = {
    version: 1, items: [],
    routers: [{ taskId: 'rp', areaId: 'personal', paused: false }, { taskId: 'rw', areaId: 'work', paused: false }],
    areas: ['personal', 'work'].map((id) => ({ id, name: id, host: '__local__', sources: [],
      taskIds: id === 'personal' ? ['rp', 'marked'] : ['rw'] })),
  } satisfies RouterAreasFile;
});

describe('context sharing around routers', () => {
  it('lets ordinary work share freely, a router keep to itself, and two routers never share', async () => {
    expect(await share('plain', 'plain2')).toBe(true);
    expect(await share('plain', undefined)).toBe(true);
    expect(await share('rp', 'rp')).toBe(true);
    for (const pair of [['rp', 'plain'], ['plain', 'rp'], ['rp', 'rw'], ['rw', 'rp']]) {
      expect(await share(pair[0]!, pair[1]!)).toBe(false);
    }
    expect(await share('rp', undefined)).toBe(false);
  });

  it('treats work an older build marked and listed in an area as ordinary work', async () => {
    expect(await share('marked', 'plain')).toBe(true);
    expect(await share('plain', 'marked')).toBe(true);
    expect(await share('marked', undefined)).toBe(true);
    expect(await share('marked', 'rp')).toBe(false);
    expect(await share('rp', 'marked')).toBe(false);
  });

  it('ignores a legacy work session profile and a profile with no role', async () => {
    profile('plain', 'work', 'personal');
    expect(await share('plain', 'plain2')).toBe(true);
    expect(await share('plain2', 'plain')).toBe(true);
    profile('plain', undefined, 'personal');
    expect(await share('plain', undefined)).toBe(true);
  });

  it('reads the registry from the data home and the task and sessions of both sides', async () => {
    expect(await share('plain', 'plain2')).toBe(true);
    expect(h.areaHomes).toEqual([WALNUT_HOME]);
    expect([...h.taskReads].sort()).toEqual(['plain', 'plain2']);
    expect([...h.sessionReads].sort()).toEqual(['plain', 'plain2']);
  });

  it('withholds everything on a broken registry, ordinary work included', async () => {
    h.broken = true;
    expect(await share('rp', 'rp')).toBe(false);
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain', undefined)).toBe(false);
  });

  it('withholds a deleted sender or receiver', async () => {
    expect(await share('gone', 'plain')).toBe(false);
    expect(await share('plain', 'gone')).toBe(false);
    expect(await share('gone', undefined)).toBe(false);
  });

  it('withholds a prefix match returned for a missing exact task', async () => {
    h.tasks.set('gone', { id: 'gone-other' });
    expect(await share('gone', 'plain')).toBe(false);
    expect(await share('plain', 'gone')).toBe(false);
    expect(await share('gone', undefined)).toBe(false);
  });

  it('withholds the context when either task\'s sessions cannot be read', async () => {
    h.sessionsBroken.add('plain2');
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain2', undefined)).toBe(false);
    expect(await share('plain', undefined)).toBe(true);
  });

  it('counts a router session profile, in both directions', async () => {
    profile('plain', 'router', 'personal');
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain', undefined)).toBe(false);
    expect(await share('plain', 'rw')).toBe(false);
    expect(await share('plain', 'rp')).toBe(true);
    expect(await share('rp', 'plain')).toBe(true);
  });

  it('withholds a task whose router sessions hold two areas, and keeps one held twice', async () => {
    profile('plain', 'router', 'personal', 'work');
    expect(await share('plain', 'rp')).toBe(false);
    expect(await share('plain', 'rw')).toBe(false);
    profile('plain', 'router', 'work', 'work');
    expect(await share('plain', 'rw')).toBe(true);
    expect(await share('plain', 'plain2')).toBe(false);
  });

  it('counts a router assignment without the org role', async () => {
    h.areas.routers = [...h.areas.routers, { taskId: 'plain', areaId: 'work', paused: false }];
    expect(await share('plain', 'rw')).toBe(true);
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain', 'rp')).toBe(false);
  });

  it('does not let an unassigned router share ordinary context or reach a taskless session', async () => {
    h.tasks.get('plain')!.org_role = 'router';
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain', 'plain')).toBe(false);
    expect(await share('plain', undefined)).toBe(false);
    expect(await share('plain2', undefined)).toBe(true);
  });
});
