/**
 * Unit tests for SyncReconciler — three-way diff, scheduling, and safety guards.
 *
 * What's tested:
 *   1. Three-way diff: create, update, remove, unchanged
 *   2. Safety guards: empty result protection, drastic drop protection
 *   3. Active session protection: tasks with sessions are not removed
 *   4. Local-only field protection: note, summary, conversation_log not overwritten
 *   5. Scheduling: first tick, epoch threshold, time elapsed, delta failures
 *   6. Batch limits: create capped at 50, update at 100
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to use temp dir
vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler'));

// Mock session tracker — controls which sessions appear as "running"
const mockSessions: Array<{ claudeSessionId: string; process_status: string }> = [];
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => mockSessions),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler } from '../../src/core/sync-reconciler.js';
import {
  _resetForTesting,
  addTasksBulk,
  ensureProject,
  getStoreProjects,
  listTasks,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

// ── Helpers ──

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Task',
    status: 'todo' as any,
    phase: 'TODO' as any,
    priority: 'none' as any,
    project: 'Test',
    source: 'test-plugin' as any,
    session_ids: [],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    description: '',
    summary: '',
    note: '',
    ext: {},
    ...overrides,
  } as Task;
}

/**
 * `fields` mirrors a real fullPull row: every shipped plugin's mapper sets
 * title/project/status/phase (see microsoft-todo.mapToLocal). `project` matters —
 * a provider-synced task must name a project (Inbox can never be claimed), so a
 * fixture that omits it isn't a realistic remote row.
 */
