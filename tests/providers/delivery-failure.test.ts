/**
 * Permanent vs transient delivery-failure classification
 * (src/providers/delivery-failure.ts).
 *
 * The verdict decides whether a failed batch is reverted to 'pending' (retried on
 * every boot and every daemon reconnect, forever) or PARKED. Both directions have
 * a real cost, so this pins the boundary:
 *   - too narrow → a deleted working folder keeps looping and re-notifying
 *     (12-day-old messages re-firing two error cards per deploy)
 *   - too wide → a plain ssh outage strands a message the user must retry by hand
 */
import { describe, it, expect } from 'vitest';
import { BudgetCheckingError, BudgetPausedError, classifyDeliveryFailure, heldByAnotherProcess, holderKindOf, holderPidOf, isPermanentDeliveryFailure, isDaemonCommandOutcomeUnknown, sendMayHaveLanded, SessionHeldElsewhereError } from '../../src/providers/delivery-failure.js';
import { isHeldElsewhereReason } from '../../src/core/sessions/undelivered-requests.js';
import { CwdMissingError } from '../../src/providers/cwd-check.js';
import { SessionStopSupersededError } from '../../src/core/sessions/session-stop.js';

describe('classifyDeliveryFailure — permanent', () => {
  it('parks a budget refusal rather than automatically resuming it on reconnect', () => {
    expect(classifyDeliveryFailure(new BudgetPausedError())).toMatchObject({ kind: 'permanent', code: 'budget_paused' });
    expect(classifyDeliveryFailure(new Error('Daemon start failed: budget_paused'))).toMatchObject({ kind: 'permanent', code: 'budget_paused' });
  });
  it('never parks a send whose budget is still being checked', () => {
    expect(classifyDeliveryFailure(new BudgetCheckingError())).toMatchObject({ kind: 'transient' });
    expect(classifyDeliveryFailure(new Error('Daemon start failed: budget_checking')).kind).toBe('transient');
  });
  it('parks a superseded send rather than resuming it on reconnect', () => {
    expect(classifyDeliveryFailure(new SessionStopSupersededError('Session stopped')))
      .toEqual({ kind: 'permanent', code: 'session_stopped', reason: 'Session stopped' });
    expect(classifyDeliveryFailure(new Error('Session stopped')).kind).toBe('transient');
  });
  it('recognizes the cwd pre-flight error BY CLASS (no string matching needed)', () => {
    const verdict = classifyDeliveryFailure(new CwdMissingError('Working directory no longer exists: /tmp/gone'));
    expect(verdict.kind).toBe('permanent');
    expect(verdict.code).toBe('cwd_missing');
    // The reason is stored on the parked row and shown to the user, so it must
    // still name the directory.
    expect(verdict.reason).toContain('/tmp/gone');
  });

  it('recognizes the same failure arriving as a plain Error (local and remote wording)', () => {
    for (const message of [
      'Working directory no longer exists: /Users/dev/marina',
      'Working directory no longer exists on build-box: /home/dev/marina',
      'Working directory not set',
    ]) {
      expect(classifyDeliveryFailure(new Error(message)).code).toBe('cwd_missing');
    }
  });

  it('treats a session with no record left to --resume as permanent', () => {
    const verdict = classifyDeliveryFailure(new Error('No active session found for session ID: abc-123'));
    expect(verdict.kind).toBe('permanent');
    expect(verdict.code).toBe('session_missing');
  });
});

