/**
 * SyncReconciler: a task that lost the field its plugin joins on is still that
 * remote item.
 *
 * 2026-10-25: one tracker plugin joins on a display id (`ext.<id>.short_id`)
 * while the database keeps `ext.<id>.id` unique per source. 22 completed tasks
 * had the id but no display id, so every full sync saw their 16 remote items as
 * new, tried to create them, and had each create refused as a duplicate (16
 * warnings a cycle, forever). The reconciler now joins such a task by the ext
 * id the remote item carries, and gives it back its key.
 *
 * Real: task DB, reconciler, apply path. Only the plugin's pull is a fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-rejoin'));
vi.mock('../../src/core/session-tracker.js', () => ({ listSessions: vi.fn(async () => []) }));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler } from '../../src/core/sync-reconciler.js';
import { _resetForTesting, listTasks, updateTasksBulk } from '../../src/core/task-manager.js';
import { closeDb, ensureExtIndexes } from '../../src/core/task-db.js';
import { setExtIndexes, _resetForTesting as resetExtIndexes } from '../../src/core/ext-index-registry.js';
import { log } from '../../src/logging/index.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN = 'acme';
/** The plugin's registered identity, as the real one registers it: UNIQUE `ext.<id>.id`. */
const SPEC = { source: PLUGIN, paths: [{ key: 'id', json: `$.${PLUGIN}.id` }] };

function item(shortId: string, extId: string | undefined, over: Partial<RemoteSyncItem> = {}, fields: Partial<Task> = {}): RemoteSyncItem {
  return {
    remoteId: shortId,
    title: `Item ${shortId}`,
    remoteUpdatedAt: '2026-06-01T00:00:00Z',
    ...over,
    fields: {
      project: 'Test', status: 'done' as Task['status'], phase: 'COMPLETE' as Task['phase'],
      ...(extId ? { ext: { [PLUGIN]: { id: extId, short_id: shortId } } } : {}),
      ...fields,
    },
  };
}

function makePlugin(items: RemoteSyncItem[]): RegisteredPlugin {
  const noop = vi.fn();
  return {
    id: PLUGIN, name: 'Fake tracker', config: {},
    sync: {
      createTask: noop, deleteTask: noop, updateTitle: noop, updateDescription: noop,
      updateSummary: noop, updateNote: noop, updateConversationLog: noop, updatePriority: noop,
      updatePhase: noop, updateDueDate: noop, updateProject: noop, updateDependencies: noop,
      pushTask: vi.fn().mockResolvedValue({ serverTimestamp: new Date().toISOString() }),
      associateSubtask: noop, disassociateSubtask: noop, syncPoll: noop,
      fullPull: vi.fn().mockResolvedValue(items),
      // Joins on the DISPLAY id, like the plugin that hit this.
      extractRemoteId: (task: Task) => (task.ext?.[PLUGIN] as { short_id?: string } | undefined)?.short_id,
    },
    migrations: [], httpRoutes: [],
  } as unknown as RegisteredPlugin;
}

/** The reconciler reads local tasks through the context, as the server hands them over. */
function ctx(tasks: Task[] = []): SyncPollContext {
  return {
    getTasks: () => [...tasks], addTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(async () => {}), emit: vi.fn(),
  } as unknown as SyncPollContext;
}

const complete = (info: ReturnType<typeof vi.spyOn>) =>
  info.mock.calls.filter(([m]) => m === 'sync-reconciler: full reconcile complete').at(-1)?.[1] as Record<string, unknown> | undefined;

/** Import the item, then drop its display id, the state the 22 tasks were in. */
async function unkeyedTask(r: SyncReconciler, it: RemoteSyncItem, extra: Record<string, unknown> = {}): Promise<Task> {
  await listTasks(); // opens the DB
  ensureExtIndexes([SPEC]);
  await r.tick(makePlugin([it]), ctx(await listTasks()));
  const task = (await listTasks()).find(t => t.title === it.title)!;
  const ext = { ...(task.ext as Record<string, Record<string, unknown>>) };
  ext[PLUGIN] = { id: (ext[PLUGIN] as { id: string }).id, ...extra };
  await updateTasksBulk([{ id: task.id, patch: { ext } as Partial<Task> }]);
  return (await listTasks()).find(t => t.id === task.id)!;
}

function advance(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 31 * 60_000);
}

let reconciler: SyncReconciler;

beforeEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  setExtIndexes([SPEC]);
  reconciler = new SyncReconciler();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetExtIndexes();
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('a task that lost its join key', () => {
  it('is joined by its ext id: no create, the key comes back, and the next cycle matches it as usual', async () => {
    const task = await unkeyedTask(reconciler, item('S-1', 'uuid-1'));
    expect((task.ext?.[PLUGIN] as Record<string, unknown>).short_id).toBeUndefined();
    const info = vi.spyOn(log.web, 'info');
    const warn = vi.spyOn(log.task, 'warn');
    advance();

    await reconciler.tick(makePlugin([item('S-1', 'uuid-1')]), ctx(await listTasks()));

    const tasks = await listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].ext?.[PLUGIN]).toMatchObject({ id: 'uuid-1', short_id: 'S-1' });
    expect(complete(info)).toMatchObject({ created: 0, rejoined: 1 });
    expect(complete(info)?.createsIntended).toBeUndefined();
    expect(warn.mock.calls.filter(([m]) => String(m).includes('UNIQUE'))).toHaveLength(0);

    advance();
    await reconciler.tick(makePlugin([item('S-1', 'uuid-1')]), ctx(await listTasks()));
    expect(complete(info)?.rejoined).toBeUndefined();
    expect(complete(info)?.createsIntended).toBeUndefined();
    expect(await listTasks()).toHaveLength(1);
  });

  it('a remote change newer than the task is applied as an update, which also restores the key', async () => {
    const task = await unkeyedTask(reconciler, item('S-2', 'uuid-2'));
    advance();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    await reconciler.tick(makePlugin([item('S-2', 'uuid-2', { title: 'Renamed remotely', remoteUpdatedAt: later }, { title: 'Renamed remotely' })]), ctx(await listTasks()));
    const [after] = await listTasks();
    expect(after.id).toBe(task.id);
    expect(after.title).toBe('Renamed remotely');
    expect(after.ext?.[PLUGIN]).toMatchObject({ id: 'uuid-2', short_id: 'S-2' });
  });

  it('a remote item with no ext id, or another ext id, is still a new task', async () => {
    await unkeyedTask(reconciler, item('S-3', 'uuid-3'));
    advance();
    await reconciler.tick(makePlugin([item('S-3', 'uuid-3'), item('S-4', undefined), item('S-5', 'uuid-5')]), ctx(await listTasks()));
    const titles = (await listTasks()).map(t => t.title).sort();
    expect(titles).toEqual(['Item S-3', 'Item S-4', 'Item S-5']);
  });

  it('two remote items naming the same ext id join it once; the other is not a second owner', async () => {
    const task = await unkeyedTask(reconciler, item('S-6', 'uuid-6'));
    advance();
    await reconciler.tick(makePlugin([item('S-6', 'uuid-6'), item('S-6b', 'uuid-6')]), ctx(await listTasks()));
    const tasks = await listTasks();
    expect(tasks.filter(t => (t.ext?.[PLUGIN] as Record<string, unknown> | undefined)?.id === 'uuid-6').map(t => t.id)).toEqual([task.id]);
    expect((tasks.find(t => t.id === task.id)!.ext?.[PLUGIN] as Record<string, unknown>).short_id).toBe('S-6');
  });

  it('the local ext keeps its own values; the remote only fills the missing key', async () => {
    const task = await unkeyedTask(reconciler, item('S-8', 'uuid-8'), { list: 'local-choice' });
    advance();
    await reconciler.tick(makePlugin([item('S-8', 'uuid-8', {}, { ext: { [PLUGIN]: { id: 'uuid-8', short_id: 'S-8', list: 'remote-old' } } })]), ctx(await listTasks()));
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.ext?.[PLUGIN]).toEqual({ id: 'uuid-8', list: 'local-choice', short_id: 'S-8' });
  });

  it('an open task whose remote copy was closed since its last edit is closed, and keyed again', async () => {
    const task = await unkeyedTask(reconciler, item('S-9', 'uuid-9', {}, { status: 'todo' as Task['status'], phase: 'TODO' as Task['phase'] }));
    expect(task.phase).not.toBe('COMPLETE');
    advance();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    await reconciler.tick(makePlugin([item('S-9', 'uuid-9', { remoteUpdatedAt: later })]), ctx(await listTasks()));
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect((after.ext?.[PLUGIN] as Record<string, unknown>).short_id).toBe('S-9');
  });

  it('a plugin with no registered identity is never joined this way', async () => {
    const task = await unkeyedTask(reconciler, item('S-10', 'uuid-10'));
    resetExtIndexes();
    advance();
    const info = vi.spyOn(log.web, 'info');
    await reconciler.tick(makePlugin([item('S-10', 'uuid-10')]), ctx(await listTasks()));
    expect(complete(info)?.rejoined).toBeUndefined();
    expect((((await listTasks()).find(t => t.id === task.id)!.ext?.[PLUGIN]) as Record<string, unknown>).short_id).toBeUndefined();
  });

  it('a task of another source holding the same ext id is never joined', async () => {
    const task = await unkeyedTask(reconciler, item('S-7', 'uuid-7'));
    await updateTasksBulk([{ id: task.id, patch: { source: 'local' } as Partial<Task> }]);
    advance();
    const info = vi.spyOn(log.web, 'info');
    await reconciler.tick(makePlugin([item('S-7', 'uuid-7')]), ctx(await listTasks()));
    expect(complete(info)?.rejoined).toBeUndefined();
    const local = (await listTasks()).find(t => t.id === task.id)!;
    expect(local.source).toBe('local');
    expect((local.ext?.[PLUGIN] as Record<string, unknown>).short_id).toBeUndefined();
  });
});
