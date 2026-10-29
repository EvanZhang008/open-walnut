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
import { isSessionStopSuperseded } from '../core/sessions/session-stop.js';
import { InheritedSessionRefusedError } from './ephemeral-session-gate.js';

export type DeliveryFailureKind = 'permanent' | 'transient';

export interface DeliveryFailureVerdict {
  kind: DeliveryFailureKind;
  /** Stable label for logs/tests. Absent for transient failures. */
  code?: 'cwd_missing' | 'session_missing' | 'session_stopped' | 'budget_paused' | 'inherited_session' | 'session_live';
  /** Human-readable cause, stored on the parked row and shown in the UI. */
  reason: string;
}

/** Cap the stored reason: it lands in a JSON row and in a UI label. */
const REASON_MAX = 300;
/** The held-elsewhere reason is read by people and agents deciding what to do: kept whole. */
const HELD_REASON_MAX = 600;

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

  if (err instanceof BudgetPausedError || (err instanceof Error && /\bbudget_paused\b/.test(err.message))) {
    return { kind: 'permanent', code: 'budget_paused', reason: 'Not sent: the session budget is paused. Raise or remove the limit, then retry.' };
  }
  if (isSessionStopSuperseded(err)) return { kind: 'permanent', code: 'session_stopped', reason };
  // A test server refusing a session it did not start: retrying changes nothing.
  if (err instanceof InheritedSessionRefusedError || /^inherited_session:/.test(message)) return { kind: 'permanent', code: 'inherited_session', reason };
  // Another process holds the session on its host: every retry is refused the
  // same way until that process ends, so the batch waits for the user's Retry.
  if (err instanceof SessionHeldElsewhereError) return { kind: 'permanent', code: 'session_live', reason: err.message.slice(0, HELD_REASON_MAX) };
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
 * "daemon command timeout: <cmd> (<ms>ms)",
 * "daemon command lost: <cmd>: connection closed before <host> answered" (its
 * socket went with it pending) and
 * "DaemonConnection not connected to <host>" (all from send()), plus
 * "Connection to <host> failed <N>s ago: …" (getDaemonConnection's failure
 * cache — the shape a RETRY surfaces after an earlier send already timed out,
 * so the earlier command may still land).
 */
const CONN_OUTCOME_UNKNOWN = /daemon command timeout|daemon command lost|not connected|connection to .+ failed \d+s ago/i;

/**
 * The host is up but did not answer in time: a daemon command that timed out or
 * lost its socket, or a send whose answer never came. Not a host that is down or
 * refused the login ("not connected", "Connection to … failed"): those keep their
 * own words and their Retry. The runner sends such rows again on a clock.
 */
const HOST_SLOW = /daemon command timeout|daemon command lost/i;
export function isSlowHostFailure(err: unknown): boolean {
  if (err instanceof SendOutcomeUnknownError) return true;
  return err instanceof Error && HOST_SLOW.test(err.message);
}

export function isDaemonCommandOutcomeUnknown(err: unknown): boolean {
  if (err instanceof SendOutcomeUnknownError) return true;
  if (!(err instanceof Error)) return false;
  return CONN_OUTCOME_UNKNOWN.test(err.message);
}

/**
 * A user-line send that may have reached the daemon but whose answer never came,
 * and that the daemon could not be asked about in time. Not a refusal: the CLI
 * may already hold the line, so the caller must neither re-send it blind (a later
 * attempt carries `dedupe`) nor stop the CLI to retry it on a fresh process.
 */
export class SendOutcomeUnknownError extends Error {
  readonly code = 'SEND_OUTCOME_UNKNOWN';
  constructor(cause: string) {
    super(`Delivery unconfirmed: the host never said whether the message reached the session (${cause})`);
    this.name = 'SendOutcomeUnknownError';
  }
}

/**
 * The host refused to start the session's CLI because another process already
 * runs it there (the daemon's one-CLI-per-session guard, cli-owner-core.ts:
 * errorKind `session_live`), or because the session belongs to another Walnut
 * (`session_other_walnut`, test servers only). Nothing was spawned and nothing
 * read the message. 2026-10-28: a `claude -r <sid>` left open in a terminal
 * refused every send to a task for hours, and the server retried each one on
 * every reconnect while telling the sender the target's turn had ended.
 */
