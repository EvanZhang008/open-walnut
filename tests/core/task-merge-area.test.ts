/**
 * A merge never touches incoming-item area work (task-manager.ts refuseAreaMerge): the area
 * registry and its ledger keep the victim's exact id, and a merge moves sessions, children and
 * history, which is no migration. Real task store, real session store, a real registry file in a
 * temp home. Every refusal must leave tasks, sessions, children and the registry as they were;
 * an ordinary merge still runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-merge-area'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  _resetForTesting, addTask, getTask, listTasks, mergeTaskInto, mergeTasksInto, updateTaskRaw,
  AreaMergeRefusedError, MergeTaskMissingError,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { routerAreaProfile } from '../../src/core/router/session-policy.js';
import { isRemoteIdBlocked } from '../../src/core/task-remote-links.js';
import { seedLegacySession } from '../helpers/router-history-fixtures.js';

const areasFile = () => path.join(WALNUT_HOME, 'router', 'areas.json');

function writeAreas(areas: Array<{ id: string; taskIds: string[] }>): void {
  fs.mkdirSync(path.dirname(areasFile()), { recursive: true });
  fs.writeFileSync(areasFile(), JSON.stringify({
    version: 1, routers: [], items: [],
    areas: areas.map((a) => ({ id: a.id, name: a.id, host: '__local__', sources: [], taskIds: a.taskIds })),
  }));
}

async function sessionStore() {
  const tracker = await import('../../src/core/session-tracker.js');
  const { closeDb: closeSessionDb } = await import('../../src/core/session-db.js');
  closeSessionDb();
  tracker._resetSessionTrackerForTesting();
  return { tracker, done: () => { closeSessionDb(); tracker._resetSessionTrackerForTesting(); } };
}

let done: () => void = () => {};
let tracker: Awaited<ReturnType<typeof sessionStore>>['tracker'];

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
  ({ tracker, done } = await sessionStore());
});

afterEach(() => {
  done();
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Two local tasks, one victim session, and a child under the victim. */
async function pair(opts: { survivorArea?: string; victimArea?: string } = {}) {
  const { task: survivor } = await addTask({ title: 'Survivor', project: '', source: 'local', ...(opts.survivorArea ? { router_area_id: opts.survivorArea } : {}) });
  const { task: victim } = await addTask({ title: 'Victim', project: '', source: 'local', ...(opts.victimArea ? { router_area_id: opts.victimArea } : {}) });
  const { task: child } = await addTask({ title: 'Child', project: '', source: 'local', parent_task_id: victim.id,
    ...(opts.victimArea ? { router_area_id: opts.victimArea } : {}) });
  await tracker.createSessionRecord('victim-sid', victim.id, '', '/tmp',
    opts.victimArea ? { profile: routerAreaProfile(opts.victimArea, 'work') } : {});
  await updateTaskRaw(victim.id, { session_id: 'victim-sid', session_ids: ['victim-sid'] });
  return { survivor, victim, child };
}

/** Everything a merge could write, read back. */
async function snapshot() {
  const tasks = JSON.stringify((await listTasks()).map((t) => ({ ...t })).sort((a, b) => a.id.localeCompare(b.id)));
  const session = JSON.stringify(await tracker.getSessionByClaudeId('victim-sid'));
  const registry = fs.existsSync(areasFile()) ? fs.readFileSync(areasFile(), 'utf-8') : null;
  return { tasks, session, registry };
}

async function expectRefused(run: () => Promise<unknown>, role: 'survivor' | 'victim', victimId: string) {
  const before = await snapshot();
  const err = await run().then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AreaMergeRefusedError);
  expect(err).toMatchObject({ code: 'area_merge_refused', status: 409, role });
  expect(await snapshot()).toEqual(before);
  expect((await getTask(victimId)).id).toBe(victimId);
  expect(isRemoteIdBlocked('local', victimId)).toBe(false);
}

