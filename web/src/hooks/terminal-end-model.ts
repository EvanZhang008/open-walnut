/**
 * What "End terminal" may tell the user, from the terminal:kill answer.
 *
 * Only `killed: true` ends the terminal. An unconfirmed answer, an RPC failure
 * or no answer in time all mean Walnut does not know the shell is gone, so the
 * UI keeps the terminal and says so instead (a confident wrong answer is worse
 * than an error). Kept free of React so it is unit tested directly.
 */

import type { TerminalKillResult } from '@/api/terminal';

/** `detail`: the technical cause, for the log only. */
export type EndOutcome = { ended: true } | { ended: false; reason: string; detail?: string };

/** A dispatched RPC has no deadline of its own (only a closing socket rejects it). */
export const END_ANSWER_MS = 30_000;

export const END_UNCONFIRMED_TEXT = 'Walnut could not confirm the terminal ended. It may still be running.';
/** After an unconfirmed End the view's own connection is gone: typing reaches nothing until a reopen. */
export const END_REATTACH_HINT = 'Close and reopen the terminal to reattach to it.';

export function endOutcomeOf(answer: TerminalKillResult | null | undefined): EndOutcome {
  if (answer?.killed === true) return { ended: true };
  const reason = typeof answer?.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : 'Walnut did not confirm it';
  return { ended: false, reason };
}

/** Wait for the answer at most `ms`; never rejects. */
export function awaitEndAnswer(answer: Promise<TerminalKillResult>, ms = END_ANSWER_MS): Promise<EndOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ended: false, reason: `Walnut did not answer within ${Math.round(ms / 1000)}s` }), ms);
    answer.then(
      (res) => { clearTimeout(timer); resolve(endOutcomeOf(res)); },
      (err: unknown) => {
        clearTimeout(timer);
        resolve({ ended: false, reason: 'the connection to Walnut failed', detail: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}

/**
 * One End at a time, per terminal generation. The hook bumps its generation on
 * every (re)open, which a sessionId change also triggers, so an End still waiting
 * on the old terminal (up to END_ANSWER_MS) never blocks End on the new one, and
 * its late release cannot free a newer End's hold.
 */
export interface EndGuard {
  /** True while an End of generation `gen` is in flight. */
  busy(gen: number): boolean;
  /** Takes the hold for `gen`; false when an End of that generation already runs. */
  take(gen: number): boolean;
  /** Frees the hold only if `gen` still owns it. */
  release(gen: number): void;
}

export function createEndGuard(): EndGuard {
  let owner: number | null = null;
  return {
    busy: (gen) => owner === gen,
    take: (gen) => {
      if (owner === gen) return false;
      owner = gen;
      return true;
    },
    release: (gen) => { if (owner === gen) owner = null; },
  };
}
