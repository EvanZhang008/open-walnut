/**
 * Bus payload SHAPES for the three project-registry events the web console needs
 * to keep ONE shared project store honest: `project:renamed`, `project:deleted`,
 * `project:updated` — plus the `config:changed` pair the rename/delete migration
 * of `favorites.projects` / `ordering.projects` has to announce.
 *
 * Companion to task-events-shape.ts, for the same reason: these payloads are
 * consumed by code the type-checker cannot reach (the browser's WS handler). The
 * regression they pin is not a crash but a silent one — before these emits, a
 * rename or a Working Dir edit reached exactly ONE surface and every other project
 * list kept the old name until a reload, re-creating the project when picked. The
 * two "fires with no task moved" cases are the sharp edge: an EMPTY project moves
 * no task, so `task:updated` announces nothing at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-store-events'));

import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  _resetForTesting,
  addTask,
  ensureProject,
  renameProject,
  deleteProject,
  setProjectMetadata,
  getProjectMetadata,
  listTasks,
} from '../../src/core/task-manager.js';
import { getConfig, updateConfig, _resetWriteLockForTest } from '../../src/core/config-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

const PROBE = 'project-store-events-probe';

interface Captured { name: string; data: Record<string, unknown> }

function capture(): Captured[] {
  const seen: Captured[] = [];
  bus.subscribe(PROBE, (event) => {
    seen.push({ name: event.name, data: (event.data ?? {}) as Record<string, unknown> });
  }, { global: true });
  return seen;
}

function only(seen: Captured[], name: string): Captured[] {
  return seen.filter((e) => e.name === name);
}

/** config:changed carries a `key`; a rename touches at most favorites + ordering. */
function changedKeys(seen: Captured[]): string[] {
  return only(seen, EventNames.CONFIG_CHANGED).map((e) => String(e.data.key));
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  _resetWriteLockForTest();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  bus.unsubscribe(PROBE);
  closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('ProjectRenamedEvent shape', () => {
  it('fires for a project with NO tasks — the case task:updated cannot cover', async () => {
    await ensureProject('marina');
    const seen = capture();

    const result = await renameProject('marina', 'marina-bay');
    expect(result).toEqual({ count: 0, merged: false });

    const renamed = only(seen, EventNames.PROJECT_RENAMED);
    expect(renamed).toHaveLength(1);
    expect(Object.keys(renamed[0].data).sort()).toEqual(['count', 'from', 'merged', 'source', 'to']);
    expect(renamed[0].data).toEqual({
      from: 'marina', to: 'marina-bay', merged: false, count: 0, source: 'local',
    });
    // No task moved, so the ONLY announcement is the registry event.
    expect(only(seen, EventNames.TASK_UPDATED)).toHaveLength(0);
  });

  it('reports the moved-task count and rides beside task:updated', async () => {
    await addTask({ title: 'A', project: 'marina' });
    await addTask({ title: 'B', project: 'marina' });
    const seen = capture();

    await renameProject('marina', 'acme');

    const renamed = only(seen, EventNames.PROJECT_RENAMED);
    expect(renamed).toHaveLength(1);
    expect(renamed[0].data).toEqual({
      from: 'marina', to: 'acme', merged: false, count: 2, source: 'local',
    });
    expect(only(seen, EventNames.TASK_UPDATED)).toHaveLength(1);
  });

  it('carries the TARGET canonical spelling on a merge, so a consumer can follow the old name forward', async () => {
    await ensureProject('Acme');
    await addTask({ title: 'A', project: 'marina' });
    const seen = capture();

    // Renaming onto an existing project merges, case-insensitively: the row that
    // survives is 'Acme', not the caller's 'acme'.
    const result = await renameProject('marina', 'acme');
    expect(result.merged).toBe(true);

    const renamed = only(seen, EventNames.PROJECT_RENAMED);
    expect(renamed).toHaveLength(1);
    expect(renamed[0].data.to).toBe('Acme');
    expect(renamed[0].data.merged).toBe(true);
    expect((await listTasks()).find((t) => t.title === 'A')?.project).toBe('Acme');
  });
});

describe('ProjectDeletedEvent shape', () => {
  it('fires for an empty project, with the claim that owned it', async () => {
    await ensureProject('marina', 'ms-todo');
    const seen = capture();

    // A provider-claimed row is deletable through core directly; the cascade
    // guard lives in the route, not here.
    await deleteProject('marina');

    const deleted = only(seen, EventNames.PROJECT_DELETED);
    expect(deleted).toHaveLength(1);
    expect(Object.keys(deleted[0].data).sort()).toEqual(['movedToInbox', 'name', 'source']);
    expect(deleted[0].data).toEqual({ name: 'marina', source: 'ms-todo', movedToInbox: 0 });
    expect(only(seen, EventNames.TASK_UPDATED)).toHaveLength(0);
  });

  it('reports how many tasks fell back to Inbox, under the CANONICAL name', async () => {
    await addTask({ title: 'A', project: 'Marina' });
    await addTask({ title: 'B', project: 'Marina' });
    const seen = capture();

    await deleteProject('marina'); // different casing than the row

    const deleted = only(seen, EventNames.PROJECT_DELETED);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].data).toEqual({ name: 'Marina', source: 'local', movedToInbox: 2 });
  });

  it('does not fire for an unknown project (the throw happens first)', async () => {
    const seen = capture();
    await expect(deleteProject('nope')).rejects.toThrow(/^No project /);
    expect(only(seen, EventNames.PROJECT_DELETED)).toHaveLength(0);
  });
});