describe('merge refuses incoming-item area work before any write', () => {
  it('area victim into ordinary work', async () => {
    const { survivor, victim, child } = await pair({ victimArea: 'personal' });
    writeAreas([{ id: 'personal', taskIds: [victim.id, child.id] }]);
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'victim', victim.id);
    expect((await getTask(child.id)).parent_task_id).toBe(victim.id);
    expect((await tracker.getSessionByClaudeId('victim-sid'))?.taskId).toBe(victim.id);
  });

  it('ordinary victim into area work', async () => {
    const { survivor, victim } = await pair({ survivorArea: 'personal' });
    writeAreas([{ id: 'personal', taskIds: [survivor.id] }]);
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'survivor', victim.id);
  });

  it('two tasks of the same area', async () => {
    const { survivor, victim, child } = await pair({ survivorArea: 'personal', victimArea: 'personal' });
    writeAreas([{ id: 'personal', taskIds: [survivor.id, victim.id, child.id] }]);
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'survivor', victim.id);
  });

  it('two tasks of different areas', async () => {
    const { survivor, victim, child } = await pair({ survivorArea: 'personal', victimArea: 'work' });
    writeAreas([{ id: 'personal', taskIds: [survivor.id] }, { id: 'work', taskIds: [victim.id, child.id] }]);
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'survivor', victim.id);
  });

  it('a task whose only area trace is a session profile', async () => {
    const { survivor, victim } = await pair();
    await seedLegacySession('profile-only', survivor.id, '', '/tmp', { profile: { areaId: 'personal', areaRole: 'work' }, initialProcessStatus: 'running' });
    writeAreas([]);
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'survivor', victim.id);
  });

  it('a task listed only in the registry', async () => {
    const { survivor, victim } = await pair();
    writeAreas([{ id: 'personal', taskIds: [victim.id] }]);
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'victim', victim.id);
  });

  it('an unreadable registry refuses every merge', async () => {
    const { survivor, victim } = await pair();
    fs.mkdirSync(path.dirname(areasFile()), { recursive: true });
    fs.writeFileSync(areasFile(), '{ not json');
    await expectRefused(() => mergeTaskInto(survivor.id, victim.id), 'survivor', victim.id);
  });

  it('a batch with one area victim merges none of its victims', async () => {
    const { survivor, victim } = await pair({ victimArea: 'personal' });
    const { task: plain } = await addTask({ title: 'Plain duplicate', project: '', source: 'local' });
    writeAreas([{ id: 'personal', taskIds: [victim.id] }]);
    const before = await snapshot();
    await expect(mergeTasksInto(survivor.id, [plain.id, victim.id])).rejects.toBeInstanceOf(AreaMergeRefusedError);
    expect(await snapshot()).toEqual(before);
    expect((await getTask(plain.id)).id).toBe(plain.id);
  });
});

describe('merge of ordinary work is unchanged', () => {
  it('merges two ordinary tasks and moves the victim\'s session and child', async () => {
    const { survivor, victim, child } = await pair();
    writeAreas([]);
    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);
    expect(merged.session_id).toBe('victim-sid');
    expect((await tracker.getSessionByClaudeId('victim-sid'))?.taskId).toBe(survivor.id);
    expect((await getTask(child.id)).parent_task_id).toBe(survivor.id);
    await expect(getTask(victim.id)).rejects.toThrow(/No task found/);
  });

  it('merges with no registry file at all', async () => {
    const { survivor, victim } = await pair();
    await mergeTaskInto(survivor.id, victim.id);
    await expect(getTask(victim.id)).rejects.toThrow(/No task found/);
  });

  it('keeps MergeTaskMissingError for a missing task', async () => {
    const { survivor } = await pair();
    await expect(mergeTaskInto(survivor.id, 'no-such-task')).rejects.toBeInstanceOf(MergeTaskMissingError);
    const batch = await mergeTasksInto(survivor.id, ['no-such-task']);
    expect(batch.notMerged).toEqual([{ id: 'no-such-task', reason: 'victim_gone' }]);
  });
});
