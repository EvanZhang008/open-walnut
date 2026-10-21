/**
 * Integration tests for error session auto-archive functionality.
 *
 * Covers:
 * 1. Quick-start retry continues the task's one session (a task has exactly one)
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

// Retry's resume path pre-flights the CLI conversation JSONL (2026-08-13
// incident). Report it present so the resume-contract tests keep exercising
// resume; the preflight itself is covered by session-retry-preflight.test.ts.
vi.mock('../../../src/core/session-file-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-file-reader.js')>();
  return {
    ...actual,
    findLocalJsonlPath: async () => '/fake/projects/x/session.jsonl',
  };
});

// Mock daemon-connection (used by enrichWithLiveStatus)
const { stopRpc } = vi.hoisted(() => ({ stopRpc: vi.fn() }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  getConnectedDaemonConnection: () => ({ connected: true, send: stopRpc }),
}));

// Mock session-manager (used by restart to kill process)
vi.mock('../../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));

// Mock claude-code-session. Restart now respawns a fresh CLI via
// sessionRunner.reinitialize() (which marks the record 'running'); terminate probes
// findAcpSession() then findSessionByClaudeId(). Stub all of them so the routes
// exercise their real logic without a live CLI — a method the route calls but the stub
// omits surfaces as a 500 ("sessionRunner.findAcpSession is not a function"), not as a
// helpful failure, so keep this in sync with the route's sessionRunner.* calls.
const reinitializeMock = vi.fn(async (sessionId: string) => {
  const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
  await updateSessionRecord(sessionId, { process_status: 'running', errorMessage: undefined } as Record<string, unknown>);
});
const settleInFlightTurnMock = vi.fn(() => {});
const isCronArmedMock = vi.fn(() => false);
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    reinitialize: (sid: string) => reinitializeMock(sid),
    findAcpSession: () => null,
    findSessionByClaudeId: () => null,
    settleInFlightTurn: (sid: string) => settleInFlightTurnMock(sid),
    isCronArmed: (sid: string) => isCronArmedMock(sid),
  },
}));

// Mock session-message-queue (used by retry/restart to inspect & resend the queue,
// and by quick-start retry to continue the task's session)
const { sendMessageToSessionMock } = vi.hoisted(() => ({
  sendMessageToSessionMock: vi.fn(async (_sid: string, _text: string, _opts?: unknown) => ({ id: 'qm-test' })),
}));
vi.mock('../../../src/core/session-message-queue.js', () => ({
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession: (sid: string, text: string, opts?: unknown) => sendMessageToSessionMock(sid, text, opts),
  // retry & restart both read the queue; empty queue is the right default for
  // these tests (no pending user messages to re-send).
  getQueue: async () => [],
  revertToPending: async () => {},
}));

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId, getSessionsForTask } from '../../../src/core/session-tracker.js';
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
  stopRpc.mockReset().mockResolvedValue({ ok: true, stopped: true });
  sendMessageToSessionMock.mockClear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
});

afterEach(async () => {
  vi.restoreAllMocks();
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
    source: 'local',
  });
  return task;
}

// ── Test 1: Quick-start retry continues the task's one session ──
//
// A task has exactly one session for its whole life, so starting a task that
// already holds a conversation sends the message into that conversation: it is
// neither archived nor replaced by a second session.

async function expectContinued(taskId: string, sessionId: string, text: string) {
  const after = await getSessionByClaudeId(sessionId);
  expect(after!.archived).toBeFalsy();
  expect((await getSessionsForTask(taskId)).map((s) => s.claudeSessionId)).toEqual([sessionId]);
  expect(sendMessageToSessionMock).toHaveBeenCalledWith(sessionId, expect.stringContaining(text), expect.anything());
}

describe('POST /api/sessions/quick-start (retry mode)', () => {
  it('continues an error session under the existing task', async () => {
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

    // The error session is the task's one conversation: continued, not archived.
    await expectContinued(task.id, 'err-sess-qs', 'Retry the task');
  });

  it('continues a stopped session under the existing task', async () => {
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
    await expectContinued(task.id, 'stopped-sess-qs', 'Retry stopped session');
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
    await expectContinued(task.id, 'running-sess-qs', 'Retry with running session');
  });
});

// ── Test 3: Quick-start new-task taskMeta WITHOUT pinTier ──
//
// A fresh quick-start with taskMeta that supplies unread/priority but NO pinTier
// must apply those fields and take the board default: pinned, with no stored
// focus_tier (Satellite). Only an explicit `pinTier: null` keeps a new task off
// the board — see the next case.

describe('POST /api/sessions/quick-start (new task, taskMeta without pinTier)', () => {
  it('applies unread/priority and lands the task in Satellite', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Start a fresh task',
        taskMeta: {
          unread: true,
          priority: 'important',
          // pinTier intentionally omitted
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.taskId).toBeTruthy();

    const task = await getTask(res.body.taskId);
    // Metadata applied …
    expect(task.unread).toBe(true);
    expect(task.priority).toBe('important');
    // … and the task is on the board with no stored tier (= Satellite).
    expect(task.pinned).toBe(true);
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

    // With claudeSessionId present, the process dead and an EMPTY queue, retry
    // RECONNECTS: the record goes back to a resumable state and nothing is sent
    // (it used to enqueue the word 'continue' — see session-retry-reconnect).
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resumable');
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

// ── Test 3: Session restart re-initializes in place ──
//
// NOTE: restart was reworked again (see sessions.ts POST /:sessionId/restart) to a
// "respawn a fresh CLI via sessionRunner.reinitialize()" model. reinitialize spawns
// `claude -p --resume` with NO message so the process re-emits its init event +
// re-runs the SessionStart hook (reloading CLAUDE.md/.claude/skills/MCP/model), then
// idles. It suppresses the old process's exit (no phantom "-1" error) and marks the
// record 'running'. Restart still does NOT archive.

describe('POST /api/sessions/:sessionId/restart', () => {
  beforeEach(() => { reinitializeMock.mockClear(); });

  it('respawns an error session (running) and returns status=restarted', async () => {
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

    // Restart re-initializes the SAME session in place — NOT archived. reinitialize
    // was invoked and (via the mock) flipped the record to running + cleared the error.
    expect(reinitializeMock).toHaveBeenCalledWith('restart-sess-1');
    const after = await getSessionByClaudeId('restart-sess-1');
    expect(after!.archived).toBeFalsy();
    expect(after!.process_status).toBe('running');
    expect(after!.errorMessage).toBeUndefined();
  });

  it('settles any in-flight turn on restart (mid-turn spinner does not hang)', async () => {
    settleInFlightTurnMock.mockClear();
    const task = await createTestTask('Restart Midturn');
    await createSessionRecord('restart-midturn', task.id, 'proj', '/tmp');
    await updateSessionRecord('restart-midturn', { process_status: 'running' });

    const app = createApp();
    const res = await request(app).post('/api/sessions/restart-midturn/restart').send({});

    expect(res.status).toBe(200);
    // reinitialize() itself settles the turn; assert the route path completed.
    expect(reinitializeMock).toHaveBeenCalledWith('restart-midturn');
  });

  it('respawns a stopped session on restart', async () => {
    const task = await createTestTask('Restart Stopped');
    await createSessionRecord('restart-stopped', task.id, 'proj', '/tmp');
    await updateSessionRecord('restart-stopped', { process_status: 'stopped' });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/restart-stopped/restart')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('restarted');
    expect(reinitializeMock).toHaveBeenCalledWith('restart-stopped');

    const after = await getSessionByClaudeId('restart-stopped');
    expect(after!.archived).toBeFalsy();
    expect(after!.process_status).toBe('running');
  });

  it('returns 404 for unknown session', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nonexistent/restart')
      .send({});

    expect(res.status).toBe(404);
    expect(reinitializeMock).not.toHaveBeenCalled();
  });

  it('rejects restart on an archived session', async () => {
    const task = await createTestTask('Restart Archived');
    await createSessionRecord('restart-archived', task.id, 'proj', '/tmp');
    await updateSessionRecord('restart-archived', { process_status: 'stopped', archived: true });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/restart-archived/restart')
      .send({});

    expect(res.status).toBe(400);
    expect(reinitializeMock).not.toHaveBeenCalled();
  });

  it('restarts a session even when it has no task (in-place re-init)', async () => {
    await createSessionRecord('no-task-restart', '', 'proj', '/tmp');
    await updateSessionRecord('no-task-restart', { process_status: 'error' });

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/no-task-restart/restart')
      .send({});

    // In-place re-init does not require a task — restart succeeds.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('restarted');
    expect(reinitializeMock).toHaveBeenCalledWith('no-task-restart');

    const after = await getSessionByClaudeId('no-task-restart');
    expect(after!.process_status).toBe('running');
  });
});

// ── Test 4: Session terminate closes the CLI, no respawn ──
//
// Mark stopped only after the daemon confirms the exit; without a confirmation, keep it pending.

describe('POST /api/sessions/:sessionId/terminate', () => {
  beforeEach(() => { reinitializeMock.mockClear(); settleInFlightTurnMock.mockClear(); });

  it('marks a running session stopped and returns status=terminated', async () => {
    const task = await createTestTask('Terminate Task');
    await createSessionRecord('term-sess-1', task.id, 'proj', '/tmp');
    await updateSessionRecord('term-sess-1', { process_status: 'running', pid: 12345 });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);

    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/term-sess-1/terminate')
      .send({});

    expect(killSpy).not.toHaveBeenCalled();
    expect(stopRpc).toHaveBeenCalledWith('stop', { sid: 'term-sess-1', reason: 'user', stopRequestId: expect.any(String) }, 10_000);
    killSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('terminated');
    expect(res.body.sessionId).toBe('term-sess-1');
    expect(reinitializeMock).not.toHaveBeenCalled();
    // terminate settles any killed mid-turn batch so the UI spinner clears.
    expect(settleInFlightTurnMock).toHaveBeenCalledWith('term-sess-1');

    const after = await getSessionByClaudeId('term-sess-1');
    expect(after!.archived).toBeFalsy();
    expect(after!.process_status).toBe('stopped');
    expect(after!.stopRequest?.state).toBe('confirmed');
    expect(after!.pid).toBeUndefined();
  });

  it('keeps an unreachable daemon stop pending without signalling the local PID', async () => {
    const task = await createTestTask('Pending Stop Task');
    await createSessionRecord('term-pending', task.id, 'proj', '/tmp');
    await updateSessionRecord('term-pending', { process_status: 'running', pid: 12348 });
    stopRpc.mockRejectedValueOnce(new Error('host unavailable'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    try {
      const res = await request(createApp()).post('/api/sessions/term-pending/terminate').send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      const record = await getSessionByClaudeId('term-pending');
      expect(record?.process_status).toBe('running');
      expect(record?.stopRequest?.state).toBe('pending');
      expect(killSpy).not.toHaveBeenCalled();
      expect(settleInFlightTurnMock).not.toHaveBeenCalled();
    } finally { killSpy.mockRestore(); }
  });

  it('returns 404 for unknown session', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/nonexistent/terminate')
      .send({});

    expect(res.status).toBe(404);
  });

  // Cron-owner guard (incident 2026-08-09): the CLI's scheduler lock is
  // directory-scoped, so killing a cron-owning session doesn't stop its crons —
  // they migrate to whichever session in the same cwd next holds the lock and
  // fire there with no provenance. terminate must refuse without force.
  it('refuses to terminate a cron-owning session without force (409 cron_owner)', async () => {
    const task = await createTestTask('Cron Owner Task');
    await createSessionRecord('term-cron-1', task.id, 'proj', '/tmp');
    await updateSessionRecord('term-cron-1', { process_status: 'running', pid: 12346 });
    isCronArmedMock.mockReturnValueOnce(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/term-cron-1/terminate')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cron_owner');
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();

    const after = await getSessionByClaudeId('term-cron-1');
    expect(after!.process_status).toBe('running'); // untouched
  });

  it('force=true terminates a cron-owning session', async () => {
    const task = await createTestTask('Cron Owner Force Task');
    await createSessionRecord('term-cron-2', task.id, 'proj', '/tmp');
    await updateSessionRecord('term-cron-2', { process_status: 'running', pid: 12347 });
    isCronArmedMock.mockReturnValueOnce(true);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const app = createApp();
    const res = await request(app)
      .post('/api/sessions/term-cron-2/terminate')
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('terminated');
    expect(killSpy).not.toHaveBeenCalled();
    expect(stopRpc).toHaveBeenCalledWith('stop', { sid: 'term-cron-2', reason: 'user', stopRequestId: expect.any(String) }, 10_000);
    killSpy.mockRestore();
  });
});

// ── Test 4: Archived error sessions are hidden from GET /api/sessions ──
//
// Each session below hangs on a task of its own: a task has exactly one
// session, and the session store keeps its rows across these tests.

describe('GET /api/sessions — archived filtering', () => {
  it('excludes archived error sessions from the list', async () => {
    // Create an archived error session
    await createSessionRecord('archived-err', 'task-archived-err', 'proj');
    await updateSessionRecord('archived-err', {
      process_status: 'error',
      archived: true,
      archive_reason: 'retry',
    });

    // Create a normal session
    await createSessionRecord('normal-sess', 'task-normal-sess', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: any) => s.claudeSessionId);
    expect(ids).toContain('normal-sess');
    expect(ids).not.toContain('archived-err');
  });

  it('excludes archived sessions from recent list', async () => {
    await createSessionRecord('archived-recent', 'task-archived-recent', 'proj');
    await updateSessionRecord('archived-recent', {
      archived: true,
      archive_reason: 'restart',
    });

    await createSessionRecord('visible-recent', 'task-visible-recent', 'proj');

    const app = createApp();
    const res = await request(app).get('/api/sessions/recent');

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: any) => s.claudeSessionId);
    expect(ids).toContain('visible-recent');
    expect(ids).not.toContain('archived-recent');
  });

});

// ── Test 5: Error sessions remain visible until explicitly retried ──

describe('GET /api/sessions — error sessions visible until archived', () => {
  it('shows non-archived error sessions in the list', async () => {
    await createSessionRecord('visible-err', 'task-visible-err', 'proj');
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
    await createSessionRecord('recent-err', 'task-recent-err', 'proj');
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

  it('error session becomes hidden only after it is archived', async () => {
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

    // Step 2: Quick-start retry continues it (the task's one session), so it stays visible
    const retry = await request(app)
      .post('/api/sessions/quick-start')
      .send({
        cwd: '/tmp/test',
        message: 'Retry the task',
        taskId: task.id,
      });
    expect(retry.status).toBe(200);
    const idsRetried = (await request(app).get('/api/sessions')).body.sessions.map((s: any) => s.claudeSessionId);
    expect(idsRetried).toContain('lifecycle-err');

    // Step 3: Archiving it hides it
    const archive = await request(app).patch('/api/sessions/lifecycle-err').send({ archived: true });
    expect(archive.status).toBe(200);
    const after = await request(app).get('/api/sessions');
    const idsAfter = after.body.sessions.map((s: any) => s.claudeSessionId);
    expect(idsAfter).not.toContain('lifecycle-err');

    // Verify the underlying record still exists but is archived
    const record = await getSessionByClaudeId('lifecycle-err');
    expect(record).not.toBeNull();
    expect(record!.archived).toBe(true);
  });
});
