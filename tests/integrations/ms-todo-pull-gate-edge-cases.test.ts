/**
 * Edge-case tests for the DELTA pull path (reconcilePulledTasks) + the durable
 * ledger it consults (2026-08-21). The full-reconcile path is covered in
 * tests/core/sync-reconciler-edge-cases.test.ts; this file pins the OTHER pull
 * door — the 30s delta tick — against the same identity contract:
 *
 *   - the ledger gate blocks CREATES only (updates to a live task still apply)
 *   - a [Moved]-marked item ledgers its release ON SIGHT, so even a marker
 *     written by a pre-ledger build converges to never-re-import
 *   - the legacy capped deletedMsIds set and the durable ledger both gate
 *   - ledger retry-list semantics that drive the sync tick's Step 1.6
 *     (oldest-first, limit, released rows exempt)
 *
 * Graph I/O is fully mocked; the task DB is real (temp dir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('ms-todo-pull-gate'));

import { WALNUT_HOME } from '../../src/constants.js';
import { reconcilePulledTasks } from '../../src/integrations/microsoft-todo.js';
import * as taskManager from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import {
  recordRemoteLink,
  getRemoteLink,
  isRemoteIdBlocked,
  listUnconfirmedRemoteDeletes,
  confirmRemoteDelete,
} from '../../src/core/task-remote-links.js';
import type { Task, TaskPhase } from '../../src/core/types.js';

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
    ext: { 'ms-todo': { id: 'ms-task-1', list_id: 'list-1' } },
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

function mockFindByExtId(local: Map<string, Task>) {
  return vi
    .spyOn(taskManager, 'findTaskByExtId')
    .mockImplementation(async (source, extId) => {
      if (source !== 'ms-todo') return undefined;
      return local.get(extId);
    });
}

const LIST = { id: 'list-1', displayName: 'Personal / Walnut' };

async function openDb(): Promise<void> {
  // Any task-manager write opens the SQLite handle the ledger shares.
  await taskManager.addTask({ title: 'db-boot', project: 'Boot' });
}

beforeEach(async () => {
  closeDb();
  taskManager._resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
  vi.restoreAllMocks();
});

afterEach(() => {
  closeDb();
  taskManager._resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ledger gate on the delta-pull create branch
// ═══════════════════════════════════════════════════════════════════════════

describe('delta pull × ledger gate', () => {
  it('G1: a released remote id never mints a task through the DELTA path either', async () => {
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'ms-released', taskId: 'old', state: 'released' });
    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [createMsTask({ id: 'ms-released', title: 'Orphaned twin' })],
      LIST, vi.fn(), addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('G2: a deleted remote id never mints a task through the delta path', async () => {
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'ms-dead', state: 'deleted' });
    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [createMsTask({ id: 'ms-dead', title: 'Zombie' })],
      LIST, vi.fn(), addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it('G3: the gate blocks CREATES only — a matched LIVE task still receives updates', async () => {
    // Ledger says released (e.g. a stale row from an aborted migration), but a
    // local task demonstrably still owns the id. The update path must not be
    // gated: blocking it would freeze a healthy task forever.
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'ms-task-1', taskId: 'task-001', state: 'released' });
    const local = createLocalTask({ updated_at: '2026-02-24T06:00:00Z' });
    mockFindByExtId(new Map([['ms-task-1', local]]));
    const updateSpy = vi.fn();

    const count = await reconcilePulledTasks(
      [createMsTask({ title: 'Fresh remote edit', lastModifiedDateTime: '2026-02-25T18:00:00Z' })],
      LIST, updateSpy, vi.fn().mockResolvedValue({} as Task),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(count).toBe(1);
  });

  it('G4: one gated item does not stop the rest of the delta batch', async () => {
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'ms-blocked', state: 'deleted' });
    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [
        createMsTask({ id: 'ms-blocked', title: 'Zombie' }),
        createMsTask({ id: 'ms-fine', title: 'Legit new' }),
      ],
      LIST, vi.fn(), addSpy,
    );

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Legit new' }));
    expect(count).toBe(1);
  });

  it('G5: legacy deletedMsIds set gates BEFORE the ledger (both doors closed)', async () => {
    await openDb();
    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [createMsTask({ id: 'ms-legacy-dead', title: 'Old-style tombstone' })],
      LIST, vi.fn(), addSpy,
      undefined, new Set(['ms-legacy-dead']),
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// [Moved]-marker → ledger convergence
// ═══════════════════════════════════════════════════════════════════════════

describe('[Moved] marker ledgers the release on sight', () => {
  it('G6: seeing a [Moved] item writes a released ledger row (pre-ledger builds converge)', async () => {
    await openDb();
    mockFindByExtId(new Map());

    await reconcilePulledTasks(
      [createMsTask({
        id: 'ms-moved-1',
        title: '[Moved] Migrated task [open-walnut:mabc1234-ffff]',
      })],
      LIST, vi.fn(), vi.fn().mockResolvedValue({} as Task),
    );

    const link = getRemoteLink('ms-todo', 'ms-moved-1');
    expect(link?.state).toBe('released');
    expect(link?.task_id).toBe('mabc1234-ffff');
    expect(link?.reason).toBe('moved-marker');
    // From now on even the FULL reconcile path (isRemoteIdBlocked) refuses it.
    expect(isRemoteIdBlocked('ms-todo', 'ms-moved-1')).toBe(true);
  });

  it('G7: a truncated [Moved] marker (no id suffix) still gates and still ledgers', async () => {
    await openDb();
    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [createMsTask({ id: 'ms-moved-trunc', title: '[Moved] lost my suffix' })],
      LIST, vi.fn(), addSpy,
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
    expect(isRemoteIdBlocked('ms-todo', 'ms-moved-trunc')).toBe(true);
  });

  it('G8: a title merely mentioning [Moved] mid-sentence is NOT gated', async () => {
    await openDb();
    mockFindByExtId(new Map());
    const addSpy = vi.fn().mockResolvedValue({} as Task);

    const count = await reconcilePulledTasks(
      [createMsTask({ id: 'ms-normal', title: 'Investigate the [Moved] label rendering' })],
      LIST, vi.fn(), addSpy,
    );

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(count).toBe(1);
    expect(getRemoteLink('ms-todo', 'ms-normal')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Retry-list semantics driving the sync tick's Step 1.6
// ═══════════════════════════════════════════════════════════════════════════

describe('unconfirmed remote-delete retry list', () => {
  it('G9: returns oldest-first and respects the per-tick limit', async () => {
    await openDb();
    // recordRemoteLink stamps updated_at=now for all three; force distinct
    // ordering through direct re-records in sequence (last write wins keeps
    // insertion order by updated_at only when they differ — so assert via
    // limit + membership, not strict order across equal timestamps).
    recordRemoteLink({ source: 'ms-todo', remoteId: 'd1', state: 'deleted' });
    recordRemoteLink({ source: 'ms-todo', remoteId: 'd2', state: 'deleted' });
    recordRemoteLink({ source: 'ms-todo', remoteId: 'd3', state: 'deleted' });

    const limited = listUnconfirmedRemoteDeletes('ms-todo', 2);
    expect(limited).toHaveLength(2);
    const all = listUnconfirmedRemoteDeletes('ms-todo', 10);
    expect(all.map((l) => l.remote_id).sort()).toEqual(['d1', 'd2', 'd3']);
  });

  it('G10: released rows and other sources never enter the retry list', async () => {
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'rel-1', state: 'released' });
    recordRemoteLink({ source: 'other-provider', remoteId: 'del-other', state: 'deleted' });
    recordRemoteLink({ source: 'ms-todo', remoteId: 'del-mine', state: 'deleted' });

    const pending = listUnconfirmedRemoteDeletes('ms-todo', 10);
    expect(pending.map((l) => l.remote_id)).toEqual(['del-mine']);
  });

  it('G11: confirmRemoteDelete is a no-op for released rows and unknown ids', async () => {
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'rel-1', state: 'released' });

    confirmRemoteDelete('ms-todo', 'rel-1');     // wrong state — must not flip
    confirmRemoteDelete('ms-todo', 'ghost');      // unknown — must not throw

    expect(getRemoteLink('ms-todo', 'rel-1')?.state).toBe('released');
    expect(getRemoteLink('ms-todo', 'rel-1')?.remote_delete_confirmed).toBe(false);
  });

  it('G12: a confirmed delete drops out of the list; unconfirmed peers stay (partial-failure tick)', async () => {
    // Simulates one Step-1.6 pass where d-ok confirms and d-fail's provider
    // call failed: the next tick must see ONLY d-fail.
    await openDb();
    recordRemoteLink({ source: 'ms-todo', remoteId: 'd-ok', state: 'deleted' });
    recordRemoteLink({ source: 'ms-todo', remoteId: 'd-fail', state: 'deleted' });

    confirmRemoteDelete('ms-todo', 'd-ok');

    const next = listUnconfirmedRemoteDeletes('ms-todo', 10);
    expect(next.map((l) => l.remote_id)).toEqual(['d-fail']);
  });
});
