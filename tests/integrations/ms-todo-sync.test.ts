/**
 * Tests for MS To-Do sync logic:
 * - reconcilePulledTasks: no project rollback when the local copy is newer
 * - autoPushTask: per-task dedup
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcilePulledTasks } from '../../src/integrations/microsoft-todo.js';
import * as taskManager from '../../src/core/task-manager.js';
import type { Task, TaskPhase } from '../../src/core/types.js';

// ── Helpers ──

function createLocalTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-001',
    title: 'Test task',
    status: 'todo',
    phase: 'TODO' as TaskPhase,
    priority: 'none',
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

/**
 * Mock `findTaskByExtId` to emulate the SQLite-indexed lookup that
 * replaced the pre-built `localByMsId` Map. Each test registers the local
 * tasks it wants to be findable by ms-id; the spy returns them accordingly.
 */
function mockFindByExtId(local: Map<string, Task>) {
  return vi
    .spyOn(taskManager, 'findTaskByExtId')
    .mockImplementation(async (source, extId) => {
      if (source !== 'ms-todo') return undefined;
      return local.get(extId);
    });
}

describe('reconcilePulledTasks — no project rollback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT roll back local project when local is newer than remote', async () => {
    // Local: project='Walnut', _syncedAt 12:00 (NEWER)
    // Remote: in a legacy "Passion / MyBot" list, modified 06:00 (OLDER)
    const localTask = createLocalTask({
      project: 'Walnut',
      updated_at: '2026-02-25T12:00:00Z',
      _syncedAt: '2026-02-25T12:00:00Z',
    });

    const msTask = createMsTask({
      lastModifiedDateTime: '2026-02-25T06:00:00Z',
    });

    mockFindByExtId(new Map([['ms-task-1', localTask]]));
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Passion / MyBot' },
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
      project: 'MyBot',
      updated_at: '2026-02-24T06:00:00Z',
    });

    const msTask = createMsTask({
      title: 'Updated from MS To-Do',
      lastModifiedDateTime: '2026-02-25T18:00:00Z',
    });

    mockFindByExtId(new Map([['ms-task-1', localTask]]));
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Passion / MyBot' },
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
    // Simulate: task moved from project HomeLab to project Walnut locally.
    // Remote still sits in the "Work / HomeLab" list, but local is newer.
    const localTask = createLocalTask({
      project: 'Walnut',
      updated_at: '2026-02-25T20:00:00Z', // very recent local change
      _syncedAt: '2026-02-25T20:00:00Z',
    });

    const msTask = createMsTask({
      lastModifiedDateTime: '2026-02-25T01:00:00Z', // old remote
    });

    mockFindByExtId(new Map([['ms-task-1', localTask]]));
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-homelab', displayName: 'Work / HomeLab' },
      updateSpy,
      addSpy,
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('creates new task for unknown remote task', async () => {
    const msTask = createMsTask({ id: 'ms-new-1', title: 'Brand new' });
    mockFindByExtId(new Map());
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({ id: 'new-local' } as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-1', displayName: 'Passion / Walnut' },
      updateSpy,
      addSpy,
    );

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Brand new',
      source: 'ms-todo',
      // Legacy two-level list name → trailing segment is the project.
      project: 'Walnut',
    }));
    expect(count).toBe(1);
  });

  it('skips tasks in deletedMsIds set', async () => {
    const msTask = createMsTask({ id: 'ms-deleted-1' });
    mockFindByExtId(new Map());
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-1', displayName: 'Passion / Walnut' },
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
    mockFindByExtId(new Map());
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-1', displayName: 'Passion / Walnut' },
      updateSpy,
      addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('falls back to previousIdsMap when primary lookup misses', async () => {
    // Local task was renamed: its current ms-id is "ms-task-new", but an older
    // id "ms-task-old" is still listed in its ext.previous_ids. When the delta
    // returns an update for the old id, reconcile should match it via the map.
    const localTask = createLocalTask({
      ext: {
        'ms-todo': {
          id: 'ms-task-new',
          list_id: 'list-mybot',
          previous_ids: ['ms-task-old'],
        },
      },
      updated_at: '2026-02-24T06:00:00Z',
    });
    const msTask = createMsTask({
      id: 'ms-task-old',
      title: 'Late-arriving update for renamed task',
      lastModifiedDateTime: '2026-02-25T18:00:00Z',
    });

    // Primary lookup misses — emulate a store that doesn't know "ms-task-old".
    mockFindByExtId(new Map());
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Passion / MyBot' },
      updateSpy,
      addSpy,
      undefined,
      undefined,
      new Map([['ms-task-old', localTask]]),
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith('task-001', expect.any(Object));
    expect(count).toBe(1);
  });
});

describe('reconcilePulledTasks — [Moved] marker gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never creates a task for a [Moved]-marked remote item', async () => {
    // The cross-source migration renames the OLD remote twin to
    // "[Moved] <title> [open-walnut:<taskId>]". A pull that sees this item
    // used to re-import it as a brand-new local task — the duplicate loop.
    const msTask = createMsTask({
      id: 'ms-task-moved',
      title: '[Moved] H-1B RFE follow-up [open-walnut:mszf18jd-f69a]',
      status: 'completed' as const,
      lastModifiedDateTime: '2026-02-25T18:00:00Z',
    });

    mockFindByExtId(new Map()); // ext already cleared by the migration
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Immigration' },
      updateSpy,
      addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('shields a matched local task from the [Moved] rename echo', async () => {
    // Race window: the pull sees the renamed remote twin BEFORE the local ext
    // is cleared (or via previous_ids). Without the gate the echo would
    // overwrite the local title with "[Moved] …".
    const localTask = createLocalTask({ updated_at: '2026-02-24T06:00:00Z' });
    const msTask = createMsTask({
      title: '[Moved] Test task [open-walnut:task-001]',
      lastModifiedDateTime: '2026-02-25T18:00:00Z',
    });

    mockFindByExtId(new Map([['ms-task-1', localTask]]));
    const updateSpy = vi.fn();
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Immigration' },
      updateSpy,
      addSpy,
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('still skips a bare [Moved] prefix whose id suffix was truncated', async () => {
    const msTask = createMsTask({
      id: 'ms-task-truncated',
      title: '[Moved] Some very long title that lost its id suffix somewhere along the way',
    });

    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [msTask],
      { id: 'list-mybot', displayName: 'Immigration' },
      vi.fn(),
      addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});