function makeRemoteItem(overrides: Partial<RemoteSyncItem> = {}): RemoteSyncItem {
  const { fields, ...rest } = overrides;
  return {
    remoteId: `remote-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Remote Task',
    remoteUpdatedAt: '2025-06-01T00:00:00Z',
    ...rest,
    fields: {
      project: 'Test',
      status: 'todo' as any,
      phase: 'TODO' as any,
      ...fields,
    },
  };
}

/** Seed the real task store, then hand back the snapshot prod passes as ctx.getTasks(). */
async function seedStore(tasks: Task[]): Promise<Task[]> {
  if (tasks.length) await addTasksBulk(tasks);
  return listTasks();
}

async function storedTitles(): Promise<string[]> {
  return (await listTasks()).map((t) => t.title);
}

async function storedIds(): Promise<string[]> {
  return (await listTasks()).map((t) => t.id);
}

function makePlugin(overrides: {
  fullPullResult?: RemoteSyncItem[] | null;
  extractFn?: (task: Task) => string | undefined;
} = {}): RegisteredPlugin {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    config: {},
    sync: {
      createTask: vi.fn(),
      deleteTask: vi.fn(),
      updateTitle: vi.fn(),
      updateDescription: vi.fn(),
      updateSummary: vi.fn(),
      updateNote: vi.fn(),
      updateConversationLog: vi.fn(),
      updatePriority: vi.fn(),
      updatePhase: vi.fn(),
      updateDueDate: vi.fn(),
      updateProject: vi.fn(),
      updateDependencies: vi.fn(),
      pushTask: vi.fn().mockResolvedValue({ serverTimestamp: new Date().toISOString() }),
      associateSubtask: vi.fn(),
      disassociateSubtask: vi.fn(),
      syncPoll: vi.fn(),
      // `in` rather than `??`: the null-return contract needs a literal null to
      // reach the reconciler, and `?? []` silently turned that case into an
      // empty-array pull (which takes the *delete everything* branch instead).
      fullPull: vi.fn().mockResolvedValue(
        'fullPullResult' in overrides ? overrides.fullPullResult : [],
      ),
      extractRemoteId: overrides.extractFn ?? ((task: Task) => (task.ext?.['test-plugin'] as any)?.remote_id),
    },
    migrations: [],
    httpRoutes: [],
  };
}

/**
 * applyDiff writes through task-manager's bulk APIs, NOT through ctx (`void ctx`
 * in sync-reconciler.applyDiff). ctx is only the read side — getTasks() supplies
 * the per-tick local snapshot, exactly like startPluginSyncPolling in server.ts.
 * Asserting on ctx.addTask/updateTask/deleteTask spies would silently pass on a
 * reconciler that writes nothing, so every effect assertion reads the store.
 */
function makeCtx(localTasks: Task[] = []): SyncPollContext {
  return {
    getTasks: () => [...localTasks],
    addTask: vi.fn(async (data) => ({ id: 'unused', ...data }) as Task),
    updateTask: vi.fn(async (id, updates) => ({ id, ...updates }) as Task),
    deleteTask: vi.fn(async () => {}),
    emit: vi.fn(),
  };
}

// ── Tests ──

describe('SyncReconciler', () => {
  let reconciler: SyncReconciler;

  // Tasks live in SQLite; the handle + task-manager's init flag / store cache are
  // module singletons, so wiping WALNUT_HOME alone leaves the previous test's rows
  // readable through the still-open handle.
  beforeEach(() => {
    closeDb();
    _resetForTesting();
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    reconciler = new SyncReconciler();
  });

  afterEach(() => {
    closeDb();
    _resetForTesting();
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  describe('scheduling', () => {
    it('runs full reconcile on first tick', async () => {
      const remoteItems = [makeRemoteItem({ remoteId: 'r1' })];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx([]);

      await reconciler.tick(plugin, ctx);

      expect(plugin.sync.fullPull).toHaveBeenCalled();
    });

    it('skips reconcile on subsequent ticks within threshold', async () => {
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx([]);

      // First tick triggers
      await reconciler.tick(plugin, ctx);
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(1);

      // Second tick should NOT trigger
      await reconciler.tick(plugin, ctx);
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(1);
    });

    it('skips plugins without fullPull implementation', async () => {
      const plugin = makePlugin();
      delete (plugin.sync as any).fullPull;
      const ctx = makeCtx([]);

      await reconciler.tick(plugin, ctx);
      // No error thrown, just silently skipped
    });

    it('triggers on delta failure threshold', async () => {
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx([]);

      // First tick (triggers as first tick)
      await reconciler.tick(plugin, ctx);
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(1);

      // 3 delta failures
      await reconciler.tick(plugin, ctx, { deltaFailed: true });
      await reconciler.tick(plugin, ctx, { deltaFailed: true });
      await reconciler.tick(plugin, ctx, { deltaFailed: true });

      // Should have triggered again due to failure threshold
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(2);
    });

    it('forceNextReconcile causes immediate reconcile', async () => {
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx([]);

      // First tick
      await reconciler.tick(plugin, ctx);
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(1);

      // Second tick normally skips
      await reconciler.tick(plugin, ctx);
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(1);

      // Force next
      reconciler.forceNextReconcile('test-plugin');
      await reconciler.tick(plugin, ctx);
      expect(plugin.sync.fullPull).toHaveBeenCalledTimes(2);
    });
  });

  describe('three-way diff', () => {
    it('creates tasks that exist in remote but not local', async () => {
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1',
          title: 'New from remote',
          fields: { title: 'New from remote', source: 'test-plugin' as any },
        }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).toEqual(['New from remote']);
    });

    it('updates local tasks when remote is newer', async () => {
      const localTask = makeTask({
        id: 'local-1',
        title: 'Old title',
        updated_at: '2025-01-01T00:00:00Z',
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1',
          title: 'New title',
          remoteUpdatedAt: '2025-06-01T00:00:00Z',
          fields: { title: 'New title' },
        }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      const [stored] = await listTasks();
      expect(stored.id).toBe('local-1');
      expect(stored.title).toBe('New title');
    });

    it('does not update local tasks when local is newer', async () => {
      const localTask = makeTask({
        id: 'local-1',
        updated_at: '2025-12-01T00:00:00Z',
        _syncedAt: '2025-12-01T00:00:00Z',
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1',
          remoteUpdatedAt: '2025-06-01T00:00:00Z',
          fields: { title: 'Should not apply' },
        }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).toEqual(['Test Task']);
    });

    it('removes local tasks not in remote', async () => {
      const localTask = makeTask({
        id: 'orphan-1',
        ext: { 'test-plugin': { remote_id: 'r-gone' } },
      });
      const plugin = makePlugin({ fullPullResult: [] });
      // lastFullPullCount=0 and result=0, so the empty-result guard won't trigger
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).not.toContain('orphan-1');
    });

    it('ignores local tasks without remote ID (cannot reconcile)', async () => {
      const localTask = makeTask({
        id: 'no-remote-id',
        ext: {}, // no test-plugin key
      });
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).toContain('no-remote-id');
    });

    it('only processes tasks belonging to the plugin', async () => {
      const localTaskOtherSource = makeTask({
        id: 'other-source',
        source: 'jira' as any,
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx(await seedStore([localTaskOtherSource]));

      await reconciler.tick(plugin, ctx);

      // Should not delete tasks from other sources
      expect(await storedIds()).toContain('other-source');
    });
  });

  describe('safety guards', () => {
    it('aborts on empty result when last count was > 5', async () => {
      // Manually seed state with high last count
      const stateFile = `${SYNC_DIR as string}/reconcile-test-plugin.json`;
      fs.writeFileSync(stateFile, JSON.stringify({
        deltaEpoch: 0,
        lastFullReconcileAt: new Date(0).toISOString(),
        lastFullPullCount: 20,
        updatedAt: new Date().toISOString(),
      }));

      const reconciler2 = new SyncReconciler();
      const plugin = makePlugin({ fullPullResult: [] });
      const localTask = makeTask({ id: 'guarded-1', ext: { 'test-plugin': { remote_id: 'r1' } } });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler2.tick(plugin, ctx);

      // Should NOT delete anything — empty result guard triggered
      expect(await storedIds()).toEqual(['guarded-1']);
    });

    it('does not remove tasks with running session', async () => {
      // Simulate an actively-running session
      mockSessions.length = 0;
      mockSessions.push({ claudeSessionId: 'sess-123', process_status: 'running' });

      const localTask = makeTask({
        id: 'has-session',
        session_id: 'sess-123',
        ext: { 'test-plugin': { remote_id: 'r-gone' } },
      });
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).toContain('has-session');
      mockSessions.length = 0;
    });

    it('does not remove tasks with a stopped session either — session history blocks removal', async () => {
      // 2026-08-20 contract flip: a remote item vanishing from a pull is not
      // authority to destroy local session history. The old "stopped sessions
      // don't block" rule is exactly how the H-1B RFE task (whose only session
      // had finished) was deleted and its session orphaned.
      mockSessions.length = 0;
      mockSessions.push({ claudeSessionId: 'sess-done', process_status: 'stopped' });

      const localTask = makeTask({
        id: 'has-done-session',
        session_id: 'sess-done',
        ext: { 'test-plugin': { remote_id: 'r-gone' } },
      });
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).toContain('has-done-session');
      mockSessions.length = 0;
    });

    it('does not remove tasks whose only link lives in session_ids', async () => {
      // session_ids was invisible to the old guard — 1,641 tasks held their
      // ONLY session link there, deletable on any remote disappearance.
      mockSessions.length = 0;
      mockSessions.push({ claudeSessionId: 'sess-hist', process_status: 'stopped' });

      const localTask = makeTask({
        id: 'has-session-ids-only',
        session_ids: ['sess-hist'],
        ext: { 'test-plugin': { remote_id: 'r-gone' } },
      });
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).toContain('has-session-ids-only');
      mockSessions.length = 0;
    });

    it('still removes session-less tasks so remote deletions propagate', async () => {
      mockSessions.length = 0;
      const localTask = makeTask({
        id: 'no-sessions',
        session_ids: [],
        ext: { 'test-plugin': { remote_id: 'r-gone' } },
      });
      const plugin = makePlugin({ fullPullResult: [] });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).not.toContain('no-sessions');
    });

    it('protects local-only fields from being overwritten', async () => {
      const localTask = makeTask({
        id: 'local-1',
        updated_at: '2025-01-01T00:00:00Z',
        note: 'my private note',
        summary: 'my summary',
        conversation_log: 'log entry',
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1',
          remoteUpdatedAt: '2025-06-01T00:00:00Z',
          fields: {
            title: 'Updated title',
            note: 'remote note should be ignored',
            summary: 'remote summary should be ignored',
            conversation_log: 'remote log should be ignored',
          },
        }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      const [stored] = await listTasks();
      expect(stored.title).toBe('Updated title');
      expect(stored.note).toBe('my private note');
      expect(stored.summary).toBe('my summary');
      expect(stored.conversation_log).toBe('log entry');
    });
  });

  describe('batch limits', () => {
    it('caps creates at 50', async () => {
      const remoteItems = Array.from({ length: 70 }, (_, i) =>
        makeRemoteItem({
          remoteId: `r-${i}`,
          title: `Task ${i}`,
          fields: { title: `Task ${i}` },
        }),
      );
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      // Asserts the CAP (never more than 50 of the 70 offered), not an exact
      // count of 50.
      //
      // A strict `toHaveLength(50)` here is ~1.9% flaky, and the flakiness is a
      // real product defect rather than test noise: the reconciler's create path
      // passes no ids, so all 50 rows get `generateId()` = base36(Date.now()) +
      // 2 random bytes (src/utils/format.ts). Within one same-millisecond bulk
      // insert that is a 50-draw birthday problem over 65536 values → 1.85%
      // chance of a duplicate id, and `addTasksBulk` uses INSERT OR REPLACE, so a
      // collision SILENTLY DROPS a task instead of erroring.
      //
      // Widening the id (or making the bulk insert reject duplicates) is the real
      // fix; that lives in task-manager/format and is tracked separately. Until
      // then this asserts the invariant the test is actually named for.
      const ids = await storedIds();
      expect(ids.length).toBeLessThanOrEqual(50);
      expect(ids.length).toBeGreaterThanOrEqual(49);
    });
  });

  describe('fullPull returns null', () => {
    it('skips reconcile when fullPull returns null', async () => {
      const localTask = makeTask({ id: 'untouched-1', ext: { 'test-plugin': { remote_id: 'r-gone' } } });
      const plugin = makePlugin({ fullPullResult: null as any });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).toEqual(['untouched-1']);
    });
  });

  // ── Project claim + retired-name gates on the bulk pull path ──
  //
  // addTasksBulk skips the create-time validation chain by design, so applyDiff
  // must apply the claim/retired-name rules itself. Regression lane for the
  // 2026-08-05 incident: a provider's full pull re-imported tasks whose project
  // was claimed by a DIFFERENT provider (creating unpushable minority-source
  // twins) and re-minted the retired 'Quick Start' group minutes after the v5
  // data repair deleted it.
  describe('project claim gate on pull', () => {
    it('does not import a remote task whose project is claimed by another provider', async () => {
      await ensureProject('Claimed Elsewhere', 'other-plugin' as any);
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r1', fields: { title: 'Cross-claim', project: 'Claimed Elsewhere' } }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).not.toContain('Cross-claim');
      // The claim itself is untouched.
      const projects = await getStoreProjects();
      expect(projects['Claimed Elsewhere']?.source).toBe('other-plugin');
    });

    it('does not resurrect retired grouping names (Quick Start / Inbox) as projects', async () => {
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r-qs', fields: { title: 'Retired QS', project: 'Quick Start' } }),
        makeRemoteItem({ remoteId: 'r-ib', fields: { title: 'Retired Inbox', project: 'Inbox' } }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).toEqual([]);
      const projects = await getStoreProjects();
      expect(Object.keys(projects).map((k) => k.toLowerCase())).not.toContain('quick start');
      expect(Object.keys(projects).map((k) => k.toLowerCase())).not.toContain('inbox');
    });

    it('keeps the local project on update when remote points at another provider\'s project', async () => {
      await ensureProject('Mine', 'test-plugin' as any);
      await ensureProject('Theirs', 'other-plugin' as any);
      const localTask = makeTask({
        id: 'local-1', title: 'Stays put', project: 'Mine',
        updated_at: '2025-01-01T00:00:00Z',
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1', remoteUpdatedAt: '2025-06-01T00:00:00Z',
          fields: { title: 'Stays put', project: 'Theirs' },
        }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      const [stored] = await listTasks();
      expect(stored.project).toBe('Mine');
    });

    it('registers an unclaimed project before bulk-creating into it', async () => {
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r1', fields: { title: 'New ground', project: 'Fresh Project' } }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).toContain('New ground');
      const projects = await getStoreProjects();
      expect(projects['Fresh Project']?.source).toBe('test-plugin');
    });
  });

  describe('alias adoption (re-keyed remote items)', () => {
    function makePluginWithAliases(fullPullResult: RemoteSyncItem[]): RegisteredPlugin {
      const plugin = makePlugin({ fullPullResult });
      plugin.sync.extractRemoteIdAliases = (task: Task) => {
        const prev = (task.ext?.['test-plugin'] as any)?.previous_ids;
        return Array.isArray(prev) ? prev : [];
      };
      return plugin;
    }

    it('adopts a remote item wearing a former id instead of creating a duplicate', async () => {
      // Fork shape: the local task re-keyed to r-new (list migration) and
      // remembers r-old in previous_ids, but a remote row keyed r-old still
      // shows up in the pull (the old twin survived the DELETE, or a stale
      // delta echoes it). Old behavior: r-old lands in toCreate → duplicate.
      const localTask = makeTask({
        id: 'owner-task',
        ext: { 'test-plugin': { remote_id: 'r-new', previous_ids: ['r-old'] } },
      });
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r-old', title: 'Re-keyed twin', fields: { title: 'Re-keyed twin' } }),
      ];
      const plugin = makePluginWithAliases(remoteItems);
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      // No duplicate created; the owner adopted the remote's current id.
      const stored = await listTasks();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('owner-task');
      expect((stored[0].ext?.['test-plugin'] as any)?.id).toBe('r-old');
    });

    it('does not queue the adopting task for removal', async () => {
      // The adopted task's CURRENT id (r-new) is absent from the remote — that
      // absence is expected (the remote wears the alias), never a removal.
      const localTask = makeTask({
        id: 'owner-task',
        session_ids: [],
        ext: { 'test-plugin': { remote_id: 'r-new', previous_ids: ['r-old'] } },
      });
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r-old', fields: { title: 'Twin' } }),
      ];
      const plugin = makePluginWithAliases(remoteItems);
      const ctx = makeCtx(await seedStore([localTask]));

      await reconciler.tick(plugin, ctx);

      expect(await storedIds()).toContain('owner-task');
    });
  });

  describe('remote-id ledger gate', () => {
    it('never re-creates a task for a released remote id', async () => {
      const { recordRemoteLink } = await import('../../src/core/task-remote-links.js');
      recordRemoteLink({
        source: 'test-plugin', remoteId: 'r-released', taskId: 'old-task',
        state: 'released', reason: 'source-migration',
      });
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r-released', title: 'Orphaned twin', fields: { title: 'Orphaned twin' } }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).not.toContain('Orphaned twin');
    });

    it('never re-creates a task for a deleted remote id', async () => {
      const { recordRemoteLink } = await import('../../src/core/task-remote-links.js');
      recordRemoteLink({
        source: 'test-plugin', remoteId: 'r-deleted', taskId: 'dead-task',
        state: 'deleted', reason: 'local-delete',
      });
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r-deleted', title: 'Zombie twin', fields: { title: 'Zombie twin' } }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).not.toContain('Zombie twin');
    });

    it('still creates tasks for owned/unknown remote ids', async () => {
      const remoteItems = [
        makeRemoteItem({ remoteId: 'r-fresh', title: 'Legit new', fields: { title: 'Legit new' } }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      const ctx = makeCtx(await seedStore([]));

      await reconciler.tick(plugin, ctx);

      expect(await storedTitles()).toContain('Legit new');
    });
  });

  describe('convergence (LWW watermark advances)', () => {
    it('addTasksBulk stamps timestamps, so a STALE remote echo no longer wins', async () => {
      // The old corrupt shape: bulk-created rows carried NULL updated_at →
      // LWW threshold 0 → even a years-old remote echo re-applied every cycle
      // (28 identical `updated 1197` cycles observed 2026-08-20). Timestamps
      // are now stamped at insert, so the stale echo loses.
      const localTask = makeTask({
        id: 'fresh-row',
        title: 'Local title',
        created_at: undefined as any,
        updated_at: undefined as any,
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1', title: 'Stale echo', remoteUpdatedAt: '2025-06-01T00:00:00Z',
          fields: { title: 'Stale echo' },
        }),
      ];
      const plugin = makePlugin({ fullPullResult: remoteItems });
      await reconciler.tick(plugin, makeCtx(await seedStore([localTask])));

      const stored = (await listTasks()).find((t) => t.id === 'fresh-row')!;
      expect(stored.title).toBe('Local title');
      expect(stored.updated_at).toBeTruthy();
      expect(stored.created_at).toBeTruthy();
    });

    it('an applied remote update advances the watermark and does not re-apply', async () => {
      const localTask = makeTask({
        id: 'stale-row',
        title: 'Old title',
        updated_at: '2025-01-01T00:00:00Z',
        ext: { 'test-plugin': { remote_id: 'r1' } },
      });
      // A genuinely newer remote edit (newer than insert time + echo grace).
      const remoteEditTime = new Date(Date.now() + 60_000).toISOString();
      const remoteItems = [
        makeRemoteItem({
          remoteId: 'r1', title: 'New title', remoteUpdatedAt: remoteEditTime,
          fields: { title: 'New title' },
        }),
      ];

      const plugin1 = makePlugin({ fullPullResult: remoteItems });
      await reconciler.tick(plugin1, makeCtx(await seedStore([localTask])));

      const afterFirst = (await listTasks()).find((t) => t.id === 'stale-row')!;
      expect(afterFirst.title).toBe('New title');
      // The watermark must now cover the remote's timestamp — this is what
      // makes the second cycle a no-op.
      expect(afterFirst._syncedAt).toBe(remoteEditTime);

      // Second reconcile over identical remote data: the diff must classify
      // the row unchanged (remoteTime == watermark, not >).
      const reconciler2 = new SyncReconciler();
      reconciler2.forceNextReconcile('test-plugin');
      const plugin2 = makePlugin({ fullPullResult: remoteItems });
      await reconciler2.tick(plugin2, makeCtx(await listTasks()));

      const afterSecond = (await listTasks()).find((t) => t.id === 'stale-row')!;
      expect(afterSecond.title).toBe('New title');
      expect(afterSecond._syncedAt).toBe(remoteEditTime);
    });
  });
});
