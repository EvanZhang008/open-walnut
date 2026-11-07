import fs from 'node:fs';

/**
 * A SQLite handle kept open under the data home must not outlive a test's wipe of it.
 *
 * Tests remove WALNUT_HOME with fs.rm between cases, while the stores keep one handle per
 * process. On Linux an open handle keeps the deleted file and SQLite reads and writes it on,
 * so the next test sees the previous test's rows through it (2026-11-07: a stop one test left
 * pending was retried 5 s later inside the next test and sent to that test's daemon). So a
 * module that keeps a handle asks `sqliteFileGone(path)` before handing it out again, and
 * closes it and opens the path afresh when it says yes.
 *
 * Only a test process looks at the disk: production never wipes its data home under a live
 * server, and there the answer is a constant `false`. Every module that keeps such a handle is
 * listed in tests/core/test-home-wipe-isolation.test.ts.
 */
const TEST_PROCESS = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');

/** True in a test process when the database file a kept handle was opened on is no longer there. */
export function sqliteFileGone(file: string): boolean {
  return TEST_PROCESS && !fs.existsSync(file);
}
