import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => true,
  isProcessAliveAsync: async () => true,
}));
vi.mock('../../src/utils/session-liveness.js', () => ({
  // Mirror real semantics enough for these tests:
  //  - stopped/error → dead
  //  - remote (has host) → alive (daemon assumed connected)
  //  - local with pid → alive
  //  - local without pid → dead
  isSessionProcessAlive: async (s: { process_status?: string; host?: string; pid?: number | null }) => {
    if (s.process_status === 'stopped' || (s.process_status === 'error' && s.pid == null)) return false;
    if (s.host) return true;
    return s.pid != null;
  },
}));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}));

import {
  createSessionRecord,
  listSessions,
  listPendingSessionStops,
  listNonTerminalSessions,
  getSessionByClaudeId,
  getSessionsForTask,
  updateSessionRecord,
  updateSessionRecordConditionally,
  batchUpdateSessionRecords,
  toSessionStatusSnapshot,
  emitSessionStatusChanged,
  stageAcpSessionIdMigration,
  linkSessionToTask,
  unlinkSessionsFromTasks,
  relinkSessionsToTask,
  getRecentSessions,
  getActiveSessionsByHost,
  getAllAliveSessionsByHost,
  checkSessionLimit,
  isTerminalSession,
  _resetSessionTrackerForTesting,
  _setRetaskSliceMsForTesting,
  _setRetaskClockForTesting,
  _withSessionWriteLockForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb, getDb as getSessionDb, SESSION_DB_PATH } from '../../src/core/session-db.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { markSessionStoppedInSqlite } from '../../src/hooks/session-status-store.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  // Close the shared SQLite handle (opened against the prior test's WALNUT_HOME,
  // which is about to be wiped) so the next open targets the fresh tmp dir.
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  bus.unsubscribe('session-status-contract-test');
  _setRetaskSliceMsForTesting(null);
  _setRetaskClockForTesting(null);
  closeDb();
  _resetSessionTrackerForTesting();
  // Retry cleanup to handle macOS ENOTEMPTY race (concurrent file writes during rm)
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('live command failure PID', () => {
  it('counts a live failed CLI as idle capacity', async () => {
    await createSessionRecord('capacity-error', '', 'demo', undefined, { pid: 4242 });
    await updateSessionRecord('capacity-error', { process_status: 'error', pid: 4242 });
    expect((await getAllAliveSessionsByHost()).local.map(s => s.claudeSessionId)).toContain('capacity-error');
    expect(await checkSessionLimit(undefined, undefined, { max_idle: 2 })).toMatchObject({ totalAlive: 1, idleCount: 1 });
  });
  it('task completion stops a live CLI even after its command failed', async () => {
    const owner = await import('../../src/core/sessions/owner-stop.js');
    const stop = vi.spyOn(owner, 'stopThroughOwner').mockResolvedValue({ stopped: true } as never);
    const { completeTaskSessions } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('complete-live-error', '', 'demo', undefined, { pid: 4242 });
    await updateSessionRecord('complete-live-error', { process_status: 'error', pid: 4242 });
    expect(await completeTaskSessions(['complete-live-error'])).toBe(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ claudeSessionId: 'complete-live-error' }), 'maintenance', 'task_completed');
    expect((await getSessionByClaudeId('complete-live-error'))?.pid).toBeUndefined();
    stop.mockRestore();
  });

  it('keeps an explicitly supplied live pid across failure and metadata writes, but clears it on death', async () => {
    await createSessionRecord('command-failure-live', '', 'demo', undefined, { pid: 4242 });
    expect((await updateSessionRecord('command-failure-live', { process_status: 'error', pid: 4242, errorMessage: 'Command failed' })).pid).toBe(4242);
    expect((await updateSessionRecord('command-failure-live', { title: 'Failed command' })).pid).toBe(4242);
    expect((await updateSessionRecord('command-failure-live', { process_status: 'error', pid: undefined })).pid).toBeUndefined();
  });
});

describe('pending session stop requests', () => {
  it('queries durable pending requests by host without excluding archived rows', async () => {
    for (const [sid, host, state] of [['stop-local', undefined, 'pending'], ['stop-remote', 'worker', 'pending'], ['stop-done', 'worker', 'confirmed']] as const) {
      await createSessionRecord(sid, `task-${sid}`, 'demo', '/tmp', { host, initialProcessStatus: 'stopped' });
      await updateSessionRecord(sid, { archived: true, stopRequest: { id: sid, requestedAt: new Date().toISOString(), state } });
    }
    expect((await listPendingSessionStops('__local__')).map((r) => r.claudeSessionId)).toEqual(['stop-local']);
    expect((await listPendingSessionStops('worker')).map((r) => r.claudeSessionId)).toEqual(['stop-remote']);
    closeDb();
    _resetSessionTrackerForTesting();
    expect((await listPendingSessionStops('worker'))[0]?.stopRequest?.state).toBe('pending');
  });
});

describe('emitSessionStatusChanged', () => {
  it('publishes the full committed snapshot with additive legacy fields and routing metadata', async () => {
    const created = await createSessionRecord(
      'status-event',
      'task-status',
      'proj',
      undefined,
      {
        mode: 'plan',
        provider: 'sdk',
        engine: 'codex',
        fromPlanSessionId: 'plan-parent',
        forkedFromSessionId: 'fork-parent',
      },
    );
    const committed = await updateSessionRecord(created.claudeSessionId, {
      process_status: 'error',
      activity: 'failed',
      planCompleted: true,
      archived: true,
      errorMessage: 'provider failed',
    });
    let received: BusEvent | undefined;
    bus.subscribe('session-status-contract-test', (event) => {
      received = event;
    });

    emitSessionStatusChanged(
      committed,
      {
        phase: 'NEED_ACTION',
        previousSessionId: 'status-event-old',
      },
      ['*'],
      { source: 'contract-test', urgency: 'urgent' },
    );

    expect(received).toEqual(expect.objectContaining({
      name: EventNames.SESSION_STATUS_CHANGED,
      destinations: ['*'],
      source: 'contract-test',
      urgency: 'urgent',
    }));
    const status = {
      sessionId: 'status-event',
      taskId: 'task-status',
      process_status: 'error',
      activity: 'failed',
      mode: 'plan',
      planCompleted: true,
      archived: true,
      errorMessage: 'provider failed',
      provider: 'sdk',
      engine: 'codex',
      pendingPermissionTool: null,
      statusRevision: committed.statusRevision,
      statusUpdatedAt: committed.statusUpdatedAt,
    };
    expect(received?.data).toEqual({
      phase: 'NEED_ACTION',
      previousSessionId: 'status-event-old',
      fromPlanSessionId: 'plan-parent',
      forkedFromSessionId: 'fork-parent',
      ...status,
      status,
    });
  });

  it('normalizes an incomplete legacy record into a full snapshot', () => {
    const snapshot = toSessionStatusSnapshot({
      claudeSessionId: 'legacy-status',
      taskId: '',
      project: 'legacy',
      process_status: undefined,
      mode: 'default',
      startedAt: '2026-07-19T10:00:00.000Z',
      lastActiveAt: '2026-07-19T10:00:00.000Z',
      messageCount: 0,
    } as unknown as Parameters<typeof toSessionStatusSnapshot>[0]);

    expect(snapshot.process_status).toBe('stopped');
    expect(Object.keys(snapshot)).toHaveLength(13);
    expect(Object.keys(snapshot)).toEqual(expect.arrayContaining([
      'sessionId',
      'taskId',
      'process_status',
      'activity',
      'mode',
      'planCompleted',
      'archived',
      'errorMessage',
      'provider',
      'engine',
      'pendingPermissionTool',
      'statusRevision',
      'statusUpdatedAt',
    ]));
    expect(snapshot.taskId).toBeNull();
  });
});

