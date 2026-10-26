/**
 * SyncReconciler: remote items Walnut itself owned before the remote-identity
 * ledger existed, and refusal cards that outlive a restart.
 *
 * 2026-10-15 to 10-25: three "Task sync cannot import the remote list" cards
 * (x29 each) for twelve remote items. Every one was Walnut's own old copy of a
 * task that had left the provider in a source repair BEFORE the ledger, so no
 * ledger row said "released", and the pull saw them as new items it could not
 * place. The card was raised again after every restart, because the refusal
 * streak lived only in memory.
 *
 * Real: the task DB, the ledger, the pre-v5 backup read through its worker, the
 * notification store. Only the plugin's pull is a fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from '../../src/lib/sqlite.js';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-pre-ledger'));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler, listRefusalRecoveryKey } from '../../src/core/sync-reconciler.js';
import { upsertNotification, listNotifications } from '../../src/core/notifications/store.js';
import { _resetForTesting, ensureProject, listTasks } from '../../src/core/task-manager.js';
import { closeDb, TASK_DB_PRE_V5_BACKUP_PATH } from '../../src/core/task-db.js';
import { isRemoteIdBlocked } from '../../src/core/task-remote-links.js';
import { buildOwnerIndex, resetPreLedgerOwnersForTest } from '../../src/core/pre-ledger-owners.js';
import { log } from '../../src/logging/index.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN = 'ms-todo';

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
    id: PLUGIN,
    name: 'Fake To-Do',
    config: {},
    sync: {
      createTask: noop, deleteTask: noop, updateTitle: noop, updateDescription: noop,
      updateSummary: noop, updateNote: noop, updateConversationLog: noop, updatePriority: noop,
      updatePhase: noop, updateDueDate: noop, updateProject: noop, updateDependencies: noop,
      pushTask: vi.fn().mockResolvedValue({ serverTimestamp: new Date().toISOString() }),
      associateSubtask: noop, disassociateSubtask: noop, syncPoll: noop,
      fullPull: vi.fn().mockResolvedValue(items),
      extractRemoteId: (task: Task) => (task.ext?.[PLUGIN] as { id?: string } | undefined)?.id,
    },
    migrations: [],
    httpRoutes: [],
  } as unknown as RegisteredPlugin;
}

function makeCtx(): SyncPollContext {
  return {
    getTasks: () => [],
    addTask: vi.fn(async (data) => ({ id: 'unused', ...data }) as Task),
    updateTask: vi.fn(async (id, updates) => ({ id, ...updates }) as Task),
    deleteTask: vi.fn(async () => {}),
    emit: vi.fn(),
  };
}

/** The pre-v5 backup as the migration leaves it: a tasks table with ext JSON. */
function writeBackup(rows: Array<{ id: string; ext: Record<string, unknown> }>): void {
  fs.mkdirSync(path.dirname(TASK_DB_PRE_V5_BACKUP_PATH), { recursive: true });
  const db = new Database(TASK_DB_PRE_V5_BACKUP_PATH);
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, ext TEXT)');
  const ins = db.prepare('INSERT INTO tasks (id, title, ext) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r.id, 'old', JSON.stringify(r.ext));
  db.close();
}

function advancePastFullInterval(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 31 * 60_000);
}

/** The refused items the cycle reported (0 when none). */
const refusedItems = (info: ReturnType<typeof vi.spyOn>): number => {
  const done = info.mock.calls.filter(([m]) => m === 'sync-reconciler: full reconcile complete').at(-1)?.[1] as { refusedItems?: number } | undefined;
  return done?.refusedItems ?? 0;
};
const refusalWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter(([m]) => String(m).includes('matches a LOCAL project'));
const escalations = (error: ReturnType<typeof vi.spyOn>) =>
  error.mock.calls.filter(([m]) => String(m).startsWith('Task sync cannot import the remote list'));

let reconciler: SyncReconciler;

