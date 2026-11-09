/**
 * A trigger check's time limit, said where people and agents read about a run.
 *
 * 2026-11-08, a trigger sweep: 15 check scripts made calls whose own timeouts times
 * their retries came to more than the trigger's time limit, so the daemon killed
 * them before a retry could run. Nothing showed the limit (the sweep read it out of
 * the routine store by hand), a killed run read "check timed out after 434s", and
 * a test run that took most of the limit passed without a word. So:
 *   - every check error the daemon reports for its deadline is worded as a kill at
 *     the limit, with the limit in it, whatever daemon version sent it;
 *   - a run's time is read against the limit, and a run over half of it is a warning
 *     (a slower source, or one retry, and it is killed);
 *   - the last test run of a check is remembered for an hour, so trigger_create can
 *     say when the script it arms came close.
 * Pure except the bounded in-memory test memory, and free of node imports: the web app reads it.
 */

/**
 * The daemon's limits (CHECK_TIMEOUT_DEFAULT_S / CHECK_TIMEOUT_MAX_S and clampTimeoutSeconds in
 * src/providers/trigger-check-core.ts), repeated here because the web app imports this file and
 * that one spawns processes. A test pins them equal.
 */
export const TIME_LIMIT_DEFAULT_S = 30;
export const TIME_LIMIT_MAX_S = 300;

function clampTimeoutSeconds(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : TIME_LIMIT_DEFAULT_S;
  return Math.min(TIME_LIMIT_MAX_S, Math.max(1, n));
}

/** The daemon's grace after the deadline before it gives up on a check that will not die (CHECK_SETTLE_GRACE_MS). */
export const TIME_LIMIT_SETTLE_S = 5;
/** The way to the daemon and back, on top of the check's own time. */
const TEST_TRANSPORT_MARGIN_MS = 15_000;
/** How long a test whose link dropped waits for the host's daemon to be back before its one retry. */
export const TEST_RETRY_RELINK_MS = 10_000;

/**
 * How long the server waits for one test run's answer from the daemon: the check's limit, the
 * daemon's settle grace and the way there and back. 2026-11-08: a fixed 10 s (the CLI) and 60 s
 * (the server) made a check with a 280 s limit untestable.
 */
export function testRunDeadlineMs(limitS: number): number {
  return (clampTimeoutSeconds(limitS) + TIME_LIMIT_SETTLE_S) * 1000 + TEST_TRANSPORT_MARGIN_MS;
}

/** How long trigger_test's caller waits for the route: two runs (the one retry after a dropped link) and the relink. */
export function testCallTimeoutMs(timeoutSeconds: unknown): number {
  return 2 * testRunDeadlineMs(timeLimitSeconds({ timeoutSeconds })) + TEST_RETRY_RELINK_MS + 5_000;
}

/** Over this share of the limit, a run is close enough to be killed by a slower day. */
export const NEAR_LIMIT_SHARE = 0.5;

/**
 * The daemon's own words for a check it killed at its deadline (checkErrorOf in
 * trigger-check-core.ts, both twins and every version so far), and ours once
 * reworded. A guard test runs checkErrorOf for a timed-out run against this.
 */
const DAEMON_TIMEOUT_RE = /^check timed out after \d+s\b/;
const KILLED_RE = /^check killed at the \d+ s limit\b/;

/** The limit a check runs under, in seconds: its own, else the daemon's default. */
export function timeLimitSeconds(check: { timeoutSeconds?: unknown } | undefined | null): number {
  return clampTimeoutSeconds(check?.timeoutSeconds);
}

/** Whether a check error says the run was killed at its time limit. */
export function isTimeLimitError(error: unknown): boolean {
  return typeof error === 'string' && (DAEMON_TIMEOUT_RE.test(error.trim()) || KILLED_RE.test(error.trim()));
}

/** "check killed at the 120 s limit (timeoutSeconds): it was still running". */
export function killedAtLimitText(limitS: number): string {
  return `check killed at the ${limitS} s limit (timeoutSeconds): it was still running`;
}

/**
 * A check error as Walnut says it: the daemon's words for a deadline kill become a kill at the
 * limit, every other error is kept, and one Walnut already worded keeps the limit it names (a run
 * killed at 30 s stays killed at 30 s after the limit is raised). `limitS` is the limit that run
 * ran under: its recorded one when known.
 */
export function checkErrorText(error: string | undefined, limitS: number): string | undefined {
  if (typeof error !== 'string' || KILLED_RE.test(error.trim())) return error;
  return DAEMON_TIMEOUT_RE.test(error.trim()) ? killedAtLimitText(limitS) : error;
}

