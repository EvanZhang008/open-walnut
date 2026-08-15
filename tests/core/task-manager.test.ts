import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;
let tasksFile: string;
let configFile: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Import after mocking
import { addTask, addTaskFull, addTasksBulk, listTasks, completeTask, getDashboardData, reorderTasks, deleteTask, linkSessionSlot, clearSessionSlot, ActiveSessionError, updateTask, autoPushIfConfigured, updateTaskRaw, getTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { log } from '../../src/logging/index.js';
import { WALNUT_HOME, TASKS_FILE, CONFIG_FILE } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  tasksFile = TASKS_FILE;
  configFile = CONFIG_FILE;
  // Clean temp directory
  closeDb();
  _resetForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('addTask', () => {
  it('creates a task with correct default fields', async () => {
    const { task } = await addTask({ title: 'Test task' });

    expect(task).toBeDefined();
    expect(task.id).toMatch(/^[a-z0-9]+-[a-f0-9]{4}$/);
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('none');
    // No project = Inbox. Inbox is structural (no registry row, unclaimable), so
    // a default quick-add task is always local.
    expect(task.project).toBe('');
    expect(task.source).toBe('local');
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

  it('respects provided options (priority, project, due_date)', async () => {
    const { task } = await addTask({
      title: 'Important work task',
      priority: 'immediate',
      project: 'walnut',
      due_date: '2026-12-31',
    });

    expect(task.priority).toBe('immediate');
    expect(task.project).toBe('walnut');
    expect(task.due_date).toBe('2026-12-31');
  });

  it('persists tasks across listTasks calls', async () => {
    const { task } = await addTask({ title: 'Persisted task' });
    const listed = await listTasks();
    expect(listed.find(t => t.id === task.id)?.title).toBe('Persisted task');
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

  it('filters by project', async () => {
    await addTask({ title: 'Work task', project: 'work' });
    await addTask({ title: 'Personal task', project: 'personal' });

    const workTasks = await listTasks({ project: 'work' });
    expect(workTasks).toHaveLength(1);
    expect(workTasks[0].title).toBe('Work task');
  });

  it("filters to Inbox with project: ''", async () => {
    await addTask({ title: 'Loose thought' });
    await addTask({ title: 'Filed', project: 'work' });

    const inbox = await listTasks({ project: '' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('Loose thought');
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
  it('reorders tasks within a project group', async () => {
    const { task: t1 } = await addTask({ title: 'First', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Second', project: 'work' });
    const { task: t3 } = await addTask({ title: 'Third', project: 'work' });

    // Reverse order: t3, t2, t1
    await reorderTasks('work', [t3.id, t2.id, t1.id]);

    const tasks = await listTasks({ project: 'work' });
    expect(tasks[0].id).toBe(t3.id);
    expect(tasks[1].id).toBe(t2.id);
    expect(tasks[2].id).toBe(t1.id);
  });

  it('reorders the Inbox group (empty project)', async () => {
    const { task: t1 } = await addTask({ title: 'Inbox 1' });
    const { task: t2 } = await addTask({ title: 'Inbox 2' });

    await reorderTasks('', [t2.id, t1.id]);

    const tasks = await listTasks({ project: '' });
    expect(tasks[0].id).toBe(t2.id);
    expect(tasks[1].id).toBe(t1.id);
  });

  it('does not affect tasks in other groups', async () => {
    const { task: w1 } = await addTask({ title: 'Work 1', project: 'work' });
    const { task: l1 } = await addTask({ title: 'Life 1', project: 'life' });
    const { task: w2 } = await addTask({ title: 'Work 2', project: 'work' });

    // Reverse work tasks
    await reorderTasks('work', [w2.id, w1.id]);

    const all = await listTasks({});
    // Life task stays in its original position (index 1)
    expect(all[0].id).toBe(w2.id);
    expect(all[1].id).toBe(l1.id);
    expect(all[2].id).toBe(w1.id);
  });

  it('self-heals when orderedIds is missing a group member (appends missing at end)', async () => {
    const { task: t1 } = await addTask({ title: 'First', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Second', project: 'work' });
    const { task: t3 } = await addTask({ title: 'Third', project: 'work' });

    // Only provide t3, t1 — t2 is missing, should be appended at the end
    await reorderTasks('work', [t3.id, t1.id]);

    const tasks = await listTasks({ project: 'work' });
    expect(tasks[0].id).toBe(t3.id);
    expect(tasks[1].id).toBe(t1.id);
    expect(tasks[2].id).toBe(t2.id); // auto-appended
  });

  it('self-heals when orderedIds contains unknown IDs (drops them)', async () => {
    const { task: t1 } = await addTask({ title: 'One', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Two', project: 'work' });

    // Include a fake ID — should be silently dropped
    await reorderTasks('work', ['fake-id', t2.id, t1.id]);

    const tasks = await listTasks({ project: 'work' });
    expect(tasks[0].id).toBe(t2.id);
    expect(tasks[1].id).toBe(t1.id);
  });

  it('self-heals when orderedIds has duplicates (deduplicates)', async () => {
    const { task: t1 } = await addTask({ title: 'One', project: 'work' });
    const { task: t2 } = await addTask({ title: 'Two', project: 'work' });

    // Duplicate t1 — should be deduplicated, t2 appended as missing
    await reorderTasks('work', [t1.id, t1.id]);

    const tasks = await listTasks({ project: 'work' });
    expect(tasks[0].id).toBe(t1.id);
    expect(tasks[1].id).toBe(t2.id); // auto-appended
  });

  it('matches the project group CASE-INSENSITIVELY', async () => {
    // Project identity ignores case everywhere else (NOCASE registry PK), so a
    // caller passing a different spelling than the stored one used to match zero
    // tasks and the reorder silently vanished.
    const { task: t1 } = await addTask({ title: 'First', project: 'Work' });
    const { task: t2 } = await addTask({ title: 'Second', project: 'Work' });

    await reorderTasks('WORK', [t2.id, t1.id]);

    const tasks = await listTasks({ project: 'Work' });
    expect(tasks[0].id).toBe(t2.id);
    expect(tasks[1].id).toBe(t1.id);
  });

  it('warns instead of silently no-oping when the group resolves to nothing', async () => {
    const { task } = await addTask({ title: 'Elsewhere', project: 'work' });
    const warn = vi.spyOn(log.task, 'warn');

    await reorderTasks('does-not-exist', [task.id]);

    const dropped = warn.mock.calls.find(([msg]) => String(msg).includes('no tasks matched'));
    expect(dropped, 'expected a warning when ids were supplied but nothing matched').toBeTruthy();
    expect(dropped![1]).toMatchObject({ project: 'does-not-exist', requestedIds: 1 });
    warn.mockRestore();

    // And the real group is untouched.
    expect((await listTasks({ project: 'work' })).map((t) => t.id)).toEqual([task.id]);
  });

  it('stays quiet when no ids were supplied at all (empty drag)', async () => {
    const warn = vi.spyOn(log.task, 'warn');
    await reorderTasks('nothing-here', []);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('no tasks matched'))).toBe(false);
    warn.mockRestore();
  });
});

// ── Retired `.metadata` sentinel guard (pull-side resurrection) ─────────────
// The v5 migration absorbed and DELETED the `.metadata_project` /
// `.metadata_category` sentinel tasks, but the remote twins still exist in
// providers' lists — so every pull re-imports them as phantom rows that every
// reader then has to filter out. The shape must be permanently uncreatable.

describe('addTaskFull: retired sentinel guard', () => {
  function pulled(title: string): Parameters<typeof addTaskFull>[0] {
    return {
      title,
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      project: 'Walnut',
      source: 'ms-todo',
      session_ids: [],
      description: '',
      summary: '',
      note: '',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ext: { 'ms-todo': { id: 'remote-sentinel' } },
    } as Parameters<typeof addTaskFull>[0];
  }

  it('refuses .metadata_project and .metadata_category', async () => {
    await expect(addTaskFull(pulled('.metadata_project'))).rejects.toThrow(/retired sentinel/);
    await expect(addTaskFull(pulled('.metadata_category'))).rejects.toThrow(/retired sentinel/);
    expect(await listTasks({})).toHaveLength(0);
  });

  it('refuses the whole `.metadata*` namespace, not just the two known titles', async () => {
    // Readers filter on `startsWith('.metadata')`, so anything in that namespace
    // would be an invisible phantom row.
    await expect(addTaskFull(pulled('.metadata'))).rejects.toThrow(/retired sentinel/);
    await expect(addTaskFull(pulled('.metadata_future'))).rejects.toThrow(/retired sentinel/);
    await expect(addTaskFull(pulled('  .metadata_project  '))).rejects.toThrow(/retired sentinel/);
  });

  it('still accepts an ordinary title (guard is not over-broad)', async () => {
    const created = await addTaskFull(pulled('metadata about the project'));
    expect(created.title).toBe('metadata about the project');
    // A leading dot alone is fine — only the retired namespace is blocked.
    const dotted = await addTaskFull({ ...pulled('.gitignore notes'), ext: { 'ms-todo': { id: 'r2' } } });
    expect(dotted.title).toBe('.gitignore notes');
  });

  it('skips sentinels in addTasksBulk (the reconciler fullPull path)', async () => {
    const created = await addTasksBulk([
      pulled('Real work'),
      pulled('.metadata_project'),
      pulled('.metadata'),
    ]);
    expect(created.map((t) => t.title)).toEqual(['Real work']);
    expect((await listTasks({})).map((t) => t.title)).toEqual(['Real work']);
  });

  it('refuses the retired grouping names as a project (Quick Start / Inbox)', async () => {
    // Same class of resurrection as the sentinels: providers' remote sides still
    // carry the retired tags, and a pull that wrote them back would re-mint the
    // registry rows the v5 repair deleted (observed live 2026-08-05).
    await expect(addTaskFull({ ...pulled('QS twin'), project: 'Quick Start' }))
      .rejects.toThrow(/retired group/);
    await expect(addTaskFull({ ...pulled('Inbox twin'), project: 'inbox' }))
      .rejects.toThrow(/retired group/);
    expect(await listTasks({})).toHaveLength(0);
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

});

describe('updateTask — unread (read marker)', () => {
  it('does NOT bump updated_at when only clearing unread', async () => {
    const { task } = await addTask({ title: 'Unread task' });
    await updateTask(task.id, { unread: true });
    const { task: marked } = await updateTask(task.id, { title: 'Marked' });
    const before = marked.updated_at;

    // Wait a tick so a (wrong) timestamp bump would be observable.
    await new Promise((r) => setTimeout(r, 5));
    const { task: cleared } = await updateTask(task.id, { unread: false });

    expect(cleared.unread).toBe(false);
    expect(cleared.updated_at).toBe(before);
  });

  it('still bumps updated_at when unread changes alongside content', async () => {
    const { task } = await addTask({ title: 'Combo task' });
    const before = task.updated_at;
    await new Promise((r) => setTimeout(r, 5));

    const { task: updated } = await updateTask(task.id, { unread: false, title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    expect(updated.updated_at).not.toBe(before);
  });

  it('clears the marker on COMPLETE so a done task never carries a dot', async () => {
    const { task } = await addTask({ title: 'Completed task' });
    await updateTask(task.id, { unread: true });

    const { task: done } = await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'api' });
    expect(done.unread).toBeFalsy();
  });

  // A phase set through updateTask (REST phase picker, agent task_update, plugin
  // sync) does NOT go through applySessionPhase, so wiring the marker only into
  // the session machine left this path dot-less: a task dragged to AGENT_COMPLETE
  // by hand looked read while a session-driven one lit up. Both now derive from
  // readMarkerForPhase, so they agree by construction.
  it('derives the marker from the phase on the updateTask path too', async () => {
    const { task } = await addTask({ title: 'Manual phase task' });

    const { task: handedBack } = await updateTask(task.id, { phase: 'AGENT_COMPLETE' }, { source: 'api' });
    expect(handedBack.unread).toBe(true);

    // The read event: opening the task clears the dot WITHOUT moving the phase.
    const { task: read } = await updateTask(task.id, { unread: false });
    expect(read.phase).toBe('AGENT_COMPLETE');
    expect(read.unread).toBe(false);

    // A new turn supersedes whatever was pending.
    const { task: running } = await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' });
    expect(running.unread).toBe(false);

    // The error path marks it too.
    const { task: awaiting } = await updateTask(task.id, { phase: 'AWAIT_HUMAN_ACTION' }, { source: 'api' });
    expect(awaiting.unread).toBe(true);
  });

  it('an explicit marker in the same patch beats the phase-implied one', async () => {
    const { task } = await addTask({ title: 'Explicit-wins task' });
    // "Mark it complete-ish but keep it read" — the caller said so, honor it.
    const { task: updated } = await updateTask(
      task.id, { phase: 'AGENT_COMPLETE', unread: false }, { source: 'api' },
    );
    expect(updated.phase).toBe('AGENT_COMPLETE');
    expect(updated.unread).toBe(false);
  });
});

// Project settings used to live in a `.metadata_project` sentinel task whose
// description was YAML. That whole machinery is gone — settings are now a JSON
// blob on the task_projects registry row, covered by
// tests/core/project-source-validation.test.ts ('project metadata').

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
      updateProject: vi.fn(),
      updateDependencies: vi.fn().mockResolvedValue(undefined),
      pushTask: vi.fn().mockResolvedValue({ serverTimestamp: new Date().toISOString() }),
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

    const { task } = await addTask({ title: 'Sync error task', project: 'test' });
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
      pushTask: vi.fn().mockRejectedValue(new Error('HTTP 302 redirect')),
    });

    const { task } = await addTask({ title: 'Fail sync task', project: 'test' });
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

