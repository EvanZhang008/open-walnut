/**
 * Which Walnut logs a failed rehearsal prints, and for which scenario.
 *
 * A scenario records the walnuts it made (`made`). A failure prints those, its own
 * install and server logs, never another scenario's: 2026-11-04, the field rehearsal's
 * three 0.6.19 scenarios failed on their npm install, and the tails printed under them
 * were 0.6.25's logs (every walnut, in the order they were made), so npm's own error
 * was not in the job log. A scenario that made none (it reused one an earlier scenario
 * made, or failed before it made one) prints the walnuts of the newest earlier scenario
 * that made any, named as that scenario's (`from`): printing every walnut put 3,000 lines
 * of other scenarios' logs under a download that failed before any start (2026-11-05).
 *
 * Ratchet: tests/scripts/release-rehearsal-failure-logs.test.ts
 */

/** At most this many failed scenarios print their logs. */
export const MAX_FAILURES_LOGGED = 3

/**
 * `[{ name, walnuts, from? }]`: for each failed result (in order, at most `max`), the
 * walnuts whose logs explain it; `from` names the earlier scenario that made them when
 * the failure made none. `walnuts` is every walnut, for results that record no `made`.
 */
export function failureLogs(results, walnuts, max = MAX_FAILURES_LOGGED) {
  const out = []
  const failed = results.filter((r) => !r.ok).slice(0, max)
  for (const r of failed) {
    if (r.made?.length) { out.push({ name: r.name, walnuts: r.made }); continue }
    if (!results.some((x) => x.made)) { out.push({ name: r.name, walnuts }); break }
    const maker = results.slice(0, results.indexOf(r)).reverse().find((x) => x.made?.length)
    if (maker) out.push({ name: r.name, walnuts: maker.made, from: maker.name })
  }
  return out
}
