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
    if (s.process_status === 'stopped' || s.process_status === 'error') return false;
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
  getRecentSessions,
  getActiveSessionsByHost,
  getAllAliveSessionsByHost,
  checkSessionLimit,
  isTerminalSession,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb, SESSION_DB_PATH } from '../../src/core/session-db.js';
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
        phase: 'AGENT_COMPLETE',
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
      statusRevision: committed.statusRevision,
      statusUpdatedAt: committed.statusUpdatedAt,
    };
    expect(received?.data).toEqual({
      phase: 'AGENT_COMPLETE',
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
    expect(Object.keys(snapshot)).toHaveLength(12);
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
  it('returns sessions linked to a task', async () => {
    await createSessionRecord('s1', 'task-a', 'proj');
    await createSessionRecord('s2', 'task-a', 'proj');
    await createSessionRecord('s3', 'task-b', 'proj');
    const sessions = await getSessionsForTask('task-a');
    expect(sessions).toHaveLength(2);
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

    await createSessionRecord('heal-stopped', 'task-h1', 'walnut');
    await updateSessionRecord('heal-stopped', { process_status: 'stopped', pendingPermission: PP });

    await createSessionRecord('heal-error', 'task-h2', 'walnut');
    await updateSessionRecord('heal-error', { process_status: 'error', pendingPermission: { ...PP, requestId: 'req-stale-2' } });

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
    await updateSessionRecord('heal-idem', { process_status: 'stopped', pendingPermission: PP });
    expect(await healStalePendingPermissions()).toBe(1);
    expect(await healStalePendingPermissions()).toBe(0);
  });

  it('no-op on a database with no stale rows', async () => {
    const { healStalePendingPermissions } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('heal-clean', 'task-h6', 'walnut');
    expect(await healStalePendingPermissions()).toBe(0);
  });
});
