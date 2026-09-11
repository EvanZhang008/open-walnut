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
 * Copy ONLY the named top-level sections out of the user's real config.yaml into
 * a test WALNUT_HOME.
 *
 * NEVER `copyFile` the real config into a test home. The 2026-09-02 leak: the
 * live-daemon tests copied it wholesale for its `hosts` block, which also handed
 * their sync plugins the user's REAL provider credentials. A fixture task created
 * against that server was pushed to the user's actual account and created a
 * remote list there; days later the production server pulled that list back and
 * re-created a project the user had deleted, with the fixture task inside it.
 *
 * `plugins`, `provider`/`providers`, `stt`, `push` and friends are therefore
 * simply absent from the copy — a test that needs one must name it, in the open.
 * (The plugin loader refuses remote-writing sync plugins in a test home anyway;
 * these are two independent layers, and this one keeps the credentials off disk.)
 *
 * Returns the sections actually found, so a caller can assert on what it got.
 */
export async function copyConfigSections(
  destHome: string,
  sections: string[] = ['version', 'hosts', 'session_server'],
): Promise<string[]> {
  const yaml = await import('js-yaml');
  const realPath = path.join(os.homedir(), '.open-walnut', 'config.yaml');
  const raw = await fs.readFile(realPath, 'utf-8');
  const parsed = (yaml.load(raw) ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  const found: string[] = [];
  for (const key of sections) {
    if (parsed[key] === undefined) continue;
    picked[key] = parsed[key];
    found.push(key);
  }
  await fs.mkdir(destHome, { recursive: true });
  await fs.writeFile(path.join(destHome, 'config.yaml'), yaml.dump(picked), 'utf-8');
  return found;
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
