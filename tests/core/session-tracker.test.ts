import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => true,
}));

import {
  createSessionRecord,
  listSessions,
  getSessionByClaudeId,
  getSessionsForTask,
  updateSessionRecord,
  linkSessionToTask,
  getRecentSessions,
  getRunningSessionsByHost,
  getActiveSessionsByHost,
  getAllAliveSessionsByHost,
  checkSessionLimit,
} from '../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
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

describe('createSessionRecord', () => {
  it('creates a session with correct fields', async () => {
    const session = await createSessionRecord('claude-sess-1', 'task-1', 'walnut');
    expect(session.claudeSessionId).toBe('claude-sess-1');
    expect(session.taskId).toBe('task-1');
    expect(session.project).toBe('walnut');
    expect(session.process_status).toBe('running');
    expect(session.work_status).toBe('in_progress');
    expect(session.startedAt).toBeDefined();
    expect(session.lastActiveAt).toBeDefined();
    expect(session.messageCount).toBe(1);
  });

  it('increments messageCount on duplicate claudeSessionId', async () => {
    await createSessionRecord('claude-sess-dup', 'task-1', 'proj');
    const session = await createSessionRecord('claude-sess-dup', 'task-1', 'proj');
    expect(session.messageCount).toBe(2);
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
    const updated = await updateSessionRecord('upd-1', { work_status: 'agent_complete', project: 'new-proj' });
    expect(updated.work_status).toBe('agent_complete');
    expect(updated.project).toBe('new-proj');
  });

  it('updates lastActiveAt timestamp', async () => {
    const session = await createSessionRecord('upd-2', 'task-1', 'proj');
    const originalActive = session.lastActiveAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateSessionRecord('upd-2', { work_status: 'agent_complete' });
    expect(updated.lastActiveAt).not.toBe(originalActive);
  });

  it('throws for non-existent session', async () => {
    await expect(updateSessionRecord('nonexistent', { work_status: 'agent_complete' })).rejects.toThrow(
      /Session not found/,
    );
  });

  it('persists updates', async () => {
    await createSessionRecord('upd-3', 'task-1', 'proj');
    await updateSessionRecord('upd-3', { work_status: 'completed' });

    const found = await getSessionByClaudeId('upd-3');
    expect(found!.work_status).toBe('completed');
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
  it('resets status to running/in_progress when upsert provides a new PID for a stopped session', async () => {
    // Create a session and mark it as stopped/agent_complete (simulating a completed turn)
    await createSessionRecord('resume-1', 'task-1', 'proj');
    await updateSessionRecord('resume-1', {
      process_status: 'stopped',
      work_status: 'agent_complete',
    });

    // Verify it's stopped
    const before = await getSessionByClaudeId('resume-1');
    expect(before!.process_status).toBe('stopped');
    expect(before!.work_status).toBe('agent_complete');

    // Upsert with a new PID (simulating session resume)
    const resumed = await createSessionRecord('resume-1', 'task-1', 'proj', undefined, {
      pid: 99999,
      outputFile: '/tmp/new-output.jsonl',
    });

    expect(resumed.process_status).toBe('running');
    expect(resumed.work_status).toBe('in_progress');
    expect(resumed.pid).toBe(99999);
    expect(resumed.last_status_change).toBeDefined();
  });

  it('does NOT reset status when upsert has no PID', async () => {
    await createSessionRecord('resume-2', 'task-1', 'proj');
    await updateSessionRecord('resume-2', {
      process_status: 'stopped',
      work_status: 'agent_complete',
    });

    // Upsert without PID (e.g., just updating outputFile)
    const result = await createSessionRecord('resume-2', 'task-1', 'proj', undefined, {
      outputFile: '/tmp/update.jsonl',
    });

    expect(result.process_status).toBe('stopped');
    expect(result.work_status).toBe('agent_complete');
  });

  it('does NOT reset status when session is already running', async () => {
    // Session is still running — PID update should not double-reset
    await createSessionRecord('resume-3', 'task-1', 'proj', undefined, { pid: 11111 });

    const before = await getSessionByClaudeId('resume-3');
    expect(before!.process_status).toBe('running');

    const result = await createSessionRecord('resume-3', 'task-1', 'proj', undefined, { pid: 22222 });
    expect(result.process_status).toBe('running');
    expect(result.work_status).toBe('in_progress');
    expect(result.pid).toBe(22222);
  });
});

describe('getRunningSessionsByHost', () => {
  // Note: isProcessAlive is mocked to return true, so any non-null PID passes liveness check.
  it('groups running sessions by host', async () => {
    await createSessionRecord('local-1', 'task-1', 'proj', undefined, { pid: 1001 });
    await createSessionRecord('local-2', 'task-2', 'proj', undefined, { pid: 1002 });
    await createSessionRecord('remote-1', 'task-3', 'proj', undefined, { host: 'devbox', pid: 2001 });
    await createSessionRecord('remote-2', 'task-4', 'proj', undefined, { host: 'devbox', pid: 2002 });
    await createSessionRecord('remote-3', 'task-5', 'proj', undefined, { host: 'remotehost', pid: 3001 });

    const byHost = await getRunningSessionsByHost();
    expect(byHost['local']).toHaveLength(2);
    expect(byHost['devbox']).toHaveLength(2);
    expect(byHost['remotehost']).toHaveLength(1);
  });

  it('excludes stopped sessions', async () => {
    await createSessionRecord('s1', 'task-1', 'proj', undefined, { pid: 1001 });
    await updateSessionRecord('s1', { process_status: 'stopped' });
    await createSessionRecord('s2', 'task-2', 'proj', undefined, { pid: 1002 });

    const byHost = await getRunningSessionsByHost();
    expect(byHost['local']).toHaveLength(1);
    expect(byHost['local']![0].claudeSessionId).toBe('s2');
  });

  it('excludes sessions without a PID', async () => {
    await createSessionRecord('no-pid', 'task-1', 'proj'); // No PID
    await createSessionRecord('has-pid', 'task-2', 'proj', undefined, { pid: 1001 });

    const byHost = await getRunningSessionsByHost();
    expect(byHost['local']).toHaveLength(1);
    expect(byHost['local']![0].claudeSessionId).toBe('has-pid');
  });

  it('returns empty object when no running sessions', async () => {
    const byHost = await getRunningSessionsByHost();
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
  it('only counts in_progress sessions', async () => {
    // Active (in_progress) — should be counted
    await createSessionRecord('active-1', 't1', 'p', undefined, { pid: 1001 });
    await createSessionRecord('active-2', 't2', 'p', undefined, { pid: 1002 });

    // Idle (agent_complete) — should NOT be counted
    await createSessionRecord('idle-1', 't3', 'p', undefined, { pid: 1003 });
    await updateSessionRecord('idle-1', { work_status: 'agent_complete' });

    // Idle (await_human_action) — should NOT be counted
    await createSessionRecord('idle-2', 't4', 'p', undefined, { pid: 1004 });
    await updateSessionRecord('idle-2', { work_status: 'await_human_action' });

    const byHost = await getActiveSessionsByHost();
    expect(byHost['local']).toHaveLength(2);
    expect(byHost['local']!.map(s => s.claudeSessionId).sort()).toEqual(['active-1', 'active-2']);
  });

  it('returns empty when all sessions are idle', async () => {
    await createSessionRecord('s1', 't1', 'p', undefined, { pid: 1001 });
    await updateSessionRecord('s1', { work_status: 'agent_complete' });

    const byHost = await getActiveSessionsByHost();
    expect(byHost).toEqual({});
  });
});

describe('getAllAliveSessionsByHost', () => {
  it('counts all alive sessions regardless of work_status', async () => {
    await createSessionRecord('active-1', 't1', 'p', undefined, { pid: 1001 });
    await createSessionRecord('idle-1', 't2', 'p', undefined, { pid: 1002 });
    await updateSessionRecord('idle-1', { work_status: 'agent_complete' });
    await createSessionRecord('idle-2', 't3', 'p', undefined, { pid: 1003 });
    await updateSessionRecord('idle-2', { work_status: 'await_human_action' });

    const byHost = await getAllAliveSessionsByHost();
    expect(byHost['local']).toHaveLength(3);
  });
});

describe('checkSessionLimit — idle sessions do not block', () => {
  it('allows new session when active limit not reached, even with many idle sessions', async () => {
    // 1 active session
    await createSessionRecord('active-1', 't1', 'p', undefined, { pid: 1001 });

    // 6 idle sessions (agent_complete) — these used to block at limit=7
    for (let i = 2; i <= 7; i++) {
      await createSessionRecord(`idle-${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`idle-${i}`, { work_status: 'agent_complete' });
    }

    const result = await checkSessionLimit(undefined, { local: 7 });
    expect(result.allowed).toBe(true);
    expect(result.running).toBe(1); // Only 1 active
    expect(result.totalAlive).toBe(7); // 7 total alive processes
  });

  it('blocks only when active (in_progress) sessions reach the limit', async () => {
    // 7 active sessions
    for (let i = 1; i <= 7; i++) {
      await createSessionRecord(`active-${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
    }

    const result = await checkSessionLimit(undefined, { local: 7 });
    expect(result.allowed).toBe(false);
    expect(result.running).toBe(7);
  });

  it('await_human_action sessions do not count as active', async () => {
    await createSessionRecord('phr-1', 't1', 'p', undefined, { pid: 1001 });
    await updateSessionRecord('phr-1', { work_status: 'await_human_action' });

    const result = await checkSessionLimit(undefined, { local: 1 });
    expect(result.allowed).toBe(true);
    expect(result.running).toBe(0);
  });
});

describe('checkSessionLimit — idle limit with eviction', () => {
  it('evicts oldest idle session when idle count reaches max_idle', async () => {
    // Create 6 sessions — all idle (migration will set process_status='idle').
    // Use max_idle=5 so 6 idle sessions triggers eviction.
    for (let i = 1; i <= 6; i++) {
      await createSessionRecord(`s${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`s${i}`, { work_status: 'agent_complete' });
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
    // 5 sessions — at the max_idle=5 cap but not over
    for (let i = 1; i <= 4; i++) {
      await createSessionRecord(`s${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`s${i}`, { work_status: 'agent_complete' });
    }

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 5 });
    expect(result.allowed).toBe(true);
    expect(result.evicted).toBeUndefined();
  });

  it('returns idleCount and maxIdle in result', async () => {
    for (let i = 1; i <= 3; i++) {
      await createSessionRecord(`s${i}`, `t${i}`, 'p', undefined, { pid: 1000 + i });
      await updateSessionRecord(`s${i}`, { work_status: 'agent_complete' });
    }

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 10 });
    expect(result.idleCount).toBe(3);
    expect(result.maxIdle).toBe(10);
  });
});

describe('legacy status migration', () => {
  it('migrates old status field to process_status/work_status on read', async () => {
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
    expect(sessions[0].work_status).toBe('agent_complete'); // idle → agent_complete
    expect(sessions[0]).not.toHaveProperty('status');
  });
});
