/**
 * The last step of `walnut daemon uninstall --yes --walnut <id>` for a set (never the default):
 * the set's own dir `~/.open-walnut-host/walnuts/<id16>/` (its install root with the staged
 * versions, about 400 MB, its runtime dir, its follower's data, logs and run dirs) goes once
 * nothing of the set still runs there. Drill D5 (2026-11-23): the uninstall left all of it.
 *
 * Kept, with the reason, while any of these lives (a pid alive with the start time recorded):
 *   - the set's daemon (daemon.pid in its runtime dir: the one the removed unit pinned, its
 *     WALNUT_DAEMON_DIR, and the one the set computes now; review round 2, H-L3),
 *   - a CLI of the set: an entry of the daemon's registry (`<install root>/sessions.json`). A stopped
 *     service leaves its CLIs running by design, and they still write into the set's dirs,
 *   - a follower the set's daemon started (`<install root>/host-server/server-*.pid`, host-server-core.ts;
 *     review round 2, H1: the twins' HOST_SERVER_DIR),
 *   - a detached run of the set (`<install root>/detached/*.run`, detached-registry.ts: a host_exec run,
 *     a plugin script or an ACP worker that outlives the daemon; review round 2, H-L4).
 * A registry or pid file that does not read is no proof that nothing runs: kept too.
 *
 * The machine id, the cli-owner records and walnut-net are every set's (service-set.ts) and are
 * never touched; nor is anything outside this set's own dir, except its /tmp runtime fallback.
 */
import fs from 'node:fs/promises'
import nodeFs from 'node:fs'
import path from 'node:path'
import { isServiceSetId, isServiceSetRuntimeDir, serviceSetBase, type ServiceSet } from './service-set.js'
import { defaultReadStartTime } from './daemon-core.js'
import { DETACHED_RUNS_STATE_DIR, HOST_SERVER_STATE_DIR } from './daemon-service-state-move.js'
import { DETACHED_KINDS, processStart, readRegistry } from './detached-registry.js'

export interface SetRemoveDeps {
  /** kill(pid, 0): true unless the pid is gone (EPERM counts as alive). */
  isAlive?(pid: number): boolean
  /** The pid's start time as the daemon records it, null when gone. */
  startTimeOf?(pid: number): string | null
  /** What ps names as the pid's start, as the detached registry records it (detached-registry.ts processStart). */
  psStartOf?(pid: number): Promise<string | null>
  /** The runtime dir the removed unit pinned (its WALNUT_DAEMON_DIR), when it named one. */
  unitRuntimeDir?: string | null
}

export type SetRemoveResult = { removed: true; dir: string } | { removed: false; dir: string; why: string }

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

type Checks = Required<Omit<SetRemoveDeps, 'unitRuntimeDir'>>

/** Is this recorded process still the one recorded? A start time that cannot be read counts as alive. */
function lives(pid: unknown, startTime: unknown, d: Checks): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || !d.isAlive(pid)) return false
  if (typeof startTime !== 'string' || !startTime) return true
  const now = d.startTimeOf(pid)
  return now === null ? false : now === startTime
}

