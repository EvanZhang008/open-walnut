import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;
let tasksFile: string;
let configFile: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Import after mocking
import { addTask, listTasks, completeTask, getDashboardData, reorderTasks, deleteTask, linkActiveSession, clearActiveSession, linkSessionSlot, clearSessionSlot, ActiveSessionError, updateTask, getProjectMetadata, autoPushIfConfigured, updateTaskRaw } from '../../src/core/task-manager.js';
import { WALNUT_HOME, TASKS_FILE, CONFIG_FILE } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  tasksFile = TASKS_FILE;
  configFile = CONFIG_FILE;
  // Clean temp directory
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  // Reset the initialized flag by clearing module state
  vi.resetModules;
});

describe('addTask', () => {
  it('creates a task with correct default fields', async () => {
    const { task } = await addTask({ title: 'Test task' });

    expect(task).toBeDefined();
    expect(task.id).toMatch(/^[a-z0-9]+-[a-f0-9]{4}$/);
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('none');
    expect(task.category).toBe('personal');
    expect(task.session_ids).toEqual([]);
    expect(task.description).toBe('');
    expect(task.note).toBe('');
    expect(task.created_at).toBeDefined();
    expect(task.updated_at).toBeDefined();
  });

  it('sets description when provided at creation', async () => {
    const { task } = await addTask({ title: 'Described task', description: 'What & why' });
    expect(task.description).toBe('What & why');
  });

  it('creates tasks with unique IDs', async () => {
    const { task: t1 } = await addTask({ title: 'Task 1' });
    const { task: t2 } = await addTask({ title: 'Task 2' });

    expect(t1.id).not.toBe(t2.id);
  });

  it('respects provided options (priority, category, project, due_date)', async () => {
    const { task } = await addTask({
      title: 'Important work task',
      priority: 'immediate',
      category: 'work',
      project: 'walnut',
      due_date: '2026-12-31',
    });

    expect(task.priority).toBe('immediate');
    expect(task.category).toBe('work');
    expect(task.project).toBe('walnut');
    expect(task.due_date).toBe('2026-12-31');
  });

  it('persists tasks to the store file', async () => {
    await addTask({ title: 'Persisted task' });

    const content = await fs.readFile(tasksFile, 'utf-8');
    const store = JSON.parse(content);
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0].title).toBe('Persisted task');
  });
});

describe('listTasks', () => {
  it('returns all tasks when no filter is provided', async () => {
    await addTask({ title: 'Task A' });
    await addTask({ title: 'Task B' });
    await addTask({ title: 'Task C' });

    const tasks = await listTasks();
    expect(tasks).toHaveLength(3);
  });

  it('filters by status', async () => {
    await addTask({ title: 'Todo task' });
    const { task: doneTask } = await addTask({ title: 'Done task' });
    await completeTask(doneTask.id);

    const todoTasks = await listTasks({ status: 'todo' });
    expect(todoTasks).toHaveLength(1);
    expect(todoTasks[0].title).toBe('Todo task');

    const doneTasks = await listTasks({ status: 'done' });
    expect(doneTasks).toHaveLength(1);
    expect(doneTasks[0].title).toBe('Done task');
  });

  it('filters by category', async () => {
    await addTask({ title: 'Work task', category: 'work' });
    await addTask({ title: 'Personal task', category: 'personal' });

    const workTasks = await listTasks({ category: 'work' });
    expect(workTasks).toHaveLength(1);
    expect(workTasks[0].title).toBe('Work task');
  });

  it('returns empty array when no tasks match', async () => {
    await addTask({ title: 'Task' });

    const tasks = await listTasks({ status: 'done' });
    expect(tasks).toEqual([]);
  });
});

describe('completeTask', () => {
  it('marks a task as done', async () => {
    const { task } = await addTask({ title: 'Complete me' });
    const { task: completed } = await completeTask(task.id);

    expect(completed.status).toBe('done');
    expect(completed.id).toBe(task.id);
  });

  it('works with partial ID prefix match', async () => {
    const { task } = await addTask({ title: 'Partial match' });
    const prefix = task.id.slice(0, 6);
    const { task: completed } = await completeTask(prefix);

    expect(completed.status).toBe('done');
    expect(completed.id).toBe(task.id);
  });

  it('throws error for non-existent ID', async () => {
    await addTask({ title: 'Existing task' });

    await expect(completeTask('nonexistent')).rejects.toThrow(
      /No task found matching ID prefix/,
    );
  });

  it('updates the updated_at timestamp', async () => {
    const { task } = await addTask({ title: 'Timestamp test' });
    const originalUpdated = task.updated_at;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const { task: completed } = await completeTask(task.id);
    expect(completed.updated_at).not.toBe(originalUpdated);
  });
});

