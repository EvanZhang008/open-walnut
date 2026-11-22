/**
 * The standby's scratch folders on the leader (the home's `tmp/standby-staging` and
 * `tmp/standby-spool`, both rebuildable): each batch or spool keeps a folder named after its
 * process, and the folders of a process that is gone (a leader killed mid-batch) are removed by
 * the next batch or spool. A folder of another process untouched for a day goes too: its pid
 * may now belong to some other program (a pid is reused), and no batch runs that long.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { pidAlive } from '../self-update/install-lock.js'

/** A batch's staging folder: `batch-<pid>-<time>` (batch.ts). */
export const STAGING_NAME = /^batch-(\d+)-\d+$/
/** A spool's folder: `<pid>-<random>` (remote-spool.ts). */
export const SPOOL_NAME = /^(\d+)-[0-9a-f]+$/
/** Another process's folder untouched this long is left over, whatever its pid says now. */
export const LEFT_OVER_MS = 24 * 60 * 60_000

/** Remove the folders in `root` whose name (by `pattern`, the pid its first group) names a process that is gone, or another process's untouched for a day. */
export async function removeDeadOwners(root: string, pattern: RegExp, now = Date.now()): Promise<number> {
  let removed = 0
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const pid = Number(pattern.exec(name)?.[1])
    if (!pid || pid === process.pid) continue
    const dir = path.join(root, name)
    if (pidAlive(pid)) {
      const st = await fs.stat(dir).catch(() => null)
      if (!st || now - st.mtimeMs < LEFT_OVER_MS) continue
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    removed++
  }
  return removed
}
