/**
 * Multi-select batch ops — setPhaseBulk / deleteTasksByIds.
 *
 * These back the Todo panel's multi-select bar ("Complete N" / "Delete N"), which
 * previously had NO complete/delete path at all — the batch dropdown only offered
 * pin/priority/date, so multi-select could not complete or delete anything.
 *
 * The invariant that matters most here is PARTIAL SUCCESS: the user picks N rows and
 * one un-completable task (active children) or busy task (active session) must skip
 * itself and be reported in `failed` — never void the other N-1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  getTask,
  listTasks,
  setPhaseBulk,
  deleteTasksByIds,
  groupTasks,
  listGroups,
  updateTaskRaw,
  linkSession,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function makeTasks(titles: string[], project = 'Marina'): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const { task } = await addTask({ title, project });
    ids.push(task.id);
  }
  return ids;
}

describe('setPhaseBulk', () => {
  it('completes every selected task in one call', async () => {
    const ids = await makeTasks(['A', 'B', 'C']);
    const { changed, failed } = await setPhaseBulk(ids, 'COMPLETE');

    expect(failed).toEqual([]);
    expect(changed).toHaveLength(3);
    for (const id of ids) {
      const t = await getTask(id);
      expect(t.phase).toBe('COMPLETE');
      expect(t.status).toBe('done');
      expect(t.completed_at).toBeTruthy();
    }
  });

  it('reopens done tasks back to TODO', async () => {
    const ids = await makeTasks(['A', 'B']);
    await setPhaseBulk(ids, 'COMPLETE');

    const { changed, failed } = await setPhaseBulk(ids, 'TODO');
    expect(failed).toEqual([]);
    expect(changed).toHaveLength(2);
    for (const id of ids) {
      const t = await getTask(id);
      expect(t.phase).toBe('TODO');
      expect(t.status).toBe('todo');
      expect(t.completed_at).toBeUndefined();
    }
  });

  it('keeps completed tasks pinned in place (auto-unpin removed 2026-08-26)', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    for (const [i, id] of [a, b, c].entries()) {
      await updateTaskRaw(id, { pinned: true, pin_order: i, focus_tier: 'focus' });
    }

    await setPhaseBulk([a, b], 'COMPLETE');

    // A pin is a manual placement: completing must not evict the card. The
    // done tasks keep their pin, tier, and order; the user unpins explicitly.
    for (const [i, id] of [a, b, c].entries()) {
      const t = await getTask(id);
      expect(t.pinned).toBe(true);
      expect(t.pin_order).toBe(i);
      expect(t.focus_tier).toBe('focus');
    }
  });

  it('skips a parent with active children but still completes the rest', async () => {
    const [parent, sibling] = await makeTasks(['Parent', 'Sibling']);
    const { task: child } = await addTask({ title: 'Child', project: 'Marina', parent_task_id: parent });

    const { changed, failed } = await setPhaseBulk([parent, sibling], 'COMPLETE');

    // Partial success: the sibling went through, the blocked parent is reported.
    expect(changed.map((t) => t.id)).toEqual([sibling]);
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(parent);
    expect(failed[0].error).toMatch(/child task/i);
    expect((await getTask(parent)).phase).not.toBe('COMPLETE');
    expect((await getTask(sibling)).phase).toBe('COMPLETE');
    expect((await getTask(child.id)).phase).not.toBe('COMPLETE');
  });

  it('completes a parent when its children are in the SAME batch', async () => {
    // Selecting a parent together with its children is the natural user intent —
    // the children are being completed too, so the guard must not fire.
    const [parent] = await makeTasks(['Parent']);
    const { task: child } = await addTask({ title: 'Child', project: 'Marina', parent_task_id: parent });

    const { changed, failed } = await setPhaseBulk([child.id, parent], 'COMPLETE');
    expect(failed).toEqual([]);
    expect(changed).toHaveLength(2);
    expect((await getTask(parent)).phase).toBe('COMPLETE');
    expect((await getTask(child.id)).phase).toBe('COMPLETE');
  });

  it('reports unknown ids without touching the valid ones', async () => {
    const [a] = await makeTasks(['A']);
    const { changed, failed } = await setPhaseBulk([a, 'does-not-exist'], 'COMPLETE');

    expect(changed.map((t) => t.id)).toEqual([a]);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/No task found/);
  });

  it('treats an already-in-phase task as a no-op, not a failure', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    await setPhaseBulk([a], 'COMPLETE');

    const { changed, failed } = await setPhaseBulk([a, b], 'COMPLETE');
    expect(failed).toEqual([]);
    // Only b actually changed; a was already COMPLETE.
    expect(changed.map((t) => t.id)).toEqual([b]);
  });

  it('is a no-op for an empty selection', async () => {
    const { changed, failed } = await setPhaseBulk([], 'COMPLETE');
    expect(changed).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('reports an external-sync failure in syncFailed, NOT in failed', async () => {
    // A plugin-sourced task with no plugin loaded: the local phase write commits, so
    // the task IS complete — only the push failed. Merging that into `failed` made a
    // fully-applied batch report total failure (caught in the E2E log: changed:3 AND
    // failed:3 for the same 3 tasks), which would roll back correct rows in the UI.
    const { task } = await addTask({ title: 'Synced task', project: 'Remote', source: 'ms-todo' });

    const { changed, failed, syncFailed } = await setPhaseBulk([task.id], 'COMPLETE');

    expect(changed.map((t) => t.id)).toEqual([task.id]);
    expect(failed).toEqual([]);
    expect(syncFailed).toHaveLength(1);
    expect(syncFailed[0].id).toBe(task.id);
    // The local write really did land.
    expect((await getTask(task.id)).phase).toBe('COMPLETE');
  });

  it('rejects an invalid phase', async () => {
    const [a] = await makeTasks(['A']);
    await expect(setPhaseBulk([a], 'NOPE' as never)).rejects.toThrow(/Invalid phase/);
  });
});

describe('deleteTasksByIds', () => {
  it('deletes every selected task in one call', async () => {
    const ids = await makeTasks(['A', 'B', 'C']);
    const { deleted, failed } = await deleteTasksByIds(ids);

    expect(failed).toEqual([]);
    expect(deleted).toHaveLength(3);
    expect(await listTasks()).toHaveLength(0);
  });

  it('deletes only the selected tasks, leaving the rest', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const { deleted } = await deleteTasksByIds([a, c]);

    expect(deleted).toHaveLength(2);
    const remaining = await listTasks();
    expect(remaining.map((t) => t.id)).toEqual([b]);
  });

  it('skips a task with an active session but still deletes the rest', async () => {
    const [busy, free] = await makeTasks(['Busy', 'Free']);
    await linkSession(busy, 'sess-batch-1');

    const { deleted, failed } = await deleteTasksByIds([busy, free]);

    expect(deleted.map((t) => t.id)).toEqual([free]);
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(busy);
    expect(failed[0].error).toMatch(/active session/i);
    // The busy task survives.
    expect((await listTasks()).map((t) => t.id)).toEqual([busy]);
  });

  it('reports unknown ids without touching the valid ones', async () => {
    const [a] = await makeTasks(['A']);
    const { deleted, failed } = await deleteTasksByIds([a, 'ghost-id']);

    expect(deleted.map((t) => t.id)).toEqual([a]);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/No task found/);
  });

  it('never prunes the folder — it survives even after every member is deleted', async () => {
    // The folder model: a folder is the user's structure, not a by-product of its
    // members. Batch-deleting the rows inside one must leave the (now empty)
    // folder in place; only an explicit deleteFolder removes it.
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g = await groupTasks([a, b, c], 'Cluster');

    // Deleting 2 of 3 leaves a lone member — still one folder.
    await deleteTasksByIds([a, b]);
    expect((await listGroups()).map((x) => x.member_ids)).toEqual([[c]]);

    // Deleting the last member empties it, but the folder row stays.
    await deleteTasksByIds([c]);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].group_id).toBe(g.group_id);
    expect(groups[0].label).toBe('Cluster');
    expect(groups[0].member_ids).toEqual([]);
  });

  it('is a no-op for an empty selection', async () => {
    await makeTasks(['A']);
    const { deleted, failed } = await deleteTasksByIds([]);
    expect(deleted).toEqual([]);
    expect(failed).toEqual([]);
    expect(await listTasks()).toHaveLength(1);
  });

  it('deduplicates repeated ids', async () => {
    const [a] = await makeTasks(['A']);
    const { deleted, failed } = await deleteTasksByIds([a, a]);
    expect(deleted).toHaveLength(1);
    expect(failed).toEqual([]);
  });
});
