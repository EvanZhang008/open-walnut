/**
 * A project-level change never lifts a task's own hold (2026-11-21, the lead: making a project
 * local only stops syncing to the outside service; clearing a task's `private` or `chosen` hold
 * would put a private task back on every host's copies). Class guard: every kind in
 * SYNC_HOLD_STATES, with every `by`, survives each project-level path; only a hold a project step
 * made (`via: 'project'`, hold-owner.ts) goes. A new kind is covered here by being added to the
 * list, and a new place in src that clears a hold fails the source ratchet below until it is named.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-hold-owner'));

import {
  addTask, getTask, ensureProject, setProjectLocal, setTaskSyncHold, releaseSyncHold, updateTask, fileTasksIntoProject,
  holdForProject, _resetForTesting, settleBackgroundPushes,
} from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { registry } from '../../../src/core/integration-registry.js';
import { createSpySync, createMockPlugin } from '../plugin-test-utils.js';
import { setPrivacyJudgeForTest } from '../../../src/core/private-tasks/privacy-judge.js';
import { settleSyncGates } from '../../../src/core/private-tasks/sync-gate.js';
import { PARENT_MADE_LOCAL_REASON, projectOwnsHold } from '../../../src/core/private-tasks/hold-owner.js';
import { keptFromHosts } from '../../../src/core/replication/host-private.js';
import { SYNC_HOLD_STATES, type SyncHold } from '../../../src/core/types.js';

const PLUGIN = 'fake-list';
const PROJECT = 'Errands';
const BYS: Array<SyncHold['by']> = [undefined, 'words', 'model', 'user'];

/** Every hold a task can own: each kind with each `by`. */
const OWN_HOLDS: SyncHold[] = SYNC_HOLD_STATES.flatMap((state) => BYS.map((by) => ({
  target: PLUGIN, state, ...(by ? { by } : {}), reason: `own ${state} hold`, at: '2026-11-21T00:00:00.000Z',
})));

async function heldTask(hold: SyncHold, project = PROJECT): Promise<string> {
  const { task } = await addTask({ title: `Held ${hold.state} ${hold.by ?? '-'}`, project, source: 'local' } as never);
  await setTaskSyncHold(task.id, hold);
  return task.id;
}

