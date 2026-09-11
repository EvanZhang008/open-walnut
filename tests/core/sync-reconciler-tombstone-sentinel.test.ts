/**
 * SyncReconciler — two things the 2026-09-08 investigation found in one tick:
 *
 *  1. `created: 3` on EVERY full reconcile, forever. Three retired
 *     `.metadata_project` sentinel twins were diffed as new, counted, and only
 *     then refused by addTasksBulk — so the one number that log line exists to
 *     report was a standing lie. Sentinels are now dropped BEFORE the diff.
 *  2. A remote list whose project the human DELETED re-created that project on
 *     the next reconcile. The reconciler resolves every pulled project through
 *     ensureProject, which now consults the project tombstone ledger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-tombstone'));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler } from '../../src/core/sync-reconciler.js';
import {
  _resetForTesting,
  deleteProject,
  ensureProject,
  getStoreProjects,
  listTasks,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { log } from '../../src/logging/index.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

function remoteItem(overrides: Partial<RemoteSyncItem> = {}): RemoteSyncItem {
  const { fields, ...rest } = overrides;
  return {
    remoteId: `remote-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Remote Task',
    remoteUpdatedAt: '2026-06-01T00:00:00Z',
    ...rest,
    fields: { project: 'Test', status: 'todo' as Task['status'], phase: 'TODO' as Task['phase'], ...fields },
  };
}

function makePlugin(items: RemoteSyncItem[]): RegisteredPlugin {
  const noop = vi.fn();
  return {
    id: 'ms-todo',
    name: 'Fake MS To-Do',
    config: {},
    sync: {
      createTask: noop, deleteTask: noop, updateTitle: noop, updateDescription: noop,
      updateSummary: noop, updateNote: noop, updateConversationLog: noop, updatePriority: noop,
      updatePhase: noop, updateDueDate: noop, updateProject: noop, updateDependencies: noop,
      pushTask: vi.fn().mockResolvedValue({ serverTimestamp: new Date().toISOString() }),
      associateSubtask: noop, disassociateSubtask: noop, syncPoll: noop,
      fullPull: vi.fn().mockResolvedValue(items),
      extractRemoteId: (task: Task) => (task.ext?.['ms-todo'] as { id?: string } | undefined)?.id,
    },
    migrations: [],
    httpRoutes: [],
  } as unknown as RegisteredPlugin;
}

function makeCtx(localTasks: Task[] = []): SyncPollContext {
  return {
    getTasks: () => [...localTasks],
    addTask: vi.fn(async (data) => ({ id: 'unused', ...data }) as Task),
    updateTask: vi.fn(async (id, updates) => ({ id, ...updates }) as Task),
    deleteTask: vi.fn(async () => {}),
    emit: vi.fn(),
  };
}

/** The `created` value the reconciler REPORTED for its completed cycle. */
function reportedCreated(info: ReturnType<typeof vi.spyOn>): number | undefined {
  const call = info.mock.calls.find(([msg]) => msg === 'sync-reconciler: full reconcile complete');
  return (call?.[1] as { created?: number } | undefined)?.created;
}

let reconciler: SyncReconciler;

beforeEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  reconciler = new SyncReconciler();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('retired .metadata sentinels', () => {
  it('are dropped before the diff, so `created` counts only real writes', async () => {
    const info = vi.spyOn(log.web, 'info');
    const items = [
      remoteItem({ remoteId: 's1', title: '.metadata_project' }),
      remoteItem({ remoteId: 's2', title: '.metadata_project', fields: { project: 'Other' } }),
      remoteItem({ remoteId: 's3', title: '  .metadata_category  ' }),
      remoteItem({ remoteId: 'r1', title: 'A real task' }),
    ];

    await reconciler.tick(makePlugin(items), makeCtx([]));

    // One real row written…
    expect((await listTasks()).map((t) => t.title)).toEqual(['A real task']);
    // …and the log says exactly that (it used to say 4).
    expect(reportedCreated(info)).toBe(1);
    const complete = info.mock.calls.find(([m]) => m === 'sync-reconciler: full reconcile complete');
    expect(complete?.[1]).toMatchObject({ sentinelsDropped: 3, remoteCount: 1 });
  });

  it('a pull of ONLY sentinels reports created: 0 and touches nothing', async () => {
    const info = vi.spyOn(log.web, 'info');
    await reconciler.tick(makePlugin([
      remoteItem({ remoteId: 's1', title: '.metadata_project' }),
      remoteItem({ remoteId: 's2', title: '.metadata_project' }),
      remoteItem({ remoteId: 's3', title: '.metadata_project' }),
    ]), makeCtx([]));

    expect(await listTasks()).toHaveLength(0);
    expect(reportedCreated(info)).toBe(0);
    // No project row manufactured for a sentinel-only list either.
    expect(Object.keys(await getStoreProjects())).toHaveLength(0);
  });
});

