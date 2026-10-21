import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('split-multi-session'));
vi.mock('../../../src/utils/process.js', () => ({
  isProcessAlive: () => true,
  isProcessAliveAsync: async () => true,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}));

import { getSessionByClaudeId, getSessionsForTask, createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { closeDb, getDb } from '../../../src/core/session-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, linkSession, mergeTaskInto, updateTaskRaw, SessionOwnedByOtherTaskError } from '../../../src/core/task-manager.js';
import { splitMultiSessionTasks } from '../../../src/core/sessions/split-multi-session-tasks.js';
import { TaskSessionTakenError } from '../../../src/core/sessions/one-session-per-task.js';

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

function insertLegacyRow(sid: string, taskId: string, lastActiveAt: string, archived = false): void {
  getDb()!.prepare(`INSERT INTO sessions (claude_session_id, task_id, project, process_status, mode, started_at, last_active_at, message_count, archived, status_revision)
    VALUES (?, ?, '', 'stopped', 'default', ?, ?, 3, ?, 1)`).run(sid, taskId, lastActiveAt, lastActiveAt, archived ? 1 : 0);
}

describe('splitting legacy tasks that hold several sessions', () => {
  it('keeps the session the task names, detaches the rest as history, then locks the rule in', async () => {
    const { task } = await addTask({ title: 'Legacy task', project: 'Demo' });
    await createSessionRecord('plan-1', '', 'Demo');
    insertLegacyRow('exec-1', task.id, '2026-10-02T00:00:00.000Z');
    insertLegacyRow('retry-1', task.id, '2026-10-03T00:00:00.000Z', true);
    getDb()!.prepare('UPDATE sessions SET task_id = ? WHERE claude_session_id = ?').run(task.id, 'plan-1');
    _resetSessionTrackerForTesting();
    await updateTaskRaw(task.id, {
      session_id: 'exec-1', exec_session_id: 'exec-1', plan_session_id: 'plan-1',
      session_ids: ['plan-1', 'exec-1', 'retry-1'],
    }, { source: 'test' });

    const first = await splitMultiSessionTasks();
    expect(first).toEqual({ tasks: 1, detached: 2, guardReady: true });

    expect((await getSessionsForTask(task.id)).map((s) => s.claudeSessionId)).toEqual(['exec-1']);
    for (const sid of ['plan-1', 'retry-1']) {
      const rec = await getSessionByClaudeId(sid);
      expect(rec?.taskId ?? '').toBe('');
      expect(rec?.legacyTaskId).toBe(task.id);
    }
    const after = await getTask(task.id);
    expect(after.session_id).toBe('exec-1');
    expect(after.session_ids).toEqual(['exec-1']);
    expect(after.plan_session_id).toBeUndefined();
    expect(new Set(after.legacy_session_ids)).toEqual(new Set(['plan-1', 'retry-1']));

    // Idempotent: nothing left to split.
    expect(await splitMultiSessionTasks()).toEqual({ tasks: 0, detached: 0, guardReady: true });
    // And the store refuses a new second session from now on.
    await expect(createSessionRecord('another', task.id, 'Demo')).rejects.toBeInstanceOf(TaskSessionTakenError);
  });

  it('keeps the session that holds the conversation over an empty one the task names', async () => {
    const { task } = await addTask({ title: 'Warm took the link', project: 'Demo' });
    insertLegacyRow('work', task.id, '2026-10-01T00:00:00.000Z');
    insertLegacyRow('warm', task.id, '2026-10-04T00:00:00.000Z');
    getDb()!.prepare("UPDATE sessions SET message_count = 0 WHERE claude_session_id = 'warm'").run();
    _resetSessionTrackerForTesting();
    await updateTaskRaw(task.id, { session_id: 'warm', session_ids: ['work', 'warm'] }, { source: 'test' });

    expect(await splitMultiSessionTasks()).toMatchObject({ tasks: 1, detached: 1 });
    expect((await getSessionsForTask(task.id)).map((s) => s.claudeSessionId)).toEqual(['work']);
    expect((await getTask(task.id)).session_id).toBe('work');
    expect((await getTask(task.id)).legacy_session_ids).toEqual(['warm']);
  });

  it('trims a task list that names sessions no row links to it any more', async () => {
    const { task } = await addTask({ title: 'Stale list', project: 'Demo' });
    const { task: other } = await addTask({ title: 'Other', project: 'Demo' });
    await createSessionRecord('mine', task.id, 'Demo');
    await createSessionRecord('elsewhere', other.id, 'Demo');
    await createSessionRecord('unlinked', '', 'Demo');
    await updateTaskRaw(task.id, { session_id: 'elsewhere', session_ids: ['unlinked', 'elsewhere', 'mine'] }, { source: 'test' });

    expect(await splitMultiSessionTasks()).toEqual({ tasks: 1, detached: 0, guardReady: true });
    const after = await getTask(task.id);
    expect(after.session_id).toBe('mine');
    expect(after.session_ids).toEqual(['mine']);
    expect(new Set(after.legacy_session_ids)).toEqual(new Set(['unlinked', 'elsewhere']));
    // The other task's session stays the other task's.
    expect((await getSessionByClaudeId('elsewhere'))?.taskId).toBe(other.id);
    expect(await splitMultiSessionTasks()).toEqual({ tasks: 0, detached: 0, guardReady: true });
  });

  it('keeps the newest live session when the task names none of its rows', async () => {
    getDb();
    insertLegacyRow('old', 'orphan-task', '2026-10-01T00:00:00.000Z');
    insertLegacyRow('new-archived', 'orphan-task', '2026-10-05T00:00:00.000Z', true);
    insertLegacyRow('mid-live', 'orphan-task', '2026-10-03T00:00:00.000Z');
    _resetSessionTrackerForTesting();
    const result = await splitMultiSessionTasks();
    expect(result.detached).toBe(2);
    expect((await getSessionsForTask('orphan-task')).map((s) => s.claudeSessionId)).toEqual(['mid-live']);
  });
});

describe('task-side links', () => {
  it('a session owned by one task is never linked to another', async () => {
    const { task: a } = await addTask({ title: 'A', project: 'Demo' });
    const { task: b } = await addTask({ title: 'B', project: 'Demo' });
    await createSessionRecord('s-a', a.id, 'Demo');
    await expect(linkSession(b.id, 's-a')).rejects.toBeInstanceOf(SessionOwnedByOtherTaskError);
    const linked = await linkSession(a.id, 's-a');
    expect(linked.task.session_ids).toEqual(['s-a']);
  });

  it('merging two tasks with sessions keeps the survivor’s and lists the victim’s as history', async () => {
    const { task: survivor } = await addTask({ title: 'Survivor', project: 'Demo' });
    const { task: victim } = await addTask({ title: 'Victim', project: 'Demo' });
    await createSessionRecord('s-surv', survivor.id, 'Demo');
    await linkSession(survivor.id, 's-surv');
    await createSessionRecord('s-vict', victim.id, 'Demo');
    await linkSession(victim.id, 's-vict');
    const result = await mergeTaskInto(survivor.id, victim.id);
    expect(result.survivor.session_id).toBe('s-surv');
    expect(result.survivor.legacy_session_ids).toContain('s-vict');
    expect((await getSessionsForTask(survivor.id)).map((s) => s.claudeSessionId)).toEqual(['s-surv']);
    const vict = await getSessionByClaudeId('s-vict');
    expect(vict?.taskId ?? '').toBe('');
    expect(vict?.legacyTaskId).toBe(survivor.id);
  });

  it('merging a victim with a session into a survivor without one moves it', async () => {
    const { task: survivor } = await addTask({ title: 'Empty survivor', project: 'Demo' });
    const { task: victim } = await addTask({ title: 'Victim with work', project: 'Demo' });
    await createSessionRecord('s-move', victim.id, 'Demo');
    await linkSession(victim.id, 's-move');
    const result = await mergeTaskInto(survivor.id, victim.id);
    expect(result.survivor.session_id).toBe('s-move');
    expect((await getSessionByClaudeId('s-move'))?.taskId).toBe(survivor.id);
  });

  it('a survivor slot naming another task\'s session is history, so the victim\'s session follows', async () => {
    const { task: survivor } = await addTask({ title: 'Stale slot', project: 'Demo' });
    const { task: victim } = await addTask({ title: 'Victim', project: 'Demo' });
    const { task: other } = await addTask({ title: 'Other', project: 'Demo' });
    await createSessionRecord('s-other', other.id, 'Demo');
    await updateTaskRaw(survivor.id, { session_id: 's-other', session_ids: ['s-other'] }, { source: 'test' });
    await createSessionRecord('s-v', victim.id, 'Demo');
    await linkSession(victim.id, 's-v');
    const result = await mergeTaskInto(survivor.id, victim.id);
    expect(result.survivor.session_id).toBe('s-v');
    expect(result.survivor.session_ids).toEqual(['s-v']);
    expect(result.survivor.legacy_session_ids).toContain('s-other');
    expect((await getSessionByClaudeId('s-other'))?.taskId).toBe(other.id);
  });
});
