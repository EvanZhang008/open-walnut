/**
 * The health monitor's auto-fixes: steps that are safe to take without asking,
 * because each only redoes what Walnut already does on its own clock (sooner)
 * and touches nothing but Walnut's own rebuildable files and records.
 *
 *  - `disk-sweep`: the task-directory sweep now (finished tasks' directories and
 *    their build output, never a repo with work found nowhere else), with the
 *    space it freed measured on the data disk.
 *  - `status-recheck`: the status check now, which re-derives what it can.
 */

import fsp from 'node:fs/promises'

const GiB = 1024 ** 3

export async function runAutoFix(id: string, dataDir: string): Promise<{ ok: boolean; detail: string }> {
  if (id === 'disk-sweep') {
    const free = async () => { const s = await fsp.statfs(dataDir); return s.bavail * s.bsize }
    const before = await free()
    const { sweepTaskDirsNow } = await import('../task-dir-sweep.js')
    const rows = await sweepTaskDirsNow()
    const after = await free()
    const removed = rows.reduce((n, r) => n + (Array.isArray(r.removed) ? r.removed.length : 0), 0)
    const freed = Math.max(0, after - before) / GiB
    return { ok: true, detail: `ran the task-directory sweep: ${removed} director${removed === 1 ? 'y' : 'ies'} removed, ${freed.toFixed(1)} GB freed` }
  }
  if (id === 'status-recheck') {
    const { runStatusCheck } = await import('../status-consistency.js')
    const found = await runStatusCheck()
    return { ok: true, detail: `ran the status check again: ${found.length} mismatch${found.length === 1 ? '' : 'es'} found and re-derived` }
  }
  return { ok: false, detail: `no auto-fix named ${id}` }
}
