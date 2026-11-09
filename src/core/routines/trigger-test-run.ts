/**
 * A trigger_test run that may outlive the call that started it.
 *
 * 2026-11-08: a check with a 280 s limit could not be tested. A session on another host calls
 * trigger_test through its host daemon's gateway, which gives one relayed call 20 s
 * (gateway-core.ts GATEWAY_HUB_TIMEOUT_MS), so no wait on the route can be longer than that.
 * The run is kept here instead: a call waits for it until just before its caller's deadline
 * (answer-by.ts), then answers `pending` with the run's id, and the next trigger_test with that
 * `testId` waits on the same run. A caller with no deadline (the installed CLI, the web form)
 * waits to the end. The run itself always finishes, so its result is ready when asked for.
 */

import { randomBytes } from 'node:crypto';

/** Answer this long before the caller's deadline, so the answer still gets back to it. */
export const ANSWER_MARGIN_MS = 4_000;
/** A finished run is kept this long for a caller that comes back for it. */
export const KEEP_FINISHED_MS = 15 * 60_000;
const MAX_RUNS = 100;

export interface TestRunInfo {
  host: string;
  limitSeconds: number;
  startedAt: number;
}

interface Entry<T> extends TestRunInfo {
  promise: Promise<T>;
  finishedAt?: number;
}

const runs = new Map<string, Entry<unknown>>();

function prune(now: number): void {
  for (const [id, r] of runs) if (r.finishedAt !== undefined && now - r.finishedAt > KEEP_FINISHED_MS) runs.delete(id);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string);
}

/** Start a run; its promise is kept (never left unhandled) for whoever asks next. */
export function startTestRun<T>(info: TestRunInfo, run: () => Promise<T>): string {
  prune(Date.now());
  const id = `tt_${randomBytes(6).toString('hex')}`;
  const promise = run();
  const entry: Entry<T> = { ...info, promise };
  promise.then(() => { entry.finishedAt = Date.now(); }, () => { entry.finishedAt = Date.now(); });
  runs.set(id, entry as Entry<unknown>);
  return id;
}

export type TestRunWait<T> =
  | { done: true; value: T }
  | { done: false; testId: string; info: TestRunInfo };

/**
 * Wait for a run until `answerBy` less the margin (to its end when there is none). A run that
 * failed rethrows its error; an unknown id is null.
 */
export async function waitTestRun<T>(testId: string, answerBy: number | undefined, now = Date.now()): Promise<TestRunWait<T> | null> {
  const entry = runs.get(testId) as Entry<T> | undefined;
  if (!entry) return null;
  if (answerBy === undefined) return { done: true, value: await entry.promise };
  const budget = Math.max(0, answerBy - ANSWER_MARGIN_MS - now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), budget); });
  try {
    const out = await Promise.race([entry.promise.then((value) => ({ value })), late]);
    if (out === 'late') return { done: false, testId, info: { host: entry.host, limitSeconds: entry.limitSeconds, startedAt: entry.startedAt } };
    return { done: true, value: out.value };
  } finally {
    clearTimeout(timer);
  }
}

export function clearTestRunsForTest(): void {
  runs.clear();
}
