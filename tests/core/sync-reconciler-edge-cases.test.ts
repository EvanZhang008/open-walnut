/**
 * Edge-case component tests for the sync identity contract (2026-08-21).
 *
 * The base suite (sync-reconciler.test.ts) pins the happy paths of the
 * 2026-08-20 anti-fork fix. This file enumerates the CORNER cases — the
 * shapes that only show up when re-keying, deletion echoes, push races, and
 * merges interleave. Everything external is mocked (session tracker, plugin
 * hooks); the task store is the real SQLite-backed task-manager.
 *
 * Sections:
 *   A. Alias adoption corners — stale twins, multi-alias, alias collisions,
 *      adopt + ledger interplay, push-inflight windows.
 *   B. Removal guard corners — inflight pushes, alias absence, mixed links.
 *   C. Ledger corners — cross-source scoping, owned-after-deleted revival,
 *      merge tombstones, adopt-then-delete lifecycle.
 *   D. Update-path corners — ext merge preserving previous_ids, protected
 *      fields, LWW boundary conditions (exact-equal timestamps, grace window).
 *   E. Create-path corners — deleted flag on remote items, duplicate remote
 *      ids in one pull, ledger gate vs adoption priority.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-edge'));

// Session tracker mock — tests control the visible session list.
const mockSessions: Array<{ claudeSessionId: string; process_status: string }> = [];
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => mockSessions),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler } from '../../src/core/sync-reconciler.js';
import {
  _resetForTesting,
  addTasksBulk,
  listTasks,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import {
  getRemoteLink,
  isRemoteIdBlocked,
  recordRemoteLink,
} from '../../src/core/task-remote-links.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

// ── Harness (same shape as sync-reconciler.test.ts) ──

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

async function seedStore(tasks: Task[]): Promise<Task[]> {
  if (tasks.length) await addTasksBulk(tasks);
  return listTasks();
}

function makePlugin(overrides: {
  fullPullResult?: RemoteSyncItem[] | null;
  withAliases?: boolean;
} = {}): RegisteredPlugin {
  const plugin: RegisteredPlugin = {
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
      fullPull: vi.fn().mockResolvedValue(
        'fullPullResult' in overrides ? overrides.fullPullResult : [],
      ),
      extractRemoteId: (task: Task) => (task.ext?.['test-plugin'] as any)?.id,
    },
    migrations: [],
    httpRoutes: [],
  };
  if (overrides.withAliases !== false) {
    plugin.sync.extractRemoteIdAliases = (task: Task) => {
      const prev = (task.ext?.['test-plugin'] as any)?.previous_ids;
      return Array.isArray(prev) ? prev : [];
    };
  }
  return plugin;
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

async function runReconcile(plugin: RegisteredPlugin, local: Task[]): Promise<void> {
  const reconciler = new SyncReconciler();
  await reconciler.tick(plugin, makeCtx(local));
}

const extOf = (t: Task) => (t.ext?.['test-plugin'] as any) ?? {};

beforeEach(() => {
  closeDb();
  _resetForTesting();
  mockSessions.length = 0;
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
});

afterEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. Alias adoption corners
// ═══════════════════════════════════════════════════════════════════════════

describe('A. alias adoption corners', () => {
  it('A1: does NOT adopt back when BOTH the current and the former id are present remotely (stale twin)', async () => {
    // The re-key succeeded (r-new exists remotely) but the DELETE of r-old
    // never landed — both ids now show in the pull. Adopting r-old would
    // steal ext.id BACK to the old id and orphan r-new, which next cycle
    // mints a duplicate. Correct: keep r-new, skip r-old (no create either).
    const owner = makeTask({
      id: 'owner',
      ext: { 'test-plugin': { id: 'r-new', previous_ids: ['r-old'] } },
    });
    const plugin = makePlugin({
      fullPullResult: [
        makeRemoteItem({ remoteId: 'r-new', fields: { title: 'current twin' } }),
        makeRemoteItem({ remoteId: 'r-old', fields: { title: 'stale twin' } }),
      ],
    });

    await runReconcile(plugin, await seedStore([owner]));

    const stored = await listTasks();
    expect(stored).toHaveLength(1);                    // no duplicate minted
    expect(extOf(stored[0]).id).toBe('r-new');         // identity NOT stolen back
  });

  it('A2: adopts only ONE of two alias hits for the same task in one cycle', async () => {
    // A task that re-keyed twice carries two former ids; a pathological pull
    // presents BOTH old twins (current id absent). Two adoptions in one cycle
    // would each overwrite ext.id — last write wins, first item re-orphaned.
    // Contract: adopt one, defer the other (skip, not create).
    const owner = makeTask({
      id: 'owner',
      ext: { 'test-plugin': { id: 'r-current', previous_ids: ['r-old1', 'r-old2'] } },
    });
    const plugin = makePlugin({
      fullPullResult: [
        makeRemoteItem({ remoteId: 'r-old1', fields: { title: 'first old twin' } }),
        makeRemoteItem({ remoteId: 'r-old2', fields: { title: 'second old twin' } }),
      ],
    });

    await runReconcile(plugin, await seedStore([owner]));

    const stored = await listTasks();
    expect(stored).toHaveLength(1);                    // neither minted a copy
    expect(['r-old1', 'r-old2']).toContain(extOf(stored[0]).id); // one adopted
  });

  it('A3: two tasks each adopt their own former id in the same cycle', async () => {
    const ownerA = makeTask({ id: 'owner-a', ext: { 'test-plugin': { id: 'a-new', previous_ids: ['a-old'] } } });
    const ownerB = makeTask({ id: 'owner-b', ext: { 'test-plugin': { id: 'b-new', previous_ids: ['b-old'] } } });
    const plugin = makePlugin({
      fullPullResult: [
        makeRemoteItem({ remoteId: 'a-old', fields: { title: 'A twin' } }),
        makeRemoteItem({ remoteId: 'b-old', fields: { title: 'B twin' } }),
      ],
    });

    await runReconcile(plugin, await seedStore([ownerA, ownerB]));

    const stored = await listTasks();
    expect(stored).toHaveLength(2);
    const byId = new Map(stored.map((t) => [t.id, t]));
    expect(extOf(byId.get('owner-a')!).id).toBe('a-old');
    expect(extOf(byId.get('owner-b')!).id).toBe('b-old');
  });

  it('A4: current-id owner beats alias claimant when two tasks reference the same remote id', async () => {
    // Fork aftermath: task X holds r1 as CURRENT id, task Y lists r1 in
    // previous_ids. The current owner must win the join; Y must not adopt.
    const current = makeTask({ id: 'current-owner', title: 'Current', ext: { 'test-plugin': { id: 'r1' } } });
    const aliasClaimant = makeTask({
      id: 'alias-claimant', title: 'Claimant',
      ext: { 'test-plugin': { id: 'r-other', previous_ids: ['r1'] } },
    });
    const plugin = makePlugin({
      fullPullResult: [
        makeRemoteItem({ remoteId: 'r1', fields: { title: 'Current' } }),
        makeRemoteItem({ remoteId: 'r-other', fields: { title: 'Claimant' } }),
      ],
    });

    await runReconcile(plugin, await seedStore([current, aliasClaimant]));

    const stored = await listTasks();
    expect(stored).toHaveLength(2);
    const byId = new Map(stored.map((t) => [t.id, t]));
    expect(extOf(byId.get('current-owner')!).id).toBe('r1');       // untouched
    expect(extOf(byId.get('alias-claimant')!).id).toBe('r-other'); // no adoption
  });

  it('A5: exactly ONE of two same-alias claimants adopts; the loser follows normal removal semantics', async () => {
    // Two forks both remember r-shared as a previous id; the pull shows only
    // r-shared. One adopts. The loser's CURRENT id is genuinely absent from
    // the remote — with session history it survives (guard), and it must
    // never mint a third copy or churn its ext.
    mockSessions.push({ claudeSessionId: 'keep-second', process_status: 'stopped' });
    const first = makeTask({ id: 'first', ext: { 'test-plugin': { id: 'f-cur', previous_ids: ['r-shared'] } } });
    const second = makeTask({
      id: 'second', session_ids: ['keep-second'],
      ext: { 'test-plugin': { id: 's-cur', previous_ids: ['r-shared'] } },
    });
    const plugin = makePlugin({
      fullPullResult: [makeRemoteItem({ remoteId: 'r-shared', fields: { title: 'shared twin' } })],
    });

    await runReconcile(plugin, await seedStore([first, second]));

    const stored = await listTasks();
    expect(stored).toHaveLength(2);                    // no third copy
    const adopted = stored.filter((t) => extOf(t).id === 'r-shared');
    expect(adopted).toHaveLength(1);                   // exactly one adopter
    // The loser keeps its own identity untouched.
    const loser = stored.find((t) => extOf(t).id !== 'r-shared')!;
    expect(['f-cur', 's-cur']).toContain(extOf(loser).id);
  });

  it('A5b: a session-less same-alias loser whose remote twin is gone is removed (deletion propagates)', async () => {
    // Same shape, loser has NO session history: its current id being absent
    // from the remote follows the normal removal rule. Pinned so the A5
    // survival above is understood as the session guard, not adoption magic.
    const first = makeTask({ id: 'first', ext: { 'test-plugin': { id: 'f-cur', previous_ids: ['r-shared'] } } });
    const second = makeTask({ id: 'second', ext: { 'test-plugin': { id: 's-cur', previous_ids: ['r-shared'] } } });
    const plugin = makePlugin({
      fullPullResult: [makeRemoteItem({ remoteId: 'r-shared', fields: { title: 'shared twin' } })],
    });

    await runReconcile(plugin, await seedStore([first, second]));

    const stored = await listTasks();
    expect(stored).toHaveLength(1);                    // loser removed, no copies
    expect(extOf(stored[0]).id).toBe('r-shared');      // the adopter survived
  });

  it('A6: adoption merges remote ext keys without erasing previous_ids', async () => {
    // The adopt patch merges {...currentExt, ...remoteExt, id}: the task's
    // alias memory must survive the adoption (it may need to adopt again).
    const owner = makeTask({
      id: 'owner',
      ext: { 'test-plugin': { id: 'r-new', previous_ids: ['r-old', 'r-ancient'], custom: 'keep-me' } },
    });
    const plugin = makePlugin({
      fullPullResult: [makeRemoteItem({ remoteId: 'r-old', fields: { title: 'twin' } })],
    });

    await runReconcile(plugin, await seedStore([owner]));

    const [stored] = await listTasks();
    const ext = extOf(stored);
    expect(ext.id).toBe('r-old');
    expect(ext.previous_ids).toEqual(['r-old', 'r-ancient']);
    expect(ext.custom).toBe('keep-me');
  });

  it('A7: plugin without extractRemoteIdAliases falls back to ledger gate, never crashes', async () => {
    // Optional hook absent (jira-style minimal plugin): a re-keyed twin can't
    // be adopted, but the ledger still blocks a release/delete re-import.
    recordRemoteLink({ source: 'test-plugin', remoteId: 'r-old', taskId: 'x', state: 'released' });
    const plugin = makePlugin({ withAliases: false, fullPullResult: [
      makeRemoteItem({ remoteId: 'r-old', fields: { title: 'ledgered twin' } }),
      makeRemoteItem({ remoteId: 'r-brand-new', fields: { title: 'legit' } }),
    ] });

    await runReconcile(plugin, await seedStore([]));

    const titles = (await listTasks()).map((t) => t.title);
    expect(titles).not.toContain('ledgered twin');
    expect(titles).toContain('legit');
  });

  it('A8: extractRemoteIdAliases returning undefined/garbage is tolerated', async () => {
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-x', fields: { title: 'fine' } }),
    ] });
    plugin.sync.extractRemoteIdAliases = (() => undefined) as any;
    const local = makeTask({ id: 't1', ext: { 'test-plugin': { id: 'r-x' } } });

    await runReconcile(plugin, await seedStore([local]));

    expect((await listTasks())).toHaveLength(1); // no crash, no duplicate
  });

  it('A9: an empty-string alias never matches anything', async () => {
    // previous_ids polluted with '' (bad legacy data) must not join to a
    // remote item whose id is also somehow '' or match vacuously.
    const owner = makeTask({ id: 'owner', ext: { 'test-plugin': { id: 'r-cur', previous_ids: [''] } } });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-cur', fields: { title: 'me' } }),
      makeRemoteItem({ remoteId: 'r-unrelated', fields: { title: 'stranger' } }),
    ] });

    await runReconcile(plugin, await seedStore([owner]));

    const stored = await listTasks();
    expect(stored).toHaveLength(2);                        // stranger created normally
    const ownerRow = stored.find((t) => t.id === 'owner')!;
    expect(extOf(ownerRow).id).toBe('r-cur');              // no phantom adoption
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Removal guard corners
// ═══════════════════════════════════════════════════════════════════════════

describe('B. removal guard corners', () => {
  it('B1: a push-inflight task whose remote id is absent is NOT removed (re-key window)', async () => {
    // Mid-push, the old remote item is already DELETEd but ext still wears
    // the old id. A full pull in this window sees "local id absent remotely"
    // — that is not authority to delete the task.
    const { markPushInflightForTesting } = await import('../../src/core/task-manager.js') as any;
    const inflight = makeTask({ id: 'mid-push', ext: { 'test-plugin': { id: 'r-being-rekeyed' } } });
    const bystander = makeTask({ id: 'bystander', ext: { 'test-plugin': { id: 'r-gone' } } });
    const seeded = await seedStore([inflight, bystander]);

    // Simulate the push window. If the helper doesn't exist, fall back to the
    // real pushInflight map via pushToPlugin — but the helper is the intended
    // seam (added alongside this test batch).
    const release = markPushInflightForTesting('mid-push');
    try {
      const plugin = makePlugin({ fullPullResult: [] });
      await runReconcile(plugin, seeded);
    } finally {
      release();
    }

    const ids = (await listTasks()).map((t) => t.id);
    expect(ids).toContain('mid-push');       // protected by the inflight window
    expect(ids).not.toContain('bystander');  // normal removal still works
  });

  it('B2: session link in the PLAN slot blocks removal', async () => {
    mockSessions.push({ claudeSessionId: 'plan-sess', process_status: 'stopped' });
    const t = makeTask({ id: 'plan-linked', plan_session_id: 'plan-sess', ext: { 'test-plugin': { id: 'r-gone' } } });
    await runReconcile(makePlugin({ fullPullResult: [] }), await seedStore([t]));
    expect((await listTasks()).map((x) => x.id)).toContain('plan-linked');
  });

  it('B3: session link in the EXEC slot blocks removal', async () => {
    mockSessions.push({ claudeSessionId: 'exec-sess', process_status: 'stopped' });
    const t = makeTask({ id: 'exec-linked', exec_session_id: 'exec-sess', ext: { 'test-plugin': { id: 'r-gone' } } });
    await runReconcile(makePlugin({ fullPullResult: [] }), await seedStore([t]));
    expect((await listTasks()).map((x) => x.id)).toContain('exec-linked');
  });

  it('B4: a session id that matches NO real session does not block removal', async () => {
    // Dangling pointer to a session that never existed / was purged: the
    // guard checks against the live session list, so this task removes.
    const t = makeTask({ id: 'dangling', session_ids: ['ghost-session'], ext: { 'test-plugin': { id: 'r-gone' } } });
    await runReconcile(makePlugin({ fullPullResult: [] }), await seedStore([t]));
    expect((await listTasks()).map((x) => x.id)).not.toContain('dangling');
  });

  it('B5: listSessions throwing → conservative block (no removal)', async () => {
    const { listSessions } = await import('../../src/core/session-tracker.js');
    (listSessions as any).mockRejectedValueOnce(new Error('sessions.sqlite locked'));
    const t = makeTask({ id: 'unknown-links', session_ids: ['maybe'], ext: { 'test-plugin': { id: 'r-gone' } } });
    await runReconcile(makePlugin({ fullPullResult: [] }), await seedStore([t]));
    expect((await listTasks()).map((x) => x.id)).toContain('unknown-links');
  });

  it('B6: removal of a session-less task writes a CONFIRMED deleted ledger row', async () => {
    // deleteTasksBulk is reconciler-only: the remote twin is already gone, so
    // the tombstone is born confirmed — but it MUST exist, or a stale delta
    // echo re-imports the id.
    const t = makeTask({ id: 'gone-soon', ext: { 'test-plugin': { id: 'r-vanished' } } });
    await runReconcile(makePlugin({ fullPullResult: [] }), await seedStore([t]));

    expect((await listTasks())).toHaveLength(0);
    const link = getRemoteLink('test-plugin', 'r-vanished');
    expect(link?.state).toBe('deleted');
    expect(link?.remote_delete_confirmed).toBe(true);
    expect(isRemoteIdBlocked('test-plugin', 'r-vanished')).toBe(true);
  });

  it('B7: after a reconciler removal, the SAME id echoed back next cycle does not resurrect', async () => {
    // Full lifecycle: remove (twin gone) → stale delta echo re-presents the
    // id → ledger gate blocks the re-import. This is the exact loop that
    // created the duplicate storm.
    const t = makeTask({ id: 'victim', ext: { 'test-plugin': { id: 'r-echo' } } });
    await runReconcile(makePlugin({ fullPullResult: [] }), await seedStore([t]));
    expect((await listTasks())).toHaveLength(0);

    // Next cycle: the echo.
    const echoPlugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-echo', fields: { title: 'zombie' } }),
    ] });
    await runReconcile(echoPlugin, await listTasks());

    expect((await listTasks())).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Ledger corners
// ═══════════════════════════════════════════════════════════════════════════

describe('C. ledger corners', () => {
  it('C1: a re-push after deletion revives ownership (owned overwrites deleted)', async () => {
    // User deletes a task (ledger: deleted) then re-creates and pushes a NEW
    // task that the provider happens to give the SAME remote id (some
    // providers recycle). recordRemoteLink last-write-wins must let 'owned'
    // overwrite 'deleted', unblocking the id.
    await seedStore([makeTask({ id: 'boot' })]); // open the DB
    recordRemoteLink({ source: 'test-plugin', remoteId: 'r-recycled', taskId: 'old', state: 'deleted' });
    expect(isRemoteIdBlocked('test-plugin', 'r-recycled')).toBe(true);

    recordRemoteLink({ source: 'test-plugin', remoteId: 'r-recycled', taskId: 'new-task', state: 'owned' });
    expect(isRemoteIdBlocked('test-plugin', 'r-recycled')).toBe(false);
    expect(getRemoteLink('test-plugin', 'r-recycled')?.task_id).toBe('new-task');
  });

  it('C2: blocking is per-source — the same remote id from another provider is untouched', async () => {
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'shared-id-space', fields: { title: 'mine' } }),
    ] });
    await seedStore([makeTask({ id: 'boot' })]);
    // Another provider deleted its item with a colliding id string.
    recordRemoteLink({ source: 'other-plugin', remoteId: 'shared-id-space', state: 'deleted' });

    await runReconcile(plugin, await listTasks());

    expect((await listTasks()).map((t) => t.title)).toContain('mine');
  });

  it('C3: adoption is exempt from the ledger gate (released id reclaimed by its owner)', async () => {
    // The gate protects CREATES. If the recorded owner still exists locally
    // and the remote item wears its former id, adoption must proceed even
    // though the id is ledgered released — that IS the repair path.
    const owner = makeTask({ id: 'owner', ext: { 'test-plugin': { id: 'r-cur', previous_ids: ['r-released'] } } });
    const seeded = await seedStore([owner]);
    recordRemoteLink({ source: 'test-plugin', remoteId: 'r-released', taskId: 'owner', state: 'released' });

    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-released', fields: { title: 'reclaim me' } }),
    ] });
    await runReconcile(plugin, seeded);

    const stored = await listTasks();
    expect(stored).toHaveLength(1);
    expect(extOf(stored[0]).id).toBe('r-released'); // adopted, not blocked, not duplicated
  });

  it('C4: merging two tasks sharing one remote id never tombstones the shared id (3-way)', async () => {
    // Three local rows, ALL pointing at one remote id (worst observed prod
    // shape). Merging victims 2 and 3 into 1 must leave the id unblocked —
    // the survivor still owns it.
    const { mergeTaskInto, addTask } = await import('../../src/core/task-manager.js');
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    const mk = async (title: string) => {
      const { task } = await addTask({ title, project: 'P' });
      await updateTaskRaw(task.id, { source: 'test-plugin' as any, ext: { 'test-plugin': { id: 'r-tri' } } });
      return task;
    };
    const a = await mk('copy A');
    const b = await mk('copy B');
    const c = await mk('copy C');

    await mergeTaskInto(a.id, b.id);
    await mergeTaskInto(a.id, c.id);

    expect(isRemoteIdBlocked('test-plugin', 'r-tri')).toBe(false);
    expect((await listTasks()).map((t) => t.id)).toEqual([a.id]);
  });

  it('C5: merge DOES tombstone the victim-only remote id, and the pull respects it', async () => {
    const { mergeTaskInto, addTask, updateTaskRaw } = await import('../../src/core/task-manager.js');
    const { task: survivor } = await addTask({ title: 'keeper', project: 'P' });
    const { task: victim } = await addTask({ title: 'dupe', project: 'P' });
    await updateTaskRaw(survivor.id, { source: 'test-plugin' as any, ext: { 'test-plugin': { id: 'r-keep' } } });
    await updateTaskRaw(victim.id, { source: 'test-plugin' as any, ext: { 'test-plugin': { id: 'r-dupe' } } });

    await mergeTaskInto(survivor.id, victim.id);

    // The victim's remote twin echoes in the next pull — must not come back.
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-keep', fields: { title: 'keeper' } }),
      makeRemoteItem({ remoteId: 'r-dupe', fields: { title: 'dupe returns' } }),
    ] });
    await runReconcile(plugin, await listTasks());

    const titles = (await listTasks()).map((t) => t.title);
    expect(titles).toContain('keeper');
    expect(titles).not.toContain('dupe returns');
  });

  it('C6: merge tombstones the victim previous_ids too, not just the current id', async () => {
    // The victim carried alias memory; those former ids are just as
    // re-importable as the current one.
    const { mergeTaskInto, addTask, updateTaskRaw } = await import('../../src/core/task-manager.js');
    const { task: survivor } = await addTask({ title: 'keeper', project: 'P' });
    const { task: victim } = await addTask({ title: 'dupe', project: 'P' });
    await updateTaskRaw(victim.id, {
      source: 'test-plugin' as any,
      ext: { 'test-plugin': { id: 'r-v-cur', previous_ids: ['r-v-old'] } },
    });

    await mergeTaskInto(survivor.id, victim.id);

    expect(isRemoteIdBlocked('test-plugin', 'r-v-cur')).toBe(true);
    expect(isRemoteIdBlocked('test-plugin', 'r-v-old')).toBe(true);
  });

  it('C7: deleting a task ledgers its ALIASES as deleted too', async () => {
    const { addTask, updateTaskRaw, deleteTask } = await import('../../src/core/task-manager.js');
    const { task } = await addTask({ title: 'doomed', project: 'P' });
    await updateTaskRaw(task.id, {
      source: 'test-plugin' as any,
      ext: { 'test-plugin': { id: 'r-cur', previous_ids: ['r-past1', 'r-past2'] } },
    });

    await deleteTask(task.id);

    for (const rid of ['r-cur', 'r-past1', 'r-past2']) {
      expect(isRemoteIdBlocked('test-plugin', rid)).toBe(true);
    }
  });

  it('C8: a local-source task deletion writes NO ledger rows', async () => {
    // source='local' has no remote identity; the ledger must stay clean of
    // junk rows (remoteIdsFromExt returns [] for local).
    const { addTask, deleteTask } = await import('../../src/core/task-manager.js');
    const { task } = await addTask({ title: 'pure local', project: 'P' });
    await deleteTask(task.id);
    // Nothing to assert by id — assert the table is empty via a known probe id.
    expect(getRemoteLink('local', task.id)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Update-path corners (LWW boundaries, ext merge)
// ═══════════════════════════════════════════════════════════════════════════

describe('D. update-path corners', () => {
  it('D1: remote time EXACTLY equal to the watermark does not re-apply (strict >)', async () => {
    const t = makeTask({
      id: 'exact', title: 'settled',
      updated_at: '2025-06-01T00:00:00Z', _syncedAt: '2025-06-01T00:00:00Z',
      ext: { 'test-plugin': { id: 'r1' } },
    });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r1', remoteUpdatedAt: '2025-06-01T00:00:00Z', fields: { title: 'echo' } }),
    ] });
    await runReconcile(plugin, await seedStore([t]));
    expect((await listTasks())[0].title).toBe('settled');
  });

  it('D2: remote time inside the 10s echo-grace window does not apply', async () => {
    const t = makeTask({
      id: 'grace', title: 'settled',
      updated_at: '2025-06-01T00:00:00Z', _syncedAt: '2025-06-01T00:00:00Z',
      ext: { 'test-plugin': { id: 'r1' } },
    });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r1', remoteUpdatedAt: '2025-06-01T00:00:09Z', fields: { title: 'grace echo' } }),
    ] });
    await runReconcile(plugin, await seedStore([t]));
    expect((await listTasks())[0].title).toBe('settled');
  });

  it('D3: remote time just past the grace window DOES apply and advances the watermark', async () => {
    const t = makeTask({
      id: 'past-grace', title: 'stale',
      updated_at: '2025-06-01T00:00:00Z', _syncedAt: '2025-06-01T00:00:00Z',
      ext: { 'test-plugin': { id: 'r1' } },
    });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r1', remoteUpdatedAt: '2025-06-01T00:00:11Z', fields: { title: 'fresh' } }),
    ] });
    await runReconcile(plugin, await seedStore([t]));
    const [stored] = await listTasks();
    expect(stored.title).toBe('fresh');
    expect(stored._syncedAt).toBe('2025-06-01T00:00:11Z');
  });

  it('D4: unparseable remoteUpdatedAt (NaN) never wins against a stamped row', async () => {
    const t = makeTask({
      id: 'nan-remote', title: 'settled',
      updated_at: '2025-06-01T00:00:00Z', _syncedAt: '2025-06-01T00:00:00Z',
      ext: { 'test-plugin': { id: 'r1' } },
    });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r1', remoteUpdatedAt: 'not-a-date', fields: { title: 'garbage time' } }),
    ] });
    await runReconcile(plugin, await seedStore([t]));
    expect((await listTasks())[0].title).toBe('settled'); // NaN > x is false
  });

  it('D5: an update echo cannot wipe previous_ids (ext MERGE, not replace)', async () => {
    const t = makeTask({
      id: 'keep-aliases', title: 'old',
      updated_at: '2025-01-01T00:00:00Z',
      ext: { 'test-plugin': { id: 'r1', previous_ids: ['r-past'], list_id: 'L1' } },
    });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({
        remoteId: 'r1', remoteUpdatedAt: '2025-06-01T00:00:00Z',
        fields: { title: 'new', ext: { 'test-plugin': { id: 'r1', list_id: 'L2' } } },
      }),
    ] });
    await runReconcile(plugin, await seedStore([t]));

    const ext = extOf((await listTasks())[0]);
    expect(ext.previous_ids).toEqual(['r-past']);  // survived the echo
    expect(ext.list_id).toBe('L2');                // remote's fresher key applied
  });

  it('D6: an update echo cannot clobber session links or phase', async () => {
    const t = makeTask({
      id: 'linked', title: 'old', phase: 'IN_PROGRESS' as any,
      session_ids: ['s1'], session_id: 'slot',
      updated_at: '2025-01-01T00:00:00Z',
      ext: { 'test-plugin': { id: 'r1' } },
    });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({
        remoteId: 'r1', remoteUpdatedAt: '2025-06-01T00:00:00Z',
        fields: {
          title: 'new', phase: 'TODO' as any,
          session_ids: [] as any, session_id: null as any,
        },
      }),
    ] });
    await runReconcile(plugin, await seedStore([t]));

    const [stored] = await listTasks();
    expect(stored.title).toBe('new');
    expect(stored.phase).toBe('IN_PROGRESS');       // remote may not drive phase
    expect(stored.session_ids).toEqual(['s1']);     // links untouchable
    expect(stored.session_id).toBe('slot');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Create-path corners
// ═══════════════════════════════════════════════════════════════════════════

describe('E. create-path corners', () => {
  it('E1: a remote item flagged deleted:true is not created AND expels its local twin', async () => {
    // remoteMap excludes deleted items → the local twin's id is "absent" →
    // removal path (session-less) applies. That's the designed propagation.
    const t = makeTask({ id: 'twin', ext: { 'test-plugin': { id: 'r-dead' } } });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-dead', deleted: true, fields: { title: 'dead' } }),
    ] });
    await runReconcile(plugin, await seedStore([t]));
    expect((await listTasks())).toHaveLength(0);
  });

  it('E2: duplicate remote ids within ONE pull collapse to a single create', async () => {
    // Provider returns the same id twice (paging overlap). Map semantics
    // dedupe — the second entry overwrites, one task results.
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-dup', fields: { title: 'first' } }),
      makeRemoteItem({ remoteId: 'r-dup', fields: { title: 'second (wins)' } }),
    ] });
    await runReconcile(plugin, await seedStore([]));

    const stored = await listTasks();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('second (wins)');
  });

  it('E3: created rows are stamped with timestamps AND an owned ledger row is not required for future updates', async () => {
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-new', remoteUpdatedAt: '2025-06-01T00:00:00Z', fields: { title: 'born' } }),
    ] });
    await runReconcile(plugin, await seedStore([]));

    const [stored] = await listTasks();
    expect(stored.created_at).toBeTruthy();
    expect(stored.updated_at).toBeTruthy();

    // Second cycle over identical data: no churn (converged immediately).
    const plugin2 = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-new', remoteUpdatedAt: '2025-06-01T00:00:00Z', fields: { title: 'echo' } }),
    ] });
    await runReconcile(plugin2, await listTasks());
    expect((await listTasks())[0].title).toBe('born');
  });

  it('E4: ledger block on one item does not stop the rest of the batch', async () => {
    await seedStore([makeTask({ id: 'boot' })]);
    recordRemoteLink({ source: 'test-plugin', remoteId: 'r-blocked', state: 'deleted' });
    const plugin = makePlugin({ fullPullResult: [
      makeRemoteItem({ remoteId: 'r-blocked', fields: { title: 'zombie' } }),
      makeRemoteItem({ remoteId: 'r-ok-1', fields: { title: 'fine 1' } }),
      makeRemoteItem({ remoteId: 'r-ok-2', fields: { title: 'fine 2' } }),
    ] });
    await runReconcile(plugin, await listTasks());

    const titles = (await listTasks()).map((t) => t.title);
    expect(titles).not.toContain('zombie');
    expect(titles).toContain('fine 1');
    expect(titles).toContain('fine 2');
  });
});
