/**
 * REGRESSION: a message typed while the CLI is still spawning must WAIT for the
 * spawn, not respawn over it.
 *
 * Context: the session panel is now interactive the moment the session id is
 * minted — which is BEFORE the `claude` process exists (quick-start/fork
 * pre-assign the id and pass it as `--session-id`). So there is a real window,
 * seconds wide over SSH, in which the user can type into a session whose
 * transport is still starting.
 *
 * The bug this guards: delivery read `hasPipe === false` on a session that was
 * merely still booting, concluded "no live pipe", and took the recovery branch
 * (`gracefulStop()` + `--resume` respawn). That SIGINTs the CLI mid-boot, losing
 * the first turn — and because the stop/respawn races the CLI's own startup, the
 * session could come back under a different id than the panel is keyed to.
 *
 * The fix: `send()` publishes a `_spawnSettled` barrier before awaiting the
 * spawn; `awaitSpawn()` exposes it, and the delivery paths await it first.
 *
 * What's real: ClaudeCodeSession.send(), awaitSpawn(), and isolated SQLite persistence.
 * What's mocked: the transport and cwd pre-flight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-spawn-barrier'));

/** Records the order of transport lifecycle calls so we can assert no
 *  stop()/respawn happened while the first start() was still in flight. */
const calls: string[] = [];
/** Resolves the pending transport.start() — the test controls spawn duration. */
let releaseStart: (() => void) | null = null;

vi.mock('../../src/providers/session-manager.js', () => ({
  createSessionManager: () => ({
    start: async () => {
      calls.push('start');
      await new Promise<void>((resolve) => { releaseStart = resolve; });
      calls.push('start:resolved');
      return { pid: 4242, outputFile: '/tmp/spawn-barrier.jsonl', fileSize: 0 };
    },
    writeMessage: async (_message: string, opts?: { onDispatch?: () => void }) => { opts?.onDispatch?.(); calls.push('writeMessage'); return true; },
    writeRaw: async () => true,
    writeSyntheticUserEvent: () => {},
    renameForSession: () => {},
    deletePipe: () => { calls.push('deletePipe'); },
    detach: () => { calls.push('detach'); },
    stop: async () => { calls.push('stop'); },
    kill: () => { calls.push('kill'); },
    flushTail: () => {},
    stopTail: () => {},
    startMonitoring: () => {},
    stopMonitoring: () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 4242,
    outputFile: '/tmp/spawn-barrier.jsonl',
  }),
  registerSessionManager: () => {},
  unregisterSessionManager: () => {},
  getRegisteredSessionManager: () => null,
}));

// cwd pre-flight must pass so we reach transport.start().
vi.mock('../../src/utils/cwd-check.js', () => ({
  checkCwdExists: async () => ({ ok: true }),
}));

import { ClaudeCodeSession, SessionRunner, sessionRunner } from '../../src/providers/claude-code-session.js';
import * as tracker from '../../src/core/session-tracker.js';
import type { SessionRecord } from '../../src/core/types.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { deleteMessage, getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js';
import { log } from '../../src/logging/index.js';

beforeEach(() => {
  calls.length = 0;
  releaseStart = null;
});

