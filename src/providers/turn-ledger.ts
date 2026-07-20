/**
 * Turn ledger — promissory-note accounting for "is this turn done yet?"
 *
 * Today, `ClaudeCodeSession` answers that question with proxy signals guessed
 * per call site: `hasPipe` (a locally-cached liveness guess), `resultEmitted`
 * (a boolean that a stale phase-proxy can seed wrong after a restart — see the
 * `attachToExisting()` incident notes), and the `session_state_changed{idle}`
 * event. Those signals are still where the underlying EVIDENCE comes from —
 * this module does not re-derive turn-completion from scratch. What it adds is
 * a single, awaitable, per-session accounting layer: open a turn when a
 * message is delivered, settle it (once) with whatever outcome the existing
 * completion code already decided, and let any caller `await` that outcome
 * instead of re-reading `hasPipe`/`resultEmitted` and guessing.
 *
 * Modeled on the "promissory note" pattern from the ACP reference adapter
 * (uuid-stamped deferred, resolved by a long-lived consumer) — reimplemented
 * from scratch for Walnut's shape, not copied. Pure in-memory, per-process;
 * no daemon wire changes, no persistence. A daemon/process restart naturally
 * drops all open turns, which is correct: any promise a dead process can't
 * settle should reject, not survive into a new process.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../logging/index.js';

/** Why a turn ended. Mirrors the ProcessStatus outcomes a turn can settle into. */
export type TurnOutcome =
  | { kind: 'result'; isError: boolean }
  | { kind: 'idle' }
  | { kind: 'stopped' }
  | { kind: 'error'; message?: string };

interface OpenTurn {
  turnId: string;
  sessionId: string;
  openedAt: number;
  settled: boolean;
  promise: Promise<TurnOutcome>;
  resolve: (outcome: TurnOutcome) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** How long an opened turn may go unsettled before we fast-fail it. Mirrors the
 *  ACP reference's "idle-without-result" fast-fail rather than hanging forever. */
export const TURN_TIMEOUT_MS = 10 * 60_000;

const openTurns = new Map<string, OpenTurn>();

/**
 * Open a new turn for a session. If a turn is already open for that session
 * (e.g. a mid-turn injection landed before the prior turn settled), it is left
 * alone — turns are per-session-serialized by the existing `activeProcessing`
 * gate, so callers should only open a turn on the same delivery paths that
 * already gate on that Set. Returns the fresh `turnId` and its promise.
 */
export function openTurn(sessionId: string): { turnId: string; promise: Promise<TurnOutcome> } {
  const existing = openTurns.get(sessionId);
  if (existing && !existing.settled) {
    log.session.warn('turn-ledger: openTurn called with a turn already open — reusing it', {
      sessionId, turnId: existing.turnId,
    });
    return { turnId: existing.turnId, promise: existing.promise };
  }

  const turnId = randomUUID();
  let resolve!: (outcome: TurnOutcome) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<TurnOutcome>((res, rej) => { resolve = res; reject = rej; });
  // A runner can own turns whose callers never requested currentTurn().
  // Teardown must still reject them promptly without creating a process-level
  // unhandled rejection; attached callers continue to observe the rejection.
  void promise.catch(() => {});

  const timer = setTimeout(() => {
    const turn = openTurns.get(sessionId);
    if (!turn || turn.turnId !== turnId || turn.settled) return;
    turn.settled = true;
    openTurns.delete(sessionId);
    log.session.warn('turn-ledger: turn timed out unsettled — fast-failing', {
      sessionId, turnId, ageMs: Date.now() - turn.openedAt,
    });
    turn.reject(new Error('no_result'));
  }, TURN_TIMEOUT_MS);
  timer.unref();

  openTurns.set(sessionId, { turnId, sessionId, openedAt: Date.now(), settled: false, promise, resolve, reject, timer });
  return { turnId, promise };
}

/**
 * Settle the currently open turn for a session with an outcome. Idempotent:
 * settling an already-settled or nonexistent turn is a no-op (mirrors
 * `resultEmitted`'s existing dup-guard pattern — callers don't need to check
 * first). Returns true if this call actually settled a turn.
 */
export function settleTurn(sessionId: string, outcome: TurnOutcome): boolean {
  const turn = openTurns.get(sessionId);
  if (!turn || turn.settled) return false;
  turn.settled = true;
  clearTimeout(turn.timer);
  openTurns.delete(sessionId);
  turn.resolve(outcome);
  return true;
}

/** Fail the open turn (if any) without a normal outcome — e.g. on kill/interrupt
 *  where the turn is being torn down rather than completing. */
export function abortTurn(sessionId: string, reason: string): boolean {
  const turn = openTurns.get(sessionId);
  if (!turn || turn.settled) return false;
  turn.settled = true;
  clearTimeout(turn.timer);
  openTurns.delete(sessionId);
  turn.reject(new Error(reason));
  return true;
}

/** Abort every open promise owned by this process (runner teardown). */
export function abortAllTurns(reason: string): number {
  let aborted = 0;
  for (const sessionId of [...openTurns.keys()]) {
    if (abortTurn(sessionId, reason)) aborted++;
  }
  return aborted;
}

/** The currently open (unsettled) turn id for a session, if any. */
export function getOpenTurnId(sessionId: string): string | undefined {
  const turn = openTurns.get(sessionId);
  return turn && !turn.settled ? turn.turnId : undefined;
}

/** The promise for the currently open (unsettled) turn, if any — a pure read,
 *  unlike `openTurn` (which mints a new turn if none is open). */
export function getOpenTurnPromise(sessionId: string): Promise<TurnOutcome> | undefined {
  const turn = openTurns.get(sessionId);
  return turn && !turn.settled ? turn.promise : undefined;
}

/** Test/diagnostic only: drop all ledger state. */
export function _resetTurnLedgerForTest(): void {
  for (const turn of openTurns.values()) clearTimeout(turn.timer);
  openTurns.clear();
}
