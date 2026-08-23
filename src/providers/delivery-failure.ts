/**
 * Permanent vs transient classification for a FAILED message delivery.
 *
 * The durable send queue retries a 'pending' row on every server boot and every
 * daemon reconnect, forever. That is the right answer for a transient failure
 * (host asleep, ssh down, daemon mid-restart) and the wrong one for a failure
 * retrying cannot fix: a session whose working directory was deleted fails the
 * spawn pre-flight identically every single time, so the row loops and publishes
 * a fresh pair of error notifications on every cycle (observed on a 12-day-old
 * message, re-firing on every deploy).
 *
 * A permanent verdict routes the batch to parkMessages() (dead-letter) instead of
 * revertToPending(). Getting it WRONG in the permanent direction costs a delivery
 * the user must retry by hand, so this stays deliberately narrow: only failures
 * whose shape we have actually seen, plus an age backstop in the queue itself
 * (MAX_PENDING_AGE_MS) for the shapes we haven't.
 */

import { CwdMissingError } from './cwd-check.js';

export type DeliveryFailureKind = 'permanent' | 'transient';

export interface DeliveryFailureVerdict {
  kind: DeliveryFailureKind;
  /** Stable label for logs/tests. Absent for transient failures. */
  code?: 'cwd_missing' | 'session_missing';
  /** Human-readable cause, stored on the parked row and shown in the UI. */
  reason: string;
}

/** Cap the stored reason: it lands in a JSON row and in a UI label. */
const REASON_MAX = 300;

/**
 * The working directory is gone (local existsSync / remote fs.ls ENOENT), or was
 * never set. Both come from providers/cwd-check.ts, which soft-fails on every
 * transient condition — so if it says no, the answer will not change on retry.
 */
const CWD_MISSING = /working directory (no longer exists|not set|not available)/i;

/**
 * The session record is gone and could not be recovered from its JSONL, so
 * processNext has nothing to --resume. Raised in claude-code-session.ts.
 */
const SESSION_MISSING = /no active session found for session id/i;

export function classifyDeliveryFailure(err: unknown): DeliveryFailureVerdict {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const reason = message.trim().slice(0, REASON_MAX) || 'delivery failed';

  if (err instanceof CwdMissingError) return { kind: 'permanent', code: 'cwd_missing', reason };
  if (CWD_MISSING.test(message)) return { kind: 'permanent', code: 'cwd_missing', reason };
  if (SESSION_MISSING.test(message)) return { kind: 'permanent', code: 'session_missing', reason };

  return { kind: 'transient', reason };
}

/** Convenience for the two revert sites. */
export function isPermanentDeliveryFailure(err: unknown): boolean {
  return classifyDeliveryFailure(err).kind === 'permanent';
}

/**
 * The daemon command timed out or hit a dead/reconnecting connection. The bytes
 * may already be in the socket: the command can STILL execute daemon-side once
 * the daemon unwedges, so this is NOT a confirmed failure — the outcome is
 * UNKNOWN and must be probed, never recorded as a terminal verdict.
 * (inc-1787511363340: a `start` that "failed" this way spawned 15s later and
 * ran for 1.6h behind a 'stopped' record no recovery loop would look at.)
 *
 * Matches the connection-class shapes the daemon layer produces:
 * "daemon command timeout: <cmd> (<ms>ms)" and
 * "DaemonConnection not connected to <host>" (both from send()), plus
 * "Connection to <host> failed <N>s ago: …" (getDaemonConnection's failure
 * cache — the shape a RETRY surfaces after an earlier send already timed out,
 * so the earlier command may still land).
 */
const CONN_OUTCOME_UNKNOWN = /daemon command timeout|not connected|connection to .+ failed \d+s ago/i;

export function isDaemonCommandOutcomeUnknown(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return CONN_OUTCOME_UNKNOWN.test(err.message);
}
