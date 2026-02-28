/**
 * Tests for MS To-Do sync logic:
 * - reconcilePulledTasks: categoryMismatch rollback fix
 * - autoPushTask: per-task dedup
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcilePulledTasks } from '../../src/integrations/microsoft-todo.js';
import type { Task, TaskPhase } from '../../src/core/types.js';

// ── Helpers ──

function createLocalTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-001',
    title: 'Test task',
    status: 'todo',
    phase: 'TODO' as TaskPhase,
    priority: 'none',
    category: 'Passion',
    project: 'Walnut',
    source: 'ms-todo',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    created_at: '2026-02-24T00:00:00Z',
    updated_at: '2026-02-25T12:00:00Z',
    ext: { 'ms-todo': { id: 'ms-task-1', list_id: 'list-mybot' } },
    ...overrides,
  } as Task;
}

function createMsTask(overrides?: Record<string, unknown>) {
  return {
    id: 'ms-task-1',
    title: 'Test task',
    status: 'notStarted' as const,
    importance: 'normal' as const,
    body: { content: '', contentType: 'text' },
    createdDateTime: '2026-02-24T00:00:00Z',
    lastModifiedDateTime: '2026-02-25T06:00:00Z',
    ...overrides,
  };
}

// ── Tests ──

describe('reconcilePulledTasks — categoryMismatch fix', () => {
  it('does NOT roll back local project when local is newer than remote', async () => {
    // Local: project='Walnut', updated 12:00 (NEWER)
    // Remote: in "Passion / MyBot" list, modified 06:00 (OLDER)
    const localTask = createLocalTask({
      category: 'Passion',
      project: 'Walnut',
      updated_at: '2026-02-25T12:00:00Z',
    });

    const msTask = createMsTask({
      lastModifiedDateTime: '2026-02-25T06:00:00Z',
    });

    const localByMsId = new Map([['ms-task-1', localTask]]);
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Passion / MyBot' },
      localByMsId,
      updateSpy,
      addSpy,
    );

    // Should NOT update — local is newer, no rollback
    expect(updateSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('accepts remote update when remote is newer than local', async () => {
    // Local: updated 06:00 (OLDER)
    // Remote: updated 18:00 (NEWER) with title change
    const localTask = createLocalTask({
      category: 'Passion',
      project: 'MyBot',
      updated_at: '2026-02-24T06:00:00Z',
    });

    const msTask = createMsTask({
      title: 'Updated from MS To-Do',
      lastModifiedDateTime: '2026-02-25T18:00:00Z',
    });

    const localByMsId = new Map([['ms-task-1', localTask]]);
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Passion / MyBot' },
      localByMsId,
      updateSpy,
      addSpy,
    );

    // Should update — remote is newer
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith('task-001', expect.objectContaining({
      title: 'Updated from MS To-Do',
    }));
    expect(count).toBe(1);
  });

  it('does NOT roll back even when project differs significantly', async () => {
    // Simulate: task moved from "Work / HomeLab" to "Passion / Walnut"
    // Remote still in "Work / HomeLab" list, local is newer
    const localTask = createLocalTask({
      category: 'Passion',
      project: 'Walnut',
      updated_at: '2026-02-25T20:00:00Z', // very recent local change
    });

    const msTask = createMsTask({
      lastModifiedDateTime: '2026-02-25T01:00:00Z', // old remote
    });

    const localByMsId = new Map([['ms-task-1', localTask]]);
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-homelab', displayName: 'Work / HomeLab' },
      localByMsId,
      updateSpy,
      addSpy,
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('creates new task for unknown remote task', async () => {
    const msTask = createMsTask({ id: 'ms-new-1', title: 'Brand new' });
    const localByMsId = new Map<string, Task>();
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({ id: 'new-local' } as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-1', displayName: 'Passion / Walnut' },
      localByMsId,
      updateSpy,
      addSpy,
    );

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Brand new',
      source: 'ms-todo',
    }));
    expect(count).toBe(1);
  });

  it('skips tasks in deletedMsIds set', async () => {
    const msTask = createMsTask({ id: 'ms-deleted-1' });
    const localByMsId = new Map<string, Task>();
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-1', displayName: 'Passion / Walnut' },
      localByMsId,
      updateSpy,
      addSpy,
      undefined,
      new Set(['ms-deleted-1']),
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('skips tasks with empty titles (tombstones)', async () => {
    const msTask = createMsTask({ id: 'ms-tombstone', title: '' });
    const localByMsId = new Map<string, Task>();
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-1', displayName: 'Passion / Walnut' },
      localByMsId,
      updateSpy,
      addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});