export class SessionHeldElsewhereError extends Error {
  readonly code = 'SESSION_LIVE';
  constructor(
    readonly host: string,
    readonly kind: 'session_live' | 'session_other_walnut',
    readonly holderPid?: number,
    /** Who holds it: a process no Walnut recorded (a terminal: most likely the user), or another Walnut. */
    readonly holder: 'terminal' | 'walnut' = 'terminal',
  ) {
    super(heldElsewhereText(host, kind, holderPid, holder));
    this.name = 'SessionHeldElsewhereError';
  }
}

/**
 * The words the sender, the parked row and the task's status all carry. Plain on
 * purpose (2026-10-28: a lead read the old wording as "this task is broken",
 * moved the work to a new task and closed the one the user was working in).
 */
function heldElsewhereText(host: string, kind: SessionHeldElsewhereError['kind'], pid: number | undefined, holder: 'terminal' | 'walnut'): string {
  const where = host === '__local__' ? 'this machine' : `host "${host}"`;
  const proc = pid ? `Claude Code pid ${pid} on ${where}` : `on ${where}`;
  if (kind === 'session_other_walnut') return `Not delivered: this session belongs to another Walnut on ${where}, and a test server does not run it.`;
  if (holder === 'walnut') {
    return `Not delivered yet: another Walnut runs this session right now (${proc}). The task is fine, not broken: `
      + 'this message waits in the session\'s queue, and Retry sends it once that process has ended.';
  }
  return `Not delivered yet: the user (or someone) has this session open in a terminal right now (${proc}). `
    + 'The task is fine, not broken. Walnut runs one process per session, so this message waits in the session\'s queue; '
    + 'Retry sends it once that terminal is closed. Do not move the work elsewhere or close the task.';
}

/**
 * The daemon's session_live refusal names a CLI another process started: a
 * terminal's `claude -r`, another Walnut's daemon. Not its own CLI ("started by
 * this daemon") and not another daemon's start in progress ("is starting this
 * session now"), which a retry gets past.
 */
export function heldByAnotherProcess(text: unknown): boolean {
  const t = typeof text === 'string' ? text : '';
  return /already has a running CLI \(pid \d+, started by /.test(t) && !/started by this daemon\)/.test(t);
}

/** Who the refusal names: a process no Walnut daemon recorded (a terminal) or another Walnut. */
export function holderKindOf(text: unknown): 'terminal' | 'walnut' {
  return typeof text === 'string' && /started by a process no Walnut daemon recorded/.test(text) ? 'terminal' : 'walnut';
}

/** The holder's pid from the daemon's refusal text ("… a running CLI (pid 4087, …"). */
export function holderPidOf(text: unknown): number | undefined {
  const m = /\bpid (\d+)/.exec(typeof text === 'string' ? text : '');
  return m ? Number(m[1]) : undefined;
}

/** The session's budget is paused (over its limit, unpriced, unreadable): nothing is sent until the user raises or removes it. */
export class BudgetPausedError extends Error {
  readonly code = 'BUDGET_PAUSED';
  constructor() {
    super('budget_paused: raise or remove the limit, then retry the message');
    this.name = 'BudgetPausedError';
  }
}

/**
 * A user line that was not sent at all: it was queued behind a line whose
 * outcome stayed unknown, and writing it would let it overtake that line. It
 * goes back to the queue, behind the unknown one.
 */
export class SendHeldError extends Error {
  readonly code: string = 'SEND_HELD';
  constructor(reason = 'Not sent yet: waiting to confirm the previous message') {
    super(reason);
    this.name = 'SendHeldError';
  }
}

/**
 * The session's host has not decided its budget yet (prices not pushed, usage
 * still being read, a check slower than the send may wait): the line was not
 * written. Held like any unsent line, so it goes back to the queue and is sent
 * again, never parked as paused.
 */
export class BudgetCheckingError extends SendHeldError {
  override readonly code = 'BUDGET_CHECKING';
  constructor() {
    super('Not sent yet: the session budget is still being checked. Retry in a moment.');
    this.name = 'BudgetCheckingError';
  }
}

/**
 * The send's request may already be on the wire: its command timed out, or the
 * socket closed while it was pending. "not connected" is thrown before anything
 * is written, so it is a plain failure, not this.
 */
const SEND_MAY_HAVE_LANDED = /daemon command timeout|connection closed/i;

export function sendMayHaveLanded(err: unknown): boolean {
  return err instanceof Error && SEND_MAY_HAVE_LANDED.test(err.message);
}
