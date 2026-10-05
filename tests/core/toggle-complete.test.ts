/**
 * Tests for toggleComplete() and slash-format parsing in addTask/updateTask.
 * Covers Fix 2 (toggle complete) and Fix 4 (slash parsing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import { removeTempTree } from '../helpers/temp-home.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, toggleComplete, completeTask, updateTask, linkSessionSlot, getTask, getChildTasks, setPhaseBulk, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await removeTempTree(WALNUT_HOME);
});

afterEach(async () => {
  // closeDb() before the rm so sqlite isn't still journaling into the tree
  // (a -wal/-shm file recreated mid-rimraf is an ENOTEMPTY source).
  closeDb();
  await removeTempTree(WALNUT_HOME);
});

// ── Fix 2: toggleComplete ──

describe('toggleComplete', () => {
  it('toggles a todo task to done', async () => {
    const { task } = await addTask({ title: 'Toggle me' });
    expect(task.status).toBe('todo');

    const { task: toggled } = await toggleComplete(task.id);
    expect(toggled.status).toBe('done');
  });

  it('toggles a done task back to todo', async () => {
    const { task } = await addTask({ title: 'Reopen me' });
    await completeTask(task.id);

    const { task: reopened } = await toggleComplete(task.id);
    expect(reopened.status).toBe('todo');
  });

  it('full cycle: todo → done → todo', async () => {
    const { task } = await addTask({ title: 'Full cycle' });
    expect(task.status).toBe('todo');

    const { task: done } = await toggleComplete(task.id);
    expect(done.status).toBe('done');

    const { task: reopened } = await toggleComplete(task.id);
    expect(reopened.status).toBe('todo');
  });

  it('clears session slots when completing', async () => {
    const { task } = await addTask({ title: 'Has session' });
    await linkSessionSlot(task.id, 'session-123', 'exec');

    const { task: completed } = await toggleComplete(task.id);
    expect(completed.status).toBe('done');
    expect(completed.plan_session_id).toBeUndefined();
    expect(completed.exec_session_id).toBeUndefined();
  });

  it('does NOT set session slots when reopening', async () => {
    const { task } = await addTask({ title: 'Reopen no session' });
    await linkSessionSlot(task.id, 'session-456', 'exec');
    await toggleComplete(task.id); // complete (clears sessions)

    const { task: reopened } = await toggleComplete(task.id);
    expect(reopened.status).toBe('todo');
    expect(reopened.plan_session_id).toBeUndefined();
    expect(reopened.exec_session_id).toBeUndefined();
  });

  it('updates the updated_at timestamp', async () => {
    const { task } = await addTask({ title: 'Timestamp test' });
    const original = task.updated_at;

    await new Promise((r) => setTimeout(r, 10));
    const { task: toggled } = await toggleComplete(task.id);
    expect(toggled.updated_at).not.toBe(original);
  });

  it('works with partial ID prefix', async () => {
    const { task } = await addTask({ title: 'Partial match' });
    const prefix = task.id.slice(0, 6);

    const { task: toggled } = await toggleComplete(prefix);
    expect(toggled.id).toBe(task.id);
    expect(toggled.status).toBe('done');
  });

  it('throws for non-existent ID', async () => {
    await expect(toggleComplete('nonexistent')).rejects.toThrow(/No task found/);
  });

  it('throws for ambiguous ID prefix', async () => {
    // Create two tasks — use full IDs to avoid ambiguity in creation
    const { task: t1 } = await addTask({ title: 'Task A' });
    const { task: t2 } = await addTask({ title: 'Task B' });

    // If both IDs start with the same char, this test verifies ambiguity handling
    // Since IDs are timestamp-based, they'll likely share a prefix
    const sharedPrefix = t1.id[0]; // first char only — very likely shared
    if (t2.id.startsWith(sharedPrefix)) {
      await expect(toggleComplete(sharedPrefix)).rejects.toThrow(/Ambiguous/);
    }
  });
});

// ── Project field: no more slash splitting ──
//
// addTask/updateTask used to split a `category` of the form "Cat / Proj" into two
// fields (the old MS To-Do list-name encoding). With Project as the only grouping
// layer that parsing is gone from the write path; the legacy list name is decoded
// on the SYNC PULL side only (parseProjectFromListName — tests/utils/format.test.ts).
// A NEW name containing '/' is now REJECTED outright (it would become a
// filesystem path segment — see assertValidProjectName) rather than silently
// split — either way, no write path ever reinterprets the separator.

describe('project field is stored verbatim', () => {
  it('rejects a " / " name instead of splitting it', async () => {
    await expect(addTask({ title: 'No parse', project: 'idea / work idea' }))
      .rejects.toThrow(/path separators/);
  });

  it('trims but otherwise preserves the project name on update', async () => {
    const { task } = await addTask({ title: 'Update me', project: 'original' });

    const { task: updated } = await updateTask(task.id, { project: '  my-project  ' });
    expect(updated.project).toBe('my-project');
  });

  it('leaves the project untouched when the update does not mention it', async () => {
    const { task } = await addTask({ title: 'Plain update', project: 'my-project' });

    const { task: updated } = await updateTask(task.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    expect(updated.project).toBe('my-project');
  });
});

// ── Open subtasks never block a completion ──

describe('completing a parent with open subtasks', () => {
  it('completeTask completes the parent and leaves the open child untouched', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    await updateTask(child.id, { phase: 'IN_PROGRESS' });

    const { task: completed } = await completeTask(parent.id);
    expect(completed.phase).toBe('COMPLETE');
    const after = await getTask(child.id);
    expect(after.phase).toBe('IN_PROGRESS');
    expect(after.parent_task_id).toBe(parent.id);
  });

  it('toggleComplete completes a parent with two open children, and toggles it back', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child A', parent_task_id: parent.id });
    await addTask({ title: 'Child B', parent_task_id: parent.id });

    expect((await toggleComplete(parent.id)).task.phase).toBe('COMPLETE');
    expect((await toggleComplete(parent.id)).task.phase).toBe('TODO');
    expect((await toggleComplete(parent.id)).task.phase).toBe('COMPLETE');
    const children = (await getChildTasks(parent.id)).map((t) => t.phase);
    expect(children).toEqual(['TODO', 'TODO']);
  });

  it('updateTask with phase=COMPLETE completes a parent whose child waits on the user', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    await updateTask(child.id, { phase: 'NEED_ACTION' });

    const { task: updated } = await updateTask(parent.id, { phase: 'COMPLETE' });
    expect(updated.phase).toBe('COMPLETE');
    expect((await getTask(child.id)).phase).toBe('NEED_ACTION');
  });

  it('updateTask with status=done completes a parent with an open child', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });

    const { task: updated } = await updateTask(parent.id, { status: 'done' });
    expect(updated.phase).toBe('COMPLETE');
  });

  it('setPhaseBulk completes a parent whose children are not in the batch', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    const { task: other } = await addTask({ title: 'Other' });

    const result = await setPhaseBulk([parent.id, other.id], 'COMPLETE');
    expect(result.failed).toEqual([]);
    expect(result.changed.map((t) => t.id).sort()).toEqual([parent.id, other.id].sort());
    expect((await getTask(child.id)).phase).toBe('TODO');
  });

  it('a parent with a Unicode title and many open children completes', async () => {
    // Test data: a CJK title (escaped) like the real recurring-digest worker.
    const { task: parent } = await addTask({ title: '\u6bcf\u65e5\u6458\u8981 leader' });
    for (let i = 0; i < 12; i++) await addTask({ title: `Worker ${i}`, parent_task_id: parent.id });

    const { task: completed } = await completeTask(parent.id);
    expect(completed.phase).toBe('COMPLETE');
    expect((await getChildTasks(parent.id)).filter((t) => t.phase !== 'COMPLETE')).toHaveLength(12);
  });

  it('allows completing a task with no children', async () => {
    const { task } = await addTask({ title: 'No children' });

    const { task: completed } = await completeTask(task.id);
    expect(completed.phase).toBe('COMPLETE');
  });

  it('non-COMPLETE phases on a parent with open children still work', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });

    const { task: updated } = await updateTask(parent.id, { phase: 'IN_PROGRESS' });
    expect(updated.phase).toBe('IN_PROGRESS');
  });
});