describe('createSessionRecord', () => {
  it('creates a session with correct fields', async () => {
    const session = await createSessionRecord('claude-sess-1', 'task-1', 'walnut');
    expect(session.claudeSessionId).toBe('claude-sess-1');
    expect(session.taskId).toBe('task-1');
    expect(session.project).toBe('walnut');
    expect(session.process_status).toBe('running');
    expect(session.startedAt).toBeDefined();
    expect(session.lastActiveAt).toBeDefined();
    expect(session.messageCount).toBe(1);
    expect(session.statusRevision).toBe(1);
    expect(session.statusUpdatedAt).toBeDefined();
  });

  it('increments messageCount on duplicate claudeSessionId when extras change', async () => {
    // Plain duplicate with identical args is a no-op (see createSessionRecord no-op guard).
    // Only advance messageCount when the caller brings a material change (e.g. a new pid).
    await createSessionRecord('claude-sess-dup', 'task-1', 'proj', undefined, { pid: 100 });
    const session = await createSessionRecord('claude-sess-dup', 'task-1', 'proj', undefined, { pid: 101 });
    expect(session.messageCount).toBe(2);
  });

  it('treats duplicate createSessionRecord with identical fields as a no-op', async () => {
    const first = await createSessionRecord('claude-sess-noop', 'task-1', 'proj');
    await new Promise((r) => setTimeout(r, 15));
    const second = await createSessionRecord('claude-sess-noop', 'task-1', 'proj');
    // Same messageCount and lastActiveAt proves no writeStore happened on the 2nd call
    expect(second.messageCount).toBe(first.messageCount);
    expect(second.lastActiveAt).toBe(first.lastActiveAt);
  });

  it.each(['idle', 'running'] as const)('releases a %s reservation when the confirmed PID is persisted', async (status) => {
    await createSessionRecord('reserved', 'task-1', 'proj', undefined, {
      initialProcessStatus: status, initialStatusReason: 'awaiting_spawn',
    });
    const started = await createSessionRecord('reserved', 'task-1', 'proj', undefined, { pid: 4242 });
    expect(started).toMatchObject({ pid: 4242, process_status: 'running', status_reason: 'session_started', status_changed_by: 'session-runner' });
    closeDb();
    _resetSessionTrackerForTesting();
    expect(await getSessionByClaudeId('reserved')).toMatchObject({ pid: 4242, status_reason: 'session_started' });
  });

  it('releases an already-persisted PID reservation even when every other field matches', async () => {
    await createSessionRecord('reserved-existing-pid', 'task-1', 'proj', undefined, {
      pid: 4242, initialProcessStatus: 'running', initialStatusReason: 'awaiting_spawn',
    });
    const started = await createSessionRecord('reserved-existing-pid', 'task-1', 'proj', undefined, { pid: 4242 });
    expect(started.status_reason).toBe('session_started');
    expect(await createSessionRecord('reserved-existing-pid', 'task-1', 'proj', undefined, { pid: 4242 })).toEqual(started);
  });

  it('keeps an init-only reservation idle when its PID arrives', async () => {
    await createSessionRecord('reserved-parked', 'task-1', 'proj', undefined, {
      initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });
    expect(await createSessionRecord('reserved-parked', 'task-1', 'proj', undefined, {
      pid: 4242, initialProcessStatus: 'idle',
    })).toMatchObject({ pid: 4242, process_status: 'idle', status_reason: 'session_started' });
  });

  it('metadata without a confirmed PID cannot release a reservation', async () => {
    await createSessionRecord('reserved-no-pid', 'task-1', 'proj', undefined, {
      initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });
    expect(await createSessionRecord('reserved-no-pid', 'task-1', 'proj', undefined, { mode: 'plan' }))
      .toMatchObject({ process_status: 'idle', status_reason: 'awaiting_spawn' });
  });

  it.each(['turn_completed', 'user_stopped', 'message_sent'] as const)(
    'a repeated PID persist preserves the newer %s state', async (reason) => {
      await createSessionRecord('reserved-newer', 'task-1', 'proj', undefined, {
        pid: 4242, initialProcessStatus: 'running', initialStatusReason: 'awaiting_spawn',
      });
      const status = reason === 'user_stopped' ? 'stopped' : reason === 'turn_completed' ? 'idle' : 'running';
      await updateSessionRecord('reserved-newer', {
        process_status: status, status_reason: reason, status_changed_by: reason === 'user_stopped' ? 'user' : 'session-runner',
      });
      expect(await createSessionRecord('reserved-newer', 'task-1', 'proj', undefined, { pid: 4242, cliModel: 'test-model' }))
        .toMatchObject({ process_status: status, status_reason: reason });
    },
  );

  it.each([undefined, 4242])('does not release an archived reservation with previous PID %s', async (pid) => {
    await createSessionRecord('reserved-archived', 'task-1', 'proj', undefined, {
      pid, initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });
    await updateSessionRecord('reserved-archived', { archived: true });
    expect(await createSessionRecord('reserved-archived', 'task-1', 'proj', undefined, { pid: 4242, cliModel: 'test-model' }))
      .toMatchObject({ archived: true, process_status: 'idle', status_reason: 'awaiting_spawn' });
  });

  it.each(['pending', 'confirmed'] as const)('does not release a reservation with a %s stop request', async (state) => {
    await createSessionRecord('reserved-stop', 'task-1', 'proj', undefined, {
      initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });
    await updateSessionRecord('reserved-stop', {
      stopRequest: { id: 'stop-reservation', state, requestedAt: new Date().toISOString() },
    });
    expect(await createSessionRecord('reserved-stop', 'task-1', 'proj', undefined, { pid: 4242 }))
      .toMatchObject({ process_status: 'idle', status_reason: 'awaiting_spawn', stopRequest: { state } });
  });

  it.each(['stopped', 'error'] as const)('does not reopen a %s reservation when its PID arrives late', async (status) => {
    await createSessionRecord('reserved-terminal', 'task-1', 'proj', undefined, {
      initialProcessStatus: status, initialStatusReason: 'awaiting_spawn',
    });
    expect(await createSessionRecord('reserved-terminal', 'task-1', 'proj', undefined, { pid: 4242 }))
      .toMatchObject({ process_status: status, status_reason: 'awaiting_spawn' });
  });

  it('keeps a permission received before the init-only PID persist visible', async () => {
    await createSessionRecord('reserved-permission', 'task-1', 'proj', undefined, {
      initialProcessStatus: 'running', initialStatusReason: 'awaiting_spawn',
    });
    const permission = { requestId: 'permission-reservation', toolName: 'Bash', input: {}, reason: 'Approval required' };
    await updateSessionRecord('reserved-permission', { pendingPermission: permission });
    expect(await createSessionRecord('reserved-permission', 'task-1', 'proj', undefined, {
      pid: 4242, initialProcessStatus: 'idle',
    })).toMatchObject({ process_status: 'running', status_reason: 'session_started', pendingPermission: permission });
  });

  it('persists session to store', async () => {
    await createSessionRecord('claude-sess-2', 'task-1', 'proj');
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].claudeSessionId).toBe('claude-sess-2');
  });

  it('creates multiple sessions with unique IDs', async () => {
    const s1 = await createSessionRecord('claude-sess-a', 'task-1', 'proj');
    const s2 = await createSessionRecord('claude-sess-b', 'task-2', 'proj');
    expect(s1.claudeSessionId).not.toBe(s2.claudeSessionId);
  });
});

describe('listSessions', () => {
  it('returns empty array initially', async () => {
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });

  it('returns all sessions', async () => {
    await createSessionRecord('s1', 'task-1', 'p');
    await createSessionRecord('s2', 'task-2', 'p');
    await createSessionRecord('s3', 'task-3', 'p');
    const sessions = await listSessions();
    expect(sessions).toHaveLength(3);
  });
});

describe('getSessionByClaudeId', () => {
  it('returns session by Claude session ID', async () => {
    await createSessionRecord('find-me-id', 'task-1', 'proj');
    const found = await getSessionByClaudeId('find-me-id');
    expect(found).not.toBeNull();
    expect(found!.taskId).toBe('task-1');
  });

  it('returns null for non-existent ID', async () => {
    const result = await getSessionByClaudeId('nonexistent');
    expect(result).toBeNull();
  });
});

describe('getSessionsForTask', () => {
  it('returns the session linked to a task; a second one for the same task is refused', async () => {
    await createSessionRecord('s1', 'task-a', 'proj');
    await expect(createSessionRecord('s2', 'task-a', 'proj'))
      .rejects.toMatchObject({ code: 'task_has_session', taskId: 'task-a', existingSessionId: 's1', attemptedSessionId: 's2' });
    await createSessionRecord('s3', 'task-b', 'proj');
    const sessions = await getSessionsForTask('task-a');
    expect(sessions.map((s) => s.claudeSessionId)).toEqual(['s1']);
    expect(await getSessionByClaudeId('s2')).toBeNull();
  });

  it('returns empty array for unknown task', async () => {
    const sessions = await getSessionsForTask('no-such-task');
    expect(sessions).toEqual([]);
  });
});

