/**
 * Quarantined test files: ones that fail at random, so they block lands and pushes that have
 * nothing to do with them. A file listed here leaves the quick tier (local runs, the land check,
 * the push gate) and runs in the slow tier instead, which CI runs on every push with retries, so
 * its coverage stays in the deep layer while it is being fixed.
 *
 * DATA, not judgement: every entry names its evidence from the land and push-gate history
 * (docs/reference/testing-pipeline.md, "Quarantine"). An entry leaves once its file passes ten
 * runs in a row under load (`bun run test:focus <file>` ten times on a busy host), or it is fixed at the
 * cause. `bun scripts/test-layers.mjs report` names entries older than 21 days.
 *
 * tests/setup/quick-tier.test.ts keeps the partition whole: quick excludes exactly these plus
 * the slow list, slow includes them, so no file runs in no tier.
 */

export interface QuarantineEntry {
  /** Repo-root-relative test file. */
  file: string
  /** YYYY-MM-DD it was quarantined. */
  since: string
  /** What fails and why it is not the change under test (one line). */
  reason: string
  /** Where it was seen: counts from the land checks and push gates. */
  evidence: string
}

// 2026-11-07: every file of the land checks and push gates of 11-05..07 that failed at random
// (on a clean main, or for 4+ unrelated tasks) and never failed rightly. Scan tests (ratchets,
// guards) are never quarantined: a rule check that times out is made faster instead.
export const QUARANTINE: readonly QuarantineEntry[] = [
  { file: 'tests/core/host-server-manager.test.ts', since: '2026-11-07', reason: 'fails at random under load (a timeout or a lost race); no change was ever refused for it rightly', evidence: 'land checks of 4 unrelated tasks (11-05..07)' },
  { file: 'tests/core/offline-merge/drain-online-rules.test.ts', since: '2026-11-07', reason: 'fails at random under load (a timeout or a lost race); no change was ever refused for it rightly', evidence: 'land checks of 4 unrelated tasks (11-05..07); failed a push gate on a wall-clock bound (149 ms > 100 ms)' },
  { file: 'tests/core/plugin-new-task-defaults.test.ts', since: '2026-11-07', reason: 'fails at random under load (a timeout or a lost race); no change was ever refused for it rightly', evidence: 'land checks of 4 unrelated tasks (11-05..07)' },
  { file: 'tests/core/push-waits-for-plugin-load.test.ts', since: '2026-11-07', reason: 'fails at random under load (a timeout or a lost race); no change was ever refused for it rightly', evidence: 'land checks of 5 unrelated tasks (11-05..07); failed at random on a clean main 4x in land checks' },
  { file: 'tests/providers/mock-daemon-death-order.test.ts', since: '2026-11-07', reason: 'fails at random under load (a timeout or a lost race); no change was ever refused for it rightly', evidence: 'land checks of 3 unrelated tasks (11-05..07); failed 2 push gates on GitHub (11-05, 11-07) with no change of its own' },
  { file: 'tests/web/routes/voice-archive-cloud.test.ts', since: '2026-11-07', reason: 'fails at random under load (a timeout or a lost race); no change was ever refused for it rightly', evidence: 'land checks of 12 unrelated tasks (11-05..07); failed at random on a clean main 11x in land checks' },
]

export const QUARANTINED_TEST_FILES: readonly string[] = QUARANTINE.map((q) => q.file)
