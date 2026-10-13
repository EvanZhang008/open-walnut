import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, linkSession, linkSessionSlot, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

// The task store is SQLite: rm'ing WALNUT_HOME does NOT reset it. better-sqlite3
// keeps its fd on the unlinked inode, so without closeDb() the cached handle
// silently carries every previous test's rows into the next one.
beforeEach(async () => {
  closeDb();
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  closeSessionDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/tasks', () => {
  it('returns empty task list initially', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });

  it('returns tasks after creating some', async () => {
    await addTask({ title: 'Task A' });
    await addTask({ title: 'Task B' });

    const app = createApp();
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
  });

  it('filters by status', async () => {
    await addTask({ title: 'Todo task' });
    const { task } = await addTask({ title: 'Done task' });
    const { completeTask } = await import('../../../src/core/task-manager.js');
    await completeTask(task.id);

    const app = createApp();
    const res = await request(app).get('/api/tasks?status=todo');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe('Todo task');
  });

  it('filters by project', async () => {
    await addTask({ title: 'HomeLab task', project: 'HomeLab' });
    await addTask({ title: 'Costco task', project: 'Costco' });

    const app = createApp();
    const res = await request(app).get('/api/tasks?project=HomeLab');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe('HomeLab task');
  });

  it('matches ?project= case-insensitively (project identity is NOCASE)', async () => {
    await addTask({ title: 'HomeLab task', project: 'HomeLab' });

    const app = createApp();
    const res = await request(app).get('/api/tasks?project=homelab');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe('HomeLab task');
  });

  it('returns Inbox tasks with project="" and no category field', async () => {
    await addTask({ title: 'Loose thought' });

    const app = createApp();
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].project).toBe('');
    expect(res.body.tasks[0]).not.toHaveProperty('category');
  });
});

