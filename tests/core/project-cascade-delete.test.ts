/**
 * deleteProjectCascade — the provider-claimed project delete path.
 *
 * Contract under test (see IntegrationSync.deleteProjectRemote):
 *  - local-source project → plain deleteProject, no plugin involved
 *  - claimed + plugin has NO hook → ProjectRemoteDeleteUnsupportedError, nothing changes
 *  - hook throws → cascade aborts BEFORE any local mutation (remote-first ordering)
 *  - { outcome: 'container-deleted' } → tasks detach (source='local', ext cleared,
 *    project='' = Inbox) and the registry row is dropped
 *  - { outcome: 'grouping-removed', fallbackProject } → tasks move to the fallback
 *    project KEEPING their provider binding; the fallback row is ensured with the
 *    same claim; an empty fallbackProject is a contract bug and aborts pre-mutation
 *  - the hook receives the project's tasks with ext intact + the registry's
 *    remote_list alias, so the plugin can tombstone / find the container
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-cascade'));

import {
  addTask,
  updateTaskRaw,
  getTask,
  ensureProject,
  getProjectRecord,
  setProjectMetadata,
  deleteProjectCascade,
  ProjectRemoteDeleteUnsupportedError,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createMockPlugin, createNoopSync } from './plugin-test-utils.js';
import type { Task } from '../../src/core/types.js';

type DeleteHookArgs = { project: string; remoteList?: string; tasks: Task[] };
type DeleteHookResult =
  | { outcome: 'container-deleted' }
  | { outcome: 'grouping-removed'; fallbackProject: string };

function registerPlugin(
  id: string,
  deleteProjectRemote?: (args: DeleteHookArgs) => Promise<DeleteHookResult>,
) {
  const sync = createNoopSync();
  if (deleteProjectRemote) sync.deleteProjectRemote = deleteProjectRemote;
  if (registry.has(id)) {
    // Same registry instance persists across tests in a file — swap the sync.
    (registry.get(id) as { sync: typeof sync }).sync = sync;
  } else {
    registry.register(id, createMockPlugin({ id, sync }));
  }
  return sync;
}

/** Create a task claimed by `source`, optionally with ext (simulating a synced twin). */
async function addClaimedTask(
  title: string,
  project: string,
  source: string,
  ext?: Record<string, unknown>,
): Promise<Task> {
  const { task } = await addTask({ title, project, source: source as Task['source'] });
  if (ext) await updateTaskRaw(task.id, { ext } as Partial<Task>);
  return (await getTask(task.id))!;
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('deleteProjectCascade', () => {
  it('local project → plain delete, remoteDeleted false, tasks to Inbox', async () => {
    const { task } = await addTask({ title: 'a', project: 'LocalProj' });
    const result = await deleteProjectCascade('LocalProj');
    expect(result.remoteDeleted).toBe(false);
    expect(result.source).toBe('local');
    expect(await getProjectRecord('LocalProj')).toBeNull();
    expect((await getTask(task.id))?.project).toBe('');
  });

  it('claimed project without hook → ProjectRemoteDeleteUnsupportedError, nothing changes', async () => {
    registerPlugin('no-hook-plugin');
    await ensureProject('Claimed', 'no-hook-plugin');
    const t = await addClaimedTask('a', 'Claimed', 'no-hook-plugin');
    await expect(deleteProjectCascade('Claimed')).rejects.toBeInstanceOf(
      ProjectRemoteDeleteUnsupportedError,
    );
    expect(await getProjectRecord('Claimed')).not.toBeNull();
    expect((await getTask(t.id))?.project).toBe('Claimed');
  });

  it('hook throw aborts the cascade with local state untouched', async () => {
    registerPlugin('failing-plugin', async () => {
      throw new Error('remote unavailable');
    });
    await ensureProject('Doomed', 'failing-plugin');
    const t = await addClaimedTask('a', 'Doomed', 'failing-plugin', { x: { id: 'r1' } });
    await expect(deleteProjectCascade('Doomed')).rejects.toThrow('remote unavailable');
    expect(await getProjectRecord('Doomed')).not.toBeNull();
    const after = await getTask(t.id);
    expect(after?.project).toBe('Doomed');
    expect(after?.source).toBe('failing-plugin');
    expect(after?.ext).toBeTruthy();
  });

  it('container-deleted → tasks detach to local + Inbox, ext cleared, row dropped', async () => {
    const hook = vi.fn(async (): Promise<DeleteHookResult> => ({ outcome: 'container-deleted' }));
    registerPlugin('list-plugin', hook);
    await ensureProject('OldList', 'list-plugin');
    const t1 = await addClaimedTask('a', 'OldList', 'list-plugin', { x: { id: 'r1' } });
    const t2 = await addClaimedTask('b', 'OldList', 'list-plugin', { x: { id: 'r2' } });

    const result = await deleteProjectCascade('OldList');
    expect(result).toMatchObject({ remoteDeleted: true, source: 'list-plugin', movedToInbox: 2 });
    expect(result.movedToProject).toBeUndefined();
    expect(await getProjectRecord('OldList')).toBeNull();
    for (const id of [t1.id, t2.id]) {
      const after = await getTask(id);
      expect(after?.project).toBe('');
      expect(after?.source).toBe('local');
      expect(after?.ext).toBeUndefined();
      expect(after?.sync_error).toBeUndefined();
    }
  });

  it('grouping-removed → tasks move to fallback keeping binding; fallback row ensured', async () => {
    registerPlugin('tag-plugin', async () => ({
      outcome: 'grouping-removed',
      fallbackProject: 'Fallback',
    }));
    await ensureProject('TagProj', 'tag-plugin');
    const t = await addClaimedTask('a', 'TagProj', 'tag-plugin', { x: { id: 'r1' } });

    const result = await deleteProjectCascade('TagProj');
    expect(result).toMatchObject({ remoteDeleted: true, source: 'tag-plugin', movedToInbox: 0 });
    expect(result.movedToProject).toEqual({ project: 'Fallback', count: 1 });
    expect(await getProjectRecord('TagProj')).toBeNull();

    const fallbackRow = await getProjectRecord('Fallback');
    expect(fallbackRow?.source).toBe('tag-plugin');

    const after = await getTask(t.id);
    expect(after?.project).toBe('Fallback');
    expect(after?.source).toBe('tag-plugin'); // binding kept — remote twin survives
    expect(after?.ext).toBeTruthy();
  });

  it('grouping-removed reuses an existing fallback row canonical casing', async () => {
    registerPlugin('tag-plugin2', async () => ({
      outcome: 'grouping-removed',
      fallbackProject: 'fallback', // lower-case from the plugin
    }));
    await ensureProject('Fallback', 'tag-plugin2'); // canonical row already exists
    await ensureProject('TagProj2', 'tag-plugin2');
    const t = await addClaimedTask('a', 'TagProj2', 'tag-plugin2');

    const result = await deleteProjectCascade('TagProj2');
    expect(result.movedToProject?.project).toBe('Fallback');
    expect((await getTask(t.id))?.project).toBe('Fallback');
  });

  it('grouping-removed with empty fallbackProject is a contract bug — aborts pre-mutation', async () => {
    registerPlugin('bad-plugin', async () => ({
      outcome: 'grouping-removed',
      fallbackProject: '  ',
    }));
    await ensureProject('BadProj', 'bad-plugin');
    const t = await addClaimedTask('a', 'BadProj', 'bad-plugin');
    await expect(deleteProjectCascade('BadProj')).rejects.toThrow(/fallbackProject/);
    expect(await getProjectRecord('BadProj')).not.toBeNull();
    expect((await getTask(t.id))?.project).toBe('BadProj');
  });

  it('hook receives tasks with ext intact and the registry remote_list alias', async () => {
    const hook = vi.fn(async (): Promise<DeleteHookResult> => ({ outcome: 'container-deleted' }));
    registerPlugin('inspect-plugin', hook);
    await ensureProject('Aliased', 'inspect-plugin');
    await setProjectMetadata('Aliased', { remote_list: 'Legacy / Aliased' });
    await addClaimedTask('a', 'Aliased', 'inspect-plugin', { x: { id: 'r1' } });

    await deleteProjectCascade('Aliased');
    expect(hook).toHaveBeenCalledTimes(1);
    const args = hook.mock.calls[0][0] as unknown as DeleteHookArgs;
    expect(args.project).toBe('Aliased');
    expect(args.remoteList).toBe('Legacy / Aliased');
    expect(args.tasks).toHaveLength(1);
    expect(args.tasks[0].ext).toEqual({ x: { id: 'r1' } });
  });

  it('rejects Inbox and unknown projects', async () => {
    await expect(deleteProjectCascade('')).rejects.toThrow(/Inbox/);
    await expect(deleteProjectCascade('NoSuch')).rejects.toThrow(/No project/);
  });
});
