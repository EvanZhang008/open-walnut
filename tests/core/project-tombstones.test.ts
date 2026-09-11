/**
 * Project tombstone / redirect ledger — a deleted project must not grow back
 * under its old name from ANY writer.
 *
 * The incident this pins (2026-09-08): "Fix Walnut" was deleted at 21:15 and a
 * provider full reconcile re-created it at 21:21 from the surviving remote list
 * of the same name, importing a stray fixture task into it. Dropping the registry
 * row was never a durable delete — every writer that names a project mints one.
 *
 * Covered here, one case per writer:
 *   - the ledger itself (record / lookup by name and by container id / clear)
 *   - resolveProjectWrite (live row wins, redirect chains, cycles, Unicode case)
 *   - ensureProject          (the sync-pull + generic choke point)
 *   - addTask                ("task_create with a project string")
 *   - updateTask             (a move onto a deleted project)
 *   - addTaskFull            (the delta-pull create path)
 *   - addTasksBulk via the reconciler's ensureProject gate (see the reconciler test)
 *   - rename / merge         (tombstone with redirect_to = survivor)
 *   - cascade delete         (provider container gone, tombstone still written)
 *   - the human door back    (ensureProject { human: true } clears it)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-tombstones'));

import {
  addTask,
  addTaskFull,
  addTasksBulk,
  deleteProject,
  deleteProjectCascade,
  ensureProject,
  getProjectRecord,
  getStoreProjects,
  getTask,
  listTasks,
  renameProject,
  resolveProjectForWrite,
  updateTask,
  updateTaskRaw,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import {
  clearProjectTombstone,
  findProjectTombstoneByRemoteListId,
  getProjectTombstone,
  listProjectTombstones,
  recordProjectTombstone,
  resolveProjectWrite,
  type ProjectTombstone,
} from '../../src/core/project-tombstones.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createMockPlugin, createNoopSync } from './plugin-test-utils.js';
import type { Task } from '../../src/core/types.js';

/** Register (or re-arm) a fake provider plugin that claims every project. */
function registerProvider(id: string, opts: {
  deleteProjectRemote?: (args: { project: string; remoteList?: string; tasks: Task[] }) =>
    Promise<{ outcome: 'container-deleted' } | { outcome: 'grouping-removed'; fallbackProject: string }>;
} = {}) {
  const sync = createNoopSync();
  if (opts.deleteProjectRemote) sync.deleteProjectRemote = opts.deleteProjectRemote;
  if (registry.has(id)) {
    (registry.get(id) as { sync: typeof sync }).sync = sync;
  } else {
    registry.register(id, createMockPlugin({ id, sync }));
  }
  return sync;
}

