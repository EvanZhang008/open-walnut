/**
 * prepareNewTask: a plugin defaults the fields it owns on a task that enters its domain.
 *
 * The motivating case is a tracker that wants every task created in one of its projects
 * to land in the current sprint. Core knows nothing about sprints, so the whole contract
 * is "return a patch, core applies what it is allowed to and what is still empty".
 *
 * Effects are read from the real store (SQLite) and from the plugin's own pushTask spy,
 * because the point of the hook is that the FIRST push already carries the defaults.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-new-task-defaults'));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
  unlinkSessionsFromTasks: vi.fn(async () => 0),
  relinkSessionsToTask: vi.fn(async () => 0),
  completeTaskSessions: vi.fn(async () => 0),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { registry } from '../../src/core/integration-registry.js';
import {
  _resetForTesting,
  addTask,
  addTaskFull,
  ensureProject,
  getTask,
  updateTask,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { createMockPlugin, createNoopSync } from './plugin-test-utils.js';
import type { IntegrationSync, RegisteredPlugin } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN_ID = 'tracker';
const OTHER_ID = 'other-tracker';
const PROJECT = 'Tracker Proj';
const OTHER_PROJECT = 'Other Proj';

/** Tasks as the plugin saw them at push time: the assertion that the create carried the default. */
let pushed: Task[] = [];
/** Every ('created' | 'moved') the hook was invoked with, in order. */
let hookCalls: Array<{ taskId: string; reason: string }> = [];
/** TASK_UPDATED events delivered to web-ui, so "no extra write" is observable. */
let webUiUpdates: Array<{ source: string; fields?: string[] }> = [];

function installPlugin(
  id: string,
  prepareNewTask?: IntegrationSync['prepareNewTask'],
): RegisteredPlugin {
  const sync = createNoopSync();
  sync.pushTask = async (task: Task) => {
    pushed.push(structuredClone(task));
    return { serverTimestamp: new Date().toISOString() };
  };
  sync.createTask = async (task: Task) => {
    pushed.push(structuredClone(task));
    return { [id]: { id: `remote-${task.id}` } };
  };
  if (prepareNewTask) {
    sync.prepareNewTask = (task, ctx) => {
      hookCalls.push({ taskId: task.id, reason: ctx.reason });
      return prepareNewTask(task, ctx);
    };
  }
  const plugin = createMockPlugin({ id, sync });
  if (registry.has(id)) registry.unregister(id);
  registry.register(id, plugin);
  return plugin;
}

beforeEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  pushed = [];
  hookCalls = [];
  webUiUpdates = [];
  bus.subscribe('web-ui', (event) => {
    if (event.name !== EventNames.TASK_UPDATED) return;
    const data = event.data as { fields?: string[] };
    webUiUpdates.push({ source: event.source, fields: data.fields });
  });
});