describe('a project-level change keeps every hold the task owns', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    setPrivacyJudgeForTest(async () => ({ private: true, reason: 'test' }));
    if (registry.has(PLUGIN)) registry.unregister(PLUGIN);
    registry.register(PLUGIN, createMockPlugin({ id: PLUGIN, sync: createSpySync() }));
    await ensureProject(PROJECT, PLUGIN);
    await ensureProject('Home', 'local');
  });

  afterEach(async () => {
    await settleSyncGates();
    await settleBackgroundPushes();
    setPrivacyJudgeForTest(null);
    registry.unregister(PLUGIN);
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('the list of kinds is the type, and no own hold is owned by a project step', () => {
    expect(SYNC_HOLD_STATES.length).toBeGreaterThanOrEqual(4);
    for (const h of OWN_HOLDS) expect(projectOwnsHold(h)).toBe(false);
    for (const state of SYNC_HOLD_STATES) expect(projectOwnsHold({ via: 'project', reason: `x ${state}` })).toBe(true);
  });

  it('setProjectLocal leaves every own hold as it was, so the task stays off hosts; it clears only what a project step made', async () => {
    const own = await Promise.all(OWN_HOLDS.map((h) => heldTask(h)));
    const made = await Promise.all(SYNC_HOLD_STATES.map((state) => heldTask({
      target: PLUGIN, state, by: 'user', via: 'project', reason: 'Its project stopped syncing to Fake', at: '2026-11-21T00:00:00.000Z',
    })));
    // Before `via` existed: the reasons such holds carried.
    const legacy = [
      await heldTask({ target: PLUGIN, state: 'chosen', by: 'user', reason: 'Its project stopped syncing to Fake', at: '2026-11-21T00:00:00.000Z' }),
      await heldTask({ target: PLUGIN, state: 'chosen', by: 'user', reason: 'Moved here from Other: it syncs to Fake only when you choose Sync', at: '2026-11-21T00:00:00.000Z' }),
    ];
    const out = await setProjectLocal(PROJECT);
    expect(out).toMatchObject({ name: PROJECT, from: PLUGIN, holdsCleared: made.length + legacy.length });
    for (const [i, id] of own.entries()) {
      const t = await getTask(id);
      expect(t.sync_hold).toEqual(OWN_HOLDS[i]);
      expect(keptFromHosts(t)).toBe(true);
    }
    for (const id of [...made, ...legacy]) expect((await getTask(id)).sync_hold).toBeUndefined();
  });

  it('a batch begun before `via` existed: a subtask that went local with a project-made parent goes with it; one of a person\'s or a stopped push\'s stays', async () => {
    const T = '2026-11-20T00:00:00.000Z'
    const family = async (parentHold: SyncHold, childAt = T) => {
      const parent = await heldTask(parentHold)
      const { task } = await addTask({ title: `Child of ${parentHold.reason}`, project: PROJECT, source: 'local', parent_task_id: parent } as never)
      const child: SyncHold = { target: PLUGIN, state: parentHold.state, ...(parentHold.by ? { by: parentHold.by } : {}), reason: PARENT_MADE_LOCAL_REASON, at: childAt }
      await setTaskSyncHold(task.id, child)
      return { parent, child: task.id, hold: child }
    }
    const batch = await family({ target: PLUGIN, state: 'chosen', by: 'user', reason: 'Its project stopped syncing to Fake', at: T })
    const person = await family({ target: PLUGIN, state: 'chosen', by: 'user', reason: 'You made it local', at: T })
    const agent = await family({ target: PLUGIN, state: 'chosen', by: 'user', reason: 'An agent made it local', at: T })
    const pushStop = await family({ target: PLUGIN, state: 'private', by: 'model', reason: 'Looks private', at: T })
    // Another step's subtask under a batch parent (another time): its own.
    const later = await family({ target: PLUGIN, state: 'chosen', by: 'user', reason: 'Its project stopped syncing to Fake', at: T }, '2026-11-20T09:00:00.000Z')
    const out = await setProjectLocal(PROJECT)
    // The two batch parents and the batch's child.
    expect(out).toMatchObject({ holdsCleared: 3 })
    expect((await getTask(batch.child)).sync_hold).toBeUndefined()
    for (const f of [person, agent, pushStop, later]) expect((await getTask(f.child)).sync_hold).toEqual(f.hold)
    for (const f of [person, agent, pushStop]) expect((await getTask(f.parent)).sync_hold).toBeDefined()
    // The reason alone never says a project made it.
    expect(projectOwnsHold(batch.hold)).toBe(false)
  })

  it('a held task moved into a project that syncs nowhere keeps its own hold (updateTask, filing)', async () => {
    for (const h of OWN_HOLDS) {
      const a = await heldTask(h);
      await updateTask(a, { project: 'Home' });
      expect((await getTask(a)).sync_hold).toEqual(h);
      const b = await heldTask(h);
      await fileTasksIntoProject('Home', [{ id: b }]);
      expect((await getTask(b)).sync_hold).toEqual(h);
    }
    const moved = await heldTask({ target: PLUGIN, state: 'chosen', by: 'user', via: 'project', reason: 'Moved here', at: '2026-11-21T00:00:00.000Z' });
    await updateTask(moved, { project: 'Home' });
    expect((await getTask(moved)).sync_hold).toBeUndefined();
  });

  it('holdForProject: a project that syncs nowhere returns the own hold itself, and a project step\'s none', () => {
    for (const h of OWN_HOLDS) expect(holdForProject(h, null)).toBe(h);
    expect(holdForProject({ ...OWN_HOLDS[0], via: 'project' }, null)).toBeNull();
  });

  it('a release in a project that syncs nowhere clears only a hold still being judged or made by a project step', async () => {
    for (const h of OWN_HOLDS) {
      const id = await heldTask(h, 'Home');
      const r = await releaseSyncHold(id, undefined, 'user');
      expect(r).toMatchObject({ released: false, reason: 'project_local' });
      expect((await getTask(id)).sync_hold).toEqual(h.state === 'checking' ? undefined : h);
    }
  });

  it('source ratchet: every place in src that clears a task\'s hold is named here', async () => {
    const root = path.resolve(__dirname, '../../../src');
    const CLEAR = /delete\s+[\w.]+\.sync_hold\b|\.sync_hold\s*=\s*(?:undefined|null)\b|\bsync_hold:\s*(?:undefined|null)\b/g;
    const found: Record<string, number> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.ts')) {
          const n = (await fs.readFile(p, 'utf8')).match(CLEAR)?.length ?? 0;
          if (n) found[path.relative(root, p).split(path.sep).join('/')] = n;
        }
      }
    };
    await walk(root);
    // Each one, and why it may clear: a new one asks projectOwnsHold first, or is a task's own step.
    expect(found).toEqual({
      // setProjectLocal (owned holds only); updateTask's project move (holdForProject); the plugin
      // snapshots of a rollback and of an outside-copy change (no store write); the folder move
      // (holdForProject); setTaskSyncHold(null); releaseSyncHold twice (a project that syncs
      // nowhere: checking or owned only; a release that sends the task out).
      'core/task-manager.ts': 8,
    });
  });
});
