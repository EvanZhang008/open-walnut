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
  sessions: new Map<string, Array<{ profile?: { areaId?: string } }>>(),
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
const profile = (taskId: string, ...areaIds: string[]) => h.sessions.set(taskId, areaIds.map((areaId) => ({ profile: { areaId } })));

beforeEach(() => {
  h.tasks.clear(); h.sessions.clear(); h.sessionsBroken.clear();
  h.broken = false; h.areaHomes.length = 0; h.taskReads.length = 0; h.sessionReads.length = 0;
  for (const id of ['plain', 'plain2', 'personal', 'personal2', 'work']) h.tasks.set(id, { id });
  h.tasks.get('personal')!.router_area_id = 'personal';
  h.tasks.get('personal2')!.router_area_id = 'personal';
  h.tasks.get('work')!.router_area_id = 'work';
  h.areas = { version: 1, routers: [], items: [], areas: ['personal', 'work'].map((id) => ({ id, name: id,
    host: '__local__', sources: [], taskIds: id === 'personal' ? ['personal', 'personal2'] : ['work'] })) } satisfies RouterAreasFile;
});

describe('context sharing across incoming-item areas', () => {
  it('allows the same confirmed scope and ordinary work, never a cross-area or area-to-ordinary copy', async () => {
    expect(await share('plain', 'plain2')).toBe(true);
    expect(await share('personal', 'personal2')).toBe(true);
    expect(await share('plain', undefined)).toBe(true);
    for (const pair of [['personal', 'work'], ['personal', 'plain'], ['plain', 'personal']]) {
      expect(await share(pair[0]!, pair[1]!)).toBe(false);
    }
  });

  it('reads the registry from the data home and the task and sessions of both sides', async () => {
    expect(await share('plain', 'plain2')).toBe(true);
    expect(h.areaHomes).toEqual([WALNUT_HOME]);
    expect([...h.taskReads].sort()).toEqual(['plain', 'plain2']);
    expect([...h.sessionReads].sort()).toEqual(['plain', 'plain2']);
  });

  it('does not lose a persisted mark while the registry is partially saved', async () => {
    h.areas.areas = [];
    expect(await share('personal', 'plain')).toBe(false);
    expect(await share('personal', 'work')).toBe(false);
    expect(await share('personal', 'personal2')).toBe(true);
  });

  it('withholds everything on a broken registry, ordinary work included', async () => {
    h.broken = true;
    expect(await share('personal', 'work')).toBe(false);
    expect(await share('personal', 'personal2')).toBe(false);
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

  it('counts an area held only by a session profile, in both directions', async () => {
    profile('plain', 'personal');
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain', undefined)).toBe(false);
    expect(await share('plain', 'work')).toBe(false);
    expect(await share('plain', 'personal')).toBe(true);
    expect(await share('personal2', 'plain')).toBe(true);
  });

  it('withholds a profile that conflicts with the task\'s mark', async () => {
    profile('personal', 'work');
    expect(await share('personal', 'personal2')).toBe(false);
    expect(await share('personal', 'work')).toBe(false);
    expect(await share('work', 'personal')).toBe(false);
    expect(await share('personal', 'plain')).toBe(false);
  });

  it('withholds a task whose sessions hold two areas, and keeps one held twice', async () => {
    profile('plain', 'personal', 'work');
    expect(await share('plain', 'personal')).toBe(false);
    expect(await share('plain', 'work')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    profile('plain', 'work', 'work');
    expect(await share('plain', 'work')).toBe(true);
    expect(await share('plain', 'plain2')).toBe(false);
  });

  it('counts an area held only by a router assignment', async () => {
    h.areas.routers = [{ taskId: 'plain', areaId: 'work', paused: false }];
    expect(await share('plain', 'work')).toBe(true);
    expect(await share('work', 'plain')).toBe(true);
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain', 'personal')).toBe(false);
    h.tasks.get('plain')!.org_role = 'router';
    expect(await share('plain', 'work')).toBe(true);
  });

  it('withholds a mismatched mark and registry rather than choosing the wider one', async () => {
    h.tasks.get('personal')!.router_area_id = 'work';
    expect(await share('personal', 'personal2')).toBe(false);
    expect(await share('personal', 'work')).toBe(false);
  });

  it('does not let an unassigned router share ordinary context or an area copy into a taskless session', async () => {
    h.tasks.get('plain')!.org_role = 'router';
    expect(await share('plain', 'plain2')).toBe(false);
    expect(await share('plain2', 'plain')).toBe(false);
    expect(await share('plain', undefined)).toBe(false);
    expect(await share('personal', undefined)).toBe(false);
    expect(await share('plain2', undefined)).toBe(true);
  });
});
