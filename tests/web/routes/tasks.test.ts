import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, linkSessionSlot, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
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
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
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
    await updateTask(task.id, { phase: 'AGENT_COMPLETE' });
    await addTask({ title: 'Fresh' });

    expect(await idsFor('?phases=AGENT_COMPLETE')).toEqual([task.id]);
    expect(await idsFor('?phases=AGENT_COMPLETE,TODO')).toHaveLength(2);
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
    await linkSessionSlot(task.id, 'sess-plan', 'plan');
    await linkSessionSlot(task.id, 'sess-exec', 'exec');

    const app = createApp();
    const res = await request(app).delete(`/api/tasks/${task.id}`);
    expect(res.status).toBe(409);
    expect(res.body.active_session_ids).toHaveLength(2);
    expect(res.body.active_session_ids).toContain('sess-plan');
    expect(res.body.active_session_ids).toContain('sess-exec');
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