afterEach(() => {
  bus.unsubscribe('web-ui');
  for (const id of [PLUGIN_ID, OTHER_ID]) if (registry.has(id)) registry.unregister(id);
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('a task created in a project the plugin claims gets the plugin defaults', () => {
  it('sprint lands on the returned task, in the store, and in the first push', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Write the migration', project: PROJECT });

    expect(task.source).toBe(PLUGIN_ID);
    expect(hookCalls).toEqual([{ taskId: task.id, reason: 'created' }]);
    // The object the caller holds.
    expect(task.sprint).toBe('Sprint 42');
    // The row on disk.
    expect((await getTask(task.id))?.sprint).toBe('Sprint 42');
    // The task the plugin was asked to create, the whole reason the hook runs pre-push.
    expect(pushed).toHaveLength(1);
    expect(pushed[0].sprint).toBe('Sprint 42');
  });

  it('every defaultable field is applied, and the console is told once', async () => {
    installPlugin(PLUGIN_ID, () => ({
      sprint: 'Sprint 42',
      priority: 'important',
      due_date: '2026-10-01',
      start_date: '2026-09-20',
      end_date: '2026-09-21',
      tags: ['triage'],
    }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Everything at once', project: PROJECT });

    const stored = await getTask(task.id);
    expect(stored?.sprint).toBe('Sprint 42');
    expect(stored?.priority).toBe('important');
    expect(stored?.due_date).toBe('2026-10-01');
    expect(stored?.start_date).toBe('2026-09-20');
    expect(stored?.end_date).toBe('2026-09-21');
    expect(stored?.tags).toEqual(['triage']);

    const fromDefaults = webUiUpdates.filter((u) => u.source === 'plugin-defaults');
    expect(fromDefaults).toHaveLength(1);
    expect(fromDefaults[0].fields).toEqual(
      expect.arrayContaining(['sprint', 'priority', 'due_date', 'start_date', 'end_date', 'tags']),
    );
  });

  it('the async-push branch defaults before the push too', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Quick add', project: PROJECT, asyncPush: true });

    // asyncPush returns before the round-trip; the default is already on the row.
    expect(task.sprint).toBe('Sprint 42');
    expect((await getTask(task.id))?.sprint).toBe('Sprint 42');
  });
});

describe('an explicit value always wins over a default', () => {
  it('a task created with sprint S1 keeps S1 when the hook returns S2', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'S2' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Explicit sprint', project: PROJECT, sprint: 'S1' });

    expect(task.sprint).toBe('S1');
    expect((await getTask(task.id))?.sprint).toBe('S1');
    expect(pushed[0].sprint).toBe('S1');
    // The hook still ran (the plugin may want to default OTHER fields).
    expect(hookCalls).toHaveLength(1);
  });

  it('an explicit priority is not overwritten, while the untouched sprint still defaults', async () => {
    installPlugin(PLUGIN_ID, () => ({ priority: 'backlog', sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Mixed', project: PROJECT, priority: 'immediate' });

    const stored = await getTask(task.id);
    expect(stored?.priority).toBe('immediate');
    expect(stored?.sprint).toBe('Sprint 42');
  });

  it("priority 'none' counts as empty, so a plugin can default it", async () => {
    installPlugin(PLUGIN_ID, () => ({ priority: 'important' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'No priority yet', project: PROJECT });

    expect((await getTask(task.id))?.priority).toBe('important');
  });

  it('an empty tag array is empty, but a tag the caller set is not', async () => {
    installPlugin(PLUGIN_ID, () => ({ tags: ['from-plugin'] }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const bare = await addTask({ title: 'No tags', project: PROJECT });
    const tagged = await addTask({ title: 'Has tags', project: PROJECT, tags: ['mine'] });

    expect((await getTask(bare.task.id))?.tags).toEqual(['from-plugin']);
    expect((await getTask(tagged.task.id))?.tags).toEqual(['mine']);
  });
});

describe('the hook cannot reach outside the defaultable set', () => {
  it('title, project and ext are dropped and the task is unchanged for them', async () => {
    installPlugin(PLUGIN_ID, () => ({
      title: 'Rewritten by the plugin',
      project: 'Somewhere Else',
      ext: { [PLUGIN_ID]: { id: 'forged' } },
      source: OTHER_ID,
      phase: 'COMPLETE',
      sprint: 'Sprint 42',
    } as Partial<Task>));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Keep my title', project: PROJECT });

    const stored = await getTask(task.id);
    expect(stored?.title).toBe('Keep my title');
    expect(stored?.project).toBe(PROJECT);
    expect(stored?.source).toBe(PLUGIN_ID);
    expect(stored?.phase).toBe('TODO');
    // ext holds only what the push wrote, never the forged id.
    expect((stored?.ext?.[PLUGIN_ID] as { id?: string } | undefined)?.id).not.toBe('forged');
    // The one allowed field still landed.
    expect(stored?.sprint).toBe('Sprint 42');
  });

  it('a patch of only disallowed keys writes nothing at all', async () => {
    installPlugin(PLUGIN_ID, () => ({ title: 'nope' } as Partial<Task>));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Untouched', project: PROJECT });

    expect((await getTask(task.id))?.title).toBe('Untouched');
    expect(webUiUpdates.filter((u) => u.source === 'plugin-defaults')).toEqual([]);
  });
});

describe('a badly behaved hook never costs the user their task', () => {
  it('a throwing hook does not fail creation, and the push still happens', async () => {
    installPlugin(PLUGIN_ID, () => { throw new Error('sprint API is down'); });
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task, syncResult } = await addTask({ title: 'Survives a bad hook', project: PROJECT });

    expect(task.id).toBeTruthy();
    expect(syncResult.success).toBe(true);
    expect((await getTask(task.id))?.title).toBe('Survives a bad hook');
    expect(pushed).toHaveLength(1);
  });

  it('a rejected promise is treated the same way', async () => {
    installPlugin(PLUGIN_ID, async () => { throw new Error('timed out'); });
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Async bad hook', project: PROJECT });
    expect((await getTask(task.id))?.sprint).toBeUndefined();
  });

  it('undefined and a non-object are both "no defaults"', async () => {
    installPlugin(PLUGIN_ID, () => undefined);
    await ensureProject(PROJECT, PLUGIN_ID);
    const a = await addTask({ title: 'Undefined patch', project: PROJECT });
    expect((await getTask(a.task.id))?.sprint).toBeUndefined();

    installPlugin(PLUGIN_ID, () => ('nope' as unknown as Partial<Task>));
    const b = await addTask({ title: 'Garbage patch', project: PROJECT });
    expect((await getTask(b.task.id))?.sprint).toBeUndefined();
    expect(webUiUpdates.filter((u) => u.source === 'plugin-defaults')).toEqual([]);
  });
});

describe('a plugin without the hook pays nothing', () => {
  it('no plugin-defaults write and no extra web-ui event', async () => {
    installPlugin(PLUGIN_ID); // no prepareNewTask
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Plain create', project: PROJECT });

    expect(hookCalls).toEqual([]);
    expect(webUiUpdates.filter((u) => u.source === 'plugin-defaults')).toEqual([]);
    // ONE web-ui update in total: the push writing back the remote id. A defaults
    // write would show up as a second one (see the "every defaultable field" case).
    expect(webUiUpdates.map((u) => u.source)).toEqual(['sync']);
    const stored = await getTask(task.id);
    // Nothing but the create touched the row: still exactly as it was born.
    expect(stored?.updated_at).toBe(task.created_at);
    expect(stored?.sprint).toBeUndefined();
  });

  it('a local task in a claimed project never enters anybody domain', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Local by choice', project: PROJECT, source: 'local' });

    expect(task.source).toBe('local');
    expect(hookCalls).toEqual([]);
    expect((await getTask(task.id))?.sprint).toBeUndefined();
  });

  it('_skipPluginOps suppresses the hook', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    const { task } = await addTask({ title: 'Internal create', project: PROJECT, _skipPluginOps: true });

    expect(hookCalls).toEqual([]);
    expect((await getTask(task.id))?.sprint).toBeUndefined();
  });
});

describe('a task the plugin imported from the remote is not a new task', () => {
  it('the sync-pull path (addTaskFull) never calls the hook', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);

    // This is exactly what SyncPollContext.addTask does (src/web/server.ts).
    const imported = await addTaskFull({
      title: 'Pulled from the remote',
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      project: PROJECT,
      source: PLUGIN_ID,
      session_ids: [],
      description: '',
      summary: '',
      note: '',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      ext: { [PLUGIN_ID]: { id: 'r-imported' } },
    } as unknown as Omit<Task, 'id'>);

    expect(hookCalls).toEqual([]);
    expect((await getTask(imported.id))?.sprint).toBeUndefined();
    // And no push was triggered either, because addTaskFull is a pull-side write.
    expect(pushed).toEqual([]);
  });
});

describe("a task moved into another plugin's project is defaulted once, with reason 'moved'", () => {
  it('a provider-to-provider move defaults through the new plugin before its first push', async () => {
    installPlugin(PLUGIN_ID); // origin plugin, no defaults of its own
    installPlugin(OTHER_ID, (_task, ctx) => (ctx.reason === 'moved' ? { sprint: 'Sprint 42' } : undefined));
    await ensureProject(PROJECT, PLUGIN_ID);
    await ensureProject(OTHER_PROJECT, OTHER_ID);

    const { task } = await addTask({ title: 'Moves house', project: PROJECT });
    expect(task.source).toBe(PLUGIN_ID);
    pushed = [];
    hookCalls = [];

    const { task: moved } = await updateTask(task.id, { project: OTHER_PROJECT }, { source: 'api' });

    expect(moved.source).toBe(OTHER_ID);
    expect(hookCalls).toEqual([{ taskId: task.id, reason: 'moved' }]);
    expect((await getTask(task.id))?.sprint).toBe('Sprint 42');
    // The first push to the NEW backend carried it.
    expect(pushed.at(-1)?.sprint).toBe('Sprint 42');
  });

  it('a move between two projects of the SAME plugin is not entering the domain', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);
    await ensureProject('Second Tracker Proj', PLUGIN_ID);

    const { task } = await addTask({ title: 'Stays inside', project: PROJECT });
    hookCalls = [];

    await updateTask(task.id, { project: 'Second Tracker Proj' }, { source: 'api' });

    expect(hookCalls).toEqual([]);
  });
});

describe('a task created from the phone (cloud outbox op) is defaulted like any other new task', () => {
  it('the primary applies the defaults before the create is pushed', async () => {
    installPlugin(PLUGIN_ID, () => ({ sprint: 'Sprint 42' }));
    await ensureProject(PROJECT, PLUGIN_ID);
    const { applyTaskOp } = await import('../../src/core/task-outbox.js');
    const now = new Date().toISOString();

    const outcome = await applyTaskOp({
      opId: 'phone-create-1', type: 'create', at: now,
      task: {
        id: 'phone-task-1', title: 'Filed from the phone', status: 'todo', phase: 'TODO',
        priority: 'none', project: PROJECT, source: 'local', session_ids: [],
        description: '', summary: '', note: '', created_at: now, updated_at: now,
      } as never,
    } as never);
    expect(outcome).toEqual({ applied: true, reason: 'created' });

    // The push is fire-and-forget on this path; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hookCalls).toEqual([{ taskId: 'phone-task-1', reason: 'created' }]);
    expect((await getTask('phone-task-1'))?.sprint).toBe('Sprint 42');
    expect(pushed.map((t) => t.sprint)).toEqual(['Sprint 42']);
  });
});