describe('a deleted project is not re-created by a full reconcile', () => {
  it('refuses the import and leaves the registry without the row', async () => {
    // The exact 2026-09-08 shape: the project existed here, the human deleted it,
    // and the remote list of the same name is still alive with an item in it.
    await ensureProject('Fix Walnut', 'local');
    await deleteProject('Fix Walnut');

    const warn = vi.spyOn(log.web, 'warn');
    await reconciler.tick(
      makePlugin([remoteItem({ remoteId: 'probe-1', title: 'A8 probe plain', fields: { project: 'Fix Walnut' } })]),
      makeCtx([]),
    );

    expect(await listTasks()).toHaveLength(0);
    expect(Object.keys(await getStoreProjects())).not.toContain('Fix Walnut');
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('DELETED project'))).toBe(true);
  });

  it('still imports items for a project that is merely NEW', async () => {
    await reconciler.tick(
      makePlugin([remoteItem({ remoteId: 'ok-1', title: 'Legit', fields: { project: 'Fresh Project' } })]),
      makeCtx([]),
    );
    expect((await listTasks()).map((t) => t.title)).toEqual(['Legit']);
    expect(Object.keys(await getStoreProjects())).toContain('Fresh Project');
  });
});

/** Only Date is faked: the reconciler's cadence reads Date.now(), and nothing
 *  else here should see a frozen clock (the store still writes real files). */
function advancePastFullInterval(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 31 * 60_000);
}

describe('the UNLINKED state: a remote list and a LOCAL project share a name', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 2026-09-08, 07:12 → 21:10: every full reconcile logged `created: 15` while
  // writing nothing — 12 of those were refused by this exact gate, and the
  // intent-shaped counter hid it for 14 hours.
  it('reports what LANDED, and names the refusal, instead of counting the intent', async () => {
    await ensureProject('Fix Walnut', 'local'); // live LOCAL row, no link to any list
    const info = vi.spyOn(log.web, 'info');
    const warn = vi.spyOn(log.web, 'warn');

    await reconciler.tick(
      makePlugin([remoteItem({ remoteId: 'probe-1', title: 'A8 probe plain', fields: { project: 'Fix Walnut' } })]),
      makeCtx([]),
    );

    expect(await listTasks()).toHaveLength(0);
    const complete = info.mock.calls.find(([m]) => m === 'sync-reconciler: full reconcile complete');
    expect(complete?.[1]).toMatchObject({
      created: 0, createsIntended: 1, refusedItems: 1, refusedProjects: ['Fix Walnut'],
    });
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('matches a LOCAL project'))).toBe(true);
    // The local project is untouched — binding it to the list automatically
    // would start pushing the user's local tasks into an account nobody asked to sync.
    expect((await getStoreProjects())['Fix Walnut']?.source).toBe('local');
  });

  it('a refusal that repeats for 3 reconciles escalates ONCE to log.error, with a remedy', async () => {
    await ensureProject('Fix Walnut', 'local');
    const error = vi.spyOn(log.web, 'error');
    const plugin = makePlugin([remoteItem({ remoteId: 'probe-1', title: 'A8 probe plain', fields: { project: 'Fix Walnut' } })]);

    for (let i = 0; i < 5; i++) {
      // Each tick must be a FULL reconcile: the first is by definition, the rest
      // ride the 30-minute time fallback, so the clock is moved past it.
      await reconciler.tick(plugin, makeCtx([]));
      advancePastFullInterval();
    }

    const escalations = error.mock.calls.filter(([m]) => m === 'Task sync cannot import a remote list');
    expect(escalations).toHaveLength(1);
    expect(escalations[0][1]).toMatchObject({
      pluginId: 'ms-todo', project: 'Fix Walnut', reason: 'local-project', consecutiveReconciles: 3,
    });
    expect(String((escalations[0][1] as { remedy?: string }).remedy)).toContain('LOCAL project');
  });

  it('a refusal that stops resets the streak — nothing is escalated for a mismatch that healed', async () => {
    await ensureProject('Fix Walnut', 'local');
    const error = vi.spyOn(log.web, 'error');
    const stuck = makePlugin([remoteItem({ remoteId: 'probe-1', title: 'A8 probe plain', fields: { project: 'Fix Walnut' } })]);
    const healed = makePlugin([]);

    await reconciler.tick(stuck, makeCtx([]));
    advancePastFullInterval();
    await reconciler.tick(stuck, makeCtx([]));
    advancePastFullInterval();
    await reconciler.tick(healed, makeCtx([])); // list gone → streak cleared
    advancePastFullInterval();
    await reconciler.tick(stuck, makeCtx([]));  // a fresh count starts at 1

    expect(error.mock.calls.filter(([m]) => m === 'Task sync cannot import a remote list')).toHaveLength(0);
  });
});