beforeEach(() => {
  closeDb();
  _resetForTesting();
  resetPreLedgerOwnersForTest();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  reconciler = new SyncReconciler();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeDb();
  _resetForTesting();
  resetPreLedgerOwnersForTest();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('buildOwnerIndex', () => {
  it('maps every id an ext entry names (id, short_id, previous_ids) to its task; an id two tasks name is dropped', () => {
    const index = buildOwnerIndex([
      { id: 't1', ext: JSON.stringify({ tracker: { id: 'uuid-1', short_id: 'S-1', previous_ids: ['old-1'] } }) },
      { id: 't2', ext: JSON.stringify({ tracker: { id: 'uuid-1' }, 'ms-todo': { id: 'm-2' } }) },
      { id: 't3', ext: 'not json' },
      { id: 't4', ext: null },
      { id: 't5', ext: JSON.stringify({ tracker: 'not an object' }) },
    ]);
    // uuid-1 is named by t1 and t2: ambiguous, so it is no evidence at all.
    expect([...index.get('tracker')!.entries()]).toEqual([
      ['S-1', 't1'], ['old-1', 't1'],
    ]);
    expect(index.get('ms-todo')!.get('m-2')).toBe('t2');
  });
});

describe('a refused item that is Walnut\'s own pre-ledger copy', () => {
  it('is released in the ledger, not imported and not reported, and every later pull skips it', async () => {
    await ensureProject('Fix Walnut', 'local');
    // The old task left this provider (here: it was deleted locally) before the
    // ledger existed; only the pre-v5 backup remembers it owned the remote item.
    writeBackup([{ id: 'gone-task', ext: { [PLUGIN]: { id: 'old-1' } } }]);
    const warn = vi.spyOn(log.web, 'warn');
    const info = vi.spyOn(log.web, 'info');
    const plugin = makePlugin([remoteItem({ remoteId: 'old-1', title: 'Old copy', fields: { project: 'Fix Walnut' } })]);

    await reconciler.tick(plugin, makeCtx());

    expect(await listTasks()).toHaveLength(0);
    expect(isRemoteIdBlocked(PLUGIN, 'old-1')).toBe(true);
    // The project gate's own line names the mismatch once, as it resolves the
    // name; the item is then released, so no refusal is counted or escalated.
    expect(refusalWarnings(warn)).toHaveLength(1);
    expect(refusedItems(info)).toBe(0);
    const released = info.mock.calls.filter(([m]) => String(m).includes('from before the ledger, released'));
    expect(released).toHaveLength(1);
    expect(released[0][1]).toMatchObject({ formerTaskId: 'gone-task', remoteId: 'old-1' });

    for (let i = 0; i < 4; i++) {
      advancePastFullInterval();
      await reconciler.tick(plugin, makeCtx());
    }
    // Blocked by the ledger before the project gate: no second release, no refusal, no warning.
    expect(info.mock.calls.filter(([m]) => String(m).includes('from before the ledger, released'))).toHaveLength(1);
    expect(refusalWarnings(warn)).toHaveLength(1);
    expect(refusedItems(info)).toBe(0);
    expect(await listTasks()).toHaveLength(0);
  });

  it('the usual case: the old owner still lives here as a LOCAL task, and keeps living untouched', async () => {
    // Moved off the provider to local in the source repair, its remote copy left behind.
    const { addTask } = await import('../../src/core/task-manager.js');
    const { task: owner } = await addTask({ title: 'Kept locally', project: 'Fix Walnut', source: 'local' } as never);
    expect(owner.source).toBe('local');
    writeBackup([{ id: owner.id, ext: { [PLUGIN]: { id: 'old-3' } } }]);
    const info = vi.spyOn(log.web, 'info');

    const plugin = makePlugin([remoteItem({ remoteId: 'old-3', title: 'Kept locally', fields: { project: 'Fix Walnut' } })]);
    await reconciler.tick(plugin, makeCtx());

    expect(isRemoteIdBlocked(PLUGIN, 'old-3')).toBe(true);
    expect(refusedItems(info)).toBe(0);
    const tasks = await listTasks();
    expect(tasks.map(t => [t.id, t.source, t.title])).toEqual([[owner.id, 'local', 'Kept locally']]);
    // No remote write of any kind.
    const sync = plugin.sync as unknown as Record<string, ReturnType<typeof vi.fn>>;
    for (const op of ['deleteTask', 'createTask', 'pushTask', 'updateProject']) expect(sync[op]).not.toHaveBeenCalled();
  });

  it('matches by the ext id the pull carries when the remote id is a display id', async () => {
    await ensureProject('Fix Walnut', 'local');
    writeBackup([{ id: 'gone-task', ext: { [PLUGIN]: { id: 'uuid-9', short_id: 'S-9' } } }]);
    await reconciler.tick(makePlugin([remoteItem({
      remoteId: 'display-only', title: 'Old copy',
      fields: { project: 'Fix Walnut', ext: { [PLUGIN]: { id: 'uuid-9' } } },
    })]), makeCtx());
    expect(isRemoteIdBlocked(PLUGIN, 'display-only')).toBe(true);
    expect(isRemoteIdBlocked(PLUGIN, 'uuid-9')).toBe(true);
    expect(await listTasks()).toHaveLength(0);
  });

  it('a list whose every item was such a copy retires the card an earlier process raised', async () => {
    await ensureProject('Fix Walnut', 'local');
    writeBackup([{ id: 'gone-task', ext: { [PLUGIN]: { id: 'old-1' } } }]);
    const recoveryKey = listRefusalRecoveryKey(PLUGIN, 'Fix Walnut');
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'list card', dedupKey: 'error:list', recoveryKey,
    });
    // Boot: the server hands the reconciler the unresolved cards' keys.
    expect(reconciler.seedReportedRefusals([recoveryKey, 'plugin:other', 'git'])).toBe(1);

    await reconciler.tick(makePlugin([remoteItem({ remoteId: 'old-1', fields: { project: 'Fix Walnut' } })]), makeCtx());

    await vi.waitFor(async () => {
      const { feed } = await listNotifications();
      expect(feed.find(n => n.dedupKey === 'error:list')?.resolved).toBe('recovered');
    });
  });
});

