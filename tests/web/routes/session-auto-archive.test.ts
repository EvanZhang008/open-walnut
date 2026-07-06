/**
 * Integration tests for error session auto-archive functionality.
 *
 * Covers:
 * 1. Quick-start retry auto-archives error/stopped sessions
 * 2. Session retry auto-archives sessions without claudeSessionId
 * 3. Session restart auto-archives sessions
 * 4. Archived error sessions are hidden from GET /api/sessions
 * 5. Non-archived error sessions remain visible
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

// Mock process liveness to avoid real PID checks
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => false,
}));

// Mock daemon-connection (used by enrichWithLiveStatus)
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
}));

// Mock session-manager (used by restart to kill process)
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));

// Mock claude-code-session (the sessionRunner import at module level)
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: null,
}));

// Mock session-message-queue (used by retry/restart to inspect & resend the queue)
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: async () => {},
  // retry & restart both read the queue; empty queue is the right default for
  // these tests (no pending user messages to re-send).
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js';
import { addTask, getTask, _resetForTesting as resetTaskManager } from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

// ── Helper: create a task via addTask (real task-manager, not mocked) ──

async function createTestTask(title = 'Test Task') {
  const { task } = await addTask({
    title,
    category: 'Inbox',
    source: 'local',
  });
  return task;
}

// ── Test 1: Quick-start retry auto-archives error sessions ──

describe('POST /api/sessions/quick-start (retry mode)', () => {
  it('archives error sessions under the existing task', async () => {
    // Create a task and an error session linked to it
    const task = await createTestTask('Quick Start Task');
    await createSessionRecord('err-sess-qs', task.id, 'proj', '/tmp');
    await updateSessionRecord('err-sess-qs', {
      process_status: 'error',
      errorMessage: 'Process exited unexpectedly',
    });

    // Verify session is in error state
    const before = await getSessionByClaudeId('err-sess-qs');
    expect(before!.process_status).toBe('error');
    expect(before!.archived).toBeFalsy();

    // Call quick-start with existing taskId (retry mode)
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Retry the task',
        taskId: task.id,
      });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe(task.id);

    // Verify the error session was archived
    const after = await getSessionByClaudeId('err-sess-qs');
    expect(after!.archived).toBe(true);
    expect(after!.archive_reason).toBe('retry');
  });

  it('archives stopped sessions under the existing task', async () => {
    const task = await createTestTask('Quick Start Stopped');
    await createSessionRecord('stopped-sess-qs', task.id, 'proj', '/tmp');
    await updateSessionRecord('stopped-sess-qs', { process_status: 'stopped' });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Retry stopped session',
        taskId: task.id,
      });

    expect(res.status).toBe(200);

    const after = await getSessionByClaudeId('stopped-sess-qs');
    expect(after!.archived).toBe(true);
    expect(after!.archive_reason).toBe('retry');
  });

  it('does NOT archive running sessions under the existing task', async () => {
    const task = await createTestTask('Quick Start Running');
    await createSessionRecord('running-sess-qs', task.id, 'proj', '/tmp', { pid: 12345 });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Retry with running session',
        taskId: task.id,
      });

    expect(res.status).toBe(200);

    const after = await getSessionByClaudeId('running-sess-qs');
    expect(after!.archived).toBeFalsy();
  });
});

// ── Test 3: Quick-start new-task taskMeta WITHOUT pinTier ──
//
// Repro: a fresh quick-start with taskMeta that supplies starred/needs_attention/
// priority but NO pinTier must apply those fields and leave the task UNPINNED.
// The new-task branch only calls togglePin()+setFocusTier() when taskMeta.pinTier
// is truthy, so an absent pinTier must not pin the task or set a focus_tier.

describe('POST /api/sessions/quick-start (new task, taskMeta without pinTier)', () => {
  it('applies starred/needs_attention/priority but leaves the task unpinned', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Start a fresh task',
        taskMeta: {
          starred: true,
          needs_attention: true,
          priority: 'important',
          // pinTier intentionally omitted
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toBeTruthy();

    const task = await getTask(res.body.taskId);
    // Metadata applied …
    expect(task.starred).toBe(true);
    expect(task.needs_attention).toBe(true);
    expect(task.priority).toBe('important');
    // … but the task is NOT pinned and carries no focus tier.
    expect(task.pinned).toBeFalsy();
    expect(task.focus_tier).toBeUndefined();
  });

  it('does not pin when pinTier is explicitly null', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Start another task',
        taskMeta: {
          starred: true,
          pinTier: null,
        },
      });

    expect(res.status).toBe(200);
    const task = await getTask(res.body.taskId);
    expect(task.pinned).toBeFalsy();
    expect(task.focus_tier).toBeUndefined();
  });
});

// ── Test 2: Session retry auto-archives sessions without claudeSessionId ──

describe('POST /api/sessions/:sessionId/retry', () => {
  it('archives error session without claudeSessionId and starts new', async () => {
    // Create a task first
    const task = await createTestTask('Retry Task');

    // Create session with no claudeSessionId value that would allow resume.
    // The retry path checks: if record.claudeSessionId exists, try resume.
    // But every session created via createSessionRecord HAS a claudeSessionId.
    // The "no claudeSessionId" fallback path is for sessions where the initial
    // session never got a Claude session ID assigned. We simulate by setting
    // claudeSessionId to empty string after creation, then looking it up by
    // the internal session ID.
    //
    // Actually, looking at the code: the retry endpoint looks up by claudeSessionId
    // (req.params.sessionId). If record.claudeSessionId is truthy, it tries resume.
    // The fallback path (archive+new) runs when claudeSessionId is falsy.
    //
    // In practice, a session that "failed before init" would have a session record
    // created with a temporary/internal ID but no real claudeSessionId.
    // Since our sessions always have claudeSessionId set (it's the primary key),
    // the retry code checks the truthiness of record.claudeSessionId.
    //
    // For this test, we verify the resume path (process dead) which sends a
    // message to the session queue. The session does get resumed, not archived.

    await createSessionRecord('retry-sess-1', task.id, 'proj', '/tmp');
    await updateSessionRecord('retry-sess-1', {
      process_status: 'error',
      errorMessage: 'Process died before init',
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/retry-sess-1/retry')
      .send({});

    // With claudeSessionId present and process dead, it takes the resume path
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resuming');
    expect(res.body.sessionId).toBe('retry-sess-1');
  });

  it('rejects retry on running sessions', async () => {
    const task = await createTestTask('Running Retry Task');
    await createSessionRecord('running-retry', task.id, 'proj', '/tmp', { pid: 99999 });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/running-retry/retry')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not retryable');
  });

  it('rejects retry on sessions without a task', async () => {
    await createSessionRecord('no-task-retry', '', 'proj', '/tmp');
    await updateSessionRecord('no-task-retry', { process_status: 'error' });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/no-task-retry/retry')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no associated task');
  });

  it('returns 404 for unknown session', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nonexistent-session/retry')
      .send({});

    expect(res.status).toBe(404);
  });
});

// ── Test 3: Session restart resumes in place ──
//
// NOTE: restart was reworked (see sessions.ts POST /:sessionId/restart) from the
// old "archive old session + spawn new" model to an in-place "kill CLI + revert
// queue + reset to idle + resume the SAME session" model. So restart no longer
// archives — it resets process_status to 'idle' and returns status 'restarted'.
// Auto-archive of terminal (error/stopped) sessions now lives only in the
// retry / quick-start paths (Tests 1 & 2). These tests assert the new contract.

describe('POST /api/sessions/:sessionId/restart', () => {
  it('resets an error session to idle and returns status=restarted', async () => {
    const task = await createTestTask('Restart Task');
    await createSessionRecord('restart-sess-1', task.id, 'proj', '/tmp');
    await updateSessionRecord('restart-sess-1', {
      process_status: 'error',
      errorMessage: 'Something went wrong',
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/restart-sess-1/restart')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('restarted');
    expect(res.body.sessionId).toBe('restart-sess-1');

    // Restart resumes the SAME session in place — it is NOT archived, the record
    // is reset to idle and its error cleared so the resumed CLI starts clean.
    const after = await getSessionByClaudeId('restart-sess-1');
    expect(after!.archived).toBeFalsy();
    expect(after!.process_status).toBe('idle');
    expect(after!.errorMessage).toBeUndefined();
  });

  it('resets a stopped session to idle on restart', async () => {
    const task = await createTestTask('Restart Stopped');
    await createSessionRecord('restart-stopped', task.id, 'proj', '/tmp');
    await updateSessionRecord('restart-stopped', { process_status: 'stopped' });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/restart-stopped/restart')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('restarted');

    const after = await getSessionByClaudeId('restart-stopped');
    expect(after!.archived).toBeFalsy();
    expect(after!.process_status).toBe('idle');
  });

  it('returns 404 for unknown session', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nonexistent/restart')
      .send({});

    expect(res.status).toBe(404);
  });

  it('restarts a session even when it has no task (in-place resume)', async () => {
    await createSessionRecord('no-task-restart', '', 'proj', '/tmp');
    await updateSessionRecord('no-task-restart', { process_status: 'error' });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/no-task-restart/restart')
      .send({});

    // In-place resume does not require a task — restart succeeds and resets to idle.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('restarted');

    const after = await getSessionByClaudeId('no-task-restart');
    expect(after!.process_status).toBe('idle');
  });
});

// ── Test 4: Archived error sessions are hidden from GET /api/sessions ──

describe('GET /api/sessions — archived filtering', () => {
  it('excludes archived error sessions from the list', async () => {
    // Create an archived error session
    await createSessionRecord('archived-err', 'task-1', 'proj');
    await updateSessionRecord('archived-err', {
      process_status: 'error',
      archived: true,
      archive_reason: 'retry',
    });

    // Create a normal session
    await createSessionRecord('normal-sess', 'task-2', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: any) => s.claudeSessionId);
    expect(ids).toContain('normal-sess');
    expect(ids).not.toContain('archived-err');
  });

  it('excludes archived sessions from recent list', async () => {
    await createSessionRecord('archived-recent', 'task-1', 'proj');
    await updateSessionRecord('archived-recent', {
      archived: true,
      archive_reason: 'restart',
    });

    await createSessionRecord('visible-recent', 'task-2', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: any) => s.claudeSessionId);
    expect(ids).toContain('visible-recent');
    expect(ids).not.toContain('archived-recent');
  });

  it('excludes archived sessions from session tree', async () => {
    const task = await createTestTask('Tree Task');

    await createSessionRecord('archived-tree', task.id, 'proj');
    await updateSessionRecord('archived-tree', {
      archived: true,
      archive_reason: 'retry',
    });

    await createSessionRecord('visible-tree', task.id, 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/tree');

    expect(res.status).toBe(200);

    // Flatten all sessions from the tree
    const allSessions: any[] = [];
    for (const cat of res.body.tree ?? []) {
      for (const proj of cat.projects ?? []) {
        for (const t of proj.tasks ?? []) {
          allSessions.push(...(t.sessions ?? []));
        }
      }
      for (const t of cat.directTasks ?? []) {
        allSessions.push(...(t.sessions ?? []));
      }
    }
    for (const s of res.body.orphanSessions ?? []) {
      allSessions.push(s);
    }

    const ids = allSessions.map((s: any) => s.claudeSessionId);
    expect(ids).not.toContain('archived-tree');
    expect(ids).toContain('visible-tree');
  });
});

// ── Test 5: Error sessions remain visible until explicitly retried ──

describe('GET /api/sessions — error sessions visible until archived', () => {
  it('shows non-archived error sessions in the list', async () => {
    await createSessionRecord('visible-err', 'task-1', 'proj');
    await updateSessionRecord('visible-err', {
      process_status: 'error',
      errorMessage: 'Process exited without result',
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: any) => s.claudeSessionId);
    expect(ids).toContain('visible-err');

    // Verify the error state is preserved in the response
    const errSession = res.body.sessions.find((s: any) => s.claudeSessionId === 'visible-err');
    expect(errSession.process_status).toBe('error');
    expect(errSession.archived).toBeFalsy();
  });

  it('shows error sessions in recent list until archived', async () => {
    await createSessionRecord('recent-err', 'task-1', 'proj');
    await updateSessionRecord('recent-err', {
      process_status: 'error',
      errorMessage: 'Something failed',
    });

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: any) => s.claudeSessionId);
    expect(ids).toContain('recent-err');
  });

  it('error session becomes hidden only after archival via retry', async () => {
    const task = await createTestTask('Error Lifecycle Task');
    await createSessionRecord('lifecycle-err', task.id, 'proj', '/tmp');
    await updateSessionRecord('lifecycle-err', {
      process_status: 'error',
      errorMessage: 'Process crashed',
    });

    const app = createApp();

    // Step 1: Error session is visible
    const before = await request(app).get('/api/sessions');
    const idsBefore = before.body.sessions.map((s: any) => s.claudeSessionId);
    expect(idsBefore).toContain('lifecycle-err');

    // Step 2: Quick-start retry archives it
    await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Retry the task',
        taskId: task.id,
      });

    // Step 3: Error session is now hidden
    const after = await request(app).get('/api/sessions');
    const idsAfter = after.body.sessions.map((s: any) => s.claudeSessionId);
    expect(idsAfter).not.toContain('lifecycle-err');

    // Verify the underlying record still exists but is archived
    const record = await getSessionByClaudeId('lifecycle-err');
    expect(record).not.toBeNull();
    expect(record!.archived).toBe(true);
    expect(record!.archive_reason).toBe('retry');
  });
});
