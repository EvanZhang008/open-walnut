/**
 * Edge-case tests for mergeTaskInto — the sanctioned dedup path (2026-08-21).
 *
 * The contract under test: NO merge shape may lose a session link, and the
 * victim's remote identity must become un-importable without ever touching an
 * id the survivor still owns. Base coverage lives in task-remote-links.test.ts;
 * this file enumerates the corners: occupied slots, chained merges, self/
 * missing args, group membership, created_at inheritance, cross-source merges.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-merge-edge'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  _resetForTesting,
  addTask,
  deleteTask,
  getTask,
  listTasks,
  mergeTaskInto,
  mergeTasksInto,
  MergeTaskMissingError,
  updateTaskRaw,
  _mergesInFlightForTesting,
} from '../../src/core/task-manager.js';
import { closeDb, getDb as getTaskDb } from '../../src/core/task-db.js';
import type { Task } from '../../src/core/types.js';
import { isRemoteIdBlocked } from '../../src/core/task-remote-links.js';

beforeEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
});

afterEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('mergeTaskInto — session link preservation corners', () => {
  it('M1: victim slot id spills into session_ids when the survivor slot is OCCUPIED', async () => {
    // The failure this pins: both copies ran sessions, so both session_id
    // slots are full. The victim's slot id can't take the survivor's slot —
    // it MUST land in session_ids or the link is destroyed (the UI joins on
    // session_ids; a slot id is not guaranteed to be mirrored there).
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { session_id: 'surv-slot' });
    await updateTaskRaw(victim.id, { session_id: 'vict-slot', plan_session_id: 'vict-plan' });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_id).toBe('surv-slot');            // survivor keeps its slot
    expect(merged.session_ids).toContain('vict-slot');      // victim's spilled, not lost
    expect(merged.plan_session_id).toBe('vict-plan');       // empty slot filled normally
  });

  it('M2: all three victim slots spill when all three survivor slots are occupied', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { session_id: 's1', plan_session_id: 's2', exec_session_id: 's3' });
    await updateTaskRaw(victim.id, { session_id: 'v1', plan_session_id: 'v2', exec_session_id: 'v3' });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_id).toBe('s1');
    expect(merged.plan_session_id).toBe('s2');
    expect(merged.exec_session_id).toBe('s3');
    for (const spilled of ['v1', 'v2', 'v3']) {
      expect(merged.session_ids).toContain(spilled);
    }
  });

  it('M3: no duplicate entries when a spilled slot id already lives in session_ids', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { session_id: 'occupied', session_ids: ['shared'] });
    await updateTaskRaw(victim.id, { session_id: 'shared', session_ids: ['shared'] });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_ids.filter((s) => s === 'shared')).toHaveLength(1);
  });

  it('M4: chained merges (C→B→A) accumulate every link into the final survivor', async () => {
    // The dedup script merges N victims one at a time. Verify transitivity:
    // links picked up from C via B must survive B's own merge into A.
    const { task: a } = await addTask({ title: 'A', project: 'P' });
    const { task: b } = await addTask({ title: 'B', project: 'P' });
    const { task: c } = await addTask({ title: 'C', project: 'P' });
    await updateTaskRaw(a.id, { session_ids: ['sa'] });
    await updateTaskRaw(b.id, { session_ids: ['sb'] });
    await updateTaskRaw(c.id, { session_ids: ['sc'], session_id: 'sc-slot' });

    await mergeTaskInto(b.id, c.id);
    const { survivor: final } = await mergeTaskInto(a.id, b.id);

    for (const sid of ['sa', 'sb', 'sc']) expect(final.session_ids).toContain(sid);
    expect(final.session_id).toBe('sc-slot'); // slot travelled B→A via the fill rule
    expect(await listTasks()).toHaveLength(1);
  });

  it('M5: merging a victim with NO links leaves the survivor links untouched', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { session_ids: ['keep'], session_id: 'keep-slot' });

    const { survivor: merged, sessionsRelinked } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_ids).toEqual(['keep']);
    expect(merged.session_id).toBe('keep-slot');
    expect(sessionsRelinked).toBe(0);
  });
});

describe('mergeTaskInto — structure and identity corners', () => {
  it('M6: refuses to merge a task into itself', async () => {
    const { task } = await addTask({ title: 'Self', project: 'P' });
    await expect(mergeTaskInto(task.id, task.id)).rejects.toThrow(/same task/);
    expect(await listTasks()).toHaveLength(1);
  });

  it('M7: missing survivor or victim throws and mutates nothing', async () => {
    const { task } = await addTask({ title: 'Alone', project: 'P' });
    await updateTaskRaw(task.id, { session_ids: ['s1'] });

    await expect(mergeTaskInto('nope-1', task.id)).rejects.toThrow(/not found/);
    await expect(mergeTaskInto(task.id, 'nope-2')).rejects.toThrow(/not found/);
    // Typed, so the route answers 404 for a merge whose task went away while it waited (r5 gate, L-29).
    await expect(mergeTaskInto('nope-1', task.id)).rejects.toMatchObject({ name: 'MergeTaskMissingError', role: 'survivor', taskId: 'nope-1' });
    await expect(mergeTaskInto(task.id, 'nope-2')).rejects.toBeInstanceOf(MergeTaskMissingError);
    await expect(mergeTaskInto(task.id, 'nope-2')).rejects.toMatchObject({ role: 'victim', taskId: 'nope-2' });
    // A rejected merge leaves the queue: nothing counts as waiting or running.
    expect(_mergesInFlightForTesting()).toBe(0);

    const after = await getTask(task.id);
    expect(after?.session_ids).toEqual(['s1']); // untouched
  });

  it('M8: survivor inherits the EARLIEST created_at (history stays honest)', async () => {
    const { task: survivor } = await addTask({ title: 'Younger', project: 'P' });
    const { task: victim } = await addTask({ title: 'Older', project: 'P' });
    await updateTaskRaw(survivor.id, { created_at: '2026-06-01T00:00:00Z' });
    await updateTaskRaw(victim.id, { created_at: '2026-01-01T00:00:00Z' });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);
    expect(merged.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('M9: survivor keeps its own created_at when it is already the older one', async () => {
    const { task: survivor } = await addTask({ title: 'Older', project: 'P' });
    const { task: victim } = await addTask({ title: 'Younger', project: 'P' });
    await updateTaskRaw(survivor.id, { created_at: '2026-01-01T00:00:00Z' });
    await updateTaskRaw(victim.id, { created_at: '2026-06-01T00:00:00Z' });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);
    expect(merged.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('M10: grandchildren keep their parent; only DIRECT children re-home', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { task: child } = await addTask({ title: 'child', project: 'P', parent_task_id: victim.id });
    const { task: grandchild } = await addTask({ title: 'grandchild', project: 'P', parent_task_id: child.id });

    await mergeTaskInto(survivor.id, victim.id);

    expect((await getTask(child.id))?.parent_task_id).toBe(survivor.id);
    expect((await getTask(grandchild.id))?.parent_task_id).toBe(child.id); // untouched
  });

  it('M11: merging two DIFFERENT-source copies tombstones only the victim source ids', async () => {
    // Fork aftermath can leave one ms-todo copy and one provider-B copy of the
    // same work item. Merging across sources must tombstone the victim's id
    // under the VICTIM's source, and never write rows for the survivor's source.
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { source: 'provider-a' as any, ext: { 'provider-a': { id: 'ra-1' } } });
    await updateTaskRaw(victim.id, { source: 'provider-b' as any, ext: { 'provider-b': { id: 'rb-1' } } });

    await mergeTaskInto(survivor.id, victim.id);

    expect(isRemoteIdBlocked('provider-b', 'rb-1')).toBe(true);   // victim id dead
    expect(isRemoteIdBlocked('provider-a', 'ra-1')).toBe(false);  // survivor id alive
  });

  it('M12: victim with NO ext merges cleanly (nothing to tombstone)', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(victim.id, { session_ids: ['sv'] });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_ids).toContain('sv');
    expect(await listTasks()).toHaveLength(1);
  });

  it('M13: sessionsRelinked counts only rows that actually pointed at the victim', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('sess-victim-1', victim.id, 'P', '/tmp');
    await createSessionRecord('sess-victim-2', victim.id, 'P', '/tmp');
    await createSessionRecord('sess-survivor', survivor.id, 'P', '/tmp');
    await createSessionRecord('sess-unrelated', 'someone-else', 'P', '/tmp');

    const { sessionsRelinked } = await mergeTaskInto(survivor.id, victim.id);

    expect(sessionsRelinked).toBe(2);
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js');
    expect((await getSessionByClaudeId('sess-victim-1'))?.taskId).toBe(survivor.id);
    expect((await getSessionByClaudeId('sess-victim-2'))?.taskId).toBe(survivor.id);
    expect((await getSessionByClaudeId('sess-survivor'))?.taskId).toBe(survivor.id);
    expect((await getSessionByClaudeId('sess-unrelated'))?.taskId).toBe('someone-else');
  });

  /** A session store of the test's own (the handle may still point at an earlier test's home), one
   *  row per retask slice (so the merges below run for many turns of the loop), and the bus. */
  async function slicedSessions() {
    const tracker = await import('../../src/core/session-tracker.js');
    const { bus, EventNames } = await import('../../src/core/event-bus.js');
    const { closeDb: closeSessionDb } = await import('../../src/core/session-db.js');
    closeSessionDb();
    tracker._resetSessionTrackerForTesting();
    tracker._setRetaskSliceMsForTesting(0);
    const done = () => {
      tracker._setRetaskSliceMsForTesting(null);
      closeSessionDb();
      tracker._resetSessionTrackerForTesting();
    };
    return { tracker, bus, EventNames, done };
  }

  it('M14: the survivor deleted while the merge re-points sessions leaves none on a deleted task', async () => {
    // The merge moves the victim's sessions in slices; a delete of the survivor that starts between
    // them must not leave the rest pointing at it (r4 gate, L-23: 59 of 60 did), and the merge must
    // not announce the survivor after its delete (every open board would show it again).
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { tracker, bus, EventNames, done } = await slicedSessions();
    const survivorRow = () => getTaskDb()!.prepare('SELECT 1 FROM tasks WHERE id = ?').pluck().get(survivor.id) !== undefined;
    // Many sessions, one per slice: the delete's few file-lock steps land while the merge still runs.
    const victims = Array.from({ length: 300 }, (_, i) => `m14-victim-${i}`);
    for (const id of victims) await tracker.createSessionRecord(id, victim.id, 'P', '/tmp');
    await tracker.createSessionRecord('m14-survivor', survivor.id, 'P', '/tmp');
    let deleting: Promise<unknown> | null = null;
    const updatesOfTheDeleted: string[] = [];
    const mergeDeletes: unknown[] = [];
    bus.subscribe('m14-delete-survivor', (event) => {
      if (event.name === EventNames.TASK_DELETED && event.source === 'merge') mergeDeletes.push(event.data);
      if (event.name === EventNames.TASK_UPDATED && (event.data as { task: Task }).task.id === survivor.id && !survivorRow()) {
        updatesOfTheDeleted.push(event.source ?? '?');
      }
      if (event.name !== EventNames.SESSION_STATUS_CHANGED || deleting) return;
      // The merge's first session is announced: now the survivor is deleted.
      deleting = deleteTask(survivor.id);
    }, { global: true }); // TASK_UPDATED is addressed to the web UI only
    let relinked = -1;
    let survivorDeleted = false;
    try {
      ({ sessionsRelinked: relinked, survivorDeleted } = await mergeTaskInto(survivor.id, victim.id));
      await deleting;
    } finally {
      bus.unsubscribe('m14-delete-survivor');
    }
    expect(deleting).not.toBeNull();
    // The merge says so, and the route answers what happened from it (r5 gate, L-28).
    expect(survivorDeleted).toBe(true);
    // The delete landed while the merge ran: it re-pointed only the sessions before it.
    expect(relinked).toBeGreaterThan(0);
    expect(relinked).toBeLessThan(victims.length);
    expect(await listTasks()).toHaveLength(0);
    for (const id of [...victims, 'm14-survivor']) {
      expect((await tracker.getSessionByClaudeId(id))?.taskId, id).toBeUndefined();
    }
    expect(updatesOfTheDeleted).toEqual([]);
    // The victim's delete names no task it went into: the survivor is gone too (r6 gate, MED-1).
    expect(mergeDeletes).toHaveLength(1);
    expect(mergeDeletes[0]).toMatchObject({ id: victim.id });
    expect((mergeDeletes[0] as { mergedInto?: unknown }).mergedInto).toBeUndefined();
    done();
  });

  it('M16: the merge announces the victim delete by its id, so every open board drops the row (r5 gate, L-27)', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'A (copy)', project: 'P' });
    const { bus, EventNames } = await import('../../src/core/event-bus.js');
    const seen: Array<{ name: string; data: unknown; destinations: string[]; source?: string }> = [];
    bus.subscribe('m16-merge-events', (event) => {
      if (event.name === EventNames.TASK_DELETED || event.name === EventNames.TASK_UPDATED) seen.push(event);
    }, { global: true }); // both are addressed to the web UI only
    let result: Awaited<ReturnType<typeof mergeTaskInto>>;
    try {
      result = await mergeTaskInto(survivor.id, victim.id);
    } finally {
      bus.unsubscribe('m16-merge-events');
    }
    expect(result.survivorDeleted).toBe(false);
    const deleted = seen.filter((e) => e.name === EventNames.TASK_DELETED);
    expect(deleted).toHaveLength(1);
    // It names where the work went, so a page open on the victim can say so and link there (r6 gate, MED-1).
    expect(deleted[0]!.data).toMatchObject({ id: victim.id, task: { id: victim.id }, mergedInto: { id: survivor.id, title: 'A' } });
    expect(deleted[0]!.destinations).toEqual(['web-ui']);
    expect(deleted[0]!.source).toBe('merge');
    expect(seen.find((e) => e.name === EventNames.TASK_UPDATED)?.data).toMatchObject({ task: { id: survivor.id } });
  });

  it('M15: two merges at once, A into B and B into C: every session follows to C', async () => {
    // Merges run one at a time. Overlapping, the first found B gone partway and cleared the links of
    // A's remaining sessions, which must follow B to C.
    const { task: c } = await addTask({ title: 'C', project: 'P' });
    const { task: b } = await addTask({ title: 'B', project: 'P' });
    const { task: a } = await addTask({ title: 'A', project: 'P' });
    const { tracker, done } = await slicedSessions();
    const ofA = Array.from({ length: 200 }, (_, i) => `m15-a-${i}`);
    const ofB = Array.from({ length: 5 }, (_, i) => `m15-b-${i}`);
    for (const id of ofA) await tracker.createSessionRecord(id, a.id, 'P', '/tmp');
    for (const id of ofB) await tracker.createSessionRecord(id, b.id, 'P', '/tmp');
    const [first, second] = await Promise.all([mergeTaskInto(b.id, a.id), mergeTaskInto(c.id, b.id)]);
    expect(first.sessionsRelinked).toBe(200);
    expect(second.sessionsRelinked).toBe(205);
    for (const id of [...ofA, ...ofB]) {
      expect((await tracker.getSessionByClaudeId(id))?.taskId, id).toBe(c.id);
    }
    expect((await listTasks()).map((t) => t.id)).toEqual([c.id]);
    done();
  });
  it('M17: a merge that fails for a reason other than a missing task is thrown and moves nothing (r6 gate, L-34)', async () => {
    // Only a task gone before its turn is listed as not merged. Any other failure (a SQLite or disk
    // error) must reach the caller: listed as "victim gone", the route answered "nothing was merged"
    // (404) while part of that victim may have moved.
    const { task: survivor } = await addTask({ title: 'Keep', project: 'P' });
    const { task: victim } = await addTask({ title: 'Keep (copy)', project: 'P' });
    const { task: next } = await addTask({ title: 'Keep (second copy)', project: 'P' });
    await updateTaskRaw(victim.id, { session_ids: ['m17-v'] });
    await expect(mergeTasksInto(survivor.id, [survivor.id])).rejects.toThrow(/same task/);
    // The victim's row cannot be removed: the write of its merge fails.
    const db = getTaskDb()!;
    db.exec(`CREATE TRIGGER m17_refuse BEFORE DELETE ON tasks WHEN OLD.id = '${victim.id}' BEGIN SELECT RAISE(ABORT, 'm17: write refused'); END`);
    try {
      await expect(mergeTasksInto(survivor.id, [victim.id, next.id])).rejects.toThrow(/m17: write refused/);
    } finally {
      db.exec('DROP TRIGGER m17_refuse');
    }
    expect(_mergesInFlightForTesting()).toBe(0);
    // Nothing moved: the victim keeps its link, the survivor did not take it, and the merge stopped
    // there (the victim after it is still its own task).
    expect((await getTask(victim.id)).session_ids).toEqual(['m17-v']);
    expect((await getTask(survivor.id)).session_ids ?? []).not.toContain('m17-v');
    expect((await listTasks()).map((t) => t.id).sort()).toEqual([survivor.id, victim.id, next.id].sort());
  });

  it('M18: a survivor that cannot be read back is an error, not a survivor deleted (r6 gate, L-34)', async () => {
    // After the victims, the merge reads the survivor back for its answer. Only "no such task" means
    // it was deleted meanwhile; any other read error must reach the caller, or the route answers
    // survivor_deleted with no task for a survivor that still exists.
    const { task: survivor } = await addTask({ title: 'Stay', project: 'P' });
    const { task: victim } = await addTask({ title: 'Stay (copy)', project: 'P' });
    const { tracker, bus, EventNames, done } = await slicedSessions();
    await tracker.createSessionRecord('m18-v', victim.id, 'P', '/tmp');
    // A second connection changes the task DB while the merge moves the victim's session (as another
    // process would): the read-back then rescans the DB, and one of the tables it reads is gone.
    const other = new Database(getTaskDb()!.name);
    let broke = false;
    bus.subscribe('m18-break-read-back', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED || broke) return;
      broke = true;
      other.exec('ALTER TABLE task_projects RENAME TO task_projects_m18');
    });
    try {
      try {
        await expect(mergeTasksInto(survivor.id, [victim.id])).rejects.toThrow(/task_projects/);
        expect(broke).toBe(true);
        expect(_mergesInFlightForTesting()).toBe(0);
      } finally {
        bus.unsubscribe('m18-break-read-back');
        if (broke) other.exec('ALTER TABLE task_projects_m18 RENAME TO task_projects');
        other.close();
      }
      // The merge itself happened: the survivor exists and holds the victim's session.
      expect((await listTasks()).map((t) => t.id)).toEqual([survivor.id]);
      expect((await tracker.getSessionByClaudeId('m18-v'))?.taskId).toBe(survivor.id);
    } finally {
      done();
    }
  });
});