describe('updateSessionRecord', () => {
  it('modifies session fields', async () => {
    await createSessionRecord('upd-1', 'task-1', 'proj');
    const updated = await updateSessionRecord('upd-1', { process_status: 'stopped', project: 'new-proj' });
    expect(updated.process_status).toBe('stopped');
    expect(updated.project).toBe('new-proj');
  });

  it('updates lastActiveAt timestamp', async () => {
    const session = await createSessionRecord('upd-2', 'task-1', 'proj');
    const originalActive = session.lastActiveAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateSessionRecord('upd-2', { process_status: 'stopped' });
    expect(updated.lastActiveAt).not.toBe(originalActive);
  });

  it('throws for non-existent session', async () => {
    await expect(updateSessionRecord('nonexistent', { process_status: 'stopped' })).rejects.toThrow(
      /Session not found/,
    );
  });

  it('persists updates', async () => {
    await createSessionRecord('upd-3', 'task-1', 'proj');
    await updateSessionRecord('upd-3', { process_status: 'stopped' });

    const found = await getSessionByClaudeId('upd-3');
    expect(found!.process_status).toBe('stopped');
  });

  it('skips writes when every field already equals current (no-op guard)', async () => {
    const created = await createSessionRecord('noop-1', 'task-1', 'proj');
    const firstActive = created.lastActiveAt;

    // Small delay — if the update path ran, lastActiveAt would be bumped
    await new Promise((r) => setTimeout(r, 15));

    // Same value as created — should be a no-op
    const result = await updateSessionRecord('noop-1', { process_status: 'running' });
    expect(result.lastActiveAt).toBe(firstActive);

    // Real change after no-op still works
    await new Promise((r) => setTimeout(r, 15));
    const changed = await updateSessionRecord('noop-1', { process_status: 'stopped' });
    expect(changed.lastActiveAt).not.toBe(firstActive);
    expect(changed.process_status).toBe('stopped');
  });

  it('increments the status revision exactly once for a canonical projection change', async () => {
    const created = await createSessionRecord('revision-change', 'task-1', 'proj');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await updateSessionRecord('revision-change', {
      process_status: 'idle',
      activity: 'waiting',
    });

    expect(updated.statusRevision).toBe(created.statusRevision + 1);
    expect(updated.statusUpdatedAt).not.toBe(created.statusUpdatedAt);
    expect(toSessionStatusSnapshot(updated)).toEqual({
      sessionId: 'revision-change',
      taskId: 'task-1',
      process_status: 'idle',
      activity: 'waiting',
      mode: 'default',
      planCompleted: false,
      archived: false,
      errorMessage: null,
      provider: 'cli',
      engine: 'claude',
      pendingPermissionTool: null,
      statusRevision: 2,
      statusUpdatedAt: updated.statusUpdatedAt,
    });
  });

  it('keeps status version stable for metadata-only writes and exact no-ops', async () => {
    const created = await createSessionRecord('revision-stable', 'task-1', 'proj');
    const metadata = await updateSessionRecord('revision-stable', {
      title: 'Metadata only',
    });
    const noOp = await updateSessionRecord('revision-stable', {
      title: 'Metadata only',
      process_status: 'running',
    });

    expect(metadata.statusRevision).toBe(created.statusRevision);
    expect(metadata.statusUpdatedAt).toBe(created.statusUpdatedAt);
    expect(noOp.statusRevision).toBe(created.statusRevision);
    expect(noOp.statusUpdatedAt).toBe(created.statusUpdatedAt);
  });

  it('does not increment on a stale conditional write', async () => {
    const created = await createSessionRecord('revision-conditional', 'task-1', 'proj');
    const skipped = await updateSessionRecordConditionally(
      'revision-conditional',
      { process_status: 'stopped' },
      (current) => current.statusRevision === created.statusRevision + 1,
    );
    const stored = await getSessionByClaudeId('revision-conditional');

    expect(skipped).toBeNull();
    expect(stored?.statusRevision).toBe(created.statusRevision);
    expect(stored?.statusUpdatedAt).toBe(created.statusUpdatedAt);
    expect(stored?.process_status).toBe('running');
  });

  it('keeps revision fields storage-owned when an untyped caller tries to override them', async () => {
    const created = await createSessionRecord('revision-owned', 'task-1', 'proj');
    const updated = await updateSessionRecord('revision-owned', {
      process_status: 'idle',
      statusRevision: 999,
      statusUpdatedAt: '2000-01-01T00:00:00.000Z',
    } as Parameters<typeof updateSessionRecord>[1]);

    expect(updated.statusRevision).toBe(created.statusRevision + 1);
    expect(updated.statusUpdatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

describe('linkSessionToTask', () => {
  it('sets taskId on session', async () => {
    await createSessionRecord('link-1', '', 'proj');
    await linkSessionToTask('link-1', 'task-abc');

    const found = await getSessionByClaudeId('link-1');
    expect(found!.taskId).toBe('task-abc');
  });
});

// The task is part of the status projection, so every change of a session's task
// is a status change: the revision moves and the snapshot is published. Until
// 2026-10-11 task delete and duplicate merge rewrote task_id with a raw UPDATE that
// kept the revision, and a page that held the old snapshot refused the record's
// "no task" as an equal-revision conflict: the deleted task's Fork, Board and
// Locate stayed live in the session header for the life of the page.
describe('a change of the session task is a status change', () => {
  const statusEvents = () => {
    const seen: BusEvent[] = [];
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name === EventNames.SESSION_STATUS_CHANGED || event.name === EventNames.SESSION_CONTENT_UPDATED) seen.push(event);
    });
    return seen;
  };
  const statusOf = (events: BusEvent[], sessionId: string) => events
    .filter((e) => e.name === EventNames.SESSION_STATUS_CHANGED && (e.data as { sessionId?: string }).sessionId === sessionId)
    .map((e) => e.data as { taskId: string | null; statusRevision: number; status: { taskId: string | null; statusRevision: number } });
  const contentOf = (events: BusEvent[]) => events
    .filter((e) => e.name === EventNames.SESSION_CONTENT_UPDATED)
    .map((e) => (e.data as { sessionId: string }).sessionId).sort();

  it('a task delete clears the link, moves the revision and publishes it, without touching activity', async () => {
    await createSessionRecord('del-a', 'task-gone', 'proj');
    await createSessionRecord('del-b', 'task-gone-too', 'proj');
    await createSessionRecord('del-other', 'task-kept', 'proj');
    const before = Object.fromEntries(await Promise.all(['del-a', 'del-b', 'del-other'].map(async (id) => [id, await getSessionByClaudeId(id)] as const)));
    const events = statusEvents();

    expect(await unlinkSessionsFromTasks(['task-gone', 'task-gone-too'])).toBe(2);

    for (const id of ['del-a', 'del-b']) {
      const after = (await getSessionByClaudeId(id))!;
      expect(after.taskId, id).toBeUndefined();
      expect(after.statusRevision, id).toBe(before[id]!.statusRevision + 1);
      expect(after.lastActiveAt, id).toBe(before[id]!.lastActiveAt);
      expect(toSessionStatusSnapshot(after).taskId, id).toBeNull();
      const published = statusOf(events, id);
      expect(published, id).toHaveLength(1);
      expect(published[0]!.taskId, id).toBeNull();
      expect(published[0]!.statusRevision, id).toBe(after.statusRevision);
      expect(published[0]!.status, id).toEqual(toSessionStatusSnapshot(after));
    }
    // A session of another task is not touched, not even its revision.
    expect((await getSessionByClaudeId('del-other'))!).toMatchObject({ taskId: 'task-kept', statusRevision: before['del-other']!.statusRevision });
    expect(statusOf(events, 'del-other')).toEqual([]);
    // The search index re-reads both (the task is part of the indexed session).
    expect(contentOf(events)).toEqual(['del-a', 'del-b']);
  });

  it('a merge points the sessions at the survivor as a status change', async () => {
    await createSessionRecord('merge-a', 'task-victim', 'proj');
    const before = (await getSessionByClaudeId('merge-a'))!;
    const events = statusEvents();

    expect(await relinkSessionsToTask('task-victim', 'task-survivor')).toBe(1);

    const after = (await getSessionByClaudeId('merge-a'))!;
    expect(after.taskId).toBe('task-survivor');
    expect(after.statusRevision).toBe(before.statusRevision + 1);
    expect(after.lastActiveAt).toBe(before.lastActiveAt);
    expect(statusOf(events, 'merge-a').map((e) => [e.taskId, e.statusRevision])).toEqual([['task-survivor', after.statusRevision]]);
    expect(contentOf(events)).toEqual(['merge-a']);
  });

  it('a bulk unlink goes in slices that each commit and publish, with a turn of the event loop between them', async () => {
    // A bulk delete has no count limit: the work is split by time, never capped. One row per slice here.
    const ids = Array.from({ length: 6 }, (_, i) => `bulk-${i}`);
    for (const [i, id] of ids.entries()) await createSessionRecord(id, `task-bulk-${i}`, 'proj');
    await updateSessionRecord('bulk-0', { summary: 'kept as written' });
    await createSessionRecord('bulk-moved', 'task-bulk-moved', 'proj');
    const before = Object.fromEntries(await Promise.all([...ids, 'bulk-moved'].map(async (id) => [id, (await getSessionByClaudeId(id))!] as const)));
    const order: string[] = [];
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return;
      order.push((event.data as { sessionId: string }).sessionId);
      // What else waits for the loop gets its turn before the next slice.
      setImmediate(() => order.push('|'));
      // Another writer links a session the slices have not reached yet: its new task stands.
      if (order.length === 1) void linkSessionToTask('bulk-moved', 'task-elsewhere');
    });
    _setRetaskSliceMsForTesting(0);
    try {
      expect(await unlinkSessionsFromTasks([...ids.map((_, i) => `task-bulk-${i}`), 'task-bulk-moved'])).toBe(6);
    } finally {
      _setRetaskSliceMsForTesting(null);
    }
    await new Promise((resolve) => setImmediate(resolve));

    const retasked = order.filter((sid) => ids.includes(sid));
    expect(retasked.sort()).toEqual([...ids].sort());
    // Between any two sessions of the delete, the loop took a turn.
    const seq = order.filter((sid) => sid === '|' || ids.includes(sid));
    for (let i = 1; i < seq.length; i++) expect(seq[i - 1] === '|' || seq[i] === '|', seq.join(' ')).toBe(true);
    for (const id of ids) {
      const after = (await getSessionByClaudeId(id))!;
      expect(after.taskId, id).toBeUndefined();
      expect(after.statusRevision, id).toBe(before[id]!.statusRevision + 1);
      expect(after.lastActiveAt, id).toBe(before[id]!.lastActiveAt);
    }
    // Only the task columns are written: the rest of the row is as it was.
    expect((await getSessionByClaudeId('bulk-0'))!.summary).toBe('kept as written');
    expect((await getSessionByClaudeId('bulk-moved'))!).toMatchObject({ taskId: 'task-elsewhere', statusRevision: before['bulk-moved']!.statusRevision + 1 });
  });

  it('slices start small and are sized by what the last one cost', async () => {
    for (let i = 0; i < 400; i++) await createSessionRecord(`size-${i}`, `task-size-${i}`, 'proj');
    const slices: number[] = [];
    let open = false;
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return;
      // A slice's announcements run back to back; the turn of the loop between slices closes it.
      if (!open) { slices.push(0); open = true; setImmediate(() => { open = false; }); }
      slices[slices.length - 1]! += 1;
    });
    expect(await unlinkSessionsFromTasks(Array.from({ length: 400 }, (_, i) => `task-size-${i}`))).toBe(400);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(400);
    expect(slices[0], slices.join(' ')).toBe(25);
    expect(slices.length, slices.join(' ')).toBeGreaterThan(1);
    expect(slices.slice(1, -1).some((n) => n !== 25), `the size follows the cost: ${slices.join(' ')}`).toBe(true);
  });

  /** Count the announced sessions per slice: a slice's announcements run back to back, and the turn of
   *  the loop between slices closes it. `cost` runs on every announcement (a slow subscriber). */
  const sliceSizes = (cost?: () => void) => {
    const slices: number[] = [];
    let open = false;
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return;
      if (!open) { slices.push(0); open = true; setImmediate(() => { open = false; }); }
      slices[slices.length - 1]! += 1;
      cost?.();
    });
    return slices;
  };

  it('a slice is at most four times the one before, however cheap it was (r4 gate, L-25)', async () => {
    for (let i = 0; i < 600; i++) await createSessionRecord(`grow-${i}`, `task-grow-${i}`, 'proj');
    const slices = sliceSizes();
    // A budget nothing can use up: only the growth cap sizes the slices.
    _setRetaskSliceMsForTesting(1_000_000);
    expect(await unlinkSessionsFromTasks(Array.from({ length: 600 }, (_, i) => `task-grow-${i}`))).toBe(600);
    expect(slices).toEqual([25, 100, 400, 75]);
  });

  it('the announcements count against the budget: a slow subscriber makes the slices smaller (r4 gate, L-25)', async () => {
    // Announcing costs the most (every event goes to every socket). A budget that timed only the
    // transaction let the slices grow to the cap while the subscribers held the loop twice as long.
    for (let i = 0; i < 60; i++) await createSessionRecord(`slow-${i}`, `task-slow-${i}`, 'proj');
    const slices = sliceSizes(() => { const until = performance.now() + 1; while (performance.now() < until) { /* 1 ms a session */ } });
    expect(await unlinkSessionsFromTasks(Array.from({ length: 60 }, (_, i) => `task-slow-${i}`))).toBe(60);
    expect(slices[0], slices.join(' ')).toBe(25);
    // 25 sessions took at least 25 ms of announcing, so the next slices fit 8 ms: 8 sessions or fewer.
    expect(Math.max(...slices.slice(1)), slices.join(' ')).toBeLessThanOrEqual(8);
  });

  it('a session linked to the deleted task while its unlink runs is unlinked too', async () => {
    // One session per task: a deleted task takes a new session only once its old one is unlinked.
    const taskOf: Record<string, string> = { 'late-a': 'task-late-a', 'late-b': 'task-late-b', 'late-c': 'task-late-c' };
    for (const [id, taskId] of Object.entries(taskOf)) await createSessionRecord(id, taskId, 'proj');
    const started: Promise<unknown>[] = [];
    bus.subscribe('session-status-contract-test', (event) => {
      const data = event.data as { sessionId?: string; taskId?: string | null };
      if (event.name !== EventNames.SESSION_STATUS_CHANGED || data.taskId !== null || !taskOf[data.sessionId!]) return;
      // After the ids were read: a session started for the first task freed, and one moved onto the second.
      if (started.length === 0) started.push(createSessionRecord('late-new', taskOf[data.sessionId!]!, 'proj'));
      else if (started.length === 1) started.push(linkSessionToTask('late-moved', taskOf[data.sessionId!]!));
    });
    await createSessionRecord('late-moved', 'task-other', 'proj');
    _setRetaskSliceMsForTesting(0);
    expect(await unlinkSessionsFromTasks(Object.values(taskOf))).toBe(5);
    expect(started).toHaveLength(2);
    await Promise.all(started);
    for (const id of ['late-a', 'late-b', 'late-c', 'late-new', 'late-moved']) {
      expect((await getSessionByClaudeId(id))!.taskId, id).toBeUndefined();
    }
  });

  it('an unlink that keeps finding new links gives up after a few reads (the integrity check reports the rest)', async () => {
    await createSessionRecord('churn-0', 'task-churn', 'proj');
    let created = 0;
    const creating: Promise<unknown>[] = [];
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED || (event.data as { taskId?: string | null }).taskId !== null) return;
      // Every session it unlinks, someone links another one to the deleted task.
      if (created < 200) creating.push(createSessionRecord(`churn-${++created}`, 'task-churn', 'proj'));
    });
    _setRetaskSliceMsForTesting(0);
    const unlinked = await unlinkSessionsFromTasks(['task-churn']);
    await Promise.all(creating);
    expect(unlinked, `unlinked ${unlinked}, created ${created}`).toBeGreaterThan(1);
    expect(unlinked, `unlinked ${unlinked}, created ${created}`).toBeLessThan(20);
  });

  it('a delete of the merge survivor while the merge runs leaves no session on it (r4 gate, L-23)', async () => {
    // One session per task: the victim has one session, and the survivor none of its own, or the
    // merge would keep the survivor's (task-manager mergeTaskInto).
    const victims = ['mv-0'];
    await createSessionRecord('mv-0', 'task-victim', 'proj');
    const events = statusEvents();
    let survivorExists = true;
    let deleting: Promise<number> | null = null;
    bus.subscribe('session-status-contract-delete', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED || deleting) return;
      // The merge's first session is announced. Now the survivor is deleted as deleteTask does it:
      // the task row goes first, then its sessions are unlinked.
      survivorExists = false;
      deleting = unlinkSessionsFromTasks(['task-survivor']);
    });
    _setRetaskSliceMsForTesting(0);
    try {
      // The merge's slice found the survivor; the delete's unlink then clears the link it made.
      expect(await relinkSessionsToTask('task-victim', 'task-survivor', { toTaskExists: () => survivorExists })).toBe(1);
      await deleting;
    } finally {
      bus.unsubscribe('session-status-contract-delete');
    }
    expect(deleting).not.toBeNull();
    for (const id of victims) {
      const after = (await getSessionByClaudeId(id))!;
      expect(after.taskId, id).toBeUndefined();
      // The last status a page heard says the same, at the stored revision.
      expect(statusOf(events, id).at(-1), id).toMatchObject({ taskId: null, statusRevision: after.statusRevision });
    }
  });

  it('the survivor check and the write of its slice are one step: a delete cannot land between them (r5 gate, L-31)', async () => {
    // Asked before the slice's lock, or with a turn of the loop before the write, the answer could be
    // stale by the write: a delete landing in between and that slice pointing its sessions at a task
    // already gone. The delete's own unlink then has to find them; the merge must not leave them.
    // One session per task: the victim's one session is the merge's one slice.
    const victims = ['atom-0'];
    await createSessionRecord('atom-0', 'task-victim', 'proj');
    const onSurvivor = () => (getSessionDb()!.prepare('SELECT claude_session_id FROM sessions WHERE task_id = ?')
      .pluck().all('task-survivor') as string[]).sort();
    let survivorExists = true;
    let checks = 0;
    const outsideTx: number[] = [];
    let onSurvivorAtDelete: string[] | null = null;
    const toTaskExists = () => {
      checks++;
      if (!getSessionDb()?.inTransaction) outsideTx.push(checks);
      // The survivor is deleted at the first turn of the loop after the first answer.
      if (checks === 1) setImmediate(() => { survivorExists = false; onSurvivorAtDelete = onSurvivor(); });
      return survivorExists;
    };
    _setRetaskSliceMsForTesting(0);
    expect(await relinkSessionsToTask('task-victim', 'task-survivor', { toTaskExists })).toBe(1);
    expect(checks).toBe(1);
    expect(outsideTx, 'checks made outside the slice transaction').toEqual([]);
    expect(onSurvivorAtDelete).toEqual(['atom-0']);
    // What sits on the survivor now is what sat there when it was deleted: the merge put nothing after.
    expect(onSurvivor()).toEqual(onSurvivorAtDelete);
    for (const id of victims.filter((id) => !onSurvivorAtDelete!.includes(id))) {
      expect((await getSessionByClaudeId(id))!.taskId, id).toBeUndefined();
    }
  });

  it('a slice that waits for the lock behind another writer is not charged for the wait (r5 gate, L-31)', async () => {
    // Each slice is sized by what the last one cost, timed from the lock on. Timed from the request, a
    // writer holding the lock a while made the slice queued behind it look slow, and the rest of the
    // move went in slices a few sessions long.
    // The cost is read on a test clock that moves only while the other writer holds the lock, by 300 ms
    // (r6 gate, L-36: on the wall clock a loaded machine made a slice's own work look as slow as the
    // wait, and the test went red with nothing wrong).
    for (let i = 0; i < 400; i++) await createSessionRecord(`wait-${i}`, `task-wait-${i}`, 'proj');
    let now = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding: Promise<unknown> | null = null;
    let afterFirstSlice = false;
    let releasedBy: string | null = null;
    const letGo = (by: string) => {
      if (releasedBy) return;
      releasedBy = by;
      now += 300;
      release();
    };
    // The first clock read after the first slice is the next slice's, before it asks for the lock: the
    // writer lets go there, so that slice queues behind it while the clock moves.
    _setRetaskClockForTesting(() => {
      const at = now;
      if (holding && afterFirstSlice) letGo('clock');
      return at;
    });
    // A safety net only, so a change in where the clock is read cannot hang the test.
    const net = setTimeout(() => letGo('safety net'), 5_000);
    const slices = sliceSizes(() => {
      if (holding) return;
      // While the first slice is announced, another writer takes the lock.
      holding = _withSessionWriteLockForTesting(() => held);
      setImmediate(() => { afterFirstSlice = true; });
    });
    _setRetaskSliceMsForTesting(20);
    try {
      expect(await unlinkSessionsFromTasks(Array.from({ length: 400 }, (_, i) => `task-wait-${i}`))).toBe(400);
    } finally {
      clearTimeout(net);
      letGo('cleanup');
      await holding;
    }
    // Their own work costs nothing on this clock, so each slice is four times the last, up to what is
    // left. Charged for the wait (300 ms for 100 sessions, at 20 ms a slice), the third would be 6.
    expect(slices, slices.join(' ')).toEqual([25, 100, 275]);
    // The writer was let go by the second slice's clock read, so that slice did queue behind it.
    expect(releasedBy).toBe('clock');
  });

  it('a merge into a survivor already deleted clears the links instead', async () => {
    await createSessionRecord('gone-a', 'task-victim', 'proj');
    expect(await relinkSessionsToTask('task-victim', 'task-deleted', { toTaskExists: () => false })).toBe(0);
    expect((await getSessionByClaudeId('gone-a'))!.taskId).toBeUndefined();
    // A check that fails keeps the survivor: the rows follow it rather than stay on the victim.
    await createSessionRecord('check-fails', 'task-victim-2', 'proj');
    expect(await relinkSessionsToTask('task-victim-2', 'task-kept', { toTaskExists: () => { throw new Error('task DB closed'); } })).toBe(1);
    expect((await getSessionByClaudeId('check-fails'))!.taskId).toBe('task-kept');
  });

  it('a link publishes the change; nothing linked, nothing published', async () => {
    await createSessionRecord('link-ev', '', 'proj');
    const before = (await getSessionByClaudeId('link-ev'))!;
    const events = statusEvents();

    await linkSessionToTask('link-ev', 'task-new');
    expect(statusOf(events, 'link-ev').map((e) => [e.taskId, e.statusRevision])).toEqual([['task-new', before.statusRevision + 1]]);
    await linkSessionToTask('link-ev', 'task-new');
    expect(statusOf(events, 'link-ev')).toHaveLength(1);

    expect(await unlinkSessionsFromTasks(['task-nobody'])).toBe(0);
    expect(await relinkSessionsToTask('task-nobody', 'task-new')).toBe(0);
    expect(await unlinkSessionsFromTasks([])).toBe(0);
    expect(statusOf(events, 'link-ev')).toHaveLength(1);
  });
});

