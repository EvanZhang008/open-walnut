/**
 * What a successful `walnut daemon uninstall` removes after the service itself (daemon-service-cli.ts),
 * in this order:
 *   - the launcher's own files: its script (systemd, launchd; cron's is the boot script, removed with the
 *     service) and its dir,
 *   - the followers its server-*.pid files name (service-entry.ts stopOldFollowers): a daemon in its
 *     two-program fallback starts its follower in a process group of its own, so the service's stop
 *     leaves it running with no parent (drill r9 on a Mac),
 *   - the service mode (no launcher, no service: a later install starts as the daemon unless its leader
 *     says otherwise),
 *   - a boot-setup marker that tells the server not to set it up again (remote-boot-start.ts
 *     BOOT_SETUP_MARKER); a later install wins,
 *   - the default set: the claim on its place (service-set-choice.ts releaseSetOwner; review round 2, H-L2),
 *     when a service config was there to remove (round 3, L-H3),
 *   - a set: its own dir once nothing of it runs (service-set-remove.ts), judged at the runtime dir the
 *     removed unit pinned (its WALNUT_DAEMON_DIR; review round 2, H-L3); else it says why it stays.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { LAUNCHER_DIR_NAME, LAUNCHER_SCRIPT_NAME } from './service-launcher-script.js'
import { removeServiceMode } from '../binary/service-mode-update.js'
import { readDaemonServiceDir } from './daemon-service-config.js'
import { releaseSetOwner } from './service-set-choice.js'
import { removeServiceSetDir, type SetRemoveDeps, type SetRemoveResult } from './service-set-remove.js'
import { HOST_SERVER_STATE_DIR } from './daemon-service-state-move.js'
import type { ServicePlatform, ServiceSet } from './service-set.js'

export interface UninstallTailInput {
  home: string
  uid: number
  platform: ServicePlatform
  set: ServiceSet
  /** The removed service's config as it was before the uninstall (null: none read). */
  unitConfig: string | null
  /** A line for stderr. */
  say(line: string): void
  /** Tests: the process checks of the set's dir removal. */
  removeDeps?: SetRemoveDeps
  /** Tests: stops the followers these pid files name; false when one may still run (stopOldFollowers). */
  stopFollowers?: (pidFiles: string[]) => Promise<boolean>
}

/** Stop the followers the service's pid files name; a line on stderr when one may still run. */
async function stopFollowersOf(root: string, o: UninstallTailInput): Promise<void> {
  const dir = path.join(root, HOST_SERVER_STATE_DIR)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const pidFiles = names.filter((n) => /^server-.*\.pid$/.test(n)).map((n) => path.join(dir, n))
  if (!pidFiles.length) return
  const stop = o.stopFollowers ?? (async (files: string[]) => (await import('../binary/service-entry.js')).stopOldFollowers(files))
  const stopped = await stop(pidFiles).catch(() => false)
  if (!stopped) o.say(`walnut daemon: a follower of the service may still run (its pid file in ${dir} is kept)\n`)
}

/** Returns what became of a set's own dir; null for the default set. */
export async function afterServiceUninstall(o: UninstallTailInput): Promise<SetRemoveResult | null> {
  const root = o.set.installRoot
  await fs.rm(path.join(root, LAUNCHER_SCRIPT_NAME), { force: true }).catch(() => {})
  await fs.rm(path.join(root, LAUNCHER_DIR_NAME), { recursive: true, force: true }).catch(() => {})
  await stopFollowersOf(root, o)
  await removeServiceMode(root).catch(() => { /* the entry reads a doubt as the daemon */ })
  await fs.writeFile(path.join(root, 'boot-setup'), `v=uninstall at=${Date.now()} result=removed\n`, { mode: 0o600 }).catch(() => {})
  if (!o.set.id) {
    // Only when a service config was there to remove (review round 3, L-H3): an uninstall that found none
    // (another scope's) leaves the claim of the service that runs, and says nothing more than before.
    if (o.unitConfig !== null) await releaseSetOwner(root).catch((error: unknown) => o.say(`walnut daemon: the claim on the default service's place stays: ${String(error)}\n`))
    return null
  }
  const pinned = o.unitConfig ? readDaemonServiceDir(o.platform, o.unitConfig) : null
  const gone = await removeServiceSetDir(o.home, o.set, o.uid, { ...o.removeDeps, unitRuntimeDir: pinned })
    .catch((error: unknown): SetRemoveResult => ({ removed: false, dir: root, why: String(error) }))
  o.say(gone.removed ? `walnut daemon: removed the service set's dir ${gone.dir}\n` : `walnut daemon: kept the service set's dir ${gone.dir}: ${gone.why}\n`)
  return gone
}
