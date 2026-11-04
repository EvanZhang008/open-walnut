/**
 * Which Walnut logs a failed rehearsal prints, and for which scenario.
 *
 * A scenario records the walnuts it made (`made`). A failure prints those, its own
 * install and server logs, never another scenario's: 2026-11-04, the field rehearsal's
 * three 0.6.19 scenarios failed on their npm install, and the tails printed under them
 * were 0.6.25's logs (every walnut, in the order they were made), so npm's own error
 * was not in the job log. A scenario that made none (it reused one an earlier scenario
 * made) prints every walnut, as before, and that covers every later failure too.
 *
 * Ratchet: tests/scripts/release-rehearsal-failure-logs.test.ts
 */

/** At most this many failed scenarios print their logs. */
export const MAX_FAILURES_LOGGED = 3

/**
 * `[{ name, walnuts }]`: for each failed result (in order, at most `max`), the walnuts
 * whose logs explain it.
 */
export function failureLogs(results, walnuts, max = MAX_FAILURES_LOGGED) {
  const out = []
  for (const r of results.filter((r) => !r.ok).slice(0, max)) {
    if (r.made?.length) { out.push({ name: r.name, walnuts: r.made }); continue }
    out.push({ name: r.name, walnuts })
    break
  }
  return out
}