describe('getRecentSessions', () => {
  it('returns sessions sorted by lastActiveAt descending', async () => {
    await createSessionRecord('first', 'task-1', 'proj');
    await new Promise((r) => setTimeout(r, 10));
    await createSessionRecord('second', 'task-2', 'proj');
    await new Promise((r) => setTimeout(r, 10));
    await createSessionRecord('third', 'task-3', 'proj');

    const recent = await getRecentSessions(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].claudeSessionId).toBe('third');
    expect(recent[2].claudeSessionId).toBe('first');
  });

  it('respects limit parameter', async () => {
    await createSessionRecord('a', 'task-1', 'p');
    await createSessionRecord('b', 'task-2', 'p');
    await createSessionRecord('c', 'task-3', 'p');

    const recent = await getRecentSessions(2);
    expect(recent).toHaveLength(2);
  });

  it('returns empty array when no sessions', async () => {
    const recent = await getRecentSessions();
    expect(recent).toEqual([]);
  });
});

describe('resume status reset', () => {
  it('resets process_status to running when upsert provides a new PID for a stopped session', async () => {
    // Create a session and mark it as stopped (simulating a completed turn)
    await createSessionRecord('resume-1', 'task-1', 'proj');
    await updateSessionRecord('resume-1', {
      process_status: 'stopped',
    });

    // Verify it's stopped
    const before = await getSessionByClaudeId('resume-1');
    expect(before!.process_status).toBe('stopped');

    // Upsert with a new PID (simulating session resume)
    const resumed = await createSessionRecord('resume-1', 'task-1', 'proj', undefined, {
      pid: 99999,
      outputFile: '/tmp/new-output.jsonl',
    });

    expect(resumed.process_status).toBe('running');
    expect(resumed.pid).toBe(99999);
    expect(resumed.last_status_change).toBeDefined();
  });

  it('does NOT reset status when upsert has no PID', async () => {
    await createSessionRecord('resume-2', 'task-1', 'proj');
    await updateSessionRecord('resume-2', {
      process_status: 'stopped',
    });

    // Upsert without PID (e.g., just updating outputFile)
    const result = await createSessionRecord('resume-2', 'task-1', 'proj', undefined, {
      outputFile: '/tmp/update.jsonl',
    });

    expect(result.process_status).toBe('stopped');
  });

  it('does NOT reset status when session is already running', async () => {
    // Session is still running — PID update should not double-reset
    await createSessionRecord('resume-3', 'task-1', 'proj', undefined, { pid: 11111 });

    const before = await getSessionByClaudeId('resume-3');
    expect(before!.process_status).toBe('running');

    const result = await createSessionRecord('resume-3', 'task-1', 'proj', undefined, { pid: 22222 });
    expect(result.process_status).toBe('running');
    expect(result.pid).toBe(22222);
  });
});