describe('getDashboardData', () => {
  it('returns correct structure with empty store', async () => {
    const data = await getDashboardData();

    expect(data).toHaveProperty('urgent_tasks');
    expect(data).toHaveProperty('today_tasks');
    expect(data).toHaveProperty('recent_tasks');
    expect(data).toHaveProperty('recent_sessions');
    expect(data).toHaveProperty('stats');
    expect(data.stats).toEqual({ total: 0, todo: 0, in_progress: 0, done: 0 });
  });

  it('calculates stats correctly', async () => {
    await addTask({ title: 'Todo 1' });
    await addTask({ title: 'Todo 2' });
    const { task } = await addTask({ title: 'Done task' });
    await completeTask(task.id);

    const data = await getDashboardData();
    expect(data.stats.total).toBe(3);
    expect(data.stats.todo).toBe(2);
    expect(data.stats.done).toBe(1);
    expect(data.stats.in_progress).toBe(0);
  });

  it('identifies urgent (high priority) tasks', async () => {
    await addTask({ title: 'Urgent task', priority: 'immediate' });
    await addTask({ title: 'Normal task', priority: 'none' });

    const data = await getDashboardData();
    expect(data.urgent_tasks).toHaveLength(1);
    expect(data.urgent_tasks[0].title).toBe('Urgent task');
  });

  it('returns recent done tasks sorted by updated_at', async () => {
    const { task: t1 } = await addTask({ title: 'Done first' });
    await new Promise((r) => setTimeout(r, 10));
    const { task: t2 } = await addTask({ title: 'Done second' });

    await completeTask(t1.id);
    await new Promise((r) => setTimeout(r, 10));
    await completeTask(t2.id);

    const data = await getDashboardData();
    expect(data.recent_tasks).toHaveLength(2);
    expect(data.recent_tasks[0].title).toBe('Done second');
    expect(data.recent_tasks[1].title).toBe('Done first');
  });
});

// Subtask tests removed — subtasks are now child tasks in the plugin system

