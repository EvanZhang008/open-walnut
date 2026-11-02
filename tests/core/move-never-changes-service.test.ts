/**
 * A project move never gives a task an outside service it was not on (2026-11-01: a move into
 * a project that synced to a work tracker pushed the user's personal tasks there, and that
 * project had become a tracker project only because a tracker task was the first one moved
 * into its brand-new name).
 *
 * Every kind of task is moved into every kind of destination, and every pair must keep the
 * invariant: after the move the task's source is the one it had or `local`, and no service it
 * was not on received a push. A synced task moved into another service's project is held
 * there (local until someone chooses Sync), and that choice still sends it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-move-never-changes-service'));

import {
  addTask, updateTask, updateTaskRaw, getTask, ensureProject, getProjectRecord, releaseSyncHold, _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import type { Task, TaskSource } from '../../src/core/types.js';
import { createMockPlugin, createSpySync } from './plugin-test-utils.js';

/** Two services other people read, and one only the user reads. */
const SERVICES = [
  { id: 'svc-a', audience: 'shared' as const },
  { id: 'svc-b', audience: 'shared' as const },
  { id: 'svc-self', audience: 'self' as const },
];
type Spy = ReturnType<typeof createSpySync>;
const spies = new Map<string, Spy>();
let remoteSeq = 0;

function freshSpy(id: string): Spy {
  const spy = createSpySync();
  // A first push is a create (its answer is the task's remote identity), later ones full pushes.
  spy.createTask.mockImplementation(async () => ({ [id]: { id: `${id}-r${++remoteSeq}` } }));
  spy.pushTask.mockImplementation(async () => ({ serverTimestamp: new Date().toISOString() }));
  return spy;
}

/** Ids of the tasks a service was sent (creates and full pushes). */
function pushedIds(id: string): string[] {
  const spy = spies.get(id);
  if (!spy) return [];
  return [...spy.createTask.mock.calls, ...spy.pushTask.mock.calls].map((c) => (c[0] as Task).id);
}

function clearPushes(): void {
  for (const s of spies.values()) { s.createTask.mockClear(); s.pushTask.mockClear(); }
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const s of SERVICES) {
    const spy = freshSpy(s.id);
    spies.set(s.id, spy);
    registry.replace(s.id, createMockPlugin({ id: s.id, name: `Service ${s.id}`, syncAudience: s.audience, sync: spy }));
  }
  await ensureProject('Home', 'local');
  await ensureProject('Home-two', 'local');
  await ensureProject('A-land', 'svc-a');
  await ensureProject('A-two', 'svc-a');
  await ensureProject('B-land', 'svc-b');
  await ensureProject('Self-land', 'svc-self');
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Every kind of destination a move can name, with the claim it ends with. */
const DESTINATIONS: Array<{ name: string; project: string; claim: TaskSource }> = [
  { name: 'the Inbox', project: '', claim: 'local' },
  { name: 'a local project', project: 'Home-two', claim: 'local' },
  { name: 'a brand-new project name', project: 'Fresh idea', claim: 'local' },
  { name: 'another project of the same service', project: 'A-two', claim: 'svc-a' },
  { name: 'a project of another service others read', project: 'B-land', claim: 'svc-b' },
  { name: 'a project of a service only the user reads', project: 'Self-land', claim: 'svc-self' },
];

/** Every kind of task a move can take. */
const TASKS: Array<{ name: string; make: () => Promise<{ task: Task; child?: Task }> }> = [
  { name: 'a local task', make: async () => ({ task: (await addTask({ title: 'Local idea', project: 'Home' })).task }) },
  { name: 'a synced task', make: async () => ({ task: (await addTask({ title: 'Synced idea', project: 'A-land' })).task }) },
  {
    name: 'a synced task with a subtask',
    make: async () => {
      const { task } = await addTask({ title: 'Synced parent', project: 'A-land' });
      const { task: child } = await addTask({ title: 'Synced child', project: 'A-land', parent_task_id: task.id });
      return { task, child };
    },
  },
];