describe('getActiveSessionsByHost', () => {
  // Note: isProcessAlive is mocked to return true, so any non-null PID passes liveness check.
  it('groups running sessions by host', async () => {
    await createSessionRecord('local-1', 'task-1', 'proj', undefined, { pid: 1001 });
    await createSessionRecord('local-2', 'task-2', 'proj', undefined, { pid: 1002 });
    await createSessionRecord('remote-1', 'task-3', 'proj', undefined, { host: 'devbox', pid: 2001 });
    await createSessionRecord('remote-2', 'task-4', 'proj', undefined, { host: 'devbox', pid: 2002 });
    await createSessionRecord('remote-3', 'task-5', 'proj', undefined, { host: 'remotehost', pid: 3001 });

    const byHost = await getActiveSessionsByHost();
    expect(byHost['local']).toHaveLength(2);
    expect(byHost['devbox']).toHaveLength(2);
    expect(byHost['remotehost']).toHaveLength(1);
  });

  it('excludes stopped sessions', async () => {
    await createSessionRecord('s1', 'task-1', 'proj', undefined, { pid: 1001 });
    await updateSessionRecord('s1', { process_status: 'stopped' });
    await createSessionRecord('s2', 'task-2', 'proj', undefined, { pid: 1002 });

    const byHost = await getActiveSessionsByHost();
    expect(byHost['local']).toHaveLength(1);
    expect(byHost['local']![0].claudeSessionId).toBe('s2');
  });

  it('excludes sessions without a PID', async () => {
    await createSessionRecord('no-pid', 'task-1', 'proj'); // No PID
    await createSessionRecord('has-pid', 'task-2', 'proj', undefined, { pid: 1001 });

    const byHost = await getActiveSessionsByHost();
    expect(byHost['local']).toHaveLength(1);
    expect(byHost['local']![0].claudeSessionId).toBe('has-pid');
  });

  it('returns empty object when no running sessions', async () => {
    const byHost = await getActiveSessionsByHost();
    expect(byHost).toEqual({});
  });
});