describe('classifyDeliveryFailure — transient (keeps the current retry behavior)', () => {
  it('leaves every connectivity/resource failure retryable', () => {
    for (const message of [
      'daemon start failed: publickey denied (simulated host outage)',
      'Local daemon not running',
      'ssh: connect to host build-box port 22: Connection refused',
      'daemon command timed out after 45000ms',
      'spawn EMFILE',
      'WebSocket closed before the response was received',
    ]) {
      const verdict = classifyDeliveryFailure(new Error(message));
      expect(verdict.kind, message).toBe('transient');
      expect(verdict.code).toBeUndefined();
      expect(isPermanentDeliveryFailure(new Error(message))).toBe(false);
    }
  });

  it('never throws on a non-Error, and always produces a usable reason', () => {
    expect(classifyDeliveryFailure(undefined)).toEqual({ kind: 'transient', reason: 'delivery failed' });
    expect(classifyDeliveryFailure('   ').reason).toBe('delivery failed');
    expect(classifyDeliveryFailure({ toString: () => 'weird thing' }).reason).toBe('weird thing');
  });

  it('caps the reason so it cannot bloat the queue row or the UI label', () => {
    const verdict = classifyDeliveryFailure(new Error('x'.repeat(5_000)));
    expect(verdict.reason.length).toBeLessThanOrEqual(300);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  isDaemonCommandOutcomeUnknown — a connection-class failure means the
//  command may STILL execute daemon-side (inc-1787511363340: a `start`
//  that "failed" this way spawned 15s later). Unknown ≠ failed.
// ═══════════════════════════════════════════════════════════════════

describe('isDaemonCommandOutcomeUnknown', () => {
  it('matches the three shapes DaemonConnection.send() produces', () => {
    expect(isDaemonCommandOutcomeUnknown(
      new Error('daemon command timeout: start (30000ms) [traceId=2956aa25]'),
    )).toBe(true);
    expect(isDaemonCommandOutcomeUnknown(
      new Error('DaemonConnection not connected to __local__'),
    )).toBe(true);
    // The socket went with the command pending: the daemon may have run it.
    const lost = new Error('daemon command lost: start: connection closed before devbox answered [traceId=2956aa25]');
    expect(isDaemonCommandOutcomeUnknown(lost)).toBe(true);
    expect(sendMayHaveLanded(lost)).toBe(true);
    expect(classifyDeliveryFailure(lost).kind).toBe('transient');
  });

  it('matches the failure-cache shape a RETRY surfaces after an earlier timeout', () => {
    expect(isDaemonCommandOutcomeUnknown(
      new Error('Connection to __local__ failed 11s ago: Local daemon started (port 65164) but not responding to hello'),
    )).toBe(true);
  });

  it('a definite daemon verdict is NOT unknown — the daemon answered', () => {
    for (const message of [
      'Daemon start failed on host "devbox": cwd missing',
      'Daemon spawn failed on host "devbox": no PID returned (cwd: "/gone")',
      'Session working directory no longer exists',
      'spawn EMFILE',
    ]) {
      expect(isDaemonCommandOutcomeUnknown(new Error(message)), message).toBe(false);
    }
  });

  it('non-Error inputs are never unknown-outcome', () => {
    expect(isDaemonCommandOutcomeUnknown('daemon command timeout: start')).toBe(false);
    expect(isDaemonCommandOutcomeUnknown(undefined)).toBe(false);
  });
});


describe('classifyDeliveryFailure — the host refuses the session (another process holds it)', () => {
  const TERMINAL = 'start: this session already has a running CLI (pid 4087, started by a process no Walnut daemon recorded); not started a second time'
  it('parks it with plain words: the user is in it in a terminal, the task is fine, the message waits', () => {
    const err = new SessionHeldElsewhereError('devbox', 'session_live', holderPidOf(TERMINAL), holderKindOf(TERMINAL));
    const verdict = classifyDeliveryFailure(err);
    expect(verdict).toMatchObject({ kind: 'permanent', code: 'session_live' });
    expect(verdict.reason).toMatch(/^Not delivered yet: the user \(or someone\) has this session open in a terminal right now \(Claude Code pid 4087 on host "devbox"\)\./);
    expect(verdict.reason).toContain('The task is fine, not broken.');
    expect(verdict.reason).toContain('this message waits');
    expect(verdict.reason).toContain('Do not move the work elsewhere or close the task.');
    // Kept whole: people and agents decide what to do from it.
    expect(verdict.reason).toBe(err.message);
    expect(isHeldElsewhereReason(verdict.reason)).toBe(true);
  });
  it('another Walnut holding it is named as that, and this machine plainly', () => {
    const walnut = 'start: this session already has a running CLI (pid 9, started by the Walnut at /data/other); not started a second time';
    expect(holderKindOf(walnut)).toBe('walnut');
    const reason = classifyDeliveryFailure(new SessionHeldElsewhereError('__local__', 'session_live', 9, holderKindOf(walnut))).reason;
    expect(reason).toMatch(/^Not delivered yet: another Walnut runs this session right now \(Claude Code pid 9 on this machine\)/);
    expect(isHeldElsewhereReason(reason)).toBe(true);
    expect(classifyDeliveryFailure(new SessionHeldElsewhereError('box', 'session_other_walnut')).reason).toContain('belongs to another Walnut');
  });
  it('only a CLI another process started counts as held: not its own daemon, not a start in progress', () => {
    expect(heldByAnotherProcess(TERMINAL)).toBe(true);
    expect(heldByAnotherProcess('start: this session already has a running CLI (pid 5, started by this daemon); not started a second time')).toBe(false);
    expect(heldByAnotherProcess('start: another daemon is starting this session now (another Walnut daemon); not started twice')).toBe(false);
    expect(heldByAnotherProcess(undefined)).toBe(false);
  });
  it('reads the holder pid only from a pid mention', () => {
    expect(holderPidOf('a running CLI (pid 12, started by')).toBe(12);
    expect(holderPidOf('no pid here')).toBeUndefined();
    expect(holderPidOf(undefined)).toBeUndefined();
  });
});