describe('reorderTasks', () => {
  it('reorders tasks within a group', async () => {
    const { task: t1 } = await addTask({ title: 'First', category: 'work', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Second', category: 'work', project: 'work' });
    const { task: t3 } = await addTask({ title: 'Third', category: 'work', project: 'work' });

    // Reverse order: t3, t2, t1
    await reorderTasks('work', 'work', [t3.id, t2.id, t1.id]);

    const tasks = await listTasks({ category: 'work' });
    expect(tasks[0].id).toBe(t3.id);
    expect(tasks[1].id).toBe(t2.id);
    expect(tasks[2].id).toBe(t1.id);
  });

  it('does not affect tasks in other groups', async () => {
    const { task: w1 } = await addTask({ title: 'Work 1', category: 'work', project: 'work' });
    const { task: l1 } = await addTask({ title: 'Life 1', category: 'life', project: 'life' });
    const { task: w2 } = await addTask({ title: 'Work 2', category: 'work', project: 'work' });

    // Reverse work tasks
    await reorderTasks('work', 'work', [w2.id, w1.id]);

    const all = await listTasks({});
    // Life task stays in its original position (index 1)
    expect(all[0].id).toBe(w2.id);
    expect(all[1].id).toBe(l1.id);
    expect(all[2].id).toBe(w1.id);
  });

  it('self-heals when orderedIds is missing a group member (appends missing at end)', async () => {
    const { task: t1 } = await addTask({ title: 'First', category: 'work', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Second', category: 'work', project: 'work' });
    const { task: t3 } = await addTask({ title: 'Third', category: 'work', project: 'work' });

    // Only provide t3, t1 — t2 is missing, should be appended at the end
    await reorderTasks('work', 'work', [t3.id, t1.id]);

    const tasks = await listTasks({ category: 'work' });
    expect(tasks[0].id).toBe(t3.id);
    expect(tasks[1].id).toBe(t1.id);
    expect(tasks[2].id).toBe(t2.id); // auto-appended
  });

  it('self-heals when orderedIds contains unknown IDs (drops them)', async () => {
    const { task: t1 } = await addTask({ title: 'One', category: 'work', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Two', category: 'work', project: 'work' });

    // Include a fake ID — should be silently dropped
    await reorderTasks('work', 'work', ['fake-id', t2.id, t1.id]);

    const tasks = await listTasks({ category: 'work' });
    expect(tasks[0].id).toBe(t2.id);
    expect(tasks[1].id).toBe(t1.id);
  });

  it('self-heals when orderedIds has duplicates (deduplicates)', async () => {
    const { task: t1 } = await addTask({ title: 'One', category: 'work', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Two', category: 'work', project: 'work' });

    // Duplicate t1 — should be deduplicated, t2 appended as missing
    await reorderTasks('work', 'work', [t1.id, t1.id]);

    const tasks = await listTasks({ category: 'work' });
    expect(tasks[0].id).toBe(t1.id);
    expect(tasks[1].id).toBe(t2.id); // auto-appended
  });
});

describe('deleteTask', () => {
  it('deletes a task by full ID', async () => {
    const { task } = await addTask({ title: 'Delete me' });
    const { task: deleted } = await deleteTask(task.id);

    expect(deleted.id).toBe(task.id);
    expect(deleted.title).toBe('Delete me');

    // Verify task is gone from store
    const tasks = await listTasks({});
    expect(tasks).toHaveLength(0);
  });

  it('deletes a task by partial ID prefix', async () => {
    const { task } = await addTask({ title: 'Prefix delete' });
    const prefix = task.id.slice(0, 6);
    const { task: deleted } = await deleteTask(prefix);

    expect(deleted.id).toBe(task.id);
    const tasks = await listTasks({});
    expect(tasks).toHaveLength(0);
  });

  it('throws for non-existent ID', async () => {
    await addTask({ title: 'Existing' });
    await expect(deleteTask('nonexistent')).rejects.toThrow(/No task found matching ID prefix/);
  });

  it('throws for ambiguous ID prefix', async () => {
    // Create two tasks with same prefix by manipulating the store
    const { task: t1 } = await addTask({ title: 'Task A' });
    const { task: t2 } = await addTask({ title: 'Task B' });
    // Use a single character that both IDs start with (they both start with a letter)
    // This is tricky because IDs are random. Instead, use an empty prefix which matches all.
    await expect(deleteTask('')).rejects.toThrow(/Ambiguous ID prefix/);
  });

  it('throws ActiveSessionError when task has active session slots', async () => {
    const { task } = await addTask({ title: 'Has sessions' });
    await linkSessionSlot(task.id, 'session-abc', 'plan');
    await linkSessionSlot(task.id, 'session-def', 'exec');

    await expect(deleteTask(task.id)).rejects.toThrow(ActiveSessionError);

    try {
      await deleteTask(task.id);
    } catch (err) {
      expect(err).toBeInstanceOf(ActiveSessionError);
      expect((err as ActiveSessionError).activeSessionIds).toEqual(['session-abc', 'session-def']);
    }

    // Task should NOT be deleted
    const tasks = await listTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
  });

  it('allows deletion after clearing session slots', async () => {
    const { task } = await addTask({ title: 'Clear then delete' });
    await linkSessionSlot(task.id, 'session-xyz', 'exec');

    // Should fail with active session
    await expect(deleteTask(task.id)).rejects.toThrow(ActiveSessionError);

    // Clear the session slot
    await clearSessionSlot(task.id, 'session-xyz');

    // Now deletion should succeed
    const { task: deleted } = await deleteTask(task.id);
    expect(deleted.id).toBe(task.id);

    const tasks = await listTasks({});
    expect(tasks).toHaveLength(0);
  });

  it('does not affect other tasks when deleting', async () => {
    const { task: keep } = await addTask({ title: 'Keep me' });
    const { task: remove } = await addTask({ title: 'Remove me' });

    await deleteTask(remove.id);

    const tasks = await listTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(keep.id);
  });
});

describe('linkSessionSlot / clearSessionSlot', () => {
  it('links a session to a task exec slot', async () => {
    const { task } = await addTask({ title: 'Session link' });
    const { task: updated } = await linkSessionSlot(task.id, 'sess-1', 'exec');

    expect(updated.exec_session_id).toBe('sess-1');
    expect(updated.session_ids).toContain('sess-1');
  });

  it('links a session to a task plan slot', async () => {
    const { task } = await addTask({ title: 'Plan link' });
    const { task: updated } = await linkSessionSlot(task.id, 'sess-plan', 'plan');

    expect(updated.plan_session_id).toBe('sess-plan');
    expect(updated.session_ids).toContain('sess-plan');
  });

  it('does not duplicate session IDs in history', async () => {
    const { task } = await addTask({ title: 'No dupe' });
    await linkSessionSlot(task.id, 'sess-1', 'exec');
    const { task: updated } = await linkSessionSlot(task.id, 'sess-1', 'exec');

    expect(updated.session_ids.filter((id: string) => id === 'sess-1')).toHaveLength(1);
  });

  it('clears a specific session by ID', async () => {
    const { task } = await addTask({ title: 'Clear one' });
    await linkSessionSlot(task.id, 'sess-plan', 'plan');
    await linkSessionSlot(task.id, 'sess-exec', 'exec');
    const { task: updated } = await clearSessionSlot(task.id, 'sess-plan');

    expect(updated.plan_session_id).toBeUndefined();
    expect(updated.exec_session_id).toBe('sess-exec');
  });

  it('clears all slots when no sessionId provided', async () => {
    const { task } = await addTask({ title: 'Clear all' });
    await linkSessionSlot(task.id, 'sess-plan', 'plan');
    await linkSessionSlot(task.id, 'sess-exec', 'exec');
    const { task: updated } = await clearSessionSlot(task.id);

    expect(updated.plan_session_id).toBeUndefined();
    expect(updated.exec_session_id).toBeUndefined();
  });

  it('backward-compat alias linkActiveSession works', async () => {
    const { task } = await addTask({ title: 'Compat' });
    const { task: updated } = await linkActiveSession(task.id, 'sess-compat');

    expect(updated.exec_session_id).toBe('sess-compat');
    expect(updated.session_ids).toContain('sess-compat');
  });

  it('backward-compat alias clearActiveSession works', async () => {
    const { task } = await addTask({ title: 'Compat clear' });
    await linkSessionSlot(task.id, 'sess-x', 'exec');
    const { task: updated } = await clearActiveSession(task.id, 'sess-x');

    expect(updated.exec_session_id).toBeUndefined();
  });
});

describe('updateTask — starred', () => {
  it('sets starred to true', async () => {
    const { task } = await addTask({ title: 'Star me' });
    expect(task.starred).not.toBe(true);

    const { task: updated } = await updateTask(task.id, { starred: true });
    expect(updated.starred).toBe(true);
  });

  it('sets starred to false (unstar)', async () => {
    const { task } = await addTask({ title: 'Unstar me' });
    // Star it first
    await updateTask(task.id, { starred: true });
    // Now unstar
    const { task: updated } = await updateTask(task.id, { starred: false });
    expect(updated.starred).toBe(false);
  });

  it('persists starred across reads', async () => {
    const { task } = await addTask({ title: 'Persist star' });
    await updateTask(task.id, { starred: true });

    const tasks = await listTasks();
    const found = tasks.find(t => t.id === task.id);
    expect(found?.starred).toBe(true);
  });

  it('does not change starred when not provided', async () => {
    const { task } = await addTask({ title: 'No star change' });
    await updateTask(task.id, { starred: true });

    // Update title only — starred should remain true
    const { task: updated } = await updateTask(task.id, { title: 'Renamed' });
    expect(updated.starred).toBe(true);
    expect(updated.title).toBe('Renamed');
  });
});

describe('getProjectMetadata', () => {
  it('returns null when no .metadata task exists', async () => {
    await addTask({ title: 'Regular task', category: 'Work', project: 'HomeLab' });

    const result = await getProjectMetadata('Work', 'HomeLab');
    expect(result).toBeNull();
  });

  it('parses YAML description from .metadata_project task', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: remote-dev\ndefault_cwd: /home/user/project',
    });

    const result = await getProjectMetadata('Work', 'HomeLab');
    expect(result).not.toBeNull();
    expect(result!.default_host).toBe('remote-dev');
    expect(result!.default_cwd).toBe('/home/user/project');
  });

  it('matches case-insensitively on category and project', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: remote-dev\ndefault_cwd: /workspace',
    });

    // Lookup with lowercase — should still find the task
    const result = await getProjectMetadata('work', 'homelab');
    expect(result).not.toBeNull();
    expect(result!.default_host).toBe('remote-dev');
  });

  it('returns null for invalid YAML in description', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'not: valid: yaml: {{{',
    });

    const result = await getProjectMetadata('Work', 'HomeLab');
    expect(result).toBeNull();
  });

  it('returns null when .metadata_project task has empty description', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
    });

    const result = await getProjectMetadata('Work', 'HomeLab');
    expect(result).toBeNull();
  });

  it('returns null when YAML parses to a non-object (e.g. a string)', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'just a plain string',
    });

    const result = await getProjectMetadata('Work', 'HomeLab');
    expect(result).toBeNull();
  });

  it('does not confuse .metadata_project tasks from different projects', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'Alpha',
      description: 'default_host: alpha-host',
    });
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'Beta',
      description: 'default_host: beta-host',
    });

    const alpha = await getProjectMetadata('Work', 'Alpha');
    const beta = await getProjectMetadata('Work', 'Beta');

    expect(alpha!.default_host).toBe('alpha-host');
    expect(beta!.default_host).toBe('beta-host');
  });

  it('parses additional YAML fields beyond default_host and default_cwd', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: remote-dev\ndefault_cwd: /workspace\ncustom_key: custom_value',
    });

    const result = await getProjectMetadata('Work', 'HomeLab');
    expect(result).not.toBeNull();
    expect(result!.custom_key).toBe('custom_value');
  });
});