describe('checkSessionLimit', () => {
  it('allows session when under limit', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    const result = await checkSessionLimit(undefined, { local: 3 });
    expect(result.allowed).toBe(true);
    expect(result.running).toBe(1);
    expect(result.limit).toBe(3);
  });

  it('blocks session when at limit', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    await createSessionRecord('s2', 't2', 'p', undefined, { pid: 1002 });
    const result = await checkSessionLimit(undefined, { local: 2 });
    expect(result.allowed).toBe(false);
    expect(result.running).toBe(2);
    expect(result.limit).toBe(2);
    expect(result.runningSessions).toHaveLength(2);
  });

  it('uses default local limit when no config', async () => {
    const result = await checkSessionLimit(undefined, undefined);
    expect(result.allowed).toBe(true);
    // DEFAULT_LOCAL_LIMIT — verify it's a reasonable positive integer
    expect(result.limit).toBeGreaterThanOrEqual(3);
    expect(result.limit).toBeLessThanOrEqual(20);
  });

  it('uses default remote limit (20) for unknown remote host', async () => {
    const result = await checkSessionLimit('devbox', undefined);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(20);
  });

  it('uses configured remote host limit', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { host: 'devbox', pid: 2001 });
    const result = await checkSessionLimit('devbox', { devbox: 1 });
    expect(result.allowed).toBe(false);
    expect(result.running).toBe(1);
    expect(result.limit).toBe(1);
  });

  it('counts only sessions on the target host', async () => {
    // 3 local sessions, 1 remote
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    await createSessionRecord('s2', 't2', 'p', undefined, { pid: 1002 });
    await createSessionRecord('s3', 't3', 'p', undefined, { pid: 1003 });
    await createSessionRecord('s4', 't4', 'p', undefined, { host: 'devbox', pid: 2001 });

    // Check local — 3 running, limit 5
    const localResult = await checkSessionLimit(undefined, { local: 5 });
    expect(localResult.running).toBe(3);
    expect(localResult.allowed).toBe(true);

    // Check devbox — only 1 running
    const remoteResult = await checkSessionLimit('devbox', { devbox: 5 });
    expect(remoteResult.running).toBe(1);
    expect(remoteResult.allowed).toBe(true);
  });

  it('ignores stopped sessions in count', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    await updateSessionRecord('s1', { process_status: 'stopped' });
    await createSessionRecord('s2', 't2', 'p', undefined, { pid: 1002 });

    const result = await checkSessionLimit(undefined, { local: 2 });
    expect(result.running).toBe(1);
    expect(result.allowed).toBe(true);
  });

  it('treats null host as local', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    const result = await checkSessionLimit(null, { local: 2 });
    expect(result.running).toBe(1);
    expect(result.allowed).toBe(true);
  });

  it('floors limit at 1 for zero or negative config values', async () => {
    const result = await checkSessionLimit(undefined, { local: 0 });
    expect(result.limit).toBe(1);
    expect(result.allowed).toBe(true); // 0 running < 1 limit

    const negResult = await checkSessionLimit(undefined, { local: -5 });
    expect(negResult.limit).toBe(1);
  });
});

describe('getActiveSessionsByHost', () => {
  it('only counts running sessions', async () => {
    // Active (running) — should be counted
    await createSessionRecord('active-1', 't1', 'p', undefined, { pid: 1001 });
    await createSessionRecord('active-2', 't2', 'p', undefined, { pid: 1002 });

    // Idle (process_status: idle) — should NOT be counted
    await createSessionRecord('idle-1', 't3', 'p', undefined, { pid: 1003 });
    await updateSessionRecord('idle-1', { process_status: 'idle' });

    // Stopped — should NOT be counted
    await createSessionRecord('idle-2', 't4', 'p', undefined, { pid: 1004 });
    await updateSessionRecord('idle-2', { process_status: 'stopped' });

    const byHost = await getActiveSessionsByHost();
    expect(byHost['local']).toHaveLength(2);
    expect(byHost['local']!.map(s => s.claudeSessionId).sort()).toEqual(['active-1', 'active-2']);
  });

  it('returns empty when all sessions are idle', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    await updateSessionRecord('s1', { process_status: 'idle' });

    const byHost = await getActiveSessionsByHost();
    expect(byHost).toEqual({});
  });
});

describe('getAllAliveSessionsByHost', () => {
  it('counts all alive sessions regardless of process_status (running + idle)', async () => {
    await createSessionRecord('active-1', 't1', 'p', undefined, { pid: 1001 });
    await createSessionRecord('idle-1', 't2', 'p', undefined, { pid: 1002 });
    await updateSessionRecord('idle-1', { process_status: 'idle' });
    await createSessionRecord('idle-2', 't3', 'p', undefined, { pid: 1003 });
    await updateSessionRecord('idle-2', { process_status: 'idle' });

    const byHost = await getAllAliveSessionsByHost();
    expect(byHost['local']).toHaveLength(3);
  });
});

