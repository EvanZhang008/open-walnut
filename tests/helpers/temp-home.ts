/**
 * Shared test utility: creates an isolated temporary home directory
 * for test isolation. Prevents tests from touching real user config.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface TempHome {
  /** Absolute path to the temporary directory */
  path: string;
  /** Clean up the temporary directory */
  cleanup: () => Promise<void>;
}

/**
 * Remove a test temp tree, tolerating writers that are still landing files.
 *
 * FAILURE MODE THIS EXISTS FOR — `ENOTEMPTY: rmdir '.../walnut-test-<ts>-<rand>'`:
 * plain `fs.rm(dir, {recursive:true, force:true})` defaults to `maxRetries:0`.
 * Node's rimraf reads a directory's entries, unlinks them, then `rmdir`s the
 * directory. If a fire-and-forget writer creates a NEW entry after that listing
 * — the 2s logger flush recreating LOG_DIR, the observability incident sink
 * writing incidents.json + an evidence bundle, an in-flight atomic-write tmp
 * file — the final `rmdir` sees a non-empty dir and throws. `force` does NOT
 * cover this (it only suppresses ENOENT), so the reject surfaces as a failure of
 * whichever test happened to own the afterEach hook. Measured: 26/30 with a
 * single late writer, 0/30 with retries (ENOTEMPTY is in Node's retry set).
 *
 * Passing retries makes cleanup converge instead of racing. Prefer this over
 * bare `fs.rm` in any hook that tears down a WALNUT_HOME-style temp tree.
 */
export async function removeTempTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

/**
 * Create a unique temporary directory for test isolation.
 * @param prefix - Optional prefix for the temp dir name (default: 'walnut-test')
 */
export async function createTempHome(prefix = 'walnut-test'): Promise<TempHome> {
  const tmpPath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpPath, { recursive: true });
  return {
    path: tmpPath,
    cleanup: () => removeTempTree(tmpPath),
  };
}

/**
 * Run a function with an isolated temp directory, auto-cleaning afterwards.
 */
export async function withTempHome<T>(
  fn: (homePath: string) => Promise<T>,
  prefix = 'walnut-test',
): Promise<T> {
  const home = await createTempHome(prefix);
  try {
    return await fn(home.path);
  } finally {
    await home.cleanup();
  }
}