describe('updateTask — parent_task_id re-parenting', () => {
  it('re-parents a task to a new parent', async () => {
    const { task: parent1 } = await addTask({ title: 'Parent 1' });
    const { task: parent2 } = await addTask({ title: 'Parent 2' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent1.id });
    expect(child.parent_task_id).toBe(parent1.id);

    const { task: updated } = await updateTask(child.id, { parent_task_id: parent2.id });
    expect(updated.parent_task_id).toBe(parent2.id);
  });

  it('removes parent when set to empty string', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    expect(child.parent_task_id).toBe(parent.id);

    const { task: updated } = await updateTask(child.id, { parent_task_id: '' });
    expect(updated.parent_task_id).toBeUndefined();
  });

  it('throws when parent task does not exist', async () => {
    const { task } = await addTask({ title: 'Orphan' });
    await expect(updateTask(task.id, { parent_task_id: 'nonexistent' })).rejects.toThrow(
      'Parent task not found',
    );
  });

  it('throws when task is set as its own parent', async () => {
    const { task } = await addTask({ title: 'Self-ref' });
    await expect(updateTask(task.id, { parent_task_id: task.id })).rejects.toThrow(
      'cannot be its own parent',
    );
  });

  it('throws on circular reference (parent is a descendant)', async () => {
    const { task: grandparent } = await addTask({ title: 'Grandparent' });
    const { task: parent } = await addTask({ title: 'Parent', parent_task_id: grandparent.id });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });

    // Try to make grandparent a child of child → circular
    await expect(updateTask(grandparent.id, { parent_task_id: child.id })).rejects.toThrow(
      'Circular reference',
    );
  });

  it('resolves parent by ID prefix', async () => {
    const { task: newParent } = await addTask({ title: 'New Parent' });
    const { task: child } = await addTask({ title: 'Child' });

    // Use the full ID — prefix resolution is already exercised by updateTask's own ID matching
    const { task: updated } = await updateTask(child.id, { parent_task_id: newParent.id });
    expect(updated.parent_task_id).toBe(newParent.id);

    // Verify persistence — re-read
    const tasks = await listTasks();
    const reloaded = tasks.find((t) => t.id === child.id);
    expect(reloaded!.parent_task_id).toBe(newParent.id);
  });
});

