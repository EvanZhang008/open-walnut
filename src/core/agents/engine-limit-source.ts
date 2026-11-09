/**
 * Where the fallback engine (fallback-engine.ts) reads whether an engine is out of usage: one small
 * seam over the usage-limit wait (sessions/usage-limit-wait.ts), so the launch rule does not
 * depend on how a usage limit is tracked.
 *
 *   sessionLimitOf  one session's own usage-limit stop, the wait's reading of its record
 *                   (usageLimitOfRecord)
 *   blockedLimitOf  the host's Claude subscription reading (sessions/subscription-limits.ts)
 *                   blocks a turn: rejected, with no extra usage to go on
 *
 * Server only (the wait's module is). Tests hand fallback-engine.ts their own sessionLimit
 * (FallbackDeps), or set one for the whole server with __setSessionLimitForTesting.
 */
import type { SessionRecord, SessionUsageLimit } from '../types.js';
import { usageLimitOfRecord } from '../sessions/usage-limit-wait.js';

export { blockedLimitOf } from '../sessions/usage-limit-model.js';

/** One session's usage-limit stop, while it may still hold its engine (the wait's own record). */
export type SessionLimitReading = Pick<SessionUsageLimit, 'window' | 'resetsAt' | 'resetsFrom' | 'since' | 'resumedAt' | 'offAt' | 'gaveUpAt' | 'dueAt'>;

type SessionLimitFn = (rec: SessionRecord, now: number) => SessionLimitReading | undefined;

let sessionLimitForTesting: SessionLimitFn | null = null;

/** A test's limits for every read of this server (null = the real reading). */
export function __setSessionLimitForTesting(fn: SessionLimitFn | null): void {
  sessionLimitForTesting = fn;
}

/** The usage-limit stop of one session, or undefined when the limit does not hold it. */
export function sessionLimitOf(rec: SessionRecord, now: number = Date.now()): SessionLimitReading | undefined {
  if (sessionLimitForTesting) return sessionLimitForTesting(rec, now);
  // Only a session the limit stopped (its wait's record) or one whose turn just ended in an error
  // (the wait's first look at a limit line) can hold its engine.
  if (!rec.usageLimit && rec.process_status !== 'error') return undefined;
  return usageLimitOfRecord(rec, now);
}
