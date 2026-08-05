/**
 * Tests for toggleComplete() and slash-format parsing in addTask/updateTask.
 * Covers Fix 2 (toggle complete) and Fix 4 (slash parsing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import { removeTempTree } from '../helpers/temp-home.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, toggleComplete, completeTask, updateTask, linkSessionSlot, ActiveChildrenError, _resetForTesting } from '../../src/core/task-manager.js';
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

// ── Active children guard ──

describe('active children guard', () => {
  it('completeTask blocks when child is active', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });

    await expect(completeTask(parent.id)).rejects.toThrow(ActiveChildrenError);
    await expect(completeTask(parent.id)).rejects.toThrow(/1 child task/);
  });

  it('toggleComplete blocks when child is active', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child A', parent_task_id: parent.id });
    await addTask({ title: 'Child B', parent_task_id: parent.id });

    await expect(toggleComplete(parent.id)).rejects.toThrow(ActiveChildrenError);
    await expect(toggleComplete(parent.id)).rejects.toThrow(/2 child task/);
  });

  it('updateTask with phase=COMPLETE blocks when child is active', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });

    await expect(updateTask(parent.id, { phase: 'COMPLETE' })).rejects.toThrow(ActiveChildrenError);
  });

  it('updateTask with status=done blocks when child is active', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });

    await expect(updateTask(parent.id, { status: 'done' })).rejects.toThrow(ActiveChildrenError);
  });

  it('allows completing parent after all children are complete', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });

    await completeTask(child.id);

    const { task: completed } = await completeTask(parent.id);
    expect(completed.phase).toBe('COMPLETE');
  });

  it('allows completing a task with no children', async () => {
    const { task } = await addTask({ title: 'No children' });

    const { task: completed } = await completeTask(task.id);
    expect(completed.phase).toBe('COMPLETE');
  });

  it('toggleComplete allows reopening a completed parent', async () => {
    // Setup: parent with completed child, both completed
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    await completeTask(child.id);
    await completeTask(parent.id);

    // Reopen should work (toggle from COMPLETE → TODO, no guard needed)
    const { task: reopened } = await toggleComplete(parent.id);
    expect(reopened.phase).toBe('TODO');
  });

  it('error message includes child task titles', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Fix login bug', parent_task_id: parent.id });

    try {
      await completeTask(parent.id);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ActiveChildrenError);
      expect((err as Error).message).toContain('Fix login bug');
    }
  });

  it('non-COMPLETE phases on parent are allowed even with active children', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    await addTask({ title: 'Child', parent_task_id: parent.id });

    // Setting to IN_PROGRESS should work fine
    const { task: updated } = await updateTask(parent.id, { phase: 'IN_PROGRESS' });
    expect(updated.phase).toBe('IN_PROGRESS');
  });
});