/** The limit a recorded run ran under: its own (stored since 2026-11-09), else the check's limit now. */
export function runLimitSeconds(entry: { limitSeconds?: unknown } | undefined, check: { timeoutSeconds?: unknown } | undefined | null): number {
  const own = entry?.limitSeconds;
  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? Math.floor(own) : timeLimitSeconds(check);
}

/** "0.4 s", "12 s", "2 m 5 s". */
export function secondsLabel(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${Math.round(s * 10) / 10} s`;
  if (s < 120) return `${Math.round(s)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} m ${whole % 60} s`;
}

/** What to do about a run near or at its limit, in one sentence. */
export function limitAdvice(limitS: number): string {
  return `Give every call in the script its own short timeout so its timeouts times its retries fit inside ${limitS} s, `
    + `or arm the trigger with a larger timeoutSeconds (at most ${TIME_LIMIT_MAX_S}).`;
}

export interface LimitUse {
  limitSeconds: number;
  durationMs: number;
  /** durationMs / the limit, two decimals. */
  share: number;
  /** The run was killed at the limit. */
  killed: boolean;
  /** Over NEAR_LIMIT_SHARE of the limit, or killed. */
  near: boolean;
}

/** A run's time against its limit; null when the run's time is unknown. */
export function limitUse(durationMs: unknown, limitS: number, killed = false): LimitUse | null {
  if (!killed && (typeof durationMs !== 'number' || !Number.isFinite(durationMs))) return null;
  const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, durationMs) : limitS * 1000;
  const share = Math.round((ms / (limitS * 1000)) * 100) / 100;
  return { limitSeconds: limitS, durationMs: ms, share, killed, near: killed || share >= NEAR_LIMIT_SHARE };
}

/** "ran 34 s of its 120 s limit" / "was killed at its 120 s limit". */
export function limitUseLine(use: LimitUse): string {
  if (use.killed) return `was killed at its ${use.limitSeconds} s limit`;
  return `ran ${secondsLabel(use.durationMs)} of its ${use.limitSeconds} s limit`;
}

/** The warning for a run over half its limit (or killed by it); undefined for a run well inside it. */
export function limitWarning(use: LimitUse | null, what = 'The run'): string | undefined {
  if (!use || !use.near) return undefined;
  const head = use.killed
    ? `${what} was killed at its ${use.limitSeconds} s time limit before it finished.`
    : `${what} took ${secondsLabel(use.durationMs)}, ${Math.round(use.share * 100)}% of its ${use.limitSeconds} s time limit: `
      + 'a slower source, or one retry inside the script, and the daemon kills it at the limit.';
  return `${head} ${limitAdvice(use.limitSeconds)}`;
}

// ── The last test run of each check, for trigger_create ──

export const TEST_MEMORY_MS = 60 * 60 * 1000;
const TEST_MEMORY_MAX = 200;

export interface TestRunMemory {
  atMs: number;
  durationMs: number;
  limitSeconds: number;
  killed: boolean;
}

const testRuns = new Map<string, TestRunMemory>();

function testKey(check: { run: string; host: string; cwd?: string }): string {
  return JSON.stringify([check.host, check.cwd ?? '', check.run.trim()]);
}

export function rememberTestRun(check: { run: string; host: string; cwd?: string }, run: TestRunMemory): void {
  const key = testKey(check);
  testRuns.delete(key);
  testRuns.set(key, run);
  while (testRuns.size > TEST_MEMORY_MAX) testRuns.delete(testRuns.keys().next().value as string);
}

/** The newest test run of this check in the last hour. */
export function recentTestRun(check: { run: string; host: string; cwd?: string }, nowMs = Date.now()): TestRunMemory | null {
  const run = testRuns.get(testKey(check));
  return run && nowMs - run.atMs <= TEST_MEMORY_MS ? run : null;
}

export function clearTestRunsForTest(): void {
  testRuns.clear();
}

/**
 * What trigger_create says about a recent test run of the check it arms, judged
 * against the limit the trigger gets (it may differ from the test's). Undefined
 * when the test ran well inside it, or no test was run.
 */
export function createLimitWarning(test: TestRunMemory | null, limitS: number): string | undefined {
  if (!test) return undefined;
  if (test.killed && limitS <= test.limitSeconds) {
    return limitWarning({ limitSeconds: limitS, durationMs: test.durationMs, share: 1, killed: true, near: true }, 'Its last trigger_test run');
  }
  if (test.killed) {
    return `Its last trigger_test run was killed at ${test.limitSeconds} s, so nobody saw it finish inside this trigger's `
      + `${limitS} s limit: run trigger_test with timeoutSeconds ${limitS} to see how long it really takes.`;
  }
  return limitWarning(limitUse(test.durationMs, limitS), 'Its last trigger_test run');
}