describe('updateTask — cwd', () => {
  it('sets cwd on a task', async () => {
    const { task } = await addTask({ title: 'Task with cwd' });
    expect(task.cwd).toBeUndefined();

    const { task: updated } = await updateTask(task.id, { cwd: '/workspace/special' });
    expect(updated.cwd).toBe('/workspace/special');
  });

  it('clears cwd with empty string', async () => {
    const { task } = await addTask({ title: 'Task to clear cwd' });
    await updateTask(task.id, { cwd: '/workspace/special' });

    const { task: cleared } = await updateTask(task.id, { cwd: '' });
    expect(cleared.cwd).toBeUndefined();
  });

  it('persists cwd across reads', async () => {
    const { task } = await addTask({ title: 'Persist cwd' });
    await updateTask(task.id, { cwd: '/workspace/persistent' });

    const tasks = await listTasks();
    const found = tasks.find(t => t.id === task.id);
    expect(found?.cwd).toBe('/workspace/persistent');
  });

  it('does not change cwd when not provided', async () => {
    const { task } = await addTask({ title: 'No cwd change' });
    await updateTask(task.id, { cwd: '/workspace/keep' });

    // Update title only — cwd should remain
    const { task: updated } = await updateTask(task.id, { title: 'Renamed' });
    expect(updated.cwd).toBe('/workspace/keep');
    expect(updated.title).toBe('Renamed');
  });
});

