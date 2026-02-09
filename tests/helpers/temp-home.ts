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
    cleanup: () => fs.rm(tmpPath, { recursive: true, force: true }),
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