describe('a project move never gives a task a new outside service', () => {
  for (const t of TASKS) {
    for (const d of DESTINATIONS) {
      it(`${t.name} moved into ${d.name}`, async () => {
        const made = await t.make();
        const before = await getTask(made.task.id);
        // A synced task really is linked to its copy (the move has a copy to mark moved).
        if (before.source !== 'local') expect(before.ext?.[before.source]).toBeTruthy();
        clearPushes();

        await updateTask(before.id, { project: d.project });
        const after = await getTask(before.id);

        expect(after.project.toLowerCase()).toBe(d.project.toLowerCase());
        // The invariant: its service is the one it had, or none.
        expect([before.source, 'local']).toContain(after.source);
        // No service it was not on received anything of it.
        for (const s of SERVICES) {
          if (s.id === before.source) continue;
          expect(pushedIds(s.id)).not.toContain(before.id);
          if (made.child) expect(pushedIds(s.id)).not.toContain(made.child.id);
        }
        // The destination keeps its own claim; a brand-new name is local.
        if (d.project) expect((await getProjectRecord(d.project))?.source).toBe(d.claim);

        const synced = before.source !== 'local';
        if (!synced) {
          expect(after.source).toBe('local');
          return;
        }
        if (d.claim === before.source) {
          expect(after.source).toBe(before.source);
          return;
        }
        expect(after.source).toBe('local');
        // Its old copy was marked moved on its own service, never left open there.
        const titled = spies.get(before.source)!.updateTitle.mock.calls.map((c) => [(c[0] as Task).id, c[1]]);
        expect(titled).toContainEqual([before.id, expect.stringMatching(/^\[Moved\] /)]);
        if (d.claim === 'local') {
          expect(after.sync_hold).toBeUndefined();
          if (made.child) expect((await getTask(made.child.id)).source).toBe('local');
        } else {
          // Held for the destination's service: only a person's Sync sends it there.
          expect(after.sync_hold).toMatchObject({ target: d.claim, state: 'chosen', by: 'user' });
          expect(after.sync_hold?.reason).toMatch(/only when you choose Sync/);
          // Its subtask stays on its own project's service.
          if (made.child) expect((await getTask(made.child.id)).source).toBe(before.source);
        }
      });
    }
  }

  it('a held task syncs to the destination when someone chooses Sync', async () => {
    const { task } = await addTask({ title: 'Synced idea', project: 'A-land' });
    await updateTask(task.id, { project: 'B-land' });
    expect(pushedIds('svc-b')).not.toContain(task.id);

    const r = await releaseSyncHold(task.id, undefined, 'user');
    expect(r.released).toBe(true);
    const after = await getTask(task.id);
    expect(after.source).toBe('svc-b');
    expect(after.sync_hold).toBeUndefined();
    expect(pushedIds('svc-b')).toContain(task.id);
  });

  it('a held task moved on into a third service\'s project stays held, and its words name that one', async () => {
    const { task } = await addTask({ title: 'Synced idea', project: 'A-land' });
    await updateTask(task.id, { project: 'B-land' });
    clearPushes();
    await updateTask(task.id, { project: 'Self-land' });
    const after = await getTask(task.id);
    expect(after.source).toBe('local');
    expect(after.sync_hold).toMatchObject({ target: 'svc-self', state: 'chosen', by: 'user' });
    expect(after.sync_hold?.reason).toMatch(/syncs to Service svc-self only when you choose Sync/);
    for (const s of SERVICES) expect(pushedIds(s.id)).not.toContain(task.id);
  });

  it('a brand-new project a synced task is moved into does not take its service', async () => {
    // 2026-06-24: the first task moved into a new name was a tracker task, the new project
    // became a tracker project, and personal tasks moved there later were pushed.
    const { task: work } = await addTask({ title: 'Work item', project: 'A-land' });
    await updateTask(work.id, { project: 'Ideas' });
    expect((await getProjectRecord('Ideas'))?.source).toBe('local');

    const { task: personal } = await addTask({ title: 'Personal idea', project: 'Self-land' });
    clearPushes();
    await updateTask(personal.id, { project: 'Ideas' });
    expect((await getTask(personal.id)).source).toBe('local');
    expect(pushedIds('svc-a')).toEqual([]);
  });

  it('a raw write cannot give a task another service, and can take it off its own', async () => {
    // Every write path that is not updateTask's move (a sync pull, the phone's queue, filing)
    // goes through the raw update; a `source` it carries never names a new service.
    const { task } = await addTask({ title: 'Synced idea', project: 'A-land' });
    await updateTaskRaw(task.id, { source: 'svc-b' } as never);
    expect((await getTask(task.id)).source).toBe('svc-a');
    const { task: local } = await addTask({ title: 'Local idea', project: 'Home' });
    await updateTaskRaw(local.id, { source: 'svc-a' } as never);
    expect((await getTask(local.id)).source).toBe('local');
    await updateTaskRaw(task.id, { source: 'local' } as never);
    expect((await getTask(task.id)).source).toBe('local');
  });

  it('Sync on a held task whose project now syncs elsewhere sends nothing and names the new service', async () => {
    const { task } = await addTask({ title: 'Synced idea', project: 'A-land' });
    await updateTask(task.id, { project: 'B-land' });
    // The project changed underneath the hold (a path that does not follow it).
    await updateTaskRaw(task.id, { project: 'Self-land' } as never);
    clearPushes();
    const r = await releaseSyncHold(task.id, undefined, 'user');
    expect(r).toMatchObject({ released: false, reason: 'target_changed' });
    const after = await getTask(task.id);
    expect(after.source).toBe('local');
    expect(after.sync_hold).toMatchObject({ target: 'svc-self' });
    for (const s of SERVICES) expect(pushedIds(s.id)).not.toContain(task.id);
  });
});
