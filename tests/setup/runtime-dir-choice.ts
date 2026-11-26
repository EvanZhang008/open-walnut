/**
 * Which runtime dir (WALNUT_DAEMON_DIR) a test worker runs in. Pure, so the
 * rule is testable without loading the harness (runtime-dir-isolation.ts
 * applies it inside every worker; global-setup.ts sweeps what it leaves).
 *
 * Every worker gets a dir named for its own pid, whatever it inherited:
 *   - nothing, or the production default  → `<tmpdir>/<prefix><pid>`
 *   - the runner's (or another worker's) harness dir → `<tmpdir>/<prefix><pid>`
 *   - a dir the caller chose (CI sets one per job) → `<chosen>/<prefix><pid>`
 *
 * Never a shared one: a local daemon is found through the port file in this
 * dir, so two workers sharing it let one test file's server adopt the daemon
 * another file's server spawned, with that file's env (2026-10-02).
 */
import os from 'node:os'
import path from 'node:path'

/** The production runtime dir in /tmp: the server's log dir, and the daemon's dir on an older install. */
export const PROD_RUNTIME_DIR = '/tmp/open-walnut' // safe: comparison only

/**
 * The production daemon dirs: the one above and `<home>/.cache/open-walnut` (src/lib/daemon-dir.ts),
 * by $HOME and by the account's own home. A daemon hands its dir to every session it starts, so a
 * test run inside a Walnut session inherits one of them as WALNUT_DAEMON_DIR.
 */
export function productionRuntimeDirs(homes: Array<string | undefined> = [process.env.HOME, accountHome()]): string[] {
  return [PROD_RUNTIME_DIR, ...new Set(homes.filter((h): h is string => !!h && path.isAbsolute(h)).map((h) => path.join(h, '.cache', 'open-walnut')))]
}

function accountHome(): string | undefined {
  try { return os.userInfo().homedir } catch { return undefined }
}

/** Marks a dir this harness created; the rest of the name is the owner's pid. */
export const RUNTIME_DIR_PREFIX = 'open-walnut-test-runtime-'

export function pointsAtProductionRuntime(dir: string | undefined, prodDirs: string[] = productionRuntimeDirs()): boolean {
  if (!dir) return true
  const resolved = path.resolve(dir)
  return prodDirs.some((prod) => resolved === prod || resolved.startsWith(prod + path.sep))
}

/** A dir the caller chose for the run: not the production default, not one this harness made. */
export function isCallerChosenRuntime(dir: string | undefined): dir is string {
  return !pointsAtProductionRuntime(dir) && !path.basename(dir!).startsWith(RUNTIME_DIR_PREFIX)
}

/** The dir a worker with `pid` must switch to, or null when `current` is already its own. */
export function workerRuntimeDir(current: string | undefined, pid: number, tmpdir: string): string | null {
  const ours = `${RUNTIME_DIR_PREFIX}${pid}`
  if (current && !pointsAtProductionRuntime(current) && path.basename(current) === ours) return null
  return path.join(isCallerChosenRuntime(current) ? current : tmpdir, ours)
}
