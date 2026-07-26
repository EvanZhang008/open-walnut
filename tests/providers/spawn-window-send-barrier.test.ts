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
 * What's real: ClaudeCodeSession.send()'s spawn sequencing + awaitSpawn().
 * What's mocked: the transport (a deliberately SLOW start, so the window is
 * observable) and the session record persistence.
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
    writeMessage: async () => { calls.push('writeMessage'); return true; },
    writeRaw: async () => true,
    writeSyntheticUserEvent: () => {},
    renameForSession: () => {},
    deletePipe: () => { calls.push('deletePipe'); },
    detach: () => { calls.push('detach'); },
    stop: async () => { calls.push('stop'); },
    kill: () => { calls.push('kill'); },
    flushTail: () => {},
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

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';

beforeEach(() => {
  calls.length = 0;
  releaseStart = null;
});

describe('spawn window — awaitSpawn() barrier', () => {
  it('a send during the spawn window waits instead of stopping the booting CLI', async () => {
    const session = new ClaudeCodeSession('task-spawn-window', 'Proj', 'claude');
    const preassignedSessionId = '11111111-2222-4333-8444-555555555555';

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
