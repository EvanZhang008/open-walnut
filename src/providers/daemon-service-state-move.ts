/**
 * The durable state a production daemon keeps outside /tmp lives in two places:
 * an unmanaged daemon's under ~/.open-walnut/tmp, a service daemon's in the
 * install root (daemon-standalone.ts: RESUME_RECORD_DIR, REPLICA_DIR,
 * HOST_SERVER_DIR, PLUGIN_JOBS_DIR, HOST_EXEC_DIR). When one becomes the other, the state moves
 * with it, so the next daemon adopts the plugin jobs and the host server still
 * running instead of starting second copies. Trigger state is not here: the
 * daemon reads its older place itself (LEGACY_TRIGGER_STATE_DIRS).
 *
 * Only ever called with no daemon running in between (after a handover, or after
 * an uninstall stopped the service), and a target that already exists is kept:
 * it is newer than anything there is to move.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const DAEMON_DURABLE_STATE_DIRS = ['resume-records', 'host-replica', 'host-server', 'plugin-jobs', 'host-exec'] as const

export function unmanagedStateRoot(home: string): string {
  return path.join(home, '.open-walnut', 'tmp')
}

/** Move each named dir from `from` to `to` when only `from` has it. Returns the names moved. */
export async function moveDaemonState(from: string, to: string): Promise<string[]> {
  const moved: string[] = []
  for (const name of DAEMON_DURABLE_STATE_DIRS) {
    const src = path.join(from, name)
    const dst = path.join(to, name)
    const have = await fs.lstat(src).catch(() => null)
    if (!have?.isDirectory() || have.isSymbolicLink()) continue
    if (await fs.lstat(dst).catch(() => null)) continue
    await fs.mkdir(to, { recursive: true, mode: 0o700 })
    try {
      await fs.rename(src, dst)
      moved.push(name)
    } catch (error) {
      // Another filesystem: leave it; the daemon starts that part fresh.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
  }
  return moved
}