describe('a refusal with no pre-ledger evidence is still reported', () => {
  it('no backup file: refused and warned, as before', async () => {
    await ensureProject('Fix Walnut', 'local');
    const warn = vi.spyOn(log.web, 'warn');
    await reconciler.tick(makePlugin([remoteItem({ remoteId: 'new-1', fields: { project: 'Fix Walnut' } })]), makeCtx());
    expect(refusalWarnings(warn)).toHaveLength(1);
    expect(isRemoteIdBlocked(PLUGIN, 'new-1')).toBe(false);
  });

  it('a backup that does not name the item: refused', async () => {
    await ensureProject('Fix Walnut', 'local');
    writeBackup([{ id: 'other-task', ext: { [PLUGIN]: { id: 'unrelated' } } }]);
    const warn = vi.spyOn(log.web, 'warn');
    await reconciler.tick(makePlugin([remoteItem({ remoteId: 'new-1', fields: { project: 'Fix Walnut' } })]), makeCtx());
    expect(refusalWarnings(warn)).toHaveLength(1);
    expect(isRemoteIdBlocked(PLUGIN, 'new-1')).toBe(false);
  });

  it('an owner that is still a live task of this provider is not a departed copy: refused', async () => {
    // A live task imported from this provider, which the backup also names as
    // the owner of a second remote item: that item is not an orphan of a task
    // that left, so nothing is released.
    await reconciler.tick(makePlugin([remoteItem({ remoteId: 'live-1', title: 'Live', fields: { project: 'Fresh' } })]), makeCtx());
    const [live] = await listTasks();
    expect(live.source).toBe(PLUGIN);
    await ensureProject('Fix Walnut', 'local');
    writeBackup([{ id: live.id, ext: { [PLUGIN]: { id: 'old-2' } } }]);
    const warn = vi.spyOn(log.web, 'warn');
    advancePastFullInterval();
    await reconciler.tick(makePlugin([
      remoteItem({ remoteId: 'live-1', title: 'Live', fields: { project: 'Fresh' } }),
      remoteItem({ remoteId: 'old-2', fields: { project: 'Fix Walnut' } }),
    ]), makeCtx());
    expect(refusalWarnings(warn)).toHaveLength(1);
    expect(isRemoteIdBlocked(PLUGIN, 'old-2')).toBe(false);
  });

  it('an unreadable backup is treated as no evidence, never as a crash', async () => {
    await ensureProject('Fix Walnut', 'local');
    fs.mkdirSync(path.dirname(TASK_DB_PRE_V5_BACKUP_PATH), { recursive: true });
    fs.writeFileSync(TASK_DB_PRE_V5_BACKUP_PATH, 'not a database');
    const warn = vi.spyOn(log.web, 'warn');
    const outcome = await reconciler.tick(makePlugin([remoteItem({ remoteId: 'new-1', fields: { project: 'Fix Walnut' } })]), makeCtx());
    expect(outcome.status).toBe('completed');
    expect(refusalWarnings(warn)).toHaveLength(1);
  });
});

describe('a refusal already reported by an earlier process', () => {
  it('is not reported again while it stands, and its end retires the card', async () => {
    await ensureProject('Fix Walnut', 'local');
    const recoveryKey = listRefusalRecoveryKey(PLUGIN, 'Fix Walnut');
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'list card', dedupKey: 'error:list', recoveryKey,
    });
    reconciler.seedReportedRefusals([recoveryKey]);
    const error = vi.spyOn(log.web, 'error');
    const stuck = makePlugin([remoteItem({ remoteId: 'new-1', fields: { project: 'Fix Walnut' } })]);

    for (let i = 0; i < 5; i++) {
      await reconciler.tick(stuck, makeCtx());
      advancePastFullInterval();
    }
    expect(escalations(error)).toHaveLength(0);

    await reconciler.tick(makePlugin([]), makeCtx());
    await vi.waitFor(async () => {
      const { feed } = await listNotifications();
      expect(feed.find(n => n.dedupKey === 'error:list')?.resolved).toBe('recovered');
    });

    // Failing again after the recovery is news: a fresh streak escalates once.
    for (let i = 0; i < 4; i++) {
      advancePastFullInterval();
      await reconciler.tick(stuck, makeCtx());
    }
    expect(escalations(error)).toHaveLength(1);
  });

  it('seeding is idempotent and ignores keys that are not list refusals', () => {
    const key = listRefusalRecoveryKey(PLUGIN, 'Quick Start');
    expect(reconciler.seedReportedRefusals([key, key, 'plugin:ms-todo', 'host:box'])).toBe(1);
    expect(reconciler.seedReportedRefusals([key])).toBe(0);
  });
});
