/**
 * A full pull that did not show an item is not proof the item was deleted.
 *
 * 2026-10-11: one To Do pull skipped 13 lists (the local store was busy, so the
 * plugin could not check who owned their projects) and left their items out of
 * the result. The reconciler read every task of those lists as "gone from the
 * remote" and removed 1,087 of them, while all of them were still in the
 * account; the remote-id ledger then refused to import them back. The class:
 * any pull that leaves out an item it read, or reports "nothing" when it read
 * nothing. Its guards:
 *   - an item the pull read but does not import rides as `seenOnly` and keeps
 *     its local twin;
 *   - more than MASS_REMOVAL_LIMIT removals in one pass are held, whatever the
 *     plugin, and a hold that keeps coming back is said once as an error;
 *   - every full-pull function in the repo is listed below and checked for the
 *     two ways it can drop items (a bare `continue`, a `return []`).
 * Also here: ledgered create candidates no longer starve the ones behind them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-pull-completeness'));
vi.mock('../../src/core/session-tracker.js', () => ({ listSessions: vi.fn(async () => []) }));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { SyncReconciler, MASS_REMOVAL_LIMIT } from '../../src/core/sync-reconciler.js';
import { log } from '../../src/logging/index.js';
import { _resetForTesting, addTasksBulk, listTasks } from '../../src/core/task-manager.js';
import { recordRemoteLink } from '../../src/core/task-remote-links.js';
import { closeDb } from '../../src/core/task-db.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN = 'test-plugin';

function localTask(i: number | string, overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${i}`,
    title: `Local ${i}`,
    status: 'todo' as any,
    phase: 'TODO' as any,
    priority: 'none' as any,
    project: 'Test',
    source: PLUGIN as any,
    session_ids: [],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    description: '',
    summary: '',
    note: '',
    ext: { [PLUGIN]: { remote_id: `r-${i}` } },
    ...overrides,
  } as Task;
}

function remote(i: number | string, overrides: Partial<RemoteSyncItem> = {}): RemoteSyncItem {
  return {
    remoteId: `r-${i}`,
    title: `Remote ${i}`,
    remoteUpdatedAt: '2024-06-01T00:00:00Z',
    fields: { title: `Remote ${i}`, project: 'Test', status: 'todo' as any, phase: 'TODO' as any },
    ...overrides,
  };
}

function plugin(pull: () => RemoteSyncItem[]): RegisteredPlugin {
  const noop = vi.fn();
  return {
    id: PLUGIN, name: 'Test Plugin', config: {},
    sync: {
      createTask: noop, deleteTask: noop, updateTitle: noop, updateDescription: noop, updateSummary: noop,
      updateNote: noop, updateConversationLog: noop, updatePriority: noop, updatePhase: noop,
      updateDueDate: noop, updateProject: noop, updateDependencies: noop, associateSubtask: noop,
      disassociateSubtask: noop, syncPoll: noop,
      pushTask: vi.fn().mockResolvedValue({ serverTimestamp: new Date().toISOString() }),
      fullPull: vi.fn(async () => pull()),
      extractRemoteId: (task: Task) => (task.ext?.[PLUGIN] as { remote_id?: string } | undefined)?.remote_id,
    },
    migrations: [], httpRoutes: [],
  } as RegisteredPlugin;
}

async function ctx(): Promise<SyncPollContext> {
  const tasks = await listTasks();
  return { getTasks: () => [...tasks], addTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), emit: vi.fn() } as never;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);

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

describe('an item the pull read but did not import (seenOnly)', () => {
  it('keeps its local twin, and is neither created nor used to update', async () => {
    await addTasksBulk([localTask('kept', { title: 'My title' }), localTask('other')]);
    const seen = remote('kept', { seenOnly: true, title: 'Remote title', remoteUpdatedAt: '2030-01-01T00:00:00Z', fields: {} });
    const p = plugin(() => [seen, remote('other'), remote('new-but-seen-only', { seenOnly: true, fields: {} })]);

    await reconciler.tick(p, await ctx());

    const tasks = await listTasks();
    expect(tasks.map((t) => t.id).sort()).toEqual(['task-kept', 'task-other']);
    expect(tasks.find((t) => t.id === 'task-kept')?.title).toBe('My title');
  });

  it('a former-id twin is not adopted while the task\'s current item is seenOnly', async () => {
    // The task now wears r-new (its list skipped this cycle); a stale twin still
    // wears its old id r-old in a list that was read. Adopting it would move the
    // task back to r-old, and r-new would mint a duplicate once its list reads again.
    await addTasksBulk([localTask('moved', { ext: { [PLUGIN]: { remote_id: 'r-new', previous_ids: ['r-old'] } } })]);
    const p = plugin(() => [remote('new', { seenOnly: true, fields: {} }), remote('old')]);
    p.sync.extractRemoteIdAliases = (task: Task) => (task.ext?.[PLUGIN] as { previous_ids?: string[] } | undefined)?.previous_ids;

    await reconciler.tick(p, await ctx());

    const tasks = await listTasks();
    expect(tasks.map((t) => [t.id, (t.ext?.[PLUGIN] as { remote_id?: string }).remote_id])).toEqual([['task-moved', 'r-new']]);
  });

  it('a task whose item is absent altogether is still removed', async () => {
    await addTasksBulk([localTask('gone'), localTask('here')]);
    await reconciler.tick(plugin(() => [remote('here')]), await ctx());
    expect((await listTasks()).map((t) => t.id)).toEqual(['task-here']);
  });
});

describe('the mass-removal guard', () => {
  it('holds a pass that would remove more than the limit, for any plugin, and says it once after three', async () => {
    // The 2026-10-11 shape: half the items missing, so the count-drop guard passes.
    const missing = range(0, MASS_REMOVAL_LIMIT + 5);
    const present = range(100, 140);
    await addTasksBulk([...missing, ...present].map((i) => localTask(i)));
    const errors = vi.spyOn(log.web, 'error');
    const p = plugin(() => present.map((i) => remote(i)));

    for (let pass = 1; pass <= 4; pass++) {
      reconciler.forceNextReconcile(PLUGIN);
      await reconciler.tick(p, await ctx());
      expect((await listTasks()).length).toBe(missing.length + present.length);
    }
    const held = errors.mock.calls.filter(([msg]) => String(msg).includes('no longer shows'));
    expect(held).toHaveLength(1);
    expect(held[0][1]).toMatchObject({ pluginId: PLUGIN, count: missing.length, consecutiveReconciles: 3 });
  });

  it('a clean cycle ends the hold streak, so the next hold counts from one again', async () => {
    // Enough items stay that the count-drop guard never aborts a pass.
    const missing = range(0, MASS_REMOVAL_LIMIT + 1);
    const present = range(100, 130);
    await addTasksBulk([...missing, ...present].map((i) => localTask(i)));
    const errors = vi.spyOn(log.web, 'error');
    let showAll = false;
    const p = plugin(() => (showAll ? [...missing, ...present] : present).map((i) => remote(i)));
    const pass = async () => { reconciler.forceNextReconcile(PLUGIN); await reconciler.tick(p, await ctx()); };

    await pass(); await pass();           // two holds
    showAll = true; await pass();         // nothing to remove: the streak ends
    showAll = false; await pass(); await pass(); // two holds again, not the third
    expect(errors.mock.calls.filter(([msg]) => String(msg).includes('no longer shows'))).toHaveLength(0);
    await pass();                         // the third in a row
    expect(errors.mock.calls.filter(([msg]) => String(msg).includes('no longer shows'))).toHaveLength(1);
  });

  it('still removes up to the limit in one pass', async () => {
    const missing = range(0, MASS_REMOVAL_LIMIT);
    await addTasksBulk([...missing, 100].map((i) => localTask(i)));
    await reconciler.tick(plugin(() => [remote(100)]), await ctx());
    expect((await listTasks()).map((t) => t.id)).toEqual(['task-100']);
  });
});

describe('creates', () => {
  it('ledgered candidates do not starve the new item behind them', async () => {
    // Sixty remote ids a local task once owned and deleted, ahead of one new item.
    for (const i of range(0, 60)) {
      recordRemoteLink({ source: PLUGIN, remoteId: `r-${i}`, taskId: `old-${i}`, state: 'deleted', reason: 'local-delete' });
    }
    const p = plugin(() => [...range(0, 60).map((i) => remote(i)), remote('fresh')]);
    await reconciler.tick(p, await ctx());
    expect((await listTasks()).map((t) => t.title)).toEqual(['Remote fresh']);
  });

  it('still writes at most 50 a cycle when ledgered and new candidates are mixed', async () => {
    for (const i of range(0, 40)) {
      recordRemoteLink({ source: PLUGIN, remoteId: `r-${i}`, taskId: `old-${i}`, state: 'released', reason: 'source-migration' });
    }
    const p = plugin(() => range(0, 120).map((i) => remote(i)));
    await reconciler.tick(p, await ctx());
    const titles = (await listTasks()).map((t) => t.title);
    expect(titles).toHaveLength(50);
    expect(titles.some((t) => /^Remote ([0-9]|[1-3][0-9])$/.test(t))).toBe(false);
  });
});

// Every full-pull function the repo ships. A new one fails here until it is read
// for the two ways a pull drops items and added to this list.
const FULL_PULLS: Record<string, { file: string; allowedContinues: RegExp[] }> = {
  fullPullAllTasks: {
    file: 'src/integrations/microsoft-todo.ts',
    // A list with no items has nothing to drop.
    allowedContinues: [/if \(allTasks\.length === 0\) continue;/],
  },
  fullPullAllIssues: { file: 'src/integrations/jira/sync.ts', allowedContinues: [] },
};

/** A top-level function, from its `export` line to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name}: no closing brace at column 0`);
  return source.slice(start, end + 2);
}

describe('every full pull reports every item it read', () => {
  const root = path.resolve(__dirname, '../..');

  it('lists every full-pull function in src/integrations', () => {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.ts$/.test(entry.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/export async function (fullPull\w*)\(/g)) found.add(m[1]);
        }
      }
    };
    walk(path.join(root, 'src/integrations'));
    expect([...found].sort()).toEqual(Object.keys(FULL_PULLS).sort());
  });

  it('no file outside this list implements a full pull of its own (an inline fullPull() included)', () => {
    const known = new Set([...Object.values(FULL_PULLS).map((f) => f.file), 'src/integrations/ms-todo/index.ts', 'src/integrations/jira/index.ts']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name) && /\bfullPull\s*[(:]/.test(fs.readFileSync(p, 'utf8'))) files.push(path.relative(root, p));
      }
    };
    walk(path.join(root, 'src/integrations'));
    expect(files.filter((f) => !known.has(f))).toEqual([]);
  });

  for (const [name, { file, allowedContinues }] of Object.entries(FULL_PULLS)) {
    it(`${name} drops no item it read`, () => {
      const body = functionBody(fs.readFileSync(path.join(root, file), 'utf8'), name);
      expect(body).toMatch(/\n  return result;\n\}$/);
      // "Nothing" is `null` (the reconciler skips the cycle), never `[]` (every task removed).
      expect(body).not.toMatch(/return \[\];/);
      const lines = body.split('\n');
      const bad = lines.flatMap((line, i) => {
        if (!/\bcontinue\b/.test(line)) return [];
        if (allowedContinues.some((re) => re.test(line))) return [];
        const near = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        return /seenOnly\(/.test(near) ? [] : [line.trim()];
      });
      expect(bad).toEqual([]);
    });
  }
});
