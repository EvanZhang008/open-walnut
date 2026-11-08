import fs from 'node:fs';

/**
 * A SQLite handle kept open under the data home must not outlive a test's wipe of it.
 *
 * Tests remove WALNUT_HOME with fs.rm between cases, while the stores keep one handle per
 * process. On Linux an open handle keeps the deleted file and SQLite reads and writes it on,
 * so the next test sees the previous test's rows through it (2026-11-07: a stop one test left
 * pending was retried 5 s later inside the next test and sent to that test's daemon). So a
 * module that keeps a handle hands it out through `reopenIfWiped`.
 *
 * Only a test process looks at the disk: production never wipes its data home under a live
 * server, and there the handle is returned as it is. Every module that keeps such a handle is
 * listed in tests/core/test-home-wipe-isolation.test.ts.
 */
const TEST_PROCESS = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');

/**
 * The handle to serve for `file`: `current` while its file is there, else a fresh one from
 * `open()`. The fresh one is opened FIRST and `current` is closed only once it is open, because
 * the wipe may still be going on: a write that ends after a test (its afterEach removing the
 * home) used to close the handle and then fail to open the file in a folder being deleted, and
 * a store that failed to open stayed failed (2026-11-07, four tests after one late write). When
 * the open fails, `current` stays, writing into the removed file as it did before this check
 * existed. A home that is gone is opened afresh like any wiped one (the open makes its folder):
 * many tests remove the home and write before making it again, and a write kept on the old
 * handle there was lost to the read that followed once something made the folder
 * (2026-11-08, tests/web/routes/sessions-changes.test.ts read 404 for a record it had just made).
 */
export function reopenIfWiped<T>(file: string, current: T, open: () => T, close: (old: T) => void): T {
  if (!TEST_PROCESS || fs.existsSync(file)) return current;
  let fresh: T;
  try { fresh = open(); } catch { return current; }
  try { close(current); } catch { /* the fresh handle serves either way */ }
  return fresh;
}