// The route is a thin adapter over queryTasks(); these cover the parsing
// contract (which params exist, what a bad value does) rather than re-testing
// the shared predicate semantics (tests/core/task-query.test.ts owns those).
describe('GET /api/tasks — canonical query params', () => {
  /** Ids in response order. */
  async function idsFor(qs: string): Promise<string[]> {
    const res = await request(createApp()).get(`/api/tasks${qs}`);
    expect(res.status).toBe(200);
    return (res.body.tasks as { id: string }[]).map((t) => t.id);
  }

  async function expect400(qs: string): Promise<string> {
    const res = await request(createApp()).get(`/api/tasks${qs}`);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    return res.body.error as string;
  }

  it('completion=complete returns only COMPLETE tasks', async () => {
    await addTask({ title: 'Open' });
    const { task: done } = await addTask({ title: 'Closed' });
    const { completeTask } = await import('../../../src/core/task-manager.js');
    await completeTask(done.id);

    expect(await idsFor('?completion=complete')).toEqual([done.id]);
    expect(await idsFor('?completion=todo')).not.toContain(done.id);
    // No implicit hiding of COMPLETE on REST.
    expect(await idsFor('')).toHaveLength(2);
  });

  it('completion accepts a comma-separated OR list', async () => {
    const { task: todo } = await addTask({ title: 'Todo' });
    const { task: done } = await addTask({ title: 'Done' });
    const { completeTask } = await import('../../../src/core/task-manager.js');
    await completeTask(done.id);

    expect(new Set(await idsFor('?completion=todo,complete'))).toEqual(new Set([todo.id, done.id]));
  });

  it('phases filters on the exact 7-state phase', async () => {
    const { task } = await addTask({ title: 'Mid-flight' });
    const { updateTask } = await import('../../../src/core/task-manager.js');
    await updateTask(task.id, { phase: 'NEED_ACTION' });
    await addTask({ title: 'Fresh' });

    expect(await idsFor('?phases=NEED_ACTION')).toEqual([task.id]);
    expect(await idsFor('?phases=NEED_ACTION,TODO')).toHaveLength(2);
  });

  it('projects / priorities / sources / sprints accept arrays', async () => {
    const { task: a } = await addTask({ title: 'A', project: 'Acme', priority: 'immediate' });
    const { task: b } = await addTask({ title: 'B', project: 'Marina', priority: 'backlog' });
    const { updateTask } = await import('../../../src/core/task-manager.js');
    await updateTask(a.id, { sprint: 'S1' });

    expect(new Set(await idsFor('?projects=Acme,Marina'))).toEqual(new Set([a.id, b.id]));
    expect(await idsFor('?priorities=immediate')).toEqual([a.id]);
    expect(await idsFor('?sources=local')).toHaveLength(2);
    expect(await idsFor('?sprints=S1')).toEqual([a.id]);
  });

  it('pinned / unread / blocked take true|false', async () => {
    const { task: pinned } = await addTask({ title: 'Pinned' });
    const { task: plain } = await addTask({ title: 'Plain' });
    const { togglePin } = await import('../../../src/core/task-manager.js');
    await togglePin(pinned.id);

    expect(await idsFor('?pinned=true')).toEqual([pinned.id]);
    expect(await idsFor('?pinned=false')).toEqual([plain.id]);
    // `starred` is a RETIRED param — unknown params are ignored, not rejected,
    // so an old client's link degrades to "no condition" instead of 400/empty.
    expect(new Set(await idsFor('?starred=true'))).toEqual(new Set([pinned.id, plain.id]));
    // The param is `unread`; the pre-v6 `needs_attention` spelling never shipped
    // on this route and is NOT accepted (an unknown param is simply ignored).
    expect(new Set(await idsFor('?unread=false'))).toEqual(new Set([pinned.id, plain.id]));
    expect(await idsFor('?unread=true')).toEqual([]);
    expect(new Set(await idsFor('?needs_attention=true'))).toEqual(new Set([pinned.id, plain.id]));
    expect(new Set(await idsFor('?blocked=false'))).toEqual(new Set([pinned.id, plain.id]));
  });

  it('tags_any is an OR match and tags_all an AND match', async () => {
    const { task: both } = await addTask({ title: 'Both', tags: ['red', 'blue'] });
    const { task: one } = await addTask({ title: 'One', tags: ['red'] });

    expect(new Set(await idsFor('?tags_any=red'))).toEqual(new Set([both.id, one.id]));
    expect(await idsFor('?tags_all=red,blue')).toEqual([both.id]);
  });

  it('an EMPTY tag param means no condition, not match-nothing', async () => {
    const { task: tagged } = await addTask({ title: 'Tagged', tags: ['red'] });
    const { task: bare } = await addTask({ title: 'Untagged' });
    const all = new Set([tagged.id, bare.id]);

    // Legacy `?tags=` always meant "no filter"; tags_any/tags_all must agree.
    expect(new Set(await idsFor('?tags='))).toEqual(all);
    expect(new Set(await idsFor('?tags_any='))).toEqual(all);
    expect(new Set(await idsFor('?tags_all='))).toEqual(all);
    // Commas-only is the same empty list once blanks are dropped.
    expect(new Set(await idsFor('?tags_any=,'))).toEqual(all);
  });

  it('tag= is a single exact tag, below tags_any in precedence', async () => {
    const { task: red } = await addTask({ title: 'Red', tags: ['red'] });
    const { task: blue } = await addTask({ title: 'Blue', tags: ['blue'] });

    expect(await idsFor('?tag=red')).toEqual([red.id]);
    // tags_any wins when both spellings arrive (tag is the op's legacy arg name).
    expect(await idsFor('?tags_any=blue&tag=red')).toEqual([blue.id]);
    // Empty means no condition, like the other tag params.
    expect(new Set(await idsFor('?tag='))).toEqual(new Set([red.id, blue.id]));
  });

  it('focus_tier matches PINNED rows only, satellite = pinned with no stored tier', async () => {
    const { task: focus } = await addTask({ title: 'Focus pin' });
    const { task: satellite } = await addTask({ title: 'Satellite pin' });
    const { task: loose } = await addTask({ title: 'Never pinned' });
    const { togglePin, setFocusTier } = await import('../../../src/core/task-manager.js');
    await togglePin(focus.id);
    await togglePin(satellite.id);
    await setFocusTier(focus.id, 'focus');

    // A tier is a property of the pinned board — an unpinned row matches no
    // tier, satellite included.
    expect(await idsFor('?focus_tier=satellite')).toEqual([satellite.id]);
    expect(await idsFor('?focus_tier=focus')).toEqual([focus.id]);
    expect(new Set(await idsFor('?focus_tier=focus,satellite')))
      .toEqual(new Set([focus.id, satellite.id]));
    expect(await idsFor('?focus_tier=focus,satellite')).not.toContain(loose.id);
    // An empty value is NO CONDITION, matching the tag params.
    expect(new Set(await idsFor('?focus_tier=')))
      .toEqual(new Set([focus.id, satellite.id, loose.id]));
  });

  it('working_set=true returns the whole pinned board in pin_order, finished pins included', async () => {
    const { task: a } = await addTask({ title: 'Board A' });
    const { task: b } = await addTask({ title: 'Board B' });
    const { task: finished } = await addTask({ title: 'Board finished' });
    await addTask({ title: 'Off the board' });
    const { togglePin, reorderPins, updateTask } = await import('../../../src/core/task-manager.js');
    await togglePin(a.id);
    await togglePin(b.id);
    await togglePin(finished.id);
    // Completion no longer unpins, so a COMPLETE pin is still on the board.
    await updateTask(finished.id, { phase: 'COMPLETE' });
    await reorderPins([b.id, finished.id, a.id]);

    expect(await idsFor('?working_set=true')).toEqual([b.id, finished.id, a.id]);
    // workingSet IS pinned=true, so the contradictory pair is a caller bug
    // rather than one side winning silently.
    expect(await expect400('?working_set=true&pinned=false')).toMatch(/pinned=false/);
    expect(await expect400('?working_set=maybe')).toMatch(/working_set/i);
  });

  it('q is a case-insensitive substring on the title', async () => {
    const { task: hit } = await addTask({ title: 'Renew the Passport' });
    await addTask({ title: 'Water the plants' });

    expect(await idsFor('?q=passport')).toEqual([hit.id]);
    expect(await idsFor('?q=PASSPORT')).toEqual([hit.id]);
    expect(await idsFor('?q=nothing-like-this')).toEqual([]);
  });

  it('ids= returns exactly the listed rows', async () => {
    const { task: one } = await addTask({ title: 'One' });
    const { task: two } = await addTask({ title: 'Two' });
    await addTask({ title: 'Three' });

    expect(new Set(await idsFor(`?ids=${one.id},${two.id}`))).toEqual(new Set([one.id, two.id]));
    expect(await idsFor(`?ids=${two.id}`)).toEqual([two.id]);
    expect(await idsFor('?ids=no-such-task')).toEqual([]);
  });

  it('completedWithinDays leaves old completions out and counts them; pinned ones stay', async () => {
    const { completeTask, updateTaskRaw, togglePin } = await import('../../../src/core/task-manager.js');
    const { task: open } = await addTask({ title: 'Open' });
    const { task: recent } = await addTask({ title: 'Recent done' });
    const { task: old } = await addTask({ title: 'Old done' });
    const { task: oldPinned } = await addTask({ title: 'Old pinned done' });
    // Completion no longer unpins, so the pin goes on first.
    await togglePin(oldPinned.id);
    for (const t of [recent, old, oldPinned]) await completeTask(t.id);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await updateTaskRaw(old.id, { completed_at: thirtyDaysAgo });
    await updateTaskRaw(oldPinned.id, { completed_at: thirtyDaysAgo });

    const res = await request(createApp()).get('/api/tasks?fields=list&completedWithinDays=7');
    expect(res.status).toBe(200);
    expect(new Set((res.body.tasks as { id: string }[]).map((t) => t.id)))
      .toEqual(new Set([open.id, recent.id, oldPinned.id]));
    expect(res.body.completedHidden).toBe(1);
    // `total` still counts what the query matched.
    expect(res.body.total).toBe(4);

    // Without the window the whole list comes back and the field is absent.
    const all = await request(createApp()).get('/api/tasks?fields=list');
    expect(all.body.tasks).toHaveLength(4);
    expect(all.body.completedHidden).toBeUndefined();

    await expect400('?completedWithinDays=soon');
    await expect400('?completedWithinDays=-1');
  });

  it('completedWithinDays keeps old completed asks: the Ask drawer lists every ask', async () => {
    const { completeTask, updateTaskRaw } = await import('../../../src/core/task-manager.js');
    const { task: filed } = await addTask({ title: 'Old chat filed as an ask', project: 'Ask Walnut' });
    const { task: born } = await addTask({ title: 'Old ask born in the drawer' });
    const { task: plain } = await addTask({ title: 'Old plain task' });
    for (const t of [filed, born, plain]) await completeTask(t.id);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    for (const t of [filed, born, plain]) await updateTaskRaw(t.id, { completed_at: sixtyDaysAgo });
    await updateTaskRaw(born.id, { walnut_agent: true });

    const res = await request(createApp()).get('/api/tasks?fields=list&completedWithinDays=7');
    expect(res.status).toBe(200);
    expect(new Set((res.body.tasks as { id: string }[]).map((t) => t.id))).toEqual(new Set([filed.id, born.id]));
    expect(res.body.completedHidden).toBe(1);
  });

  it('parent_task_id is an EXACT match on REST', async () => {
    const { task: parent } = await addTask({ title: 'Parent' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });

    expect(await idsFor(`?parent_task_id=${parent.id}`)).toEqual([child.id]);
    expect(await idsFor(`?parent_task_id=${parent.id.slice(0, 5)}`)).toEqual([]);
  });

  it('group_id filters group members (payload-stored field)', async () => {
    const { task: a } = await addTask({ title: 'Group A' });
    const { task: b } = await addTask({ title: 'Group B' });
    await addTask({ title: 'Outsider' });
    const { groupTasks } = await import('../../../src/core/task-manager.js');
    const { group_id } = await groupTasks([a.id, b.id], 'Pair');

    expect(new Set(await idsFor(`?group_id=${group_id}`))).toEqual(new Set([a.id, b.id]));
  });

  it('time_basis + last_hours filters on a relative window', async () => {
    const { task: recent } = await addTask({ title: 'Recent' });
    const { task: old } = await addTask({ title: 'Old' });
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js');
    const longAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    await updateTaskRaw(old.id, { created_at: longAgo, updated_at: longAgo });

    expect(await idsFor('?time_basis=updated&last_hours=6')).toEqual([recent.id]);
    expect(new Set(await idsFor('?time_basis=updated&last_days=7'))).toEqual(new Set([recent.id, old.id]));
    expect(await idsFor('?time_basis=created_or_updated&last_hours=6')).toEqual([recent.id]);
  });

  it('time_from / time_until accept an absolute half-open window', async () => {
    const { task } = await addTask({ title: 'Stamped' });
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js');
    await updateTaskRaw(task.id, { updated_at: '2026-03-05T12:00:00.000Z' });

    expect(await idsFor('?time_basis=updated&time_from=2026-03-01T00:00:00Z&time_until=2026-03-10T00:00:00Z'))
      .toEqual([task.id]);
    // until is EXCLUSIVE.
    expect(await idsFor('?time_basis=updated&time_from=2026-03-01T00:00:00Z&time_until=2026-03-05T12:00:00Z'))
      .toEqual([]);
  });

  it('time_basis=due filters a DATE-ONLY due_date row', async () => {
    // due_date is commonly stored date-only, which misses the candidate SQL's
    // canonical ISO globs — those rows must ride the fallback branch and be
    // decided in JS, not silently dropped.
    const { task: due } = await addTask({ title: 'Due mid-April', due_date: '2026-04-15' });
    await addTask({ title: 'No deadline' });

    expect(await idsFor('?time_basis=due&time_from=2026-04-01&time_until=2026-05-01')).toEqual([due.id]);
    expect(await idsFor('?time_basis=due&time_from=2026-05-01&time_until=2026-06-01')).toEqual([]);
  });

  it('an extreme time_until still matches a recent row (widened bound is clamped)', async () => {
    const { task } = await addTask({ title: 'Recent' });

    // The candidate SQL widens `until` by 1s; year 9999 + 1s renders as
    // '+010000-01-01T…' whose leading '+' sorts BELOW every digit, so the
    // candidate WHERE used to match NOTHING and real rows never reached JS.
    expect(await idsFor('?time_basis=updated&time_until=9999-12-31T23:59:59Z')).toEqual([task.id]);
    expect(await idsFor('?time_basis=created_or_updated&time_until=9999-12-31T23:59:59Z')).toEqual([task.id]);
    // The symmetric lower bound: year 0000 - 1s would render '-000001-…'.
    expect(await idsFor('?time_basis=updated&time_from=0000-01-01T00:00:00Z')).toEqual([task.id]);
  });

  it('sort and limit apply after filtering', async () => {
    const { task: first } = await addTask({ title: 'Alpha' });
    const { task: second } = await addTask({ title: 'Beta' });
    // Stamp distinct created_at values — two addTask calls can land in the SAME
    // millisecond, and created_desc would then tie-break on the random id.
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js');
    await updateTaskRaw(first.id, { created_at: '2026-03-01T00:00:00.000Z' });
    await updateTaskRaw(second.id, { created_at: '2026-03-02T00:00:00.000Z' });

    expect(await idsFor('?sort=title_asc')).toEqual([first.id, second.id]);
    expect(await idsFor('?sort=title_asc&limit=1')).toEqual([first.id]);
    expect(await idsFor('?sort=created_desc')).toEqual([second.id, first.id]);
  });

  it('reports total and truncated so a capped answer is detectable', async () => {
    await addTask({ title: 'Alpha' });
    await addTask({ title: 'Beta' });
    await addTask({ title: 'Gamma' });

    const app = createApp();
    // No limit — the whole match set, and nothing claims to be cut.
    const all = await request(app).get('/api/tasks');
    expect(all.body.tasks).toHaveLength(3);
    expect(all.body.total).toBe(3);
    expect(all.body.truncated).toBe(false);

    // Capped: total stays the PRE-limit match count, which is the only way a
    // caller can tell 1 row of 3 apart from "you have 1 task".
    const capped = await request(app).get('/api/tasks?limit=1');
    expect(capped.body.tasks).toHaveLength(1);
    expect(capped.body.total).toBe(3);
    expect(capped.body.truncated).toBe(true);

    // total counts rows matching the FILTER, not the store.
    const filtered = await request(app).get('/api/tasks?q=alpha&limit=1');
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.truncated).toBe(false);

    // Same contract on the slim/minimal projections the UI rides.
    const slim = await request(app).get('/api/tasks?fields=list&limit=2');
    expect(slim.body.tasks).toHaveLength(2);
    expect(slim.body.total).toBe(3);
    expect(slim.body.truncated).toBe(true);
  });

  it('working_set carries the server-computed board counts', async () => {
    const { task: focus } = await addTask({ title: 'Focus pin', pinned: true });
    const { task: satellite } = await addTask({ title: 'Satellite pin', pinned: true });
    const { task: done } = await addTask({ title: 'Finished pin', pinned: true });
    await addTask({ title: 'Never pinned' });
    const { setFocusTier, updateTask } = await import('../../../src/core/task-manager.js');
    await setFocusTier(focus.id, 'focus');
    await updateTask(done.id, { phase: 'COMPLETE' });

    const res = await request(createApp()).get('/api/tasks?working_set=true');
    expect(res.status).toBe(200);
    const board = res.body.board as {
      pinned_total: number; pinned_active: number; pinned_completed: number;
      tiers: { tier: string; total: number; active: number; completed: number }[];
    };
    expect(board.pinned_total).toBe(3);
    expect(board.pinned_active).toBe(2);
    expect(board.pinned_completed).toBe(1);
    const byTier = Object.fromEntries(board.tiers.map((t) => [t.tier, t]));
    expect(byTier.focus).toMatchObject({ total: 1, active: 1, completed: 0 });
    // The finished pin keeps its default tier, so Satellite holds two rows, one done.
    expect(byTier.satellite).toMatchObject({ total: 2, active: 1, completed: 1 });
    expect(byTier.wait.total).toBe(0);
    expect(byTier.backlog).toBeUndefined();
    // The counts add up to the board, which is what makes them a cross-check.
    expect(board.tiers.reduce((sum, t) => sum + t.total, 0)).toBe(board.pinned_total);
    expect(satellite.id).toBeTruthy();

    // Not a board read → no counts, no second store read.
    const plain = await request(createApp()).get('/api/tasks');
    expect(plain.body.board).toBeUndefined();

    // Same numbers from the dedicated route.
    const direct = await request(createApp()).get('/api/tasks/board-counts');
    expect(direct.status).toBe(200);
    expect(direct.body).toEqual(board);
  });

  it('rejects invalid enums, limits and time windows with 400', async () => {
    expect(await expect400('?completion=finished')).toMatch(/completion/i);
    expect(await expect400('?phases=SHIPPED')).toMatch(/phase/i);
    expect(await expect400('?priorities=urgent')).toMatch(/priority/i);
    expect(await expect400('?sort=random')).toMatch(/sort/i);
    expect(await expect400('?status=archived')).toMatch(/status/i);
    expect(await expect400('?limit=0')).toMatch(/limit/i);
    expect(await expect400('?limit=500')).toMatch(/limit/i);
    expect(await expect400('?pinned=1')).toMatch(/pinned/i);
    expect(await expect400('?time_basis=updated&last_hours=3&last_days=1')).toMatch(/mutually exclusive/i);
    expect(await expect400('?last_days=1')).toMatch(/time_basis/i);
    expect(await expect400('?time_basis=updated&last_days=400')).toMatch(/exceed/i);
    expect(await expect400('?time_basis=updated&time_from=2026-13-45T00:00:00Z')).toMatch(/timestamp/i);
  });

  it('tolerates a repeated param instead of throwing on the array shape', async () => {
    const { task } = await addTask({ title: 'Only', project: 'Acme' });
    // Express hands `?x=1&x=2` to the route as an ARRAY. Splitting that directly
    // would throw (→ 500); the parser takes the last value instead.
    expect(await idsFor('?projects=Nope&projects=Acme')).toEqual([task.id]);
    expect(await idsFor('?limit=200&limit=1')).toHaveLength(1);
    // A repeated INVALID value still answers 400, not 500.
    expect(await expect400('?limit=1&limit=abc')).toMatch(/limit/i);
  });

  it('slim and minimal projections return the same ids as the full payload', async () => {
    await addTask({ title: 'One', project: 'Acme' });
    await addTask({ title: 'Two', project: 'Acme' });

    const full = await idsFor('?projects=Acme&sort=title_asc');
    expect(full).toHaveLength(2);
    expect(await idsFor('?projects=Acme&sort=title_asc&slim=1')).toEqual(full);
    expect(await idsFor('?projects=Acme&sort=title_asc&fields=list')).toEqual(full);
  });
});

