/**
 * Tests for toggleComplete() and slash-format parsing in addTask/updateTask.
 * Covers Fix 2 (toggle complete) and Fix 4 (slash parsing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, toggleComplete, completeTask, updateTask, linkSessionSlot, ActiveChildrenError } from '../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
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

// ── Fix 4: Slash format parsing ──

describe('addTask slash parsing', () => {
  it('parses "category / project" format into separate fields', async () => {
    const { task } = await addTask({ title: 'Parsed task', category: 'idea / work idea' });

    expect(task.category).toBe('Idea');
    expect(task.project).toBe('Work idea');
  });

  it('explicit project overrides parsed project', async () => {
    const { task } = await addTask({
      title: 'Override test',
      category: 'idea / work idea',
      project: 'custom project',
    });

    expect(task.category).toBe('Idea');
    expect(task.project).toBe('custom project');
  });

  it('plain category (no slash) is unchanged', async () => {
    const { task } = await addTask({ title: 'Plain cat', category: 'work' });

    expect(task.category).toBe('work');
    expect(task.project).toBe('work');
  });

  it('preserves exact spacing — only " / " is the separator', async () => {
    // Single slash without spaces should NOT be parsed
    const { task } = await addTask({ title: 'No parse', category: 'work/project' });
    expect(task.category).toBe('work/project');
    expect(task.project).toBe('work/project');
  });
});

describe('updateTask slash parsing', () => {
  it('splits "category / project" when project is not provided', async () => {
    const { task } = await addTask({ title: 'Update me', category: 'original' });

    const { task: updated } = await updateTask(task.id, {
      category: 'new cat / new proj',
    });

    expect(updated.category).toBe('New cat');
    expect(updated.project).toBe('New proj');
  });

  it('explicit project takes precedence even with slash category', async () => {
    const { task } = await addTask({ title: 'Explicit proj', category: 'original' });

    const { task: updated } = await updateTask(task.id, {
      category: 'new cat / new proj',
      project: 'override',
    });

    // When both category (with slash) and project are provided,
    // the explicit project is set AFTER slash parsing
    expect(updated.project).toBe('override');
  });

  it('plain category update (no slash) only changes category', async () => {
    const { task } = await addTask({ title: 'Plain update', category: 'old', project: 'my-project' });

    const { task: updated } = await updateTask(task.id, { category: 'new' });

    expect(updated.category).toBe('new');
    expect(updated.project).toBe('my-project'); // unchanged
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
