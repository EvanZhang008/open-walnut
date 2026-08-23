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
import { classifyDeliveryFailure, isPermanentDeliveryFailure, isDaemonCommandOutcomeUnknown } from '../../src/providers/delivery-failure.js';
import { CwdMissingError } from '../../src/providers/cwd-check.js';

describe('classifyDeliveryFailure — permanent', () => {
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
  it('matches the two shapes DaemonConnection.send() produces', () => {
    expect(isDaemonCommandOutcomeUnknown(
      new Error('daemon command timeout: start (30000ms) [traceId=2956aa25]'),
    )).toBe(true);
    expect(isDaemonCommandOutcomeUnknown(
      new Error('DaemonConnection not connected to __local__'),
    )).toBe(true);
  });

  it('matches the failure-cache shape a RETRY surfaces after an earlier timeout', () => {
    expect(isDaemonCommandOutcomeUnknown(
      new Error('Connection to __local__ failed 11s ago: Local daemon started (port 65164) but not responding to hello'),
    )).toBe(true);
  });

  it('a definite daemon verdict is NOT unknown — the daemon answered', () => {
    for (const message of [
      'Daemon start failed on host "clouddev": cwd missing',
      'Daemon spawn failed on host "clouddev": no PID returned (cwd: "/gone")',
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
