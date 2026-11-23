/**
 * What a successful `walnut daemon uninstall` removes after the service itself (daemon-service-cli.ts),
 * in this order:
 *   - the launcher's own files: its script (systemd, launchd; cron's is the boot script, removed with the
 *     service) and its dir,
 *   - the service mode (no launcher, no service: a later install starts as the daemon unless its leader
 *     says otherwise),
 *   - a boot-setup marker that tells the server not to set it up again (remote-boot-start.ts
 *     BOOT_SETUP_MARKER); a later install wins,
 *   - the default set: the claim on its place (service-set-choice.ts releaseSetOwner; review round 2, H-L2),
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
}

/** Returns what became of a set's own dir; null for the default set. */
export async function afterServiceUninstall(o: UninstallTailInput): Promise<SetRemoveResult | null> {
  const root = o.set.installRoot
  await fs.rm(path.join(root, LAUNCHER_SCRIPT_NAME), { force: true }).catch(() => {})
  await fs.rm(path.join(root, LAUNCHER_DIR_NAME), { recursive: true, force: true }).catch(() => {})
  await removeServiceMode(root).catch(() => { /* the entry reads a doubt as the daemon */ })
  await fs.writeFile(path.join(root, 'boot-setup'), `v=uninstall at=${Date.now()} result=removed\n`, { mode: 0o600 }).catch(() => {})
  if (!o.set.id) {
    await releaseSetOwner(root).catch((error: unknown) => o.say(`walnut daemon: the claim on the default service's place stays: ${String(error)}\n`))
    return null
  }
  const pinned = o.unitConfig ? readDaemonServiceDir(o.platform, o.unitConfig) : null
  const gone = await removeServiceSetDir(o.home, o.set, o.uid, { ...o.removeDeps, unitRuntimeDir: pinned })
    .catch((error: unknown): SetRemoveResult => ({ removed: false, dir: root, why: String(error) }))
  o.say(gone.removed ? `walnut daemon: removed the service set's dir ${gone.dir}\n` : `walnut daemon: kept the service set's dir ${gone.dir}: ${gone.why}\n`)
  return gone
}
