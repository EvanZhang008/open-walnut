/**
 * The standby's scratch folders on the leader (the home's `tmp/standby-staging` and
 * `tmp/standby-spool`, both rebuildable): each batch or spool keeps a folder named after its
 * process, and the folders of a process that is gone (a leader killed mid-batch) are removed by
 * the next batch or spool.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { pidAlive } from '../self-update/install-lock.js'

/** A batch's staging folder: `batch-<pid>-<time>` (batch.ts). */
export const STAGING_NAME = /^batch-(\d+)-\d+$/
/** A spool's folder: `<pid>-<random>` (remote-spool.ts). */
export const SPOOL_NAME = /^(\d+)-[0-9a-f]+$/

/** Remove the folders in `root` whose name (by `pattern`, the pid its first group) names a process that is gone. */
export async function removeDeadOwners(root: string, pattern: RegExp): Promise<number> {
  let removed = 0
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const pid = Number(pattern.exec(name)?.[1])
    if (!pid || pidAlive(pid)) continue
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})
    removed++
  }
  return removed
}
