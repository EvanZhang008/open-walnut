/**
 * The health monitor's auto-fixes: steps that are safe to take without asking,
 * because each only redoes what Walnut already does on its own clock (sooner)
 * and touches nothing but Walnut's own rebuildable files and records.
 *
 *  - `disk-sweep`: the task-directory sweep now (finished tasks' directories and
 *    their build output, never a repo with work found nowhere else), with the
 *    space it freed measured on the data disk.
 *  - `status-recheck`: the status check now, which re-derives what it can.
 *  - `host-reconnect`: a host link that is down and waiting out its backoff dials
 *    now (the human's Connect now). It never tears down a working link or its
 *    SSH master: a master that outlives an expired sign-in is what keeps a host
 *    working (ssh-control-master.ts, 2026-10-07), so a rebuild could cost the
 *    user a login. A link that is up, or one that waits on a sign-in, is left alone.
 */

import fsp from 'node:fs/promises'

const GiB = 1024 ** 3

export async function runAutoFix(id: string, dataDir: string, labels?: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
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
  if (id === 'host-reconnect') return reconnectHost(labels?.host)
  return { ok: false, detail: `no auto-fix named ${id}` }
}

const RECONNECT_WAIT_MS = 20_000

async function reconnectHost(host: string | undefined): Promise<{ ok: boolean; detail: string }> {
  if (!host) return { ok: false, detail: 'no host named' }
  const { peekDaemonConnection, reconnectHostNow } = await import('../../providers/daemon-connection.js')
  const { getReconnectCause } = await import('../../providers/daemon-reconnect-cause.js')
  const conn = peekDaemonConnection(host)
  if (!conn) return { ok: false, detail: `no link to ${host} is open` }
  if (conn.connected) return { ok: true, detail: `the link to ${host} is up now; left its SSH connection as it is` }
  const cause = getReconnectCause(host)
  if (cause?.standing) return { ok: false, detail: `the link to ${host} waits on ${cause.summary}; not dialled again` }
  const dial = reconnectHostNow(host)
  if (!dial) return { ok: false, detail: `the link to ${host} is already dialling` }
  const timer = new Promise<'slow'>((r) => { const t = setTimeout(() => r('slow'), RECONNECT_WAIT_MS); t.unref?.() })
  const out = await Promise.race([dial.then(() => 'done' as const, (err: unknown) => (err instanceof Error ? err.message : String(err))), timer])
  if (out === 'done' && conn.connected) return { ok: true, detail: `reconnected ${host} now instead of waiting out its backoff` }
  if (out === 'slow') return { ok: true, detail: `asked ${host} to reconnect now; still dialling` }
  return { ok: false, detail: `reconnecting ${host} failed: ${out === 'done' ? 'still not connected' : out}` }
}
