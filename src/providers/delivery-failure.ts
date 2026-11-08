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
import { AcpSessionNotNativeError } from './acp-native-guard.js';
import { isSessionStopSuperseded } from '../core/sessions/session-stop.js';
import { InheritedSessionRefusedError, isInheritedSessionText } from './ephemeral-session-gate.js';
import { thisServer } from '../core/server-self-name.js';
import { DaemonFrameTooLargeError, FRAME_TOO_LARGE } from './daemon-frame-cap.js';

export type DeliveryFailureKind = 'permanent' | 'transient';

export interface DeliveryFailureVerdict {
  kind: DeliveryFailureKind;
  /** Stable label for logs/tests. Absent for transient failures. */
  code?: 'cwd_missing' | 'session_missing' | 'session_stopped' | 'budget_paused' | 'inherited_session' | 'session_live' | 'too_large' | 'acp_session' | 'claude_missing';
  /** Human-readable cause, stored on the parked row and shown in the UI. */
  reason: string;
  /**
   * The agent cannot run on the host yet (a readiness kind, host-problem.ts
   * AGENT_CANNOT_RUN_KINDS): the parked row carries it, and Walnut sends the row by
   * itself once the host reads runnable (core/sessions/agent-wait-resend.ts).
   */
  waitsFor?: string;
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
const CWD_MISSING = /working directory (no longer exists|not set|not available)|cwd does not exist on this host/i;

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
  // Claude Code cannot run on the host yet: every retry fails the same way until the
  // user installs it, so the message waits, said plainly, for their Retry.
  if (err instanceof ClaudeRuntimeMissingError) return { kind: 'permanent', code: 'claude_missing', reason: err.waitingReason, waitsFor: err.errorKind };
  // A test server refusing a session it did not start: retrying changes nothing.
  if (err instanceof InheritedSessionRefusedError || isInheritedSessionText(message)) return { kind: 'permanent', code: 'inherited_session', reason: reason.replace(/^inherited_session:\s*/, '') };
  // Another process holds the session on its host: every retry is refused the
  // same way until that process ends, so the batch waits for the user's Retry.
  if (err instanceof SessionHeldElsewhereError) return { kind: 'permanent', code: 'session_live', reason: err.message.slice(0, HELD_REASON_MAX) };
  // A Claude CLI under an ACP session's id: refused the same way on every try, so the batch waits (acp-native-guard.ts).
  if (err instanceof AcpSessionNotNativeError) return { kind: 'permanent', code: 'acp_session', reason };
  if (err instanceof CwdMissingError) return { kind: 'permanent', code: 'cwd_missing', reason };
  if (CWD_MISSING.test(message)) return { kind: 'permanent', code: 'cwd_missing', reason };
  if (SESSION_MISSING.test(message)) return { kind: 'permanent', code: 'session_missing', reason };
  // Over the frame cap of the host's daemon: refused before a byte went, the same on every retry.
  if (err instanceof DaemonFrameTooLargeError || FRAME_TOO_LARGE.test(message)) {
    return { kind: 'permanent', code: 'too_large', reason: `Not sent: ${reason}. Send it in smaller parts.` };
  }

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

/**
 * Nothing reached the host: its link is down (a send held for the connection, a
 * daemon connection that is not up, a connect that failed a moment ago). The
 * message was never written, so it waits and goes out when the link is back
 * (the reconnect redelivers it), never a "Send failed".
 */
// The companion's hop (cloud-session-link.ts) is the way the Mac takes when its own link to
// the host is down; its words for "it has no way through either" are the same wait
// (2026-11-06: "Send failed: The companion refused the session stream", sent a second later).
const HOST_LINK_DOWN = /waiting for the connection to the session host|no companion connection is available|^DaemonConnection not connected to\b|connection to .+ failed \d+s ago|connection to .+ was closed|^The companion (refused the session stream|did not confirm the session stream|has no connection to the session host|credential is awaiting recovery)|^The connection to the companion failed|^The session stream closed before|^The session host bridge disconnected|this Walnut server is shutting down, and the next one connects/i;
export function isHostLinkFailure(err: unknown): boolean {
  return err instanceof Error && !(err instanceof SendOutcomeUnknownError) && HOST_LINK_DOWN.test(err.message);
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
  if (kind === 'session_other_walnut') return `Not delivered: this session belongs to another Walnut on ${where}, and ${thisServer()} does not run it.`;
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

/**
 * The host's daemon refused to start the CLI because Claude Code cannot run there
 * (not installed, or the npm build with no Node). Nothing was spawned. The message
 * is the readiness sentence every surface shows (host-readiness.ts spawnGateSentence).
 */
export class ClaudeRuntimeMissingError extends Error {
  readonly code = 'CLAUDE_RUNTIME';
  constructor(message: string, readonly errorKind: 'claude_missing' | 'claude_needs_node' | 'claude_error') {
    super(message);
    this.name = 'ClaudeRuntimeMissingError';
  }
  /** What a message that could not start says while it waits for the install. */
  get waitingReason(): string {
    const said = this.message.trim().replace(/\.?$/, '.');
    if (this.errorKind === 'claude_missing') return `${said} Install Claude Code and this message goes out by itself.`;
    // claude_error: it is installed and stopped at once, which readiness may not see; Retry is the sure way.
    if (this.errorKind === 'claude_error') return `${said} Then press Retry to send this message.`;
    return `${said} Once Claude Code can start, this message goes out by itself.`;
  }
}

/**
 * A daemon start whose CLI ended before it took its first line (both daemon twins say
 * "start: initial message not delivered (<reason>)": ENXIO, no reader on its stdin; session_dead
 * or not_found, the process already reaped). Claude Code on that host does not start: no
 * conversation began, and the words a person reads say so (2026-11-11 review: the raw
 * "internal daemon error handling start: start: initial message not delivered (ENXIO)").
 */
const CLI_GONE_BEFORE_FIRST_LINE = /initial message not delivered \((?:ENXIO|session_dead|not_found)\)/;

export function cliStoppedBeforeFirstLine(daemonError: unknown): boolean {
  return typeof daemonError === 'string' && CLI_GONE_BEFORE_FIRST_LINE.test(daemonError);
}

/** Where a host is, in a sentence: its name, or this computer. */
function hostWords(host: string | null): { on: string; there: string } {
  return host && host !== '__local__'
    ? { on: ` on ${host}`, there: ` in a terminal on ${host}` }
    : { on: '', there: ' in a terminal on this computer' };
}

/** The sentence for a start whose Claude Code stopped before it read the message. */
export function cliStoppedSentence(host: string | null): string {
  const w = hostWords(host);
  return `Claude Code${w.on} stopped before it read your message, so nothing started. Check that it runs: \`claude --version\`${w.there}.`;
}

/**
 * Any other daemon start failure, in plain words: what failed, then the daemon's own cause
 * with its internal frames ("internal daemon error handling start: start: ...") taken off.
 */
export function startFailureSentence(host: string | null, daemonError: unknown): string {
  const cause = String(daemonError ?? '').replace(/^(?:internal daemon error handling \w+:\s*)?(?:start:\s*)?/i, '').trim();
  return `Walnut could not start Claude Code${hostWords(host).on}${cause ? `: ${cause}` : '.'}`;
}

/** By type, or by the daemon/runner's sentence when the error was rebuilt from text. */
export function isClaudeRuntimeMissing(err: unknown): boolean {
  if (err instanceof ClaudeRuntimeMissingError) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return CLAUDE_RUNTIME_SENTENCE.test(message);
}
/** The two sentences of host-readiness-problems.ts (claudeMissingMessage / claudeNeedsNodeMessage). */
const CLAUDE_RUNTIME_SENTENCE = /^Claude Code (is not installed on |on .+ is the npm build and no working Node\.js was found|(?:on .+ )?stopped before it read your message)/;

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
