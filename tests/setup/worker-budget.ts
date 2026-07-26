/**
 * THE machine-wide worker budget — single source of truth for every vitest tier.
 *
 * 2026-07-25: this Mac hard-crashed (screen flashing, then a full reboot) while
 * tests ran. Per-run caps were NOT enough, because "one run" of `npm test` fanned
 * out into 6 parallel tier processes, each with its own worker pool and its own
 * multi-GB heaps — so a `maxWorkers: 4` config actually permitted 6 × 4 workers.
 *
 * The rule: no more than `maxWorkers()` worker processes machine-wide, EVER,
 * regardless of tier count, run count, or how many agent sessions are active.
 * Three independent layers enforce it, so no single bypass defeats the budget:
 *
 *   1. This module → `test.maxWorkers` in every vitest.*.config.ts.
 *   2. scripts/test-parallel.mjs runs tiers SEQUENTIALLY, so the tier count can
 *      never multiply the budget (this was the hole that crashed the machine).
 *   3. tests/setup/test-gate.ts admits ONE run group machine-wide, so a second
 *      agent session queues instead of doubling the budget.
 *
 * Deliberately conservative: 2 workers × 2GB heap ≈ 4GB peak. Tests take longer;
 * that is the right trade — a crashed machine costs far more than a slow suite.
 * This box also carries ~3GB of mandated security agents, the prod server on
 * :3456, simulators and browsers, and 128 test files spawn REAL servers/daemons
 * whose memory sits outside any V8 heap cap.
 *
 * One-off override on an idle machine only: WALNUT_TEST_WORKERS=4 npm test
 */

/** Hard ceiling — no override may exceed this. */
const ABSOLUTE_MAX = 4

/** Worker processes allowed concurrently, machine-wide. */
export function maxWorkers(): number {
  // CI runners are isolated single-purpose machines — no shared-box risk.
  if (process.env.CI) return 4
  const n = Number(process.env.WALNUT_TEST_WORKERS)
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), ABSOLUTE_MAX)
  return 2
}

/** Per-worker V8 heap cap. One uncapped worker was measured at 4.7GB RSS. */
export function workerExecArgv(): string[] {
  const mb = Number(process.env.WALNUT_TEST_WORKER_HEAP_MB)
  const heap = Number.isFinite(mb) && mb >= 512 ? Math.floor(mb) : 2048
  return [`--max-old-space-size=${heap}`]
}
