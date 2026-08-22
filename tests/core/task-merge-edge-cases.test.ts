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
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-merge-edge'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  _resetForTesting,
  addTask,
  getTask,
  listTasks,
  mergeTaskInto,
  updateTaskRaw,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
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
});
