/**
 * A daemon that still runs after its door files (daemon.port, daemon.instance, daemon.pid) were
 * removed under it: a temp cleaner, a person, a stop that judged the wrong pid dead. Every
 * starter that reads only the files saw no daemon, and the daemon it started met the live one's
 * instance lock and exited, so no port file ever came ("port file not created within 10s",
 * 2026-11-25: a Mac's 15-day-old daemon, every session start failed for two days). The lock still
 * names the daemon with its port, so its files are written back from there, never over one
 * that says something else (two daemons' files mixed is worse than none), the pid file last: it
 * is what says a daemon runs here.
 *
 * Callers: the server's start (local-daemon.ts ensureRunningInner), a daemon program that meets
 * a live owner (daemon-standalone.ts startDaemon, the remote start's path too), `walnut net join`.
 */
import nodeFs from 'node:fs'
import path from 'node:path'
import { readDaemonInstanceOwner, type DaemonLockOwnerInfo } from './daemon-instance-lock.js'

/** The door files, the pid file last (the order they are written back in). */
export const DOOR_FILE_NAMES = ['daemon.port', 'daemon.instance', 'daemon.pid'] as const

export interface LostDaemon {
  pid: number
  port: number
  instanceId: string
}

type LostFilesFs = Pick<typeof nodeFs, 'existsSync' | 'readFileSync' | 'writeFileSync'>

/** Whether any door file is missing from `dir` (no lock probe needed otherwise). */
export function doorFilesMissing(dir: string, fsApi: LostFilesFs = nodeFs): boolean {
  return DOOR_FILE_NAMES.some((name) => !fsApi.existsSync(path.join(dir, name)))
}

/**
 * Writes back the missing door files of `owner`, the daemon holding `dir`'s instance lock, once it
 * answers hello on the lock's port as the lock's instance. `hello` gives the instance id that
 * answered there, or null. Null when nothing was missing, nothing answers as the owner, the owner
 * runs inside a server (it has no daemon.pid of its own), or a file there names something else.
 */
export async function writeBackDoorFiles(opts: {
  dir: string
  owner: DaemonLockOwnerInfo | null
  hello: (port: number) => Promise<string | null>
  fs?: LostFilesFs
}): Promise<LostDaemon | null> {
  const fsApi = opts.fs ?? nodeFs
  const owner = opts.owner
  if (!doorFilesMissing(opts.dir, fsApi)) return null
  if (!owner || !(owner.pid > 1) || owner.wsPort === null || !owner.instanceId || owner.inProcess) return null
  let answered: string | null = null
  try { answered = await opts.hello(owner.wsPort) } catch { return null }
  if (answered !== owner.instanceId) return null
  const text: Record<(typeof DOOR_FILE_NAMES)[number], string> = {
    'daemon.port': String(owner.wsPort), 'daemon.instance': owner.instanceId, 'daemon.pid': String(owner.pid),
  }
  // Every survivor checked before anything is written: one that names something else leaves the
  // dir as it was, never a mix of two daemons' files.
  const missing: Array<(typeof DOOR_FILE_NAMES)[number]> = []
  for (const name of DOOR_FILE_NAMES) {
    const file = path.join(opts.dir, name)
    if (!fsApi.existsSync(file)) { missing.push(name); continue }
    try { if (String(fsApi.readFileSync(file, 'utf8')).trim() !== text[name]) return null } catch { return null }
  }
  for (const name of missing) {
    const file = path.join(opts.dir, name)
    try { fsApi.writeFileSync(file, text[name], { flag: 'wx', mode: 0o600 }) } catch (err) {
      // Written meanwhile (the owner's keeper, or a new owner): it must say the same.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
      try { if (String(fsApi.readFileSync(file, 'utf8')).trim() !== text[name]) return null } catch { return null }
    }
  }
  return { pid: owner.pid, port: owner.wsPort, instanceId: owner.instanceId }
}

/** The same, reading the owner from `dir`'s instance lock first (only when a file is missing). */
export async function recoverLostDaemonFiles(opts: {
  dir: string
  uid: number
  hello: (port: number) => Promise<string | null>
  fs?: LostFilesFs
  readOwner?: typeof readDaemonInstanceOwner
}): Promise<LostDaemon | null> {
  const fsApi = opts.fs ?? nodeFs
  if (!doorFilesMissing(opts.dir, fsApi)) return null
  const owner = await (opts.readOwner ?? readDaemonInstanceOwner)({ runtimeDir: opts.dir, uid: opts.uid })
  return writeBackDoorFiles({ dir: opts.dir, owner, hello: opts.hello, fs: fsApi })
}