async function freshHome(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

beforeEach(freshHome);
afterEach(freshHome);

// ── The ledger ───────────────────────────────────────────────────────────────

describe('the ledger', () => {
  it('records, finds (case-insensitively, Unicode included) and clears', async () => {
    await ensureProject('Marina');            // opens the DB
    recordProjectTombstone({ name: 'Ärger', source: 'local', reason: 'deleted' });

    expect(getProjectTombstone('ärger')?.name).toBe('Ärger');
    expect(getProjectTombstone('ÄRGER')?.name).toBe('Ärger');
    expect(getProjectTombstone('Marina')).toBeUndefined();

    expect(clearProjectTombstone('ärger')).toBe(true);
    expect(getProjectTombstone('Ärger')).toBeUndefined();
    expect(clearProjectTombstone('Ärger')).toBe(false);
  });

  it('accumulates container ids across repeated removals instead of forgetting them', async () => {
    await ensureProject('Marina');
    recordProjectTombstone({ name: 'Gone', source: 'ms-todo', remoteListIds: ['list-1'] });
    recordProjectTombstone({ name: 'Gone', source: 'ms-todo', remoteListIds: ['list-2'] });

    expect(getProjectTombstone('Gone')!.remote_list_ids.sort()).toEqual(['list-1', 'list-2']);
    expect(findProjectTombstoneByRemoteListId('ms-todo', 'list-1')?.name).toBe('Gone');
    expect(findProjectTombstoneByRemoteListId('ms-todo', 'list-3')).toBeUndefined();
  });

  it('answers a container-id lookup for a LOCALLY-claimed project too (the 2026-09-08 shape)', async () => {
    await ensureProject('Marina');
    recordProjectTombstone({ name: 'Fixtures', source: 'local', remoteListIds: ['leaked-list'] });
    expect(findProjectTombstoneByRemoteListId('ms-todo', 'leaked-list')?.name).toBe('Fixtures');
  });

  it('never stores a self-redirect (it would be a permanent no-op loop)', async () => {
    await ensureProject('Marina');
    recordProjectTombstone({ name: 'Loop', redirectTo: 'loop' });
    expect(getProjectTombstone('Loop')!.redirect_to).toBeNull();
  });

  it('keeps ONE row per project when the spelling changes', async () => {
    await ensureProject('Marina');
    recordProjectTombstone({ name: 'Alpha' });
    recordProjectTombstone({ name: 'ALPHA' });
    expect(listProjectTombstones().filter((t) => t.name.toLowerCase() === 'alpha')).toHaveLength(1);
  });
});

// ── The pure resolver ────────────────────────────────────────────────────────

describe('resolveProjectWrite', () => {
  const live = (...names: string[]) => (n: string) =>
    names.find((v) => v.toLowerCase() === n.trim().toLowerCase());
  const ledger = (rows: Array<Partial<ProjectTombstone> & { name: string }>) => (n: string) =>
    rows.find((r) => r.name.toLowerCase() === n.trim().toLowerCase()) as ProjectTombstone | undefined;

  it('lets Inbox through untouched', () => {
    expect(resolveProjectWrite('', live(), ledger([]))).toEqual({ kind: 'ok', name: '' });
  });

  it('a LIVE row wins over a tombstone (that is what re-creating a project does)', () => {
    const d = resolveProjectWrite('Marina', live('Marina'), ledger([{ name: 'Marina', redirect_to: null }]));
    expect(d).toEqual({ kind: 'ok', name: 'Marina' });
  });

  it('blocks a deleted name with no survivor', () => {
    expect(resolveProjectWrite('Gone', live(), ledger([{ name: 'Gone', redirect_to: null }])))
      .toEqual({ kind: 'blocked', from: 'Gone' });
  });

  it('follows a redirect chain to the first LIVE row', () => {
    const d = resolveProjectWrite('A', live('C'), ledger([
      { name: 'A', redirect_to: 'B' }, { name: 'B', redirect_to: 'C' },
    ]));
    expect(d).toEqual({ kind: 'redirect', name: 'C', from: 'A' });
  });

  it('blocks when the chain dead-ends on a survivor that was itself deleted', () => {
    const d = resolveProjectWrite('A', live(), ledger([
      { name: 'A', redirect_to: 'B' }, { name: 'B', redirect_to: null },
    ]));
    expect(d).toEqual({ kind: 'blocked', from: 'A' });
  });

  it('terminates on a redirect cycle instead of looping', () => {
    const d = resolveProjectWrite('A', live(), ledger([
      { name: 'A', redirect_to: 'B' }, { name: 'B', redirect_to: 'A' },
    ]));
    expect(d).toEqual({ kind: 'blocked', from: 'A' });
  });

  it('mints a rename target that was never used (no row, no tombstone)', () => {
    const d = resolveProjectWrite('A', live(), ledger([{ name: 'A', redirect_to: 'Fresh' }]));
    expect(d).toEqual({ kind: 'redirect', name: 'Fresh', from: 'A' });
  });
});

// ── Every writer ─────────────────────────────────────────────────────────────

describe('writers cannot resurrect a deleted project', () => {
  it('ensureProject (the sync-pull path) files into Inbox and does not mint a row', async () => {
    await ensureProject('Fix Walnut', 'local');
    await deleteProject('Fix Walnut');

    const again = await ensureProject('Fix Walnut', 'ms-todo', { writer: 'ms-todo-pull' });
    expect(again).toMatchObject({ name: '', blocked: true, created: false });
    expect(Object.keys(await getStoreProjects())).not.toContain('Fix Walnut');
  });

  it('addTask (task_create with a project string) files the task in the Inbox', async () => {
    await ensureProject('Fix Walnut');
    await deleteProject('Fix Walnut');

    const { task } = await addTask({ title: 'quick-start task', project: 'Fix Walnut' });
    expect(task.project).toBe('');
    expect(task.source).toBe('local');
    expect(Object.keys(await getStoreProjects())).not.toContain('Fix Walnut');
  });

  it('addTask still 400s (InvalidProjectNameError) on a malformed name — the gate order is preserved', async () => {
    await expect(addTask({ title: 'x', project: '../escape' })).rejects.toThrow(/path separators/);
  });

  it('addTask refuses a PROVIDER task naming a deleted project, naming the reason', async () => {
    registerProvider('prov-a');
    await ensureProject('Synced', 'prov-a');
    await deleteProject('Synced');

    await expect(addTask({ title: 'pulled', project: 'Synced', source: 'prov-a' }))
      .rejects.toThrow(/that project was deleted/);
  });

  it('updateTask keeps the task where it is rather than dropping it into Inbox', async () => {
    await ensureProject('Keep');
    await ensureProject('Gone');
    const { task } = await addTask({ title: 'T', project: 'Keep' });
    await deleteProject('Gone');

    await updateTask(task.id, { project: 'Gone' });
    expect((await getTask(task.id))!.project).toBe('Keep');
    expect(Object.keys(await getStoreProjects())).not.toContain('Gone');
  });

  it('addTaskFull (the delta-pull create) refuses instead of minting the row', async () => {
    registerProvider('prov-b');
    await ensureProject('Pulled', 'prov-b');
    await deleteProject('Pulled');

    await expect(addTaskFull({
      title: 'A8 probe plain', project: 'Pulled', source: 'prov-b',
      status: 'todo', phase: 'TODO', priority: 'none',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      session_ids: [], description: '', summary: '', note: '',
    } as unknown as Omit<Task, 'id'>)).rejects.toThrow(/deleted project/);
    expect(Object.keys(await getStoreProjects())).not.toContain('Pulled');
  });

  it('a task already parked in the deleted project is untouched by later writers', async () => {
    await ensureProject('Gone');
    const { task } = await addTask({ title: 'T', project: 'Gone' });
    await deleteProject('Gone');
    // The delete itself moved it to Inbox; nothing re-files it later.
    expect((await getTask(task.id))!.project).toBe('');
    await ensureProject('Gone', 'local', { writer: 'later-writer' });
    expect((await getTask(task.id))!.project).toBe('');
  });

  it('the empty project (Inbox) can never be tombstoned', async () => {
    await ensureProject('Marina');
    await expect(deleteProject('')).rejects.toThrow(/Inbox is not a project/);
    expect(recordProjectTombstone({ name: '   ' })).toBe(false);
    expect(await resolveProjectForWrite('')).toEqual({ name: '', blocked: false });
  });
});

// ── Rename / merge follow forward ────────────────────────────────────────────

describe('rename and merge redirect instead of blocking', () => {
  it('a plain rename sends later writers to the new name', async () => {
    await ensureProject('Old Name');
    await addTask({ title: 'T', project: 'Old Name' });
    await renameProject('Old Name', 'New Name');

    expect(getProjectTombstone('Old Name')).toMatchObject({ redirect_to: 'New Name', reason: 'renamed' });
    const ensured = await ensureProject('Old Name', 'local', { writer: 'pull' });
    expect(ensured).toMatchObject({ name: 'New Name', redirectedFrom: 'Old Name' });

    const { task } = await addTask({ title: 'from a stale writer', project: 'Old Name' });
    expect(task.project).toBe('New Name');
  });

  it('a merge redirects to the survivor', async () => {
    await ensureProject('Alpha');
    await ensureProject('Beta');
    await renameProject('Alpha', 'Beta');

    expect(getProjectTombstone('Alpha')).toMatchObject({ redirect_to: 'Beta', reason: 'merged' });
    const { task } = await addTask({ title: 'T', project: 'alpha' });
    expect(task.project).toBe('Beta');
  });

  it('deleting the survivor afterwards blocks the whole chain', async () => {
    await ensureProject('Alpha');
    await renameProject('Alpha', 'Beta');
    await deleteProject('Beta');

    const { task } = await addTask({ title: 'T', project: 'Alpha' });
    expect(task.project).toBe('');
  });

  it('a rename ONTO a deleted name re-opens it (a rename is a human gesture)', async () => {
    await ensureProject('Retired');
    await deleteProject('Retired');
    await ensureProject('Working');

    await renameProject('Working', 'Retired');
    expect(getProjectTombstone('Retired')).toBeUndefined();
    expect((await getProjectRecord('Retired'))?.name).toBe('Retired');
  });
});

// ── The door back ────────────────────────────────────────────────────────────

describe('the human door back', () => {
  it('ensureProject({ human: true }) clears the tombstone and re-creates the row', async () => {
    await ensureProject('Fix Walnut');
    await deleteProject('Fix Walnut');

    const created = await ensureProject('Fix Walnut', 'local', { human: true });
    expect(created).toMatchObject({ name: 'Fix Walnut', created: true });
    expect(getProjectTombstone('Fix Walnut')).toBeUndefined();

    // …and from then on ordinary writers work again.
    const { task } = await addTask({ title: 'T', project: 'Fix Walnut' });
    expect(task.project).toBe('Fix Walnut');
  });

  it('a NON-human ensureProject does not clear it, however many times it is called', async () => {
    await ensureProject('Fix Walnut');
    await deleteProject('Fix Walnut');
    for (let i = 0; i < 3; i++) await ensureProject('Fix Walnut', 'ms-todo', { writer: 'pull' });
    expect(getProjectTombstone('Fix Walnut')).toBeDefined();
    expect(Object.keys(await getStoreProjects())).not.toContain('Fix Walnut');
  });
});

// ── Container ids recorded on delete ────────────────────────────────────────

describe('remote container ids are recorded, so a remote RENAME cannot slip past', () => {
  it('plain delete records the container ids of the project’s tasks', async () => {
    registerProvider('prov-c');
    await ensureProject('Synced', 'prov-c');
    const { task } = await addTask({ title: 'T', project: 'Synced', source: 'prov-c' });
    await updateTaskRaw(task.id, { ext: { 'prov-c': { id: 'item-1', list_id: 'remote-list-1' } } } as Partial<Task>);

    await deleteProject('Synced');
    expect(getProjectTombstone('Synced')!.remote_list_ids).toEqual(['remote-list-1']);
    expect(findProjectTombstoneByRemoteListId('prov-c', 'remote-list-1')?.name).toBe('Synced');
  });

  it('cascade delete tombstones too (a re-created remote list must not bring it back)', async () => {
    registerProvider('prov-d', { deleteProjectRemote: async () => ({ outcome: 'container-deleted' }) });
    await ensureProject('Cascaded', 'prov-d');
    const { task } = await addTask({ title: 'T', project: 'Cascaded', source: 'prov-d' });
    await updateTaskRaw(task.id, { ext: { 'prov-d': { id: 'i', list_id: 'cascade-list' } } } as Partial<Task>);

    const result = await deleteProjectCascade('Cascaded');
    expect(result.remoteDeleted).toBe(true);
    const tomb = getProjectTombstone('Cascaded')!;
    expect(tomb.redirect_to).toBeNull();
    expect(tomb.remote_list_ids).toContain('cascade-list');
    // The pull path's cheap id check sees it even under a new display name.
    expect(findProjectTombstoneByRemoteListId('prov-d', 'cascade-list')?.name).toBe('Cascaded');
  });

  it('a grouping-removed cascade REDIRECTS to the fallback project instead of blocking', async () => {
    registerProvider('prov-e', {
      deleteProjectRemote: async () => ({ outcome: 'grouping-removed', fallbackProject: 'Survivor' }),
    });
    await ensureProject('Grouped', 'prov-e');
    await addTask({ title: 'T', project: 'Grouped', source: 'prov-e' });

    await deleteProjectCascade('Grouped');
    expect(getProjectTombstone('Grouped')!.redirect_to).toBe('Survivor');
    const ensured = await ensureProject('Grouped', 'prov-e', { writer: 'pull' });
    expect(ensured).toMatchObject({ name: 'Survivor', redirectedFrom: 'Grouped' });
  });
});

// ── The bulk pull path ──────────────────────────────────────────────────────

describe('addTasksBulk (the reconciler’s write path)', () => {
  it('writes rows into a deleted project only if some other writer minted it', async () => {
    await ensureProject('Gone');
    await deleteProject('Gone');
    // The reconciler resolves the project through ensureProject BEFORE the bulk
    // insert (see sync-reconciler.applyDiff); that resolution is what refuses.
    const ensured = await ensureProject('Gone', 'local', { writer: 'reconcile' });
    expect(ensured.blocked).toBe(true);

    // A caller that ignored the gate and wrote the raw column still cannot bring
    // the registry row back — nothing in the bulk path mints one.
    await addTasksBulk([{
      title: 'raw', project: 'Gone', source: 'local', status: 'todo', phase: 'TODO',
      priority: 'none', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as unknown as Omit<Task, 'id'>]);
    expect(Object.keys(await getStoreProjects())).not.toContain('Gone');
    expect((await listTasks()).some((t) => t.title === 'raw')).toBe(true);
  });
});
