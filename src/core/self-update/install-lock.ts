/**
 * One update of a binary install at a time (binary-install.ts), shared with
 * install.sh, which takes the same lock with the same rules:
 *
 *   <root>/.update.lock/           made with one mkdir: whoever makes it holds it
 *   <root>/.update.lock/owner      "<pid> <token> <process start time>"
 *   <root>/.update.lock.takeover/  one taker at a time takes over a stale lock
 *
 * The lock is taken over only when its holder is provably gone: its pid is not
 * running, or that pid now belongs to a process that started at another time (a
 * reused pid), or the owner line was never written for a minute (a holder that
 * died between mkdir and the write). A holder that is alive, however slow, keeps
 * it. A takeover happens inside the takeover directory, judges the owner again
 * there, moves the lock aside and goes on only if what it moved is the very
 * directory it judged (its inode): two takers never both win, and a lock someone
 * made in between is put back. It is released only by the update holding it.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** An owner line that was never written is a lock being made, for at most this long. */
const UNOWNED_STALE_MS = 60_000

/** Does a process with this pid exist? (Signal 0 sends nothing.) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** When `pid` started, as `ps -o lstart=` prints it ('' when ps cannot say: a minimal container). */
export function processStart(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 1) return resolve('')
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5_000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : stdout.trim().replace(/\s+/g, ' '))
    })
  })
}

export interface LockDeps {
  now?: () => number
  alive?: (pid: number) => boolean
  started?: (pid: number) => Promise<string>
}

/** Whether the owner line `text` (or none) names a holder that is gone. */
async function ownerGone(text: string | null, lockAgeMs: number, deps: Required<LockDeps>): Promise<boolean> {
  if (text === null || !text.trim()) return lockAgeMs >= UNOWNED_STALE_MS
  const [pidText, , ...startWords] = text.trim().split(/\s+/)
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 1) return lockAgeMs >= UNOWNED_STALE_MS
  if (!deps.alive(pid)) return true
  // The same pid, another process: the holder is gone and its pid was handed on.
  const recorded = startWords.join(' ')
  if (!recorded) return false
  const now = await deps.started(pid)
  return now !== '' && now !== recorded
}

const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}
const statOf = (p: string): fs.Stats | null => {
  try { return fs.statSync(p) } catch { return null }
}

/**
 * Remove a stale lock, inside the takeover directory. True when the lock is
 * gone (mkdir then decides who holds it next), false when it is not stale after
 * all, or another taker is at it right now.
 */
async function takeOver(lock: string, d: Required<LockDeps>): Promise<boolean> {
  const gate = `${lock}.takeover`
  try {
    fs.mkdirSync(gate)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // A taker that died inside it: its takeover directory goes after a minute.
    const st = statOf(gate)
    if (st && d.now() - st.mtimeMs < UNOWNED_STALE_MS) return false
    fs.rmSync(gate, { recursive: true, force: true })
    try { fs.mkdirSync(gate) } catch { return false }
  }
  try {
    const judged = statOf(lock)
    if (!judged) return true
    if (!(await ownerGone(readText(path.join(lock, 'owner')), d.now() - judged.mtimeMs, d))) return false
    const aside = `${lock}.stale-${crypto.randomBytes(4).toString('hex')}`
    try {
      fs.renameSync(lock, aside)
    } catch {
      return true // released meanwhile
    }
    const moved = statOf(aside)
    if (!moved || moved.ino !== judged.ino || moved.dev !== judged.dev) {
      // A new lock replaced the stale one after the judging: it goes back.
      if (!fs.existsSync(lock)) { try { fs.renameSync(aside, lock) } catch { /* below */ } }
      fs.rmSync(aside, { recursive: true, force: true })
      return false
    }
    fs.rmSync(aside, { recursive: true, force: true })
    return true
  } finally {
    fs.rmSync(gate, { recursive: true, force: true })
  }
}

/**
 * Take `<root>/.update.lock`, or throw `another update of <root> is running`.
 * Resolves to the release, which removes the lock only while it is still this one.
 */
export async function takeLock(root: string, deps: LockDeps = {}): Promise<() => void> {
  const d: Required<LockDeps> = { now: deps.now ?? Date.now, alive: deps.alive ?? pidAlive, started: deps.started ?? processStart }
  const lock = path.join(root, '.update.lock')
  const ownerFile = path.join(lock, 'owner')
  const busy = () => new Error(`another update of ${root} is running`)
  const token = `${process.pid} ${crypto.randomBytes(6).toString('hex')} ${await d.started(process.pid)}`.trim()
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    if (attempt >= 2) throw busy()
    const st = statOf(lock)
    if (!st) continue // just released: try again
    if (!(await ownerGone(readText(ownerFile), d.now() - st.mtimeMs, d))) throw busy()
    if (!(await takeOver(lock, d))) throw busy()
  }
  fs.writeFileSync(ownerFile, `${token}\n`)
  return () => {
    if (readText(ownerFile)?.trim() === token) fs.rmSync(lock, { recursive: true, force: true })
  }
}