describe('checkSessionLimit — idle sessions do not block', () => {
  it('allows new session when active limit not reached, even with many idle sessions', async () => {
    // 1 active session
    await createSessionRecord('active-1', 't1', 'p', undefined, { pid: 1001 });

    // 6 idle sessions (process_status: idle) — these should not block at limit=7
    for (let i = 2; i <= 7; i++) {
      await createSessionRecord(`idle-${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`idle-${i}`, { process_status: 'idle' });
    }

    const result = await checkSessionLimit(undefined, { local: 7 });
    expect(result.allowed).toBe(true);
    expect(result.running).toBe(1); // Only 1 active
    expect(result.totalAlive).toBe(7); // 7 total alive processes
  });

  it('blocks only when active (running) sessions reach the limit', async () => {
    // 7 active sessions
    for (let i = 1; i <= 7; i++) {
      await createSessionRecord(`active-${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
    }

    const result = await checkSessionLimit(undefined, { local: 7 });
    expect(result.allowed).toBe(false);
    expect(result.running).toBe(7);
  });

  it('idle sessions do not count as active', async () => {
    await createSessionRecord('phr-1', 't1', 'p', undefined, { pid: 1001 });
    await updateSessionRecord('phr-1', { process_status: 'idle' });

    const result = await checkSessionLimit(undefined, { local: 1 });
    expect(result.allowed).toBe(true);
    expect(result.running).toBe(0);
  });
});

describe('checkSessionLimit — idle limit with eviction', () => {
  it('evicts oldest idle session when idle count reaches max_idle', async () => {
    // Create 6 sessions — all idle (process_status='idle').
    // Use max_idle=5 so 6 idle sessions triggers eviction.
    for (let i = 1; i <= 6; i++) {
      await createSessionRecord(`s${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`s${i}`, { process_status: 'idle' });
    }

    // With max_idle=5, having 6 idle sessions should trigger eviction
    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 5 });
    expect(result.allowed).toBe(true); // 0 running < 7
    expect(result.evicted).toBeDefined();
    expect(result.evicted).toHaveLength(2); // evict 6-5+1=2 to make room
    expect(result.evicted![0].claudeSessionId).toBe('s1'); // oldest idle

    // Verify the evicted session is now stopped
    const evictedSession = await getSessionByClaudeId('s1');
    expect(evictedSession!.process_status).toBe('stopped');
  });

  it('does not evict when under idle limit', async () => {
    // 4 sessions — under the max_idle=5 cap
    for (let i = 1; i <= 4; i++) {
      await createSessionRecord(`s${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`s${i}`, { process_status: 'idle' });
    }

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 5 });
    expect(result.allowed).toBe(true);
    expect(result.evicted).toBeUndefined();
  });

  it('returns idleCount and maxIdle in result', async () => {
    for (let i = 1; i <= 3; i++) {
      await createSessionRecord(`s${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`s${i}`, { process_status: 'idle' });
    }

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 10 });
    expect(result.idleCount).toBe(3);
    expect(result.maxIdle).toBe(10);
  });
});

describe('legacy status migration', () => {
  it('migrates old status field to process_status on read', async () => {
    // Write a v2 store with the old single-status format
    const { SESSIONS_FILE } = await import('../../src/constants.js');
    await fsp.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
    const oldStore = {
      version: 2,
      sessions: [{
        claudeSessionId: 'old-uuid',
        taskId: 'task-old',
        project: 'old-proj',
        status: 'idle',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastActiveAt: '2024-01-02T00:00:00.000Z',
        messageCount: 0,
      }],
    };
    await fsp.writeFile(SESSIONS_FILE, JSON.stringify(oldStore), 'utf-8');

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].process_status).toBe('stopped');
    expect(sessions[0]).not.toHaveProperty('status');
    expect(sessions[0]).not.toHaveProperty('work_status');
  });
});

// ── Test 1: isTerminalSession recognizes process_status:'error' ──────────────

describe('isTerminalSession', () => {
  it('returns true when process_status is error', () => {
    expect(isTerminalSession({ process_status: 'error' })).toBe(true);
  });

  it('returns true when taskPhase is COMPLETE', () => {
    expect(isTerminalSession({ process_status: 'stopped' }, 'COMPLETE')).toBe(true);
  });

  it('returns false when session is actively running', () => {
    expect(isTerminalSession({ process_status: 'running' })).toBe(false);
  });

  it('returns false when session is stopped without COMPLETE phase', () => {
    expect(isTerminalSession({ process_status: 'stopped' })).toBe(false);
  });

  it('returns false for idle sessions', () => {
    expect(isTerminalSession({ process_status: 'idle' })).toBe(false);
  });
});

// ── Test 2: Legacy data migration work_status:'error' → process_status:'error' ──

describe('legacy work_status migration', () => {
  it('strips work_status:error from session on read (process_status preserved)', async () => {
    const { SESSIONS_FILE } = await import('../../src/constants.js');
    await fsp.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });

    const legacyStore = {
      version: 2,
      sessions: [{
        claudeSessionId: 'err-session-1',
        taskId: 'task-err',
        project: 'err-proj',
        process_status: 'stopped',
        work_status: 'error',
        mode: 'default',
        type: 'interactive',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastActiveAt: '2024-01-02T00:00:00.000Z',
        messageCount: 5,
      }],
    };
    await fsp.writeFile(SESSIONS_FILE, JSON.stringify(legacyStore), 'utf-8');

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    // Migration strips work_status entirely — process_status is preserved as-is
    expect(sessions[0].process_status).toBe('stopped');
    expect(sessions[0]).not.toHaveProperty('work_status');
  });

  it('strips work_status from sessions on read', async () => {
    const { SESSIONS_FILE } = await import('../../src/constants.js');
    await fsp.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });

    const store = {
      version: 2,
      sessions: [{
        claudeSessionId: 'normal-session',
        taskId: 'task-ok',
        project: 'proj',
        process_status: 'stopped',
        work_status: 'agent_complete',
        mode: 'default',
        type: 'interactive',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastActiveAt: '2024-01-02T00:00:00.000Z',
        messageCount: 3,
      }],
    };
    await fsp.writeFile(SESSIONS_FILE, JSON.stringify(store), 'utf-8');

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].process_status).toBe('stopped');
    expect(sessions[0]).not.toHaveProperty('work_status');
  });
});

// ── Test 4: listNonTerminalSessions excludes process_status:'error' ──────────

describe('listNonTerminalSessions', () => {
  it('excludes sessions with process_status:error', async () => {
    // Create a normal running session
    await createSessionRecord('running-1', 'task-1', 'proj', undefined, { pid: 1001 });

    // Create a session and mark it as error
    await createSessionRecord('error-1', 'task-2', 'proj', undefined, { pid: 1002 });
    await updateSessionRecord('error-1', { process_status: 'error', errorMessage: 'Process exited without result' });

    // Create a stopped session (non-error — not terminal without COMPLETE task phase)
    await createSessionRecord('done-1', 'task-3', 'proj');
    await updateSessionRecord('done-1', { process_status: 'stopped' });

    const nonTerminal = await listNonTerminalSessions();

    // running-1 and done-1 should be included; error-1 should be excluded
    // (listNonTerminalSessions only excludes process_status:'error' — no task phase check)
    const ids = nonTerminal.map(s => s.claudeSessionId);
    expect(ids).toContain('running-1');
    expect(ids).not.toContain('error-1');
    expect(ids).toContain('done-1');
  });

  it('includes sessions with non-terminal statuses', async () => {
    await createSessionRecord('s-running', 'task-1', 'proj', undefined, { pid: 2001 });

    await createSessionRecord('s-stopped', 'task-2', 'proj', undefined, { pid: 2002 });
    await updateSessionRecord('s-stopped', { process_status: 'stopped' });

    await createSessionRecord('s-idle', 'task-3', 'proj', undefined, { pid: 2003 });
    await updateSessionRecord('s-idle', { process_status: 'idle' });

    const nonTerminal = await listNonTerminalSessions();
    const ids = nonTerminal.map(s => s.claudeSessionId);

    expect(ids).toContain('s-running');
    expect(ids).toContain('s-stopped');
    expect(ids).toContain('s-idle');
  });

  it('excludes archived sessions', async () => {
    await createSessionRecord('archived-1', 'task-1', 'proj');
    await updateSessionRecord('archived-1', { archived: true });

    const nonTerminal = await listNonTerminalSessions();
    const ids = nonTerminal.map(s => s.claudeSessionId);
    expect(ids).not.toContain('archived-1');
  });
});

// ── Whole-store read cache (write-invalidated) ───────────────────────────────

describe('session store read cache', () => {
  it('serves repeated reads from cache — only ONE SELECT * scan for N reads', async () => {
    await createSessionRecord('cache-seed', 'task-1', 'proj', undefined, { pid: 1001 });

    // Spy on the SQLite handle's prepare() and count whole-table scans.
    const { getDb } = await import('../../src/core/session-db.js');
    const db = getDb()!;
    const prepareSpy = vi.spyOn(db, 'prepare');

    // 50 consecutive reads should trigger AT MOST one `SELECT * FROM sessions`
    // (the cache priming) — the rest are served from the cached array.
    for (let i = 0; i < 50; i++) {
      await listSessions();
    }

    const fullScans = prepareSpy.mock.calls.filter(
      (call) => String(call[0]).replace(/\s+/g, ' ').includes('SELECT * FROM sessions'),
    );
    expect(fullScans.length).toBeLessThanOrEqual(1);

    prepareSpy.mockRestore();
  });

  it('invalidates the cache on write so the next read reflects the mutation', async () => {
    await createSessionRecord('write-1', 'task-1', 'proj', undefined, { pid: 1001 });
    // Prime the cache.
    expect((await listSessions())[0].process_status).toBe('running');

    // Mutate — withWriteLock.finally must drop the cache.
    await updateSessionRecord('write-1', { process_status: 'stopped' });

    // Next read MUST reflect the new value (not the stale cached 'running').
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].process_status).toBe('stopped');
  });

  it('detects an on-stop write committed through another SQLite connection', async () => {
    const created = await createSessionRecord(
      'external-write-1',
      'task-1',
      'proj',
      undefined,
      { pid: 1001 },
    );
    await updateSessionRecord('external-write-1', { activity: 'processing' });
    const before = (await listSessions())[0];
    expect(before.process_status).toBe('running');
    expect(before.activity).toBe('processing');

    expect(markSessionStoppedInSqlite(
      SESSION_DB_PATH,
      'external-write-1',
      '2026-07-19T12:00:00.000Z',
    )).toBe(true);

    const after = (await listSessions())[0];
    expect(after).toMatchObject({
      process_status: 'stopped',
      statusRevision: created.statusRevision! + 2,
      statusUpdatedAt: '2026-07-19T12:00:00.000Z',
    });
    expect(after.activity).toBeUndefined();
  });

  it('hands out isolated clones — mutating a read result never poisons the cache', async () => {
    await createSessionRecord('clone-1', 'task-1', 'proj', undefined, { pid: 1001 });

    const first = await listSessions();
    // Simulate what the /api/sessions route does (enrichWithLiveStatus mutates
    // process_status in place on the returned objects).
    first[0].process_status = 'stopped';
    (first[0] as { activity?: string }).activity = 'mutated-in-place';

    // A fresh read must NOT see the in-place mutation — it returns the
    // canonical cached value, not the caller-mutated object.
    const second = await listSessions();
    expect(second[0].process_status).toBe('running');
    expect((second[0] as { activity?: string }).activity).toBeUndefined();
    expect(second[0]).not.toBe(first[0]); // distinct object instances
  });
});

describe('ACP provider identity migration status versions', () => {
  it('makes the replacement newer than the archived redirect', async () => {
    const original = await createSessionRecord(
      'provider-old',
      'task-1',
      'proj',
      undefined,
      {
        initialProcessStatus: 'idle',
        engine: 'codex',
        acpRuntimeId: 'acp-runtime',
      },
    );

    const replacement = await stageAcpSessionIdMigration(
      'provider-old',
      'provider-new',
    );
    const redirect = await getSessionByClaudeId('provider-old');

    expect(redirect).toMatchObject({
      archived: true,
      statusRevision: original.statusRevision! + 1,
    });
    expect(replacement).toMatchObject({
      claudeSessionId: 'provider-new',
      archived: false,
      statusRevision: original.statusRevision! + 2,
      statusUpdatedAt: redirect?.statusUpdatedAt,
    });
  });
});

describe('batchUpdateSessionRecords', () => {
  it('applies the same patch to many sessions and returns written ids', async () => {
    for (let i = 0; i < 5; i++) {
      await createSessionRecord(`batch-${i}`, `task-${i}`, 'walnut', undefined, { pid: 1000 + i });
      await updateSessionRecord(`batch-${i}`, { process_status: 'running' });
    }
    const ids = ['batch-0', 'batch-1', 'batch-2', 'batch-3', 'batch-4'];
    const written = await batchUpdateSessionRecords(ids, {
      process_status: 'stopped',
      status_reason: 'orphan_no_pid',
      status_changed_by: 'health-monitor',
    });
    expect(written.sort()).toEqual(ids.sort());
    for (const id of ids) {
      const s = await getSessionByClaudeId(id);
      expect(s?.process_status).toBe('stopped');
    }
  });

  it('skips no-op updates (already in target state)', async () => {
    await createSessionRecord('batch-noop', 'task-noop', 'walnut');
    // createSessionRecord makes it 'running'; first mark it stopped.
    await updateSessionRecord('batch-noop', { process_status: 'stopped' });
    // Re-applying stopped is a no-op → not written.
    const written = await batchUpdateSessionRecords(['batch-noop'], { process_status: 'stopped' });
    expect(written).toEqual([]);
  });

  it('skips missing rows without throwing', async () => {
    await createSessionRecord('batch-real', 'task-real', 'walnut', undefined, { pid: 9999 });
    await updateSessionRecord('batch-real', { process_status: 'running' });
    const written = await batchUpdateSessionRecords(
      ['batch-real', 'does-not-exist-1', 'does-not-exist-2'],
      { process_status: 'stopped', status_reason: 'orphan_no_pid' },
    );
    expect(written).toEqual(['batch-real']);
  });

  it('returns empty array for empty input', async () => {
    const written = await batchUpdateSessionRecords([], { process_status: 'stopped' });
    expect(written).toEqual([]);
  });
});

describe('healStalePendingPermissions (incident a172ce49)', () => {
  // A permission request cannot outlive its CLI process, but before the
  // control_cancel_request handler existed nothing cleared the persisted copy
  // on dead sessions — 28 terminal rows accumulated a permanent "Waiting"
  // badge. The startup heal clears pendingPermission ONLY on terminal records.
  const PP = {
    requestId: 'req-stale-1',
    toolName: 'ExitPlanMode',
    subtype: 'can_use_tool',
    receivedAt: '2026-06-01T00:00:00.000Z',
  };

  it('clears pendingPermission on stopped/error records, leaves live ones alone', async () => {
    const { healStalePendingPermissions } = await import('../../src/core/session-tracker.js');

    // Seed the prompt AFTER the terminal transition (two writes): the
    // transition-time clear (incident d9df1a86) now wipes a prompt riding the
    // SAME write as the death, so the boot heal's remaining constituency is
    // prompts landing on already-terminal records (external raw-SQL writers,
    // crash ordering) — which is exactly what this seeds.
    await createSessionRecord('heal-stopped', 'task-h1', 'walnut');
    await updateSessionRecord('heal-stopped', { process_status: 'stopped' });
    await updateSessionRecord('heal-stopped', { pendingPermission: PP });

    await createSessionRecord('heal-error', 'task-h2', 'walnut');
    await updateSessionRecord('heal-error', { process_status: 'error' });
    await updateSessionRecord('heal-error', { pendingPermission: { ...PP, requestId: 'req-stale-2' } });

    // Live sessions: daemon pendingCtrl is their truth — heal must NOT touch them.
    await createSessionRecord('heal-running', 'task-h3', 'walnut', undefined, { pid: 4242 });
    await updateSessionRecord('heal-running', { pendingPermission: { ...PP, requestId: 'req-live-1' } });

    await createSessionRecord('heal-idle', 'task-h4', 'walnut', undefined, { pid: 4243 });
    await updateSessionRecord('heal-idle', { process_status: 'idle', pendingPermission: { ...PP, requestId: 'req-live-2' } });

    const healed = await healStalePendingPermissions();
    expect(healed).toBe(2);

    expect((await getSessionByClaudeId('heal-stopped'))?.pendingPermission).toBeUndefined();
    expect((await getSessionByClaudeId('heal-error'))?.pendingPermission).toBeUndefined();
    expect((await getSessionByClaudeId('heal-running'))?.pendingPermission?.requestId).toBe('req-live-1');
    expect((await getSessionByClaudeId('heal-idle'))?.pendingPermission?.requestId).toBe('req-live-2');
  });

  it('is idempotent — second run heals nothing', async () => {
    const { healStalePendingPermissions } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('heal-idem', 'task-h5', 'walnut');
    await updateSessionRecord('heal-idem', { process_status: 'stopped' });
    await updateSessionRecord('heal-idem', { pendingPermission: PP });
    expect(await healStalePendingPermissions()).toBe(1);
    expect(await healStalePendingPermissions()).toBe(0);
  });

  it('no-op on a database with no stale rows', async () => {
    const { healStalePendingPermissions } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('heal-clean', 'task-h6', 'walnut');
    expect(await healStalePendingPermissions()).toBe(0);
  });

  // ── mid-flight death (incident d9df1a86, 2026-08-15) ────────────────────
  // The heal above only runs at BOOT. A session dying while the server is up
  // kept its prompt, and attach-time Layer-2 recovery resurrected it from the
  // record seconds after death — a permanent red Waiting on a dead session.
  // The clear now rides the terminal TRANSITION itself (applyUpdateToSession).

  it('INCIDENT SHAPE: transition to error clears the prompt in the same write', async () => {
    await createSessionRecord('die-mid-flight', 'task-h7', 'walnut', undefined, { pid: 9015 });
    await updateSessionRecord('die-mid-flight', { pendingPermission: { ...PP, requestId: 'req-mid-1' } });
    expect((await getSessionByClaudeId('die-mid-flight'))?.pendingPermission?.requestId).toBe('req-mid-1');

    await updateSessionRecord('die-mid-flight', {
      process_status: 'error',
      status_reason: 'snapshot_projection',
      status_changed_by: 'snapshot-projection',
    } as never);

    const rec = await getSessionByClaudeId('die-mid-flight');
    expect(rec?.process_status).toBe('error');
    expect(rec?.pendingPermission).toBeUndefined();
  });

  it('remote_unreachable keeps the prompt (connectivity loss ≠ death)', async () => {
    await createSessionRecord('ssh-flap', 'task-h8', 'walnut', undefined, { pid: 9016 });
    await updateSessionRecord('ssh-flap', { pendingPermission: { ...PP, requestId: 'req-flap-1' } });

    await updateSessionRecord('ssh-flap', {
      process_status: 'error',
      status_reason: 'remote_unreachable',
      status_changed_by: 'health-monitor',
    } as never);

    const rec = await getSessionByClaudeId('ssh-flap');
    expect(rec?.process_status).toBe('error');
    expect(rec?.pendingPermission?.requestId).toBe('req-flap-1');

    // …and the boot heal must ALSO skip it (same carve-out, both layers).
    const { healStalePendingPermissions } = await import('../../src/core/session-tracker.js');
    expect(await healStalePendingPermissions()).toBe(0);
    expect((await getSessionByClaudeId('ssh-flap'))?.pendingPermission?.requestId).toBe('req-flap-1');
  });

  // ── the NOTIFICATION half of the same death ─────────────────────────────
  // Clearing the record was only half the job: the durable notification
  // (`perm:<requestId>`) stayed resolved:undefined, which the panel reads as
  // still-pending — a permanent phantom in Needs Action with Approve/Deny
  // buttons that 404 against a session dead for days. Both clear paths now
  // stamp 'expired' as they clear.

  /** Poll the store: the stamp is fire-and-forget off the session write. */
  async function waitForResolved(dedupKey: string, expected: string | undefined): Promise<string | undefined> {
    const { listNotifications } = await import('../../src/core/notifications/store.js');
    for (let i = 0; i < 40; i++) {
      const { feed } = await listNotifications();
      const rec = feed.find(n => n.dedupKey === dedupKey);
      if (rec?.resolved === expected) return rec?.resolved;
      await new Promise(r => setTimeout(r, 25));
    }
    const { feed } = await listNotifications();
    return feed.find(n => n.dedupKey === dedupKey)?.resolved;
  }

  async function seedPermNotification(requestId: string, sessionId: string): Promise<void> {
    const { addNotification } = await import('../../src/core/notifications/store.js');
    await addNotification({
      kind: 'permission', severity: 'warning', title: 'ExitPlanMode',
      sessionId, dedupKey: `perm:${requestId}`, requestId,
    });
  }

  it('terminal transition expires the NOTIFICATION and emits the settle event', async () => {
    await seedPermNotification('req-notif-1', 'die-with-notif');
    const seen: Array<Record<string, unknown>> = [];
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name === EventNames.SESSION_PERMISSION_RESOLVED) {
        seen.push(event.data as Record<string, unknown>);
      }
    });

    await createSessionRecord('die-with-notif', 'task-n1', 'walnut', undefined, { pid: 9020 });
    await updateSessionRecord('die-with-notif', { pendingPermission: { ...PP, requestId: 'req-notif-1' } });
    await updateSessionRecord('die-with-notif', {
      process_status: 'error', status_reason: 'process_died', status_changed_by: 'health-monitor',
    } as never);

    expect(await waitForResolved('perm:req-notif-1', 'expired')).toBe('expired');

    // The live-tab settle event: allowed:false for old consumers, expired:true
    // as the thing that says nobody decided. Emitted after the tx commits, so
    // give the setImmediate a tick.
    await new Promise(r => setTimeout(r, 50));
    const ev = seen.find(e => e.requestId === 'req-notif-1');
    expect(ev).toMatchObject({
      sessionId: 'die-with-notif', taskId: 'task-n1', requestId: 'req-notif-1',
      allowed: false, expired: true,
    });
  });

  it('boot heal expires the notification too, with NO bus event', async () => {
    await seedPermNotification('req-notif-2', 'heal-with-notif');
    const seen: unknown[] = [];
    bus.subscribe('session-status-contract-test', (event) => {
      if (event.name === EventNames.SESSION_PERMISSION_RESOLVED) seen.push(event.data);
    });

    // Prompt lands AFTER the terminal transition, so the boot heal is the path
    // that clears it (same shape as the heal tests above).
    await createSessionRecord('heal-with-notif', 'task-n2', 'walnut');
    await updateSessionRecord('heal-with-notif', { process_status: 'stopped' });
    await updateSessionRecord('heal-with-notif', { pendingPermission: { ...PP, requestId: 'req-notif-2' } });

    const { healStalePendingPermissions } = await import('../../src/core/session-tracker.js');
    expect(await healStalePendingPermissions()).toBe(1);
    expect(await waitForResolved('perm:req-notif-2', 'expired')).toBe('expired');
    // No browser exists at boot — an event would fan out to nobody.
    await new Promise(r => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
  });

  it('remote_unreachable leaves the notification pending (expiry inherits the carve-out)', async () => {
    await seedPermNotification('req-notif-3', 'flap-with-notif');
    await createSessionRecord('flap-with-notif', 'task-n3', 'walnut', undefined, { pid: 9021 });
    await updateSessionRecord('flap-with-notif', { pendingPermission: { ...PP, requestId: 'req-notif-3' } });
    await updateSessionRecord('flap-with-notif', {
      process_status: 'error', status_reason: 'remote_unreachable', status_changed_by: 'health-monitor',
    } as never);

    // The expiry only runs where the CLEAR runs, so the SSH-flap carve-out
    // protects both copies of the question with no extra code.
    expect(await waitForResolved('perm:req-notif-3', 'expired')).toBeUndefined();
  });
});
