/**
 * A project created by a task under a name Walnut has never seen is Local, unless someone chose
 * its service (2026-11-01, the user: "all project should be created local by default, unless user
 * or ai explicitly choose"). The personal list plugin claims every name, so before this every new
 * name became one of its lists and every task in it was pushed there. What still counts as a
 * choice: a source the caller names, and a plugin set up for that exact name (a tracker's
 * configured category). A project that already has a row keeps its service.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-new-project-starts-local'));

import { addTask, ensureProject, getProjectRecord, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import type { Task } from '../../src/core/types.js';
import { createMockPlugin, createSpySync } from './plugin-test-utils.js';

const lists = createSpySync();
const tracker = createSpySync();
lists.createTask.mockImplementation(async () => ({ lists: { id: 'l-1' } }));
tracker.createTask.mockImplementation(async () => ({ tracker: { id: 't-1' } }));

const pushed = (spy: ReturnType<typeof createSpySync>) =>
  [...spy.createTask.mock.calls, ...spy.pushTask.mock.calls].map((c) => (c[0] as Task).id);

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const s of [lists, tracker]) { s.createTask.mockClear(); s.pushTask.mockClear(); }
  // A personal list that claims every name, and a tracker set up for one name.
  registry.replace('lists', createMockPlugin({
    id: 'lists', syncAudience: 'self', sync: lists, claim: { fn: () => true, priority: 0 },
  }));
  registry.replace('tracker', createMockPlugin({
    id: 'tracker', syncAudience: 'shared', sync: tracker,
    claim: { fn: (p: string) => p.toLowerCase() === 'team room', priority: 10 },
  }));
});

afterEach(async () => {
  registry.unregister('lists');
  registry.unregister('tracker');
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('a task under a new project name', () => {
  it('makes a Local project and a local task, sending nothing anywhere', async () => {
    const { task } = await addTask({ title: 'Plan the garden', project: 'Brand New' } as never);
    expect(task.source).toBe('local');
    expect((await getProjectRecord('Brand New'))?.source).toBe('local');
    expect([...pushed(lists), ...pushed(tracker)]).toEqual([]);
  });

  it('keeps the name Local for the next task too', async () => {
    await addTask({ title: 'First', project: 'Brand New' } as never);
    const { task } = await addTask({ title: 'Second', project: 'brand new' } as never);
    expect(task.source).toBe('local');
    expect((await getProjectRecord('Brand New'))?.source).toBe('local');
  });

  it('asked Local makes a Local project with no hold aimed at the catch-all list', async () => {
    const { task } = await addTask({ title: 'Mine', project: 'Kept Here', source: 'local' } as never);
    expect(task.source).toBe('local');
    expect(task.sync_hold?.target ?? 'local').toBe('local');
    expect((await getProjectRecord('Kept Here'))?.source).toBe('local');
  });

  it('takes the service the caller named', async () => {
    const { task } = await addTask({ title: 'Buy seeds', project: 'Errands', source: 'lists' } as never);
    expect((await getProjectRecord('Errands'))?.source).toBe('lists');
    expect(task.source === 'lists' || task.sync_hold?.target === 'lists').toBe(true);
  });

  it('takes the service the user set up for that exact name', async () => {
    const { task } = await addTask({ title: 'Fix the build', project: 'Team Room' } as never);
    expect((await getProjectRecord('Team Room'))?.source).toBe('tracker');
    expect(task.source === 'tracker' || task.sync_hold?.target === 'tracker').toBe(true);
    expect(pushed(lists)).toEqual([]);
  });
});

describe('a project that already has a row', () => {
  it('keeps its service: a task filed there syncs as before', async () => {
    await ensureProject('Groceries', 'lists');
    const { task } = await addTask({ title: 'Milk', project: 'Groceries' } as never);
    expect(task.source).toBe('lists');
    expect((await getProjectRecord('Groceries'))?.source).toBe('lists');
  });
});

describe('registry.getNamedClaimFor', () => {
  it('skips a claim that takes every name, and one that throws', async () => {
    registry.replace('broken', createMockPlugin({
      id: 'broken', claim: { fn: () => { throw new Error('boom'); }, priority: 20 },
    }));
    try {
      expect(await registry.getNamedClaimFor('Anything')).toBeUndefined();
      expect((await registry.getNamedClaimFor('TEAM ROOM'))?.id).toBe('tracker');
    } finally {
      registry.unregister('broken');
    }
  });
});