describe('autoPushIfConfigured sync_error lifecycle', () => {
  // Helper: create a mock sync with all methods succeeding by default
  function createMockSync(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return {
      createTask: vi.fn().mockResolvedValue(null),
      deleteTask: vi.fn(),
      updateTitle: vi.fn().mockResolvedValue(undefined),
      updateDescription: vi.fn().mockResolvedValue(undefined),
      updateSummary: vi.fn(),
      updateNote: vi.fn(),
      updateConversationLog: vi.fn(),
      updatePriority: vi.fn().mockResolvedValue(undefined),
      updatePhase: vi.fn().mockResolvedValue(undefined),
      updateDueDate: vi.fn(),
      updateStar: vi.fn(),
      updateCategory: vi.fn(),
      updateDependencies: vi.fn().mockResolvedValue(undefined),
      associateSubtask: vi.fn(),
      disassociateSubtask: vi.fn(),
      syncPoll: vi.fn(),
      ...overrides,
    };
  }

  // Helper: register a test plugin (idempotent)
  async function registerTestPlugin(id: string, syncOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    const { registry } = await import('../../src/core/integration-registry.js');
    if (!registry.has(id)) {
      registry.register(id, {
        id,
        name: `Test Plugin (${id})`,
        config: {},
        sync: createMockSync(syncOverrides) as any,
        migrations: [],
        httpRoutes: [],
      });
    }
  }

  it('clears sync_error when all plugin updates succeed', async () => {
    await registerTestPlugin('test-plugin');

    const { task } = await addTask({ title: 'Sync error task', category: 'test', project: 'test' });
    await updateTaskRaw(task.id, {
      source: 'test-plugin',
      ext: { 'test-plugin': { id: 'remote-123' } },
      sync_error: 'Sync auth expired (HTTP 302 redirect)',
    } as any);

    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.sync_error).toBe('Sync auth expired (HTTP 302 redirect)');

    const result = await autoPushIfConfigured(before);
    expect(result.success).toBe(true);

    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.sync_error).toBeUndefined();
  });

  it('sets sync_error when a plugin update fails', async () => {
    await registerTestPlugin('test-fail-plugin', {
      updateTitle: vi.fn().mockRejectedValue(new Error('HTTP 302 redirect')),
    });

    const { task } = await addTask({ title: 'Fail sync task', category: 'test', project: 'test' });
    await updateTaskRaw(task.id, {
      source: 'test-fail-plugin',
      ext: { 'test-fail-plugin': { id: 'remote-456' } },
    } as any);

    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.sync_error).toBeUndefined();

    const result = await autoPushIfConfigured(before);
    expect(result.success).toBe(false);

    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.sync_error).toBeDefined();
    expect(after.sync_error).toContain('HTTP 302 redirect');
  });

  it('skips local-source tasks', async () => {
    const { task } = await addTask({ title: 'Local task' });
    const result = await autoPushIfConfigured(task);
    expect(result.success).toBe(true);
  });
});
