/**
 * Room in a test's time limit for a queue it waits in (the panel count lock, a fixture lease).
 *
 * A test's hooks and its body share ONE time limit, and `test.setTimeout(ms)` replaces that limit
 * outright, counted from the start of the first beforeEach. So a wait in a hook that only widened
 * the limit was handed back to the body's own call: a test that queued 80 s for the panel count
 * lock and then said `test.setTimeout(90_000)` had 10 s left, and timed out in its first
 * `page.goto` (2026-11-03, CI: session-voice-selection.webkit.spec.ts, every case but the one that
 * took the lock first). Here the wait is kept on the running test, and a later `setTimeout` from
 * the test (or a hook) gets it added, so no limit a test names counts the time it spent queued.
 */
import type { TestInfo } from '@playwright/test'

const waited = new WeakMap<TestInfo, number>()

/** Make the test's own `setTimeout` keep every wait recorded for it. */
function keepWaits(info: TestInfo): (ms: number) => void {
  const own = (info as TestInfo & { __ownSetTimeout?: (ms: number) => void }).__ownSetTimeout
  if (own) return own
  const original = info.setTimeout.bind(info)
  Object.defineProperty(info, '__ownSetTimeout', { value: original })
  info.setTimeout = (ms: number) => original(ms > 0 ? ms + (waited.get(info) ?? 0) : ms)
  return original
}

/**
 * Run `wait` (a loop that polls for a lock) with up to `limitMs` of extra room first, then set the
 * limit to what it was plus the time the wait took, and remember that time for any later
 * `test.setTimeout` of this test.
 */
export async function waitOutsideBudget<T>(info: TestInfo, limitMs: number, wait: () => Promise<T>): Promise<T> {
  const set = keepWaits(info)
  const budget = info.timeout
  const start = Date.now()
  // Room to wait first: extended only once the lock came, a queue longer than the time the test
  // had left timed it out inside the wait (2026-11-03, CI: session-threads-views).
  if (budget > 0) set(budget + limitMs)
  try {
    return await wait()
  } finally {
    const took = Date.now() - start
    waited.set(info, (waited.get(info) ?? 0) + took)
    if (budget > 0) set(budget + took)
  }
}
