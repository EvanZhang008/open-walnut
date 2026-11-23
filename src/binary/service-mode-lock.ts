/**
 * One writer at a time of `<install root>/service-mode.json` (service-mode.ts): the leader switch's
 * setServiceRole (in the runtime's process) and `walnut daemon install|update|uninstall` (the CLI)
 * each read the mode, decide and write it. Without a lock the update could read a replica mode, the
 * switch write the leader role, and the update write the replica back with its new version: the
 * leader role lost. Each read-decide-write runs while holding `service-mode.lock`.
 *
 * The lock is a file made with O_EXCL naming its holder (`pid=`, `at=`). A lock whose process is
 * gone, or that is older than LOCK_STALE_MS (a held section lasts milliseconds), is stale: it is
 * moved aside (an atomic rename, after a second read shows the same holder) and taken again.
 * The sync form never waits (the runtime's event loop must not block): a held lock throws
 * ServiceModeBusyError, and its caller tries again later. The async form waits, a few times a second.
 *
 * Reads only node:fs and node:path, like service-mode.ts.
 */
import fs from 'node:fs'
import path from 'node:path'

export const SERVICE_MODE_LOCK_FILE = 'service-mode.lock'
export const LOCK_STALE_MS = 30_000

export class ServiceModeBusyError extends Error {
  constructor(readonly holder: string) {
    super(`mode_busy: another writer holds the service mode (${holder || 'unknown holder'}); try again`)
    this.name = 'ServiceModeBusyError'
  }
}

export interface LockFs {
  openSync(file: string, flags: string, mode: number): number
  writeSync(fd: number, text: string): number
  closeSync(fd: number): void
  readFileSync(file: string, encoding: 'utf8'): string
  renameSync(from: string, to: string): void
  linkSync(existing: string, link: string): void
  rmSync(file: string, opts: { force: true }): void
}

function holderAlive(pid: number): boolean {
  if (!(pid > 1)) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Whether the holder text names a lock nobody holds any more. */
export function lockIsStale(text: string, now: number, alive: (pid: number) => boolean = holderAlive): boolean {
  const pid = Number(/^pid=(\d+)$/m.exec(text)?.[1])
  const at = Number(/^at=(\d+)$/m.exec(text)?.[1])
  if (!(at > 0) || now - at > LOCK_STALE_MS) return true
  return !alive(pid)
}

/** Takes the lock, or null when a live holder has it. Returns its release. */
export function tryLockServiceMode(stateDir: string, o: { f?: LockFs; now?: () => number; alive?: (pid: number) => boolean } = {}): (() => void) | null {
  const f = o.f ?? fs
  const now = o.now ?? Date.now
  const file = path.join(stateDir, SERVICE_MODE_LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = f.openSync(file, 'wx', 0o600)
      const mine = `pid=${process.pid}\nat=${now()}\n`
      try { f.writeSync(fd, mine) } finally { f.closeSync(fd) }
      return () => {
        // Only our own: a lock broken as stale and taken by another writer is theirs.
        let text = ''
        try { text = f.readFileSync(file, 'utf8') } catch { return }
        if (text === mine) f.rmSync(file, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let held = ''
    try { held = f.readFileSync(file, 'utf8') } catch { continue }
    if (!lockIsStale(held, now(), o.alive)) return null
    // Break it only if it still names the same holder, by an atomic move aside.
    let again = ''
    try { again = f.readFileSync(file, 'utf8') } catch { continue }
    if (again !== held) return null
    const aside = `${file}.stale.${process.pid}.${now()}`
    try { f.renameSync(file, aside) } catch { continue /* another writer broke it first */ }
    // Two writers breaking one stale lock at once: the second rename can move the first one's fresh
    // lock aside. What was moved is not the stale holder: put it back (link fails if one is there now).
    let moved = ''
    try { moved = f.readFileSync(aside, 'utf8') } catch { /* gone */ }
    if (moved && moved !== held) { try { f.linkSync(aside, file) } catch { /* a newer lock is there */ } }
    f.rmSync(aside, { force: true })
    if (moved && moved !== held) return null
  }
  return null
}

function holderOf(stateDir: string, f: LockFs): string {
  try { return f.readFileSync(path.join(stateDir, SERVICE_MODE_LOCK_FILE), 'utf8').trim().replace(/\n/g, ' ') } catch { return '' }
}

/** Runs `fn` holding the lock; a lock a live writer holds throws ServiceModeBusyError at once. */
export function withServiceModeLock<T>(stateDir: string, fn: () => T, o: { f?: LockFs } = {}): T {
  const release = tryLockServiceMode(stateDir, o)
  if (!release) throw new ServiceModeBusyError(holderOf(stateDir, o.f ?? fs))
  try { return fn() } finally { release() }
}

/** Runs `fn` holding the lock, waiting for it up to `waitMs` (then ServiceModeBusyError). */
export async function withServiceModeLockWait<T>(stateDir: string, fn: () => T | Promise<T>, o: { waitMs?: number; pollMs?: number; f?: LockFs } = {}): Promise<T> {
  const end = Date.now() + (o.waitMs ?? 10_000)
  for (;;) {
    const release = tryLockServiceMode(stateDir, o)
    if (release) {
      try { return await fn() } finally { release() }
    }
    if (Date.now() >= end) throw new ServiceModeBusyError(holderOf(stateDir, o.f ?? fs))
    await new Promise((resolve) => setTimeout(resolve, o.pollMs ?? 200))
  }
}
