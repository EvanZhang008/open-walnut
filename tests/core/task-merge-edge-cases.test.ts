/**
 * Edge-case tests for mergeTaskInto — the sanctioned dedup path (2026-08-21).
 *
 * The contract under test: NO merge shape may lose a session link, and the
 * victim's remote identity must become un-importable without ever touching an
 * id the survivor still owns. A task has exactly one session
 * (src/core/sessions/one-session-per-task.ts): the survivor keeps its own, an
 * empty survivor takes the victim's, and every other victim session is detached
 * (its row names the survivor as `legacyTaskId`) and listed in the survivor's
 * `legacy_session_ids`. Base coverage lives in task-remote-links.test.ts;
 * this file enumerates the corners: occupied slots, chained merges, self/
 * missing args, group membership, created_at inheritance, cross-source merges.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from '../../src/lib/sqlite.js';
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

/** A session store of the test's own: the handle may still point at an earlier test's home. */
async function sessionStore() {
  const tracker = await import('../../src/core/session-tracker.js');
  const { closeDb: closeSessionDb } = await import('../../src/core/session-db.js');
  closeSessionDb();
  tracker._resetSessionTrackerForTesting();
  const done = () => {
    closeSessionDb();
    tracker._resetSessionTrackerForTesting();
  };
  return { tracker, done };
}

