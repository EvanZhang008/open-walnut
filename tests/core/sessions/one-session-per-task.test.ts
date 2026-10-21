import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('one-session-per-task'));
vi.mock('../../../src/utils/process.js', () => ({
  isProcessAlive: () => true,
  isProcessAliveAsync: async () => true,
}));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}));

import {
  createSessionRecord,
  getSessionByClaudeId,
  getSessionsForTask,
  importSessionRecord,
  relinkSessionsToTask,
  stageAcpSessionIdMigration,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js';
import { closeDb, getDb } from '../../../src/core/session-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import {
  ensureOneSessionPerTaskGuard,
  ONE_SESSION_PER_TASK_TRIGGERS,
  sessionHasNoConversation,
  TaskSessionTakenError,
} from '../../../src/core/sessions/one-session-per-task.js';
import { claimTaskForNewSession, taskConversation } from '../../../src/core/sessions/task-session-claim.js';
import type { SessionRecord } from '../../../src/core/types.js';

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

/** Write a row behind the guard's back, the way legacy data was written. */
function insertLegacyRow(sid: string, taskId: string, lastActiveAt: string, extra: Record<string, unknown> = {}): void {
  const db = getDb()!;
  db.prepare(`INSERT INTO sessions (claude_session_id, task_id, project, process_status, mode, started_at, last_active_at, message_count, archived, archive_reason, status_revision)
    VALUES (@sid, @taskId, '', 'stopped', 'default', @at, @at, 3, @archived, @reason, 1)`)
    .run({ sid, taskId, at: lastActiveAt, archived: extra.archived ? 1 : 0, reason: (extra.archive_reason as string) ?? null });
}

describe('one session per task: the store refuses a second session', () => {
  it('refuses a new session for a task that has one, and keeps the first untouched', async () => {
    await createSessionRecord('s-one', 'task-a', 'demo', '/tmp');
    await expect(createSessionRecord('s-two', 'task-a', 'demo', '/tmp')).rejects.toBeInstanceOf(TaskSessionTakenError);
    expect((await getSessionsForTask('task-a')).map((s) => s.claudeSessionId)).toEqual(['s-one']);
    expect(await getSessionByClaudeId('s-two')).toBeNull();
  });

  it('lets the same session be written again (resume, result persist)', async () => {
    await createSessionRecord('s-one', 'task-a', 'demo', '/tmp');
    await expect(createSessionRecord('s-one', 'task-a', 'demo', '/tmp', { pid: 77 })).resolves.toMatchObject({ pid: 77 });
  });

  it('allows any number of sessions with no task (side threads, warm lanes)', async () => {
    await createSessionRecord('free-1', '', 'demo');
    await createSessionRecord('free-2', '', 'demo');
    expect((await getSessionByClaudeId('free-2'))?.taskId).toBe('');
  });

  it('refuses moving a session onto a task that already has one', async () => {
    await createSessionRecord('s-a', 'task-a', 'demo');
    await createSessionRecord('s-b', 'task-b', 'demo');
    await expect(updateSessionRecord('s-b', { taskId: 'task-a' })).rejects.toBeInstanceOf(TaskSessionTakenError);
    expect((await getSessionByClaudeId('s-b'))?.taskId).toBe('task-b');
  });

  it('refuses importing a session into a task that already has one', async () => {
    await createSessionRecord('s-a', 'task-a', 'demo');
    await expect(importSessionRecord({ claudeSessionId: 's-imported', taskId: 'task-a', project: 'demo' }))
      .rejects.toBeInstanceOf(TaskSessionTakenError);
  });

  it('a merge leaves the victim session unlinked when the survivor already has its own', async () => {
    await createSessionRecord('s-survivor', 'survivor', 'demo');
    await createSessionRecord('s-victim', 'victim', 'demo');
    const pointed = await relinkSessionsToTask('victim', 'survivor');
    expect(pointed).toBe(0);
    expect((await getSessionsForTask('survivor')).map((s) => s.claudeSessionId)).toEqual(['s-survivor']);
    expect((await getSessionByClaudeId('s-victim'))?.taskId ?? '').toBe('');
  });

  it('a merge moves the victim session when the survivor has none', async () => {
    await createSessionRecord('s-victim', 'victim', 'demo');
    expect(await relinkSessionsToTask('victim', 'survivor')).toBe(1);
    expect((await getSessionByClaudeId('s-victim'))?.taskId).toBe('survivor');
  });

  it('an ACP identity migration keeps its redirect row without counting it as a second session', async () => {
    await createSessionRecord('acp-old', 'task-acp', 'demo', '/tmp', { engine: 'codex', acpRuntimeId: 'rt-1' });
    const db = getDb()!;
    expect(ensureOneSessionPerTaskGuard(db)).toBe(true);
    const replacement = await stageAcpSessionIdMigration('acp-old', 'acp-new');
    expect(replacement?.taskId).toBe('task-acp');
    expect((await getSessionByClaudeId('acp-old'))?.archived).toBe(true);
    // The other session of the task is the redirect, which the rule ignores.
    await expect(taskConversation('task-acp')).resolves.toMatchObject({ claudeSessionId: 'acp-new' });
  });
});