describe('ProjectUpdatedEvent shape', () => {
  it('carries the MERGED metadata blob, so a consumer needs no follow-up GET', async () => {
    await ensureProject('marina');
    await setProjectMetadata('marina', { default_cwd: '/tmp/marina' });
    const seen = capture();

    await setProjectMetadata('marina', { default_host: 'box' });

    const updated = only(seen, EventNames.PROJECT_UPDATED);
    expect(updated).toHaveLength(1);
    expect(Object.keys(updated[0].data).sort()).toEqual(['metadata', 'name']);
    expect(updated[0].data.name).toBe('marina');
    expect(updated[0].data.metadata).toEqual({ default_cwd: '/tmp/marina', default_host: 'box' });
    // …and it matches what a reader would fetch.
    expect(await getProjectMetadata('marina')).toEqual({ default_cwd: '/tmp/marina', default_host: 'box' });
  });

  it('announces a clear (undefined drops the key) rather than staying silent', async () => {
    await setProjectMetadata('marina', { default_cwd: '/tmp/marina' });
    const seen = capture();

    await setProjectMetadata('marina', { default_cwd: undefined });

    const updated = only(seen, EventNames.PROJECT_UPDATED);
    expect(updated).toHaveLength(1);
    expect(updated[0].data.metadata).toEqual({ default_cwd: undefined });
  });
});

describe('config:changed for the favorites / ordering migration', () => {
  it('emits the same keyed events the favorites and ordering routes emit', async () => {
    await ensureProject('marina');
    await ensureProject('acme');
    await updateConfig({
      favorites: { projects: ['marina'] },
      ordering: { projects: ['acme', 'marina'] },
    });
    const seen = capture();

    await renameProject('marina', 'marina-bay');

    // Both lists are keyed by project NAME, so both had to be rewritten — and a
    // client that never hears about it shows a hollow star and loses the slot.
    expect(changedKeys(seen).sort()).toEqual(['favorites', 'ordering']);
    const config = await getConfig();
    expect(config.favorites?.projects).toEqual(['marina-bay']);
    expect(config.ordering?.projects).toEqual(['acme', 'marina-bay']);
  });

  it('emits only for the list that actually mentioned the project', async () => {
    await ensureProject('marina');
    await updateConfig({ ordering: { projects: ['marina'] } });
    const seen = capture();

    await renameProject('marina', 'marina-bay');

    expect(changedKeys(seen)).toEqual(['ordering']);
  });

  it('stays silent when neither list mentions it (no config write, no event)', async () => {
    await ensureProject('marina');
    await updateConfig({ favorites: { projects: ['acme'] } });
    const seen = capture();

    await renameProject('marina', 'marina-bay');

    expect(changedKeys(seen)).toEqual([]);
  });

  it('drops the entry on delete, and says so', async () => {
    await ensureProject('marina');
    await updateConfig({
      favorites: { projects: ['marina'] },
      ordering: { projects: ['marina'] },
    });
    const seen = capture();

    await deleteProject('marina');

    expect(changedKeys(seen).sort()).toEqual(['favorites', 'ordering']);
    const config = await getConfig();
    expect(config.favorites?.projects).toEqual([]);
    expect(config.ordering?.projects).toEqual([]);
  });
});