describe('GET /api/tasks/enriched', () => {
  it('returns enriched tasks with computed fields', async () => {
    await addTask({ title: 'Overdue task', due_date: '2020-01-01' });
    await addTask({ title: 'Normal task' });

    const app = createApp();
    const res = await request(app).get('/api/tasks/enriched');
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);

    const overdue = res.body.tasks.find((t: { title: string }) => t.title === 'Overdue task');
    expect(overdue.overdue).toBe(true);

    const normal = res.body.tasks.find((t: { title: string }) => t.title === 'Normal task');
    expect(normal.overdue).toBe(false);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns a single task', async () => {
    const { task } = await addTask({ title: 'Specific task' });

    const app = createApp();
    const res = await request(app).get(`/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Specific task');
    expect(res.body.task.id).toBe(task.id);
  });

  it('returns 404 for non-existent task', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tasks/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /api/tasks/bulk', () => {
  const NOTE = '## Progress\n- [DONE] shipped it\n- [BLOCKED] waiting on review\n\n'
    + '## Work Log\n- long log prose a triage pass must not have to download\n';

  it('projects the named fields for many ids in ONE call, in input order', async () => {
    const { task: one } = await addTask({ title: 'One', project: 'Acme' });
    const { task: two } = await addTask({ title: 'Two', project: 'Acme' });
    const { updateNote } = await import('../../../src/core/task-manager.js');
    await updateNote(one.id, NOTE);

    const res = await request(createApp())
      .get(`/api/tasks/bulk?ids=${two.id},${one.id}&fields=title,phase,progress`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.errors).toBe(0);
    expect(res.body.fields).toEqual(['title', 'phase', 'progress']);
    expect((res.body.tasks as { id: string }[]).map((t) => t.id)).toEqual([two.id, one.id]);
    expect(res.body.tasks[1]).toMatchObject({
      title: 'One',
      phase: 'TODO',
      progress: [
        { status: 'DONE', text: 'shipped it' },
        { status: 'BLOCKED', text: 'waiting on review' },
      ],
    });
    // The Work Log never rides along.
    expect(JSON.stringify(res.body)).not.toContain('long log prose');
  });

  it('answers a missing id per item instead of failing the call', async () => {
    const { task } = await addTask({ title: 'Real' });
    const res = await request(createApp()).get(`/api/tasks/bulk?ids=${task.id},nope&fields=title`);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBe(1);
    expect(res.body.tasks[0].title).toBe('Real');
    expect(res.body.tasks[1]).toEqual({ id: 'nope', error: 'not found' });
  });

  it('defaults the field set and rejects a bad request with 400', async () => {
    const { task } = await addTask({ title: 'Defaults', project: 'Acme' });
    const defaulted = await request(createApp()).get(`/api/tasks/bulk?ids=${task.id}`);
    expect(defaulted.status).toBe(200);
    expect(defaulted.body.tasks[0]).toMatchObject({ title: 'Defaults', project: 'Acme', phase: 'TODO' });
    expect(defaulted.body.tasks[0]).not.toHaveProperty('note');

    expect((await request(createApp()).get('/api/tasks/bulk')).status).toBe(400);
    expect((await request(createApp()).get('/api/tasks/bulk?ids=')).status).toBe(400);
    const badField = await request(createApp()).get(`/api/tasks/bulk?ids=${task.id}&fields=nope`);
    expect(badField.status).toBe(400);
    expect(badField.body.error).toMatch(/Unknown field/);

    const tooMany = await request(createApp())
      .get(`/api/tasks/bulk?ids=${Array.from({ length: 51 }, (_, i) => `id${i}`).join(',')}`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/at most 50/);
  });

  it('is not shadowed by the /:id route', async () => {
    // Declared before '/:id', so 'bulk' is the route, never a task id.
    const res = await request(createApp()).get('/api/tasks/bulk?ids=whatever');
    expect(res.status).toBe(200);
    expect(res.body.tasks[0].error).toBe('not found');
  });
});

describe('POST /api/tasks', () => {
  it('creates a task and returns it', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'New task', priority: 'immediate', project: 'work' });

    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('New task');
    expect(res.body.task.priority).toBe('immediate');
    expect(res.body.task.project).toBe('work');
    expect(res.body.task.id).toBeDefined();
  });

  it('creates a task with default fields (no project → Inbox)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Simple task' });

    expect(res.status).toBe(201);
    expect(res.body.task.priority).toBe('none');
    expect(res.body.task.status).toBe('todo');
    expect(res.body.task.project).toBe('');
    expect(res.body.task.source).toBe('local');
  });

  it('creates a local task when source="local" is passed', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Local note', project: 'Scratch', source: 'local' });

    expect(res.status).toBe(201);
    expect(res.body.task.source).toBe('local');
    expect(res.body.task.project).toBe('Scratch');
  });

  it('auto-creates the registry row for a brand-new project name', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Kickoff', project: 'Brand New' });

    expect(res.status).toBe(201);
    const { getStoreProjects } = await import('../../../src/core/task-manager.js');
    expect(await getStoreProjects()).toHaveProperty('Brand New');
  });

  it('folds a differently-cased project name onto the canonical spelling', async () => {
    const app = createApp();
    await request(app).post('/api/tasks').send({ title: 'First', project: 'HomeLab' });
    const res = await request(app).post('/api/tasks').send({ title: 'Second', project: 'homelab' });

    expect(res.status).toBe(201);
    // NOCASE identity: the registry's spelling wins, so one project — not two.
    expect(res.body.task.project).toBe('HomeLab');
    const { getStoreProjects } = await import('../../../src/core/task-manager.js');
    expect(Object.keys(await getStoreProjects())).toEqual(['HomeLab']);
  });

  it('rejects a provider-sourced task with no project (Inbox is local-only)', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Orphan remote task', source: 'ms-todo' });

    // No project → structurally unclaimable, so addTask refuses rather than
    // silently filing a syncable task where it can never be pushed.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Inbox/);
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('updates task fields', async () => {
    const { task } = await addTask({ title: 'Original' });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ title: 'Updated', priority: 'immediate' });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Updated');
    expect(res.body.task.priority).toBe('immediate');
  });
});

describe('POST /api/tasks/:id/complete', () => {
  it('marks a task as done', async () => {
    const { task } = await addTask({ title: 'To complete' });

    const app = createApp();
    const res = await request(app).post(`/api/tasks/${task.id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('done');
  });

  it('completes a parent with open subtasks and leaves every subtask as it was', async () => {
    const { task: parent } = await addTask({ title: 'Ship the release' });
    const { task: a } = await addTask({ title: 'Build the page', parent_task_id: parent.id });
    // Test data: a mixed CJK title (escaped).
    const { task: b } = await addTask({ title: 'Wire the API \u6d4b\u8bd5', parent_task_id: parent.id });
    const { task: done } = await addTask({ title: 'Already done', parent_task_id: parent.id });
    await request(createApp()).post(`/api/tasks/${done.id}/complete`);

    const res = await request(createApp()).post(`/api/tasks/${parent.id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.task.phase).toBe('COMPLETE');
    const list = await request(createApp()).get('/api/tasks');
    const byId = new Map((list.body.tasks as Array<{ id: string; phase: string; parent_task_id?: string }>).map((t) => [t.id, t]));
    expect(byId.get(a.id)).toMatchObject({ phase: 'TODO', parent_task_id: parent.id });
    expect(byId.get(b.id)).toMatchObject({ phase: 'TODO', parent_task_id: parent.id, title: 'Wire the API \u6d4b\u8bd5' });
    expect(byId.get(done.id)).toMatchObject({ phase: 'COMPLETE' });
  });
});

describe('POST /api/tasks/:id/notes', () => {
  it('adds a note to a task', async () => {
    const { task } = await addTask({ title: 'Notable' });

    const app = createApp();
    const res = await request(app)
      .post(`/api/tasks/${task.id}/notes`)
      .send({ content: 'Important note' });

    expect(res.status).toBe(200);
    expect(res.body.task.note).toContain('Important note');
  });
});

describe('PATCH /api/tasks/reorder', () => {
  // Manual order is persisted as the store's ROW ORDER (see reorderTasks — it
  // permutes array slots and touches no field). It is a UI presentation concern,
  // NOT a query dimension, so these assert it through listTasks (which returns
  // store order); GET /api/tasks answers in its own documented sort order
  // (updated_desc by default) and is asserted separately below.
  it('reorders tasks within a project group and persists', async () => {
    const { task: t1 } = await addTask({ title: 'First', project: 'HomeLab' });
    const { task: t2 } = await addTask({ title: 'Second', project: 'HomeLab' });
    const { task: t3 } = await addTask({ title: 'Third', project: 'HomeLab' });

    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ project: 'HomeLab', taskIds: [t3.id, t1.id, t2.id] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { listTasks } = await import('../../../src/core/task-manager.js');
    const stored = (await listTasks({ project: 'HomeLab' })).map((t) => t.id);
    expect(stored).toEqual([t3.id, t1.id, t2.id]);
  });

  it("reorders the Inbox group (project: '') — '' is a valid group, not a missing field", async () => {
    const { task: t1 } = await addTask({ title: 'Inbox one' });
    const { task: t2 } = await addTask({ title: 'Inbox two' });

    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ project: '', taskIds: [t2.id, t1.id] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { listTasks } = await import('../../../src/core/task-manager.js');
    expect((await listTasks({ project: '' })).map((t) => t.id)).toEqual([t2.id, t1.id]);
  });

  it('GET /api/tasks answers in updated_desc order, not store order', async () => {
    const { task: t1 } = await addTask({ title: 'First', project: 'HomeLab' });
    const { task: t2 } = await addTask({ title: 'Second', project: 'HomeLab' });

    const app = createApp();
    // Put t1 first in STORE order…
    await request(app).patch('/api/tasks/reorder').send({ project: 'HomeLab', taskIds: [t1.id, t2.id] });
    // …the query still answers newest-updated first (t2 was created later).
    const listRes = await request(app).get('/api/tasks?projects=HomeLab');
    expect(listRes.body.tasks.map((t: { id: string }) => t.id)).toEqual([t2.id, t1.id]);
  });

  it('returns 400 when project is not a string', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ taskIds: ['a', 'b'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project must be a string/);
  });

  it('returns 400 for missing taskIds', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ project: 'HomeLab' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for empty taskIds', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/tasks/reorder')
      .send({ project: 'HomeLab', taskIds: [] });

    expect(res.status).toBe(400);
  });

  // Removed: 'returns 500 for mismatched IDs'. reorderTasks stopped throwing on
  // an orderedIds/group mismatch in 3404816 — it now self-heals (drops unknown
  // ids, dedups, appends missing members) because the frontend legitimately sends
  // stale ids from optimistic updates. The reconciliation semantics are covered in
  // tests/core/task-manager.test.ts; there is no 500 path left to assert here.
});

// Subtask endpoint tests removed — subtasks are now child tasks in the plugin system

describe('DELETE /api/tasks/:id', () => {
  it('deletes a task and returns 204', async () => {
    const { task } = await addTask({ title: 'Delete via API' });

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(204);

    // Verify task is gone
    const listRes = await request(app).get('/api/tasks');
    expect(listRes.body.tasks).toHaveLength(0);
  });

  it('returns 409 when task has active session slots', async () => {
    const { task } = await addTask({ title: 'Active session task' });
    await createSessionRecord('session-aaa', task.id, '', undefined, { initialProcessStatus: 'running' });
    await linkSessionSlot(task.id, 'session-aaa', 'exec');

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active sessions/);
    expect(res.body.active_session_ids).toContain('session-aaa');

    // Verify task still exists
    const listRes = await request(app).get('/api/tasks');
    expect(listRes.body.tasks).toHaveLength(1);
  });

  it('returns 409 with both slots occupied', async () => {
    const { task } = await addTask({ title: 'Multi session task' });
    await createSessionRecord('sess-plan', task.id, '', undefined, { initialProcessStatus: 'idle' });
    await createSessionRecord('sess-exec', task.id, '', undefined, { initialProcessStatus: 'running' });
    await linkSessionSlot(task.id, 'sess-plan', 'plan');
    await linkSessionSlot(task.id, 'sess-exec', 'exec');

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(409);
    expect(res.body.active_session_ids).toHaveLength(2);
    expect(res.body.active_session_ids).toContain('sess-plan');
    expect(res.body.active_session_ids).toContain('sess-exec');
  });

  it('deletes (204, no force) a task whose linked session has stopped', async () => {
    const { task } = await addTask({ title: 'Ended session task' });
    await createSessionRecord('sess-ended', task.id, '', undefined, { initialProcessStatus: 'stopped' });
    await linkSession(task.id, 'sess-ended');

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(204);
    const listRes = await request(app).get('/api/tasks');
    expect(listRes.body.tasks).toHaveLength(0);
  });

  it('returns 404 for non-existent task', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/tasks/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:id/merge', () => {
  it('merges victims into the survivor, unioning session links', async () => {
    const { linkSession } = await import('../../../src/core/task-manager.js');
    const { task: survivor } = await addTask({ title: 'H-1B RFE follow-up' });
    const { task: victim } = await addTask({ title: 'H-1B RFE follow-up (copy)' });
    await linkSession(survivor.id, 'sess-a');
    await linkSession(victim.id, 'sess-b');

    const app = createApp();
    const res = await request(app)
      .post(`/api/tasks/${survivor.id}/merge`)
      .send({ victim_ids: [victim.id] });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(1);
    expect(res.body.task.session_ids).toEqual(expect.arrayContaining(['sess-a', 'sess-b']));

    // Victim is gone; survivor holds both links.
    const listRes = await request(app).get('/api/tasks');
    expect(listRes.body.tasks).toHaveLength(1);
    expect(listRes.body.tasks[0].id).toBe(survivor.id);
  });

  it('rejects a survivor listed among the victims', async () => {
    const { task } = await addTask({ title: 'Self merge' });
    const app = createApp();
    const res = await request(app)
      .post(`/api/tasks/${task.id}/merge`)
      .send({ victim_ids: [task.id] });
    expect(res.status).toBe(400);
  });

  it('rejects an empty victim list', async () => {
    const { task } = await addTask({ title: 'No victims' });
    const app = createApp();
    const res = await request(app)
      .post(`/api/tasks/${task.id}/merge`)
      .send({ victim_ids: [] });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown victim', async () => {
    const { task } = await addTask({ title: 'Lonely survivor' });
    const app = createApp();
    const res = await request(app)
      .post(`/api/tasks/${task.id}/merge`)
      .send({ victim_ids: ['nonexistent-task'] });
    expect(res.status).toBe(404);
  });

  describe('a survivor or victim gone while the merge runs or waits (r5 gate, L-28, L-29)', () => {
    // A request merges its victims in one turn of the merge queue, and each merge moves its
    // sessions under the session write lock. Holding that lock here stops a merge right after its
    // task commit, so the deletes land exactly where the gate found them: while a merge moves its
    // sessions, or while another request waits behind it.
    async function holdSessionLock() {
      const tracker = await import('../../../src/core/session-tracker.js');
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const done = tracker._withSessionWriteLockForTesting(() => held);
      return { release, done };
    }
    const post = (app: ReturnType<typeof createApp>, survivor: string, victims: string[]) =>
      request(app).post(`/api/tasks/${survivor}/merge`).send({ victim_ids: victims }).then((res) => res);
    const gone = async (id: string) => {
      const { getTask } = await import('../../../src/core/task-manager.js');
      await vi.waitFor(async () => { await expect(getTask(id)).rejects.toThrow(/No task found/); }, { timeout: 10_000, interval: 10 });
    };
    const taskOf = async (sid: string) => {
      const { getSessionByClaudeId } = await import('../../../src/core/session-tracker.js');
      return (await getSessionByClaudeId(sid))?.taskId;
    };
    const inFlight = async () => (await import('../../../src/core/task-manager.js'))._mergesInFlightForTesting();
    /** What a test started and must see end, even when it fails: answers, deletes, the lock hold. */
    let pending: Array<Promise<unknown>> = [];
    let releaseLock: (() => void) | null = null;
    afterEach(async () => {
      releaseLock?.();
      releaseLock = null;
      await Promise.allSettled(pending.splice(0));
      // No merge outlives its test (a later one counts the queue).
      await vi.waitFor(async () => { expect(await inFlight()).toBe(0); }, { timeout: 10_000, interval: 10 });
    });
    async function lockHeld() {
      const lock = await holdSessionLock();
      releaseLock = lock.release;
      pending.push(lock.done);
      return lock;
    }
    function started<T>(p: Promise<T>): Promise<T> {
      pending.push(p);
      return p;
    }

    it('the survivor deleted while the merge moves the sessions: 200, the victim merged, no task (L-28)', async () => {
      const { deleteTask, getTask } = await import('../../../src/core/task-manager.js');
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a } = await addTask({ title: 'Survivor (copy)' });
      for (const sid of ['l28-a1', 'l28-a2', 'l28-a3']) await createSessionRecord(sid, a.id, 'P', '/tmp');
      const lock = await lockHeld();
      const answer = started(post(createApp(), b.id, [a.id]));
      await gone(a.id); // the merge committed its tasks and now waits to move the sessions
      const deleting = started(deleteTask(b.id));
      await gone(b.id);
      lock.release();
      const res = await answer;
      await deleting;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ task: null, survivor_deleted: true, merged: 1, merged_ids: [a.id], sessions_relinked: 0 });
      expect(res.body.not_merged).toBeUndefined();
      await expect(getTask(a.id)).rejects.toThrow(/No task found/);
      for (const sid of ['l28-a1', 'l28-a2', 'l28-a3']) expect(await taskOf(sid), sid).toBeUndefined();
    });

    it('the survivor deleted after some sessions moved: 200 with the count that moved (L-28)', async () => {
      const { deleteTask } = await import('../../../src/core/task-manager.js');
      const tracker = await import('../../../src/core/session-tracker.js');
      const { bus, EventNames } = await import('../../../src/core/event-bus.js');
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a } = await addTask({ title: 'Survivor (copy)' });
      const ofA = Array.from({ length: 12 }, (_, i) => `l28k-a${i}`);
      for (const sid of ofA) await createSessionRecord(sid, a.id, 'P', '/tmp');
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      releaseLock = release;
      let holding = false;
      let moved = 0;
      bus.subscribe('l28k-hold', (event) => {
        if (event.name !== EventNames.SESSION_STATUS_CHANGED || !ofA.includes((event.data as { sessionId: string }).sessionId)) return;
        // After the fifth session moved, another writer holds the lock: the delete lands there.
        if (++moved === 5 && !holding) {
          holding = true;
          pending.push(tracker._withSessionWriteLockForTesting(() => held));
        }
      }, { global: true });
      tracker._setRetaskSliceMsForTesting(0);
      try {
        const answer = started(post(createApp(), b.id, [a.id]));
        await vi.waitFor(() => { expect(holding).toBe(true); }, { timeout: 10_000, interval: 10 });
        const deleting = started(deleteTask(b.id));
        await gone(b.id);
        release();
        const res = await answer;
        await deleting;
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ task: null, survivor_deleted: true, merged: 1, sessions_relinked: 5 });
        for (const sid of ofA) expect(await taskOf(sid), sid).toBeUndefined();
      } finally {
        release();
        bus.unsubscribe('l28k-hold');
        tracker._setRetaskSliceMsForTesting(null);
      }
    });

    it('a queued merge whose survivor was deleted while it waited: 404, nothing merged (L-29)', async () => {
      const { deleteTask, getTask } = await import('../../../src/core/task-manager.js');
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a } = await addTask({ title: 'Copy one' });
      const { task: c } = await addTask({ title: 'Copy two' });
      await createSessionRecord('l29-a', a.id, 'P', '/tmp');
      await createSessionRecord('l29-c1', c.id, 'P', '/tmp');
      await createSessionRecord('l29-c2', c.id, 'P', '/tmp');
      const lock = await lockHeld();
      const first = started(post(createApp(), b.id, [a.id]));
      await gone(a.id);
      const second = started(post(createApp(), b.id, [c.id]));
      await vi.waitFor(async () => { expect(await inFlight()).toBe(2); }, { timeout: 10_000, interval: 10 });
      const deleting = started(deleteTask(b.id));
      await gone(b.id);
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      await deleting;
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ task: null, survivor_deleted: true, merged: 1 });
      expect(two.status).toBe(404);
      expect(two.body).toMatchObject({ code: 'survivor_gone', merged: 0, not_merged: [{ id: c.id, reason: 'survivor_gone' }] });
      expect(two.body.error).toContain(`survivor ${b.id} was deleted, or merged into another task, before this merge ran`);
      // The queued victim is untouched, sessions and all.
      expect((await getTask(c.id)).id).toBe(c.id);
      for (const sid of ['l29-c1', 'l29-c2']) expect(await taskOf(sid), sid).toBe(c.id);
    });

    it('a queued merge whose victim was deleted while it waited: 404; the merge ahead of it: 200 (L-29)', async () => {
      const { deleteTask, getTask } = await import('../../../src/core/task-manager.js');
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a } = await addTask({ title: 'Copy one' });
      const { task: c } = await addTask({ title: 'Copy two' });
      await createSessionRecord('l29v-a', a.id, 'P', '/tmp');
      const lock = await lockHeld();
      const first = started(post(createApp(), b.id, [a.id]));
      await gone(a.id);
      const second = started(post(createApp(), b.id, [c.id]));
      await vi.waitFor(async () => { expect(await inFlight()).toBe(2); }, { timeout: 10_000, interval: 10 });
      const deleting = started(deleteTask(c.id));
      await gone(c.id);
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      await deleting;
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ task: { id: b.id }, merged: 1, merged_ids: [a.id], sessions_relinked: 1 });
      expect(one.body.survivor_deleted).toBeUndefined();
      expect(two.status).toBe(404);
      expect(two.body).toMatchObject({ code: 'victim_gone', merged: 0, not_merged: [{ id: c.id, reason: 'victim_gone' }] });
      expect((await getTask(b.id)).id).toBe(b.id);
      expect(await taskOf('l29v-a')).toBe(b.id);
    });

    it('several victims and the survivor deleted during the first: 200 with the rest not merged and kept', async () => {
      const { deleteTask, getTask } = await import('../../../src/core/task-manager.js');
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a } = await addTask({ title: 'Copy one' });
      const { task: c } = await addTask({ title: 'Copy two' });
      await createSessionRecord('multi-c', c.id, 'P', '/tmp');
      const lock = await lockHeld();
      const answer = started(post(createApp(), b.id, [a.id, c.id]));
      await gone(a.id);
      const deleting = started(deleteTask(b.id));
      await gone(b.id);
      lock.release();
      const res = await answer;
      await deleting;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        task: null, survivor_deleted: true, merged: 1, merged_ids: [a.id],
        not_merged: [{ id: c.id, reason: 'survivor_gone' }],
      });
      expect((await getTask(c.id)).id).toBe(c.id);
      expect(await taskOf('multi-c')).toBe(c.id);
    });

    it('a merge of the survivor queued meanwhile waits for all of the request: nothing is reported gone', async () => {
      // A1 and A2 into B, and B into C asked while A1 moves its sessions. Queued one victim at a
      // time, B into C ran between A1 and A2: A2 had no survivor and was reported gone (r6 review).
      const { getTask } = await import('../../../src/core/task-manager.js');
      const { task: c } = await addTask({ title: 'Final' });
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a1 } = await addTask({ title: 'Copy one' });
      const { task: a2 } = await addTask({ title: 'Copy two' });
      for (const [sid, t] of [['seq-a1', a1], ['seq-a2', a2], ['seq-b', b]] as const) await createSessionRecord(sid, t.id, 'P', '/tmp');
      const lock = await lockHeld();
      const first = started(post(createApp(), b.id, [a1.id, a2.id]));
      await gone(a1.id);
      const second = started(post(createApp(), c.id, [b.id]));
      await vi.waitFor(async () => { expect(await inFlight()).toBe(2); }, { timeout: 10_000, interval: 10 });
      lock.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ task: { id: b.id }, merged: 2, merged_ids: [a1.id, a2.id], sessions_relinked: 2 });
      expect(one.body.not_merged).toBeUndefined();
      expect(two.status).toBe(200);
      expect(two.body).toMatchObject({ task: { id: c.id }, merged: 1, merged_ids: [b.id], sessions_relinked: 3 });
      for (const sid of ['seq-a1', 'seq-a2', 'seq-b']) expect(await taskOf(sid), sid).toBe(c.id);
      await expect(getTask(a2.id)).rejects.toThrow(/No task found/);
    });

    it('a victim named twice is merged once', async () => {
      const { task: b } = await addTask({ title: 'Survivor' });
      const { task: a } = await addTask({ title: 'Copy' });
      const res = await started(post(createApp(), b.id, [a.id, a.id]));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ task: { id: b.id }, merged: 1, merged_ids: [a.id] });
      expect(res.body.not_merged).toBeUndefined();
    });
  });

  describe('from a session on another host (x-walnut-origin: host:…), only its own work', () => {
    const SID = '33333333-4444-5555-6666-000000000901';
    async function leaderWithSession(project = 'marina'): Promise<{ id: string; group_id?: string }> {
      const { task: leader } = await addTask({ title: 'Triage board', project });
      await createSessionRecord(SID, leader.id, project, '/repo/marina', { title: 'Triage board', initialProcessStatus: 'running' });
      return leader;
    }
    const merge = (app: ReturnType<typeof createApp>, survivor: string, victims: string[], sid: string | undefined = SID) => {
      let req = request(app).post(`/api/tasks/${survivor}/merge`).set('x-walnut-origin', 'host:devbox');
      if (sid) req = req.set('x-walnut-caller-sid', sid);
      return req.send({ victim_ids: victims });
    };

    it('merges its own subtasks (the duplicate imports it was handed)', async () => {
      const leader = await leaderWithSession();
      const { task: a } = await addTask({ title: 'Ticket 123', project: 'marina', parent_task_id: leader.id });
      const { task: b } = await addTask({ title: '[ALARM] Ticket 123', project: 'marina', parent_task_id: leader.id });
      const res = await merge(createApp(), a.id, [b.id]);
      expect(res.status).toBe(200);
      expect(res.body.merged).toBe(1);
    });

    it('merges tasks in its own folder', async () => {
      const { createFolder, addToGroup } = await import('../../../src/core/task-manager.js');
      const leader = await leaderWithSession();
      const folder = await createFolder('Sev2', 'marina');
      const { task: a } = await addTask({ title: 'Dup A', project: 'marina' });
      const { task: b } = await addTask({ title: 'Dup B', project: 'marina' });
      await addToGroup(folder.group_id, [leader.id, a.id, b.id]);
      const res = await merge(createApp(), a.id, [b.id]);
      expect(res.status).toBe(200);
    });

    it('refuses a task outside its reach, naming it, and merges nothing', async () => {
      const leader = await leaderWithSession();
      const { task: own } = await addTask({ title: 'Own', project: 'marina', parent_task_id: leader.id });
      const { task: stranger } = await addTask({ title: 'Someone else\'s task', project: 'marina' });
      const app = createApp();
      const res = await merge(app, own.id, [stranger.id]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('out_of_reach');
      expect(res.body.error.out_of_reach).toEqual([stranger.id]);
      expect(res.body.error.message).toContain(stranger.id);
      const list = await request(app).get('/api/tasks');
      expect(list.body.tasks.map((t: { id: string }) => t.id).sort()).toEqual([leader.id, own.id, stranger.id].sort());
    });

    it('a remote caller Walnut cannot place reaches nothing', async () => {
      const { task: a } = await addTask({ title: 'A' });
      const { task: b } = await addTask({ title: 'B' });
      const anonymous = await merge(createApp(), a.id, [b.id], undefined);
      expect(anonymous.status).toBe(403);
      const unknownSid = await merge(createApp(), a.id, [b.id], '33333333-4444-5555-6666-000000000999');
      expect(unknownSid.status).toBe(403);
    });

    it('the same call from this box is not limited', async () => {
      const { task: a } = await addTask({ title: 'A' });
      const { task: b } = await addTask({ title: 'B' });
      const res = await request(createApp()).post(`/api/tasks/${a.id}/merge`).send({ victim_ids: [b.id] });
      expect(res.status).toBe(200);
    });
  });
});

describe('Cross-source project change', () => {
  async function setupPluginConfig() {
    const { CONFIG_FILE } = await import('../../../src/constants.js');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none' },
        provider: { type: 'bedrock' },
        // The claim point moved down a level: plugins reserve a PROJECT now.
        plugins: { 'plugin-a': { room_id: 'room-123', project: 'Work' } },
      }),
    );
  }

  // A LOCAL task moved into a plugin-reserved project stays local — the
  // project is just a folder for a never-sync task (promoting it minted the
  // remote twin that seeded the duplicate-import loop). Provider→provider and
  // provider→Inbox moves still migrate (tested below).
  it('PATCH /api/tasks/:id keeps a local task local in a plugin-reserved project', async () => {
    await setupPluginConfig();

    const { registry } = await import('../../../src/core/integration-registry.js');
    const { createMockPlugin } = await import('../../core/plugin-test-utils.js');
    if (!registry.has('plugin-a')) registry.register('plugin-a', createMockPlugin({ id: 'plugin-a' }));

    // 'Work' matches plugins.plugin-a.project, so the claim resolves to plugin-a
    // for a task created WITHOUT an explicit source.
    const { task: pluginTask } = await addTask({ title: 'Plugin task', project: 'Work' });
    expect(pluginTask.source).toBe('plugin-a');

    // 'Life' is unclaimed → local.
    const { task: localTask } = await addTask({ title: 'Local task', project: 'Life' });
    expect(localTask.source).toBe('local');

    const app = createApp();
    const res = await request(app)
      .patch(`/api/tasks/${localTask.id}`)
      .send({ project: 'Work' });

    expect(res.status).toBe(200);
    expect(res.body.task.project).toBe('Work');
    expect(res.body.task.source).toBe('local');
  });

  it('PATCH /api/tasks/:id succeeds for a same-source project change', async () => {
    // Both projects are local (no external plugin config)
    const { task: t1 } = await addTask({ title: 'Task A', project: 'Alpha' });
    await addTask({ title: 'Task B', project: 'Beta' });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/tasks/${t1.id}`)
      .send({ project: 'Beta' });

    expect(res.status).toBe(200);
    expect(res.body.task.project).toBe('Beta');
    expect(res.body.task.source).toBe('local');
  });

  it('PATCH project="" moves a task to Inbox and migrates it back to local', async () => {
    await setupPluginConfig();
    const { registry } = await import('../../../src/core/integration-registry.js');
    const { createMockPlugin } = await import('../../core/plugin-test-utils.js');
    if (!registry.has('plugin-a')) registry.register('plugin-a', createMockPlugin({ id: 'plugin-a' }));

    const { task } = await addTask({ title: 'Provider task', project: 'Work' });
    expect(task.source).toBe('plugin-a');

    const app = createApp();
    const res = await request(app).patch(`/api/tasks/${task.id}`).send({ project: '' });

    expect(res.status).toBe(200);
    expect(res.body.task.project).toBe('');
    // Inbox is structurally local-only, so the task can't keep a provider claim.
    expect(res.body.task.source).toBe('local');
  });
});