describe('the guard triggers', () => {
  it('are not created while legacy duplicates exist, and are once they are gone', async () => {
    getDb();
    insertLegacyRow('l-1', 'task-x', '2026-10-01T00:00:00.000Z');
    insertLegacyRow('l-2', 'task-x', '2026-10-02T00:00:00.000Z');
    const db = getDb()!;
    expect(ensureOneSessionPerTaskGuard(db)).toBe(false);
    db.prepare('UPDATE sessions SET task_id = NULL WHERE claude_session_id = ?').run('l-1');
    expect(ensureOneSessionPerTaskGuard(db)).toBe(true);
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).pluck().all();
    expect(names).toEqual(expect.arrayContaining([...ONE_SESSION_PER_TASK_TRIGGERS]));
    // SQLite itself now refuses a second row, even one written around the guard.
    expect(() => insertLegacyRow('l-3', 'task-x', '2026-10-03T00:00:00.000Z')).toThrow(/one session per task/);
    // ...and moving a row onto the task.
    expect(() => db.prepare('UPDATE sessions SET task_id = ? WHERE claude_session_id = ?').run('task-x', 'l-1')).toThrow(/one session per task/);
  });

  it('an INSERT OR REPLACE written around the guard fails instead of deleting the task\'s session', async () => {
    await createSessionRecord('keep-me', 'task-r', 'demo');
    const db = getDb()!;
    expect(ensureOneSessionPerTaskGuard(db)).toBe(true);
    expect(() => db.prepare(`INSERT OR REPLACE INTO sessions (claude_session_id, task_id, project, process_status, mode, started_at, last_active_at, message_count, archived, status_revision)
      VALUES ('intruder', 'task-r', '', 'stopped', 'default', 'x', 'x', 1, 0, 1)`).run()).toThrow(/one session per task/);
    expect(db.prepare('SELECT claude_session_id FROM sessions WHERE task_id = ?').pluck().all('task-r')).toEqual(['keep-me']);
    // The same row written again (same id, same task) still goes through.
    expect(() => db.prepare(`INSERT OR REPLACE INTO sessions (claude_session_id, task_id, project, process_status, mode, started_at, last_active_at, message_count, archived, status_revision)
      VALUES ('keep-me', 'task-r', '', 'idle', 'default', 'x', 'x', 2, 0, 2)`).run()).not.toThrow();
  });

  it('drops the unique index an earlier build created', async () => {
    const db = getDb()!;
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_per_task ON sessions(task_id) WHERE task_id <> ''`);
    ensureOneSessionPerTaskGuard(db);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='sessions_one_per_task'`).get()).toBeUndefined();
  });
});

describe('which session may be replaced', () => {
  const base: SessionRecord = {
    claudeSessionId: 's', taskId: 't', project: '', process_status: 'error', mode: 'default',
    startedAt: '2026-10-01T00:00:00.000Z', lastActiveAt: '2026-10-01T00:00:00.000Z', messageCount: 1,
  };
  it('a lost transcript may be replaced', () => {
    expect(sessionHasNoConversation({ ...base, archived: true, archive_reason: 'remote_conversation_lost' })).toBe(true);
    expect(sessionHasNoConversation({ ...base, archived: true, archive_reason: 'conversation_never_persisted' })).toBe(true);
  });
  it('a start that failed before any turn may be replaced', () => {
    expect(sessionHasNoConversation({ ...base, status_reason: 'api_error' })).toBe(true);
    expect(sessionHasNoConversation({ ...base, process_status: 'idle', status_reason: 'awaiting_spawn' })).toBe(true);
  });
  it('anything with a turn behind it is a conversation', () => {
    expect(sessionHasNoConversation({ ...base, status_reason: 'api_error', contextTokens: 1200 })).toBe(false);
    expect(sessionHasNoConversation({ ...base, status_reason: 'api_error', messageCount: 4 })).toBe(false);
    expect(sessionHasNoConversation({ ...base, status_reason: 'normal_completion' })).toBe(false);
    expect(sessionHasNoConversation({ ...base, process_status: 'idle', status_reason: 'awaiting_spawn', pid: 9 })).toBe(false);
    expect(sessionHasNoConversation({ ...base, archived: true, archive_reason: 'retry' })).toBe(false);
  });
});

describe('claiming a task for a new session', () => {
  it('retires a session that never held a conversation', async () => {
    await createSessionRecord('dead-start', 'task-c', 'demo', '/tmp', { initialProcessStatus: 'error' });
    await updateSessionRecord('dead-start', { status_reason: 'api_error' });
    await expect(claimTaskForNewSession('task-c')).resolves.toBeUndefined();
    // Detached, never deleted: the row stays, no longer the task's.
    expect(await getSessionByClaudeId('dead-start')).toMatchObject({ taskId: '', legacyTaskId: 'task-c' });
    await expect(createSessionRecord('fresh', 'task-c', 'demo')).resolves.toMatchObject({ taskId: 'task-c' });
  });

  it('keeps a real conversation and refuses the new session', async () => {
    await createSessionRecord('real', 'task-d', 'demo', '/tmp');
    await updateSessionRecord('real', { process_status: 'stopped', status_reason: 'normal_completion', contextTokens: 5000 });
    await expect(claimTaskForNewSession('task-d')).rejects.toMatchObject({ code: 'task_has_session', existingSessionId: 'real' });
    expect(await getSessionByClaudeId('real')).not.toBeNull();
  });

  it('an archived conversation is still the task’s one conversation', async () => {
    await createSessionRecord('archived-real', 'task-e', 'demo', '/tmp');
    await updateSessionRecord('archived-real', { archived: true, archive_reason: 'plan_executed', contextTokens: 10 });
    await expect(taskConversation('task-e')).resolves.toMatchObject({ claudeSessionId: 'archived-real' });
  });
});
