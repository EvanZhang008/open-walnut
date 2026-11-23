/**
 * The last step of `walnut daemon uninstall --yes --walnut <id>` for a set (never the default):
 * the set's own dir `~/.open-walnut-host/walnuts/<id16>/` (its install root with the staged
 * versions, about 400 MB, its runtime dir, its follower's data, logs and run dirs) goes once
 * nothing of the set still runs there. Drill D5 (2026-11-23): the uninstall left all of it.
 *
 * Kept, with the reason, while any of these lives (a pid alive with the start time recorded):
 *   - the set's daemon (its runtime dir's daemon.pid),
 *   - a CLI of the set: an entry of the daemon's registry (`<install root>/sessions.json`). A stopped
 *     service leaves its CLIs running by design, and they still write into the set's dirs,
 *   - a follower the set's daemon started (`<install root>/server-*.pid`, host-server-core.ts).
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

export interface SetRemoveDeps {
  /** kill(pid, 0): true unless the pid is gone (EPERM counts as alive). */
  isAlive?(pid: number): boolean
  /** The pid's start time as the daemon records it, null when gone. */
  startTimeOf?(pid: number): string | null
}

export type SetRemoveResult = { removed: true; dir: string } | { removed: false; dir: string; why: string }

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Is this recorded process still the one recorded? A start time that cannot be read counts as alive. */
function lives(pid: unknown, startTime: unknown, d: Required<SetRemoveDeps>): boolean {
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

/** What of the set still runs, in words; null when nothing does. */
async function stillRuns(set: ServiceSet, d: Required<SetRemoveDeps>): Promise<string | null> {
  const pid = Number((await fs.readFile(path.join(set.runtimeDir, 'daemon.pid'), 'utf8').catch(() => '')).trim())
  if (Number.isSafeInteger(pid) && pid > 1 && d.isAlive(pid)) return `its daemon still runs (pid ${pid})`
  let registry
  try { registry = await readJson(path.join(set.installRoot, 'sessions.json')) } catch (e) {
    return `its session registry does not read (${(e as Error).message.split('\n')[0]})`
  }
  if (!registry.missing) {
    const sessions = (registry.value as { sessions?: unknown } | null)?.sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return 'its session registry does not read'
    const live = Object.entries(sessions as Record<string, { pid?: unknown; startTime?: unknown }>)
      .filter(([, e]) => lives(e?.pid, e?.startTime, d)).map(([sid]) => sid)
    if (live.length) return `${live.length} CLI${live.length === 1 ? '' : 's'} of the set still run${live.length === 1 ? 's' : ''} (${live.slice(0, 3).join(', ')}); stop ${live.length === 1 ? 'it' : 'them'} and uninstall again`
  }
  const names = await fs.readdir(set.installRoot).catch(() => [] as string[])
  for (const name of names.filter((n) => /^server-.*\.pid$/.test(n))) {
    let held
    try { held = await readJson(path.join(set.installRoot, name)) } catch { return `its follower's pid file ${name} does not read` }
    if (held.missing) continue
    const h = held.value as { pid?: unknown; startTime?: unknown } | null
    if (lives(h?.pid, h?.startTime, d)) return `its follower still runs (pid ${String(h?.pid)})`
  }
  return null
}

/** Remove the set's own dir when nothing of it runs; the default set is never removed here. */
export async function removeServiceSetDir(home: string, set: ServiceSet, uid: number, deps: SetRemoveDeps = {}): Promise<SetRemoveResult> {
  if (!isServiceSetId(set.id)) throw new Error('only a service set\'s own dir is removed, never the default\'s')
  const dir = serviceSetBase(home, set.id)
  const d: Required<SetRemoveDeps> = {
    isAlive: deps.isAlive ?? defaultIsAlive,
    startTimeOf: deps.startTimeOf ?? ((pid) => defaultReadStartTime(nodeFs, pid)),
  }
  const st = await fs.lstat(dir).catch(() => null)
  if (!st) return { removed: true, dir }
  if (!st.isDirectory() || st.isSymbolicLink()) return { removed: false, dir, why: 'it is not a plain directory' }
  const runs = await stillRuns(set, d)
  if (runs) return { removed: false, dir, why: runs }
  await fs.rm(dir, { recursive: true, force: true })
  // The /tmp fallback of a home too long for sockets lives outside the set's dir.
  if (!set.runtimeDir.startsWith(dir + path.sep) && isServiceSetRuntimeDir(set.runtimeDir, home, uid)) {
    await fs.rm(set.runtimeDir, { recursive: true, force: true }).catch(() => {})
  }
  return { removed: true, dir }
}
