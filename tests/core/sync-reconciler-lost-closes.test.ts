/**
 * Full reconcile vs. a close that only one side saw.
 *
 * Two shapes from the 2026-09 audit of 1,023 tracker-linked tasks:
 *   - 86 tasks COMPLETE here, still open remotely: the completion push was lost
 *     (dropped behind an in-flight push, or a plugin that was down), and the local
 *     row believed it had synced. The reconciler must push the completion again,
 *     but never over a remote edit made AFTER the completion (a teammate reopening).
 *   - 7 tasks closed remotely, still open here: the reconciler dropped the remote
 *     phase (RC8) while stamping _syncedAt with the close time, so the close was
 *     buried under the LWW watermark forever. A remote close of an open task must
 *     be applied, and an already-buried one must still be found.
 *
 * Effects are read from the real store (SQLite) and from the plugin's pushTask spy;
 * nothing here goes through ctx spies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-lost-closes'));

const mockSessions: Array<{ claudeSessionId: string; process_status: string }> = [];
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => mockSessions),
  unlinkSessionsFromTasks: vi.fn(async () => 0),
  relinkSessionsToTask: vi.fn(async () => 0),
  completeTaskSessions: vi.fn(async () => 0),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler } from '../../src/core/sync-reconciler.js';
import { registry } from '../../src/core/integration-registry.js';
import { _resetForTesting, addTasksBulk, getTask, listTasks } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { createMockPlugin, createNoopSync } from './plugin-test-utils.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN_ID = 'tracker';
const T0 = '2026-08-01T10:00:00.000Z';
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Local task',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Proj',
    source: PLUGIN_ID,
    session_ids: [],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    description: '',
    summary: '',
    note: '',
    ext: {},
    ...overrides,
  } as unknown as Task;
}

function remoteItem(remoteId: string, overrides: Partial<RemoteSyncItem> & { open?: boolean } = {}): RemoteSyncItem {
  const { open = true, fields, ...rest } = overrides;
  return {
    remoteId,
    title: 'Local task',
    remoteUpdatedAt: T0,
    ...rest,
    fields: {
      project: 'Proj',
      status: open ? 'todo' : 'done',
      phase: open ? 'TODO' : 'COMPLETE',
      ...fields,
    } as Partial<Task>,
  };
}

let pushed: Array<{ id: string; phase: string }> = [];
let pushShouldFail = false;

function installPlugin(fullPullResult: RemoteSyncItem[]): RegisteredPlugin {
  const sync = createNoopSync();
  sync.pushTask = async (task: Task) => {
    if (pushShouldFail) throw new Error('remote said no');
    pushed.push({ id: task.id, phase: task.phase });
    return { serverTimestamp: new Date().toISOString() };
  };
  sync.fullPull = async () => fullPullResult;
  sync.extractRemoteId = (task: Task) => (task.ext?.[PLUGIN_ID] as { id?: string } | undefined)?.id;
  const plugin = createMockPlugin({ id: PLUGIN_ID, sync });
  if (registry.has(PLUGIN_ID)) registry.unregister(PLUGIN_ID);
  registry.register(PLUGIN_ID, plugin);
  return plugin;
}

function ctxFor(tasks: Task[]): SyncPollContext {
  return {
    getTasks: () => [...tasks],
    addTask: vi.fn(async (data) => ({ id: 'unused', ...data }) as Task),
    updateTask: vi.fn(async (id, updates) => ({ id, ...updates }) as Task),
    deleteTask: vi.fn(async () => {}),
    emit: vi.fn(),
  };
}

async function reconcile(plugin: RegisteredPlugin, seed: Task[]): Promise<void> {
  await addTasksBulk(seed);
  const reconciler = new SyncReconciler();
  await reconciler.tick(plugin, ctxFor(await listTasks()));
}

beforeEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  pushed = [];
  pushShouldFail = false;
});

afterEach(() => {
  if (registry.has(PLUGIN_ID)) registry.unregister(PLUGIN_ID);
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('a completion the remote never received is pushed again', () => {
  it('remote untouched since before the completion, row believes it synced: re-pushed', async () => {
    // The plugin-was-down shape once the row's sync_error has been cleared by some
    // later push that reported success without carrying the close.
    const done = makeTask({
      id: 'lost-1', status: 'done', phase: 'COMPLETE',
      completed_at: plus(T0, 60_000), updated_at: plus(T0, 60_000), _syncedAt: plus(T0, 60_000),
      ext: { [PLUGIN_ID]: { id: 'r1' } },
    });
    const plugin = installPlugin([remoteItem('r1', { remoteUpdatedAt: T0, open: true })]);
    await reconcile(plugin, [done]);

    expect(pushed).toEqual([{ id: 'lost-1', phase: 'COMPLETE' }]);
    const stored = await getTask('lost-1');
    expect(stored?.phase).toBe('COMPLETE');
    expect(stored?.sync_error).toBeUndefined();
  });

  it('a row that already carries a sync_error is the retry schedule\'s, not the reconciler\'s', async () => {
    // The sync loop retries sync_error rows with backoff (5 per tick); re-pushing them
    // here too would double the calls and bypass the backoff a permanently refused
    // task relies on.
    const done = makeTask({
      id: 'errored', status: 'done', phase: 'COMPLETE',
      completed_at: plus(T0, 60_000), updated_at: plus(T0, 60_000),
      sync_error: 'Plugin "tracker" not loaded, task not synced',
      ext: { [PLUGIN_ID]: { id: 'r1e' } },
    });
    const plugin = installPlugin([remoteItem('r1e', { remoteUpdatedAt: T0, open: true })]);
    await reconcile(plugin, [done]);
    expect(pushed).toEqual([]);
    expect((await getTask('errored'))?.sync_error).toBeTruthy();
  });

  it('a later local edit to a finished task does not turn a teammate\'s reopen into "lost"', async () => {
    // Local COMPLETE at T; the remote is edited (reopened) an hour later; a bulk
    // migration bumps updated_at a week after that. Intent is the completion time.
    const completedAt = plus(T0, 5_000);
    const done = makeTask({
      id: 'edited-later', status: 'done', phase: 'COMPLETE',
      completed_at: completedAt, updated_at: plus(completedAt, 7 * 86_400_000), _syncedAt: completedAt,
      ext: { [PLUGIN_ID]: { id: 'r1l' } },
    });
    const plugin = installPlugin([remoteItem('r1l', { remoteUpdatedAt: plus(completedAt, 3_600_000), open: true })]);
    await reconcile(plugin, [done]);
    expect(pushed).toEqual([]);
  });

  it('remote touched by our own stale push, within a second of the completion: re-pushed', async () => {
    // The in-flight-coalescing shape: the stale push landed 300ms after the local
    // completion and the row recorded success. The remote is "newer" than
    // completed_at by less than the skew allowance, so it still reads as ours.
    const completedAt = plus(T0, 5_000);
    const done = makeTask({
      id: 'lost-2', status: 'done', phase: 'COMPLETE',
      completed_at: completedAt, updated_at: completedAt,
      _syncedAt: plus(completedAt, 300),
      ext: { [PLUGIN_ID]: { id: 'r2' } },
    });
    const plugin = installPlugin([remoteItem('r2', { remoteUpdatedAt: plus(completedAt, 300), open: true })]);
    await reconcile(plugin, [done]);
    expect(pushed.map((p) => p.id)).toEqual(['lost-2']);
  });

  it('a teammate reopened it AFTER our completion: left alone, not re-closed', async () => {
    const completedAt = plus(T0, 5_000);
    const done = makeTask({
      id: 'reopened', status: 'done', phase: 'COMPLETE',
      completed_at: completedAt, updated_at: completedAt, _syncedAt: completedAt,
      ext: { [PLUGIN_ID]: { id: 'r3' } },
    });
    const plugin = installPlugin([remoteItem('r3', { remoteUpdatedAt: plus(completedAt, 3_600_000), open: true })]);
    await reconcile(plugin, [done]);
    expect(pushed).toEqual([]);
    // RC8 still holds too: the remote reopen does not reopen the local row.
    expect((await getTask('reopened'))?.phase).toBe('COMPLETE');
  });

  it('remote already closed: nothing to push', async () => {
    const done = makeTask({
      id: 'fine', status: 'done', phase: 'COMPLETE',
      completed_at: plus(T0, 1000), updated_at: plus(T0, 1000), _syncedAt: plus(T0, 1000),
      ext: { [PLUGIN_ID]: { id: 'r4' } },
    });
    const plugin = installPlugin([remoteItem('r4', { remoteUpdatedAt: plus(T0, 1200), open: false })]);
    await reconcile(plugin, [done]);
    expect(pushed).toEqual([]);
  });

  it('a mapper that reports no state says nothing: no re-push on guesswork', async () => {
    const done = makeTask({
      id: 'opaque', status: 'done', phase: 'COMPLETE',
      completed_at: plus(T0, 1000), updated_at: plus(T0, 1000),
      ext: { [PLUGIN_ID]: { id: 'r5' } },
    });
    const item = remoteItem('r5', { remoteUpdatedAt: T0 });
    delete item.fields.phase;
    delete item.fields.status;
    const plugin = installPlugin([item]);
    await reconcile(plugin, [done]);
    expect(pushed).toEqual([]);
  });

  it('a failing re-push records sync_error and leaves the row COMPLETE', async () => {
    pushShouldFail = true;
    const done = makeTask({
      id: 'lost-3', status: 'done', phase: 'COMPLETE',
      completed_at: plus(T0, 1000), updated_at: plus(T0, 1000),
      ext: { [PLUGIN_ID]: { id: 'r6' } },
    });
    const plugin = installPlugin([remoteItem('r6', { remoteUpdatedAt: T0, open: true })]);
    await reconcile(plugin, [done]);
    const stored = await getTask('lost-3');
    expect(stored?.phase).toBe('COMPLETE');
    expect(stored?.sync_error).toBe('remote said no');
  });

  it('the batch is bounded; the rest wait for the next cycle', async () => {
    const seed: Task[] = [];
    const items: RemoteSyncItem[] = [];
    for (let i = 0; i < 55; i++) {
      seed.push(makeTask({
        id: `bulk-${i}`, status: 'done', phase: 'COMPLETE',
        completed_at: plus(T0, 1000), updated_at: plus(T0, 1000),
        ext: { [PLUGIN_ID]: { id: `rb${i}` } },
      }));
      items.push(remoteItem(`rb${i}`, { remoteUpdatedAt: T0, open: true }));
    }
    const plugin = installPlugin(items);
    await reconcile(plugin, seed);
    expect(pushed).toHaveLength(50);
  });

  it('a rate-limit refusal stops the batch; the rest are left untouched for the next cycle', async () => {
    // The live tracker answered pushes 15-50 with "ThrottlingException: Rate exceeded"
    // once the reconciler hammered it. Every push after the first refusal would fail the
    // same way and stamp a sync_error on a row that has nothing wrong with it.
    const seed: Task[] = [];
    const items: RemoteSyncItem[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(makeTask({
        id: `rl-${i}`, status: 'done', phase: 'COMPLETE',
        completed_at: plus(T0, 1000), updated_at: plus(T0, 1000),
        ext: { [PLUGIN_ID]: { id: `rl${i}` } },
      }));
      items.push(remoteItem(`rl${i}`, { remoteUpdatedAt: T0, open: true }));
    }
    const plugin = installPlugin(items);
    let attempts = 0;
    plugin.sync!.pushTask = async (task: Task) => {
      attempts++;
      if (attempts > 4) throw new Error('Tracker GraphQL error: ThrottlingException: Rate exceeded');
      pushed.push({ id: task.id, phase: task.phase });
      return { serverTimestamp: new Date().toISOString() };
    };
    await reconcile(plugin, seed);
    expect(pushed).toHaveLength(4);
    // Two workers each meet the refusal at most once, then both stop: at most two
    // rows carry a sync_error, the other fourteen are untouched.
    expect(attempts).toBeLessThanOrEqual(6);
    const errored = (await listTasks()).filter((t) => t.sync_error);
    expect(errored.length).toBeGreaterThanOrEqual(1);
    expect(errored.length).toBeLessThanOrEqual(2);
    expect(errored.every((t) => /Rate exceeded/.test(t.sync_error!))).toBe(true);
  });

  it('a push that throws (not a plugin refusal) counts as one failure and the batch goes on', async () => {
    const seed = [0, 1, 2].map((i) => makeTask({
      id: `throw-${i}`, status: 'done', phase: 'COMPLETE',
      completed_at: plus(T0, 1000), updated_at: plus(T0, 1000),
      ext: { [PLUGIN_ID]: { id: `th${i}` } },
    }));
    const plugin = installPlugin(seed.map((_, i) => remoteItem(`th${i}`, { remoteUpdatedAt: T0, open: true })));
    let attempts = 0;
    plugin.sync!.pushTask = async (task: Task) => {
      attempts++;
      if (task.id === 'throw-1') throw new TypeError('mapper blew up');
      pushed.push({ id: task.id, phase: task.phase });
      return { serverTimestamp: new Date().toISOString() };
    };
    await expect(reconcile(plugin, seed)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(pushed.map((p) => p.id).sort()).toEqual(['throw-0', 'throw-2']);
    expect((await getTask('throw-1'))?.sync_error).toContain('mapper blew up');
  });
});

describe('a remote close of a task still open here is applied', () => {
  it('remote newer than the watermark: the row becomes COMPLETE with the remote close time', async () => {
    const open = makeTask({
      id: 'closed-remotely', updated_at: T0, _syncedAt: T0,
      ext: { [PLUGIN_ID]: { id: 'c1' } },
    });
    const closedAt = plus(T0, 86_400_000);
    const plugin = installPlugin([remoteItem('c1', { remoteUpdatedAt: closedAt, open: false })]);
    await reconcile(plugin, [open]);

    const stored = await getTask('closed-remotely');
    expect(stored?.phase).toBe('COMPLETE');
    expect(stored?.status).toBe('done');
    expect(stored?.completed_at).toBe(closedAt);
    expect(stored?.unread).toBeFalsy();
    expect(pushed).toEqual([]);  // pull only: nothing goes back to the remote
  });

  it('a close an earlier cycle buried (watermark == remote close time) is still applied', async () => {
    // _syncedAt was stamped with the close time while the phase was dropped, so
    // the LWW check alone would never look at this row again.
    const closedAt = plus(T0, 86_400_000);
    const open = makeTask({
      id: 'buried', phase: 'IN_PROGRESS', status: 'in_progress',
      updated_at: T0, _syncedAt: closedAt,
      ext: { [PLUGIN_ID]: { id: 'c2' } },
    });
    const plugin = installPlugin([remoteItem('c2', { remoteUpdatedAt: closedAt, open: false })]);
    await reconcile(plugin, [open]);
    expect((await getTask('buried'))?.phase).toBe('COMPLETE');
  });

  it('local edited AFTER the remote close: local wins, the row stays open', async () => {
    const closedAt = plus(T0, 60_000);
    const open = makeTask({
      id: 'edited-later', phase: 'IN_PROGRESS', status: 'in_progress',
      updated_at: plus(closedAt, 3_600_000), _syncedAt: T0,
      ext: { [PLUGIN_ID]: { id: 'c3' } },
    });
    const plugin = installPlugin([remoteItem('c3', { remoteUpdatedAt: closedAt, open: false })]);
    await reconcile(plugin, [open]);
    expect((await getTask('edited-later'))?.phase).toBe('IN_PROGRESS');
  });

  it('the tracker stamps the close a second BEFORE our last push: still applied (skew grace)', async () => {
    // Observed on the live tracker: lastUpdated 1s behind the push that closed it.
    const pushedAt = plus(T0, 60_000);
    const open = makeTask({
      id: 'skewed', phase: 'IN_PROGRESS', status: 'in_progress',
      updated_at: pushedAt, _syncedAt: pushedAt,
      ext: { [PLUGIN_ID]: { id: 'c3s' } },
    });
    const plugin = installPlugin([remoteItem('c3s', { remoteUpdatedAt: plus(pushedAt, -1_000), open: false })]);
    await reconcile(plugin, [open]);
    expect((await getTask('skewed'))?.phase).toBe('COMPLETE');
  });

  it('local edited well outside the grace after the remote close: stays open', async () => {
    const closedAt = plus(T0, 60_000);
    const open = makeTask({
      id: 'edited-30s', phase: 'IN_PROGRESS', status: 'in_progress',
      updated_at: plus(closedAt, 30_000), _syncedAt: T0,
      ext: { [PLUGIN_ID]: { id: 'c3t' } },
    });
    const plugin = installPlugin([remoteItem('c3t', { remoteUpdatedAt: closedAt, open: false })]);
    await reconcile(plugin, [open]);
    expect((await getTask('edited-30s'))?.phase).toBe('IN_PROGRESS');
  });

  it('a remote non-terminal phase still never drives the local phase (RC8)', async () => {
    const local = makeTask({
      id: 'rc8', phase: 'IN_PROGRESS', status: 'in_progress', updated_at: T0, _syncedAt: T0,
      ext: { [PLUGIN_ID]: { id: 'c4' } },
    });
    const plugin = installPlugin([remoteItem('c4', {
      remoteUpdatedAt: plus(T0, 86_400_000), fields: { title: 'renamed remotely', phase: 'TODO', status: 'todo' },
    })]);
    await reconcile(plugin, [local]);
    const stored = await getTask('rc8');
    expect(stored?.title).toBe('renamed remotely');
    expect(stored?.phase).toBe('IN_PROGRESS');
  });

  it('a remote close of an already COMPLETE row changes nothing (no echo write)', async () => {
    const completedAt = plus(T0, 1000);
    const done = makeTask({
      id: 'already', status: 'done', phase: 'COMPLETE',
      completed_at: completedAt, updated_at: completedAt, _syncedAt: completedAt,
      ext: { [PLUGIN_ID]: { id: 'c5' } },
    });
    const plugin = installPlugin([remoteItem('c5', { remoteUpdatedAt: plus(completedAt, 500), open: false })]);
    await reconcile(plugin, [done]);
    const stored = await getTask('already');
    expect(stored?.completed_at).toBe(completedAt);
    expect(pushed).toEqual([]);
  });
});