describe('spawn window — awaitSpawn() barrier', () => {
  it.each(['awaiting_spawn', 'spawn_outcome_unknown'] as const)('does not cold-resume a seeded %s record', async (reason) => {
    const read = vi.spyOn(tracker, 'getSessionByClaudeId').mockResolvedValue({
      claudeSessionId: 'seeded', taskId: 'task-seeded', process_status: 'idle', status_reason: reason,
    } as SessionRecord);
    const attach = vi.spyOn(sessionRunner as any, 'maybeAttachAcpSession');
    try {
      await (sessionRunner as any).processNext('seeded');
      expect(attach).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    } finally {
      read.mockRestore();
      attach.mockRestore();
    }
  });
  it('a send during the spawn window waits instead of stopping the booting CLI', async () => {
    const session = new ClaudeCodeSession('task-spawn-window', 'Proj', 'claude');
    const preassignedSessionId = '11111111-2222-4333-8444-555555555555';
    await tracker.createSessionRecord(preassignedSessionId, 'task-spawn-window', 'Proj', undefined, {
      initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });

    // Start a fresh session (fire-and-forget, like the real SESSION_START path).
    session.send(
      'first turn', '/tmp', undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, false, undefined, undefined, undefined,
      undefined, { preassignedSessionId },
    );

    // The id is usable IMMEDIATELY — this is what lets the panel mount at once.
    expect(session.sessionId).toBe(preassignedSessionId);

    // Spawn is in flight and has NOT resolved yet.
    await vi.waitFor(() => expect(calls).toContain('start'));
    expect(calls).not.toContain('start:resolved');

    // User types in that window. awaitSpawn() must not resolve yet...
    let sendUnblocked = false;
    const pendingSend = session.awaitSpawn().then(() => { sendUnblocked = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(sendUnblocked).toBe(false);

    // ...and crucially, nothing has torn down the still-booting process.
    expect(calls).not.toContain('stop');
    expect(calls).not.toContain('kill');

    // Spawn lands → the barrier releases so the queued text can be delivered.
    releaseStart!();
    await pendingSend;
    expect(sendUnblocked).toBe(true);
    expect(calls).toContain('start:resolved');
    // Still exactly ONE spawn: the typed message rode the original process.
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    await session.sessionReady;
    expect(await tracker.getSessionByClaudeId(preassignedSessionId)).toMatchObject({
      pid: 4242, process_status: 'running', status_reason: 'session_started',
    });
    session.detach();
  });

  it('an init-only reserved spawn stays idle when the transport confirms its PID', async () => {
    const session = new ClaudeCodeSession('task-spawn-parked', 'Proj', 'claude');
    const preassignedSessionId = '33333333-4444-4555-8666-777777777777';
    await tracker.createSessionRecord(preassignedSessionId, 'task-spawn-parked', 'Proj', undefined, {
      initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });
    session.send(
      '', '/tmp', undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, false, undefined, undefined, undefined,
      undefined, { preassignedSessionId },
    );
    await vi.waitFor(() => expect(calls).toContain('start'));
    releaseStart!();
    await session.sessionReady;
    try {
      expect(await tracker.getSessionByClaudeId(preassignedSessionId)).toMatchObject({
        pid: 4242, process_status: 'idle', status_reason: 'session_started',
      });
      expect(calls).not.toContain('stop');
      expect(calls).not.toContain('kill');
    } finally {
      session.detach();
    }
  });

  // REGRESSION 2026-10-02: the phone minted a lane with no first message (record
  // seeded `awaiting_spawn`), and its relayed turn queued a message ~70 ms later.
  // processNext saw the unconfirmed spawn and returned; the CLI came up 100 ms
  // after that, but only startSession() drained the queue once ready, never the
  // bus SESSION_START path, so the message sat queued until a daemon reconnect
  // 82 minutes later. The drain now lives in handleStart, shared by both paths.
  /** Bus-start an init-only lane spawn, queue a send while it is unconfirmed, then
   *  land the spawn. Returns what was delivered and the queued id. */
  async function sendDuringBusStartedSpawn(sid: string, info: { mock: { calls: unknown[][] } }) {
    const deliveredIds: string[] = [];
    bus.subscribe(`test-spawn-window-delivered-${sid}`, (e) => {
      const d = e.data as { sessionId?: string; messageIds?: string[] };
      if (d.sessionId === sid) deliveredIds.push(...(d.messageIds ?? []));
    }, { global: true, interest: [EventNames.SESSION_MESSAGES_DELIVERED] });
    await tracker.createSessionRecord(sid, '', '', '/tmp', {
      lane: 'test-spawn-window-lane', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    });
    bus.emit(EventNames.SESSION_START, {
      taskId: '', message: '', cwd: '/tmp', lane: 'test-spawn-window-lane', preassignedSessionId: sid,
    }, ['session-runner'], { source: 'test' });
    await vi.waitFor(() => expect(calls).toContain('start'), { timeout: 5000 });

    // The relayed turn's message arrives while the spawn is still in flight.
    const queued = await sendMessageToSession(sid, 'hello from the phone', { source: 'test' });
    await vi.waitFor(() => expect(info.mock.calls.some(([msg, meta]) =>
      msg === 'processNext: waiting for initial spawn confirmation'
      && (meta as { sessionId?: string } | undefined)?.sessionId === sid)).toBe(true), { timeout: 5000 });
    expect(calls).not.toContain('writeMessage');
    expect((await getQueue(sid)).map((m) => [m.id, m.status])).toEqual([[queued.id, 'pending']]);
    releaseStart!();
    return { deliveredIds, queuedId: queued.id };
  }

  function newRunner(): InstanceType<typeof SessionRunner> {
    const runner = new SessionRunner('claude');
    // Skips the local-daemon ensure; the transport itself is the mock above.
    runner.setTestDaemonUrl('ws://127.0.0.1:1');
    runner.init();
    return runner;
  }

  it('a message queued while a bus-started init-only spawn is unconfirmed is delivered once it lands', async () => {
    const sid = '44444444-5555-4666-8777-888888888888';
    const runner = newRunner();
    const info = vi.spyOn(log.session, 'info');
    try {
      const { deliveredIds, queuedId } = await sendDuringBusStartedSpawn(sid, info);
      // The spawn landed: the queued message goes out over the fresh FIFO, with no
      // reconnect, no extra spawn, and exactly once.
      await vi.waitFor(() => expect(deliveredIds).toEqual([queuedId]), { timeout: 3000 });
      expect(info.mock.calls.some(([msg]) => msg === 'draining messages queued during the spawn window')).toBe(true);
      expect(calls.filter((c) => c === 'writeMessage')).toHaveLength(1);
      expect(calls.filter((c) => c === 'start')).toHaveLength(1);
      expect(calls).not.toContain('stop');
      await new Promise((r) => setTimeout(r, 200));
      expect(calls.filter((c) => c === 'writeMessage')).toHaveLength(1);
      expect(deliveredIds).toEqual([queuedId]);
    } finally {
      info.mockRestore();
      bus.unsubscribe(`test-spawn-window-delivered-${sid}`);
      runner.destroy();
    }
  });

  it('control: without the post-ready drain the same message stays stranded (the incident)', async () => {
    const sid = '55555555-6666-4777-8888-999999999999';
    const drain = vi.spyOn(SessionRunner.prototype as never, 'drainQueuedAfterSpawn' as never)
      .mockImplementation((async () => {}) as never);
    const runner = newRunner();
    const info = vi.spyOn(log.session, 'info');
    let queued: string | undefined;
    try {
      const { deliveredIds, queuedId } = await sendDuringBusStartedSpawn(sid, info);
      queued = queuedId;
      await vi.waitFor(() => expect(drain).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 500));
      expect(deliveredIds).toEqual([]);
      expect(calls).not.toContain('writeMessage');
      expect((await getQueue(sid)).map((m) => [m.id, m.status])).toEqual([[queuedId, 'pending']]);
    } finally {
      drain.mockRestore();
      info.mockRestore();
      bus.unsubscribe(`test-spawn-window-delivered-${sid}`);
      runner.destroy();
      // A pending row would be picked up by a later runner's startup recovery.
      if (queued) await deleteMessage(sid, queued);
    }
  });

  it('awaitSpawn() is a no-op once the transport is up', async () => {
    const session = new ClaudeCodeSession('task-spawn-settled', 'Proj', 'claude');
    session.send(
      'first turn', '/tmp', undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, false, undefined, undefined, undefined,
      undefined, { preassignedSessionId: '99999999-8888-4777-8666-555555555555' },
    );
    await vi.waitFor(() => expect(calls).toContain('start'));
    releaseStart!();
    await vi.waitFor(() => expect(calls).toContain('start:resolved'));

    // Already settled → resolves promptly, no hang for later turns.
    await expect(Promise.race([
      session.awaitSpawn().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('timeout'), 500)),
    ])).resolves.toBe('settled');
  });

  it('the barrier never rejects — a waiting send must not raise, only proceed', async () => {
    const session = new ClaudeCodeSession('task-spawn-failed', 'Proj', 'claude');
    session.send(
      'first turn', '/tmp', undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, false, undefined, undefined, undefined,
      undefined, { preassignedSessionId: '22222222-3333-4444-8555-666666666666' },
    );
    await vi.waitFor(() => expect(calls).toContain('start'));

    // Wait BEFORE the spawn settles — this is the real ordering (user types during
    // the window), and it proves the barrier is swallow-only: `.then(noop, noop)`.
    // If it ever propagated a spawn rejection, this await would throw inside
    // processNext and the queued message would vanish with an unhandled error.
    const waiter = session.awaitSpawn().then(() => 'settled', () => 'rejected');
    releaseStart!();

    await expect(Promise.race([
      waiter,
      new Promise((r) => setTimeout(() => r('timeout'), 1000)),
    ])).resolves.toBe('settled');
  });
});