describe('mergeTaskInto — session link preservation corners', () => {
  it('M1: an OCCUPIED survivor keeps its session; the victim\'s is detached and listed, not lost', async () => {
    // The failure this pins: both copies ran sessions. A task has one session, so
    // the victim's cannot become the survivor's second: it must stay findable from
    // the survivor (legacy_session_ids, and legacyTaskId on its row) or it is lost.
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { tracker, done } = await sessionStore();
    try {
      await tracker.createSessionRecord('surv-slot', survivor.id, 'P', '/tmp');
      await tracker.createSessionRecord('vict-slot', victim.id, 'P', '/tmp');
      await updateTaskRaw(survivor.id, { session_id: 'surv-slot', session_ids: ['surv-slot'] });
      await updateTaskRaw(victim.id, { session_id: 'vict-slot', plan_session_id: 'vict-slot', session_ids: ['vict-slot'] });

      const { survivor: merged, sessionsRelinked } = await mergeTaskInto(survivor.id, victim.id);

      expect(merged.session_id).toBe('surv-slot');            // survivor keeps its session
      expect(merged.session_ids).toEqual(['surv-slot']);      // and only it
      expect(merged.plan_session_id).toBeUndefined();         // no slot names the victim's
      expect(merged.legacy_session_ids).toEqual(['vict-slot']); // listed, not lost
      expect(sessionsRelinked).toBe(0);
      const detached = await tracker.getSessionByClaudeId('vict-slot');
      expect(detached?.taskId).toBeFalsy();
      expect(detached?.legacyTaskId).toBe(survivor.id);
      expect((await tracker.getSessionByClaudeId('surv-slot'))?.taskId).toBe(survivor.id);
    } finally {
      done();
    }
  });

  it('M2: an EMPTY survivor takes the victim\'s session, every slot naming it', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { tracker, done } = await sessionStore();
    try {
      await tracker.createSessionRecord('v1', victim.id, 'P', '/tmp');
      await updateTaskRaw(victim.id, { session_id: 'v1', exec_session_id: 'v1', session_ids: ['v1'] });

      const { survivor: merged, sessionsRelinked } = await mergeTaskInto(survivor.id, victim.id);

      expect(merged.session_id).toBe('v1');
      expect(merged.session_ids).toEqual(['v1']);
      expect(merged.legacy_session_ids).toBeUndefined();
      expect(sessionsRelinked).toBe(1);
      expect((await tracker.getSessionByClaudeId('v1'))?.taskId).toBe(survivor.id);
    } finally {
      done();
    }
  });

  it('M3: no duplicate history entries when the victim lists its session in its slot and session_ids', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { session_id: 'occupied', session_ids: ['occupied'], legacy_session_ids: ['shared'] });
    await updateTaskRaw(victim.id, { session_id: 'shared', session_ids: ['shared'] });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_ids).toEqual(['occupied']);
    expect(merged.legacy_session_ids).toEqual(['shared']);
  });

  it('M4: chained merges (C→B→A) carry every link into the final survivor', async () => {
    // The dedup script merges N victims one at a time. Verify transitivity:
    // history picked up from C via B must survive B's own merge into A.
    const { task: a } = await addTask({ title: 'A', project: 'P' });
    const { task: b } = await addTask({ title: 'B', project: 'P' });
    const { task: c } = await addTask({ title: 'C', project: 'P' });
    const { tracker, done } = await sessionStore();
    try {
      for (const [sid, t] of [['sa', a], ['sb', b], ['sc', c]] as const) {
        await tracker.createSessionRecord(sid, t.id, 'P', '/tmp');
        await updateTaskRaw(t.id, { session_id: sid, session_ids: [sid] });
      }

      await mergeTaskInto(b.id, c.id);
      const { survivor: final } = await mergeTaskInto(a.id, b.id);

      expect(final.session_id).toBe('sa');
      expect(final.session_ids).toEqual(['sa']);
      expect([...(final.legacy_session_ids ?? [])].sort()).toEqual(['sb', 'sc']);
      expect((await tracker.getSessionByClaudeId('sa'))?.taskId).toBe(a.id);
      const sb = await tracker.getSessionByClaudeId('sb');
      expect(sb?.taskId).toBeFalsy();
      expect(sb?.legacyTaskId).toBe(a.id);
      expect((await tracker.getSessionByClaudeId('sc'))?.taskId).toBeFalsy();
      expect(await listTasks()).toHaveLength(1);
    } finally {
      done();
    }
  });

  it('M5: merging a victim with NO links leaves the survivor links untouched', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    await updateTaskRaw(survivor.id, { session_ids: ['keep'], session_id: 'keep' });

    const { survivor: merged, sessionsRelinked } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_ids).toEqual(['keep']);
    expect(merged.session_id).toBe('keep');
    expect(merged.legacy_session_ids).toBeUndefined();
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
    const { tracker, done } = await sessionStore();
    try {
      await tracker.createSessionRecord('sv', victim.id, 'P', '/tmp');
      await updateTaskRaw(victim.id, { session_id: 'sv', session_ids: ['sv'] });

      const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

      expect(merged.session_ids).toEqual(['sv']);
      expect(await listTasks()).toHaveLength(1);
    } finally {
      done();
    }
  });

  it('M13: sessionsRelinked counts only rows that actually moved to the survivor', async () => {
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { task: emptySurvivor } = await addTask({ title: 'C', project: 'P' });
    const { task: victim2 } = await addTask({ title: 'D', project: 'P' });
    const { createSessionRecord, getSessionByClaudeId } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('sess-victim', victim.id, 'P', '/tmp');
    await createSessionRecord('sess-survivor', survivor.id, 'P', '/tmp');
    await createSessionRecord('sess-victim2', victim2.id, 'P', '/tmp');
    await createSessionRecord('sess-unrelated', 'someone-else', 'P', '/tmp');

    // A survivor with its own session takes none: the victim's is detached, not moved.
    expect((await mergeTaskInto(survivor.id, victim.id)).sessionsRelinked).toBe(0);
    // An empty survivor takes the victim's one session.
    expect((await mergeTaskInto(emptySurvivor.id, victim2.id)).sessionsRelinked).toBe(1);

    expect((await getSessionByClaudeId('sess-victim'))?.taskId).toBeFalsy();
    expect((await getSessionByClaudeId('sess-victim'))?.legacyTaskId).toBe(survivor.id);
    expect((await getSessionByClaudeId('sess-survivor'))?.taskId).toBe(survivor.id);
    expect((await getSessionByClaudeId('sess-victim2'))?.taskId).toBe(emptySurvivor.id);
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
    // A delete of the survivor that lands after the merge's task commit but before its session
    // moves must not leave the session pointing at it (r4 gate, L-23), and the merge must not
    // announce the survivor after its delete (every open board would show it again). A task has
    // one session, so the merge moves at most one: holding the session write lock stops the merge
    // right after its task commit, exactly where the delete has to land.
    const { task: survivor } = await addTask({ title: 'A', project: 'P' });
    const { task: victim } = await addTask({ title: 'B', project: 'P' });
    const { tracker, bus, EventNames, done } = await slicedSessions();
    const survivorRow = () => getTaskDb()!.prepare('SELECT 1 FROM tasks WHERE id = ?').pluck().get(survivor.id) !== undefined;
    const victimRow = () => getTaskDb()!.prepare('SELECT 1 FROM tasks WHERE id = ?').pluck().get(victim.id) !== undefined;
    // Stopped: the moved session becomes the survivor's, and a running one would block its delete.
    await tracker.createSessionRecord('m14-victim', victim.id, 'P', '/tmp', { initialProcessStatus: 'stopped' });
    const updatesOfTheDeleted: string[] = [];
    const mergeDeletes: unknown[] = [];
    bus.subscribe('m14-delete-survivor', (event) => {
      if (event.name === EventNames.TASK_DELETED && event.source === 'merge') mergeDeletes.push(event.data);
      if (event.name === EventNames.TASK_UPDATED && (event.data as { task: Task }).task.id === survivor.id && !survivorRow()) {
        updatesOfTheDeleted.push(event.source ?? '?');
      }
    }, { global: true }); // TASK_UPDATED is addressed to the web UI only
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockDone = tracker._withSessionWriteLockForTesting(() => held);
    let relinked = -1;
    let survivorDeleted = false;
    try {
      const merging = mergeTaskInto(survivor.id, victim.id);
      // The merge committed its tasks and now waits to move the session: the survivor is deleted.
      await vi.waitFor(() => { expect(victimRow()).toBe(false); }, { timeout: 10_000, interval: 10 });
      const deleting = deleteTask(survivor.id);
      await vi.waitFor(() => { expect(survivorRow()).toBe(false); }, { timeout: 10_000, interval: 10 });
      release();
      ({ sessionsRelinked: relinked, survivorDeleted } = await merging);
      await deleting;
    } finally {
      release();
      await lockDone;
      bus.unsubscribe('m14-delete-survivor');
    }
    // The merge says so, and the route answers what happened from it (r5 gate, L-28).
    expect(survivorDeleted).toBe(true);
    expect(relinked).toBe(0);
    expect(await listTasks()).toHaveLength(0);
    expect((await tracker.getSessionByClaudeId('m14-victim'))?.taskId).toBeUndefined();
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

  it('M15: two merges at once, A into B and B into C: every session ends up on C or in its history', async () => {
    // Merges run one at a time. Overlapping, the first found B gone partway and cleared the links of
    // A's remaining sessions, which must follow B to C. One session per task: B keeps its own and
    // A's is detached into B's history, then B's session follows to the empty C with that history.
    const { task: c } = await addTask({ title: 'C', project: 'P' });
    const { task: b } = await addTask({ title: 'B', project: 'P' });
    const { task: a } = await addTask({ title: 'A', project: 'P' });
    const { tracker, done } = await slicedSessions();
    await tracker.createSessionRecord('m15-a', a.id, 'P', '/tmp');
    await tracker.createSessionRecord('m15-b', b.id, 'P', '/tmp');
    const [first, second] = await Promise.all([mergeTaskInto(b.id, a.id), mergeTaskInto(c.id, b.id)]);
    expect(first.sessionsRelinked).toBe(0);
    expect(second.sessionsRelinked).toBe(1);
    expect(second.survivor.session_id).toBe('m15-b');
    expect(second.survivor.legacy_session_ids).toEqual(['m15-a']);
    expect((await tracker.getSessionByClaudeId('m15-b'))?.taskId).toBe(c.id);
    expect((await tracker.getSessionByClaudeId('m15-a'))?.taskId).toBeFalsy();
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