async function readJson(file: string): Promise<{ missing: true } | { missing: false; value: unknown }> {
  let text: string
  try { text = await fs.readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    throw error
  }
  return { missing: false, value: JSON.parse(text) }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** What of the set still runs, in words; null when nothing does. */
async function stillRuns(set: ServiceSet, runtimeDirs: string[], d: Checks): Promise<string | null> {
  for (const dir of runtimeDirs) {
    const pid = Number((await fs.readFile(path.join(dir, 'daemon.pid'), 'utf8').catch(() => '')).trim())
    if (Number.isSafeInteger(pid) && pid > 1 && d.isAlive(pid)) return `its daemon still runs (pid ${pid})`
  }
  let registry
  try { registry = await readJson(path.join(set.installRoot, 'sessions.json')) } catch (e) {
    return `its session registry does not read (${(e as Error).message.split('\n')[0]})`
  }
  if (!registry.missing) {
    const sessions = (registry.value as { sessions?: unknown } | null)?.sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return 'its session registry does not read'
    const live = Object.entries(sessions as Record<string, { pid?: unknown; startTime?: unknown }>)
      .filter(([, e]) => lives(e?.pid, e?.startTime, d)).map(([sid]) => sid)
    if (live.length) return `${live.length} CLI${plural(live.length, '', 's')} of the set still run${plural(live.length, 's', '')} (${live.slice(0, 3).join(', ')}); stop ${plural(live.length, 'it', 'them')} and uninstall again`
  }
  const followers = path.join(set.installRoot, HOST_SERVER_STATE_DIR)
  const names = await fs.readdir(followers).catch(() => [] as string[])
  for (const name of names.filter((n) => /^server-.*\.pid$/.test(n))) {
    let held
    try { held = await readJson(path.join(followers, name)) } catch { return `its follower's pid file ${name} does not read` }
    if (held.missing) continue
    const h = held.value as { pid?: unknown; startTime?: unknown } | null
    if (lives(h?.pid, h?.startTime, d)) return `its follower still runs (pid ${String(h?.pid)})`
  }
  // A detached run lives while the process ps named at its start holds its pid; one listed before ps
  // named it (lstart empty), or whose start ps cannot read now, counts as alive.
  const detached = path.join(set.installRoot, DETACHED_RUNS_STATE_DIR)
  const runs: string[] = []
  for (const kind of DETACHED_KINDS) {
    for (const e of await readRegistry(detached, kind)) {
      if (!d.isAlive(e.pid)) continue
      const now = e.lstart ? await d.psStartOf(e.pid) : null
      if (!e.lstart || now === null || now === e.lstart) runs.push(`${kind} ${e.id}`)
    }
  }
  if (runs.length) return `${runs.length} detached run${plural(runs.length, '', 's')} of the set still run${plural(runs.length, 's', '')} (${runs.slice(0, 3).join(', ')}); stop ${plural(runs.length, 'it', 'them')} and uninstall again`
  return null
}

/** Remove the set's own dir when nothing of it runs; the default set is never removed here. */
export async function removeServiceSetDir(home: string, set: ServiceSet, uid: number, deps: SetRemoveDeps = {}): Promise<SetRemoveResult> {
  if (!isServiceSetId(set.id)) throw new Error('only a service set\'s own dir is removed, never the default\'s')
  const dir = serviceSetBase(home, set.id)
  const d: Checks = {
    isAlive: deps.isAlive ?? defaultIsAlive,
    startTimeOf: deps.startTimeOf ?? ((pid) => defaultReadStartTime(nodeFs, pid)),
    psStartOf: deps.psStartOf ?? ((pid) => processStart(pid)),
  }
  // The unit's own dir first: a home that resolves otherwise now (a link, a length near the socket
  // limit) computes another one (review round 2, H-L3).
  const runtimeDirs = [...new Set([deps.unitRuntimeDir, set.runtimeDir].filter((x): x is string => !!x && path.isAbsolute(x)))]
  const st = await fs.lstat(dir).catch(() => null)
  if (!st) return { removed: true, dir }
  if (!st.isDirectory() || st.isSymbolicLink()) return { removed: false, dir, why: 'it is not a plain directory' }
  const runs = await stillRuns(set, runtimeDirs, d)
  if (runs) return { removed: false, dir, why: runs }
  await fs.rm(dir, { recursive: true, force: true })
  // The /tmp fallback of a home too long for sockets lives outside the set's dir: only this set's own.
  for (const rt of runtimeDirs) {
    if (rt.startsWith(dir + path.sep) || !isServiceSetRuntimeDir(rt, home, uid) || !rt.endsWith(`-${set.id}`)) continue
    await fs.rm(rt, { recursive: true, force: true }).catch(() => {})
  }
  return { removed: true, dir }
}
