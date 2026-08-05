/**
 * Single-instance lock: at most ONE server process may own a given data
 * directory (WALNUT_HOME).
 *
 * Why this exists (2026-08-04 incident): a stray `node dist/cli.js web --port
 * 3467` (production mode, same ~/.open-walnut) ran alongside the real :3456
 * server for a day. Both processes hold an in-process whole-store task cache
 * (task-manager.ts taskStoreCache) that is only invalidated by their OWN
 * writes, and writeStore() persists a full snapshot that DELETES rows absent
 * from it — so each server silently erased the tasks the other had just
 * created. Different PORT does not mean different DATA: the lock therefore
 * guards WALNUT_HOME, not the port.
 *
 * Mechanics: an O_EXCL-created lock file at {WALNUT_HOME}/server.lock.json
 * containing {pid, port, startedAt}. On conflict we probe the recorded pid
 * with kill(pid, 0):
 *   - alive  → refuse to start (throw InstanceLockError with actionable text)
 *   - dead   → stale lock from a crash (SIGKILL skips our cleanup) → take over
 * The lock is removed on stopServer() and on normal process exit. Ephemeral
 * servers / tests use their own throwaway HOME, so they lock their own dir and
 * never conflict with production.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WALNUT_HOME, TASKS_DIR } from '../constants.js'
import { log } from '../logging/index.js'

const execFileAsync = promisify(execFile)

const LOCK_FILE = path.join(WALNUT_HOME, 'server.lock.json')
/** Same value as task-db.ts TASK_DB_PATH — computed here to avoid importing the DB module. */
const TASK_DB_FILE = path.join(TASKS_DIR, 'tasks.sqlite')

interface LockPayload {
  pid: number
  port: number | null
  startedAt: string
}

export class InstanceLockError extends Error {
  constructor(holder: LockPayload) {
    super(
      `Another Walnut server (pid ${holder.pid}, port ${holder.port ?? '?'}, started ${holder.startedAt}) ` +
      `already owns ${WALNUT_HOME}. Two servers on one data directory silently corrupt each other's ` +
      `writes (stale-cache full-snapshot rewrites delete the other's new tasks). ` +
      `Use \`--ephemeral\` for a test server on a snapshot copy, or stop the other process first.`,
    )
    this.name = 'InstanceLockError'
  }
}

function readLock(): LockPayload | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as LockPayload
    return typeof raw?.pid === 'number' ? raw : null
  } catch {
    return null // missing or corrupt — treat as absent (corrupt = stale by definition)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but not ours — still alive. ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

let held = false

/**
 * Acquire the single-instance lock for WALNUT_HOME or throw InstanceLockError.
 * Call once from startServer() before any subsystem opens the databases.
 */
export function acquireInstanceLock(port: number | null): void {
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  const payload: LockPayload = { pid: process.pid, port, startedAt: new Date().toISOString() }
  const body = JSON.stringify(payload)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, body, { flag: 'wx' })
      held = true
      installExitCleanup()
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = readLock()
      if (holder && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw new InstanceLockError(holder)
      }
      // Stale (dead holder / corrupt) — remove and retry the exclusive create.
      log.web.warn('stale instance lock — taking over', { staleHolder: holder ?? 'corrupt', lockFile: LOCK_FILE })
      try { fs.unlinkSync(LOCK_FILE) } catch { /* raced with another starter; retry handles it */ }
    }
  }
  // Two failed takeover attempts = a live racer beat us both times.
  const holder = readLock()
  throw new InstanceLockError(holder ?? { pid: -1, port: null, startedAt: 'unknown' })
}

/** Update the recorded port once listen() resolves (port 0 → real port). */
export function updateInstanceLockPort(port: number): void {
  if (!held) return
  const current = readLock()
  if (current?.pid !== process.pid) return
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ ...current, port }))
  } catch { /* cosmetic only */ }
}

/** Release the lock if this process holds it. Safe to call repeatedly. */
export function releaseInstanceLock(): void {
  if (!held) return
  held = false
  const current = readLock()
  if (current?.pid !== process.pid) return // someone took over after our crash-probe — not ours
  try { fs.unlinkSync(LOCK_FILE) } catch { /* already gone */ }
}

let exitHookInstalled = false
function installExitCleanup(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', releaseInstanceLock)
}

// ── Layer 2: foreign DB-holder detection ──────────────────────────────────
//
// The lock file only stops lock-AWARE builds. An old binary / stale dist copy
// predating the lock will happily open the same tasks.sqlite. lsof tells us
// who actually HOLDS the database file, regardless of what code they run.
//
// False-positive guard: hook child processes (on-stop/on-compact,
// src/hooks/shared.ts) open the DB for milliseconds. Every caller therefore
// requires the SAME pid to hold the file across two probes ~1.5s apart before
// treating it as a resident co-writer. lsof missing/failing = fail open.

export interface DbHolder {
  pid: number
  command: string
}

/** Processes (other than us) currently holding tasks.sqlite open. */
export async function listForeignDbHolders(): Promise<DbHolder[]> {
  try {
    // -F pc → parseable "p<pid>\nc<command>" pairs. Exit code 1 = no holders.
    const { stdout } = await execFileAsync('lsof', ['-nP', '-F', 'pc', TASK_DB_FILE], { timeout: 10_000 })
    const holders: DbHolder[] = []
    let pid: number | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('c') && pid !== null && pid !== process.pid) {
        holders.push({ pid, command: line.slice(1) })
        pid = null
      }
    }
    return holders
  } catch {
    return [] // no holders (lsof exit 1), lsof absent, or timeout — fail open
  }
}

/** Holders present in BOTH probes (spaced by `gapMs`) — i.e. resident, not a transient hook. */
export async function listPersistentForeignDbHolders(gapMs = 1500): Promise<DbHolder[]> {
  const first = await listForeignDbHolders()
  if (first.length === 0) return []
  await new Promise((r) => setTimeout(r, gapMs))
  const second = await listForeignDbHolders()
  const secondPids = new Set(second.map((h) => h.pid))
  return first.filter((h) => secondPids.has(h.pid))
}

export class ForeignDbHolderError extends Error {
  constructor(holders: DbHolder[]) {
    const list = holders.map((h) => `pid ${h.pid} (${h.command})`).join(', ')
    super(
      `Refusing to start: another process already holds ${TASK_DB_FILE}: ${list}. ` +
      `It is likely an older Walnut server that predates the instance lock — two writers on one ` +
      `database silently delete each other's tasks. Stop it (kill <pid>) or, if you are CERTAIN ` +
      `it is not a Walnut server, set WALNUT_IGNORE_DB_HOLDERS=1.`,
    )
    this.name = 'ForeignDbHolderError'
  }
}

/**
 * Startup gate against lock-UNAWARE co-writers. Call right after
 * acquireInstanceLock(): throws if some other process persistently holds the
 * task DB. WALNUT_IGNORE_DB_HOLDERS=1 downgrades to a logged error.
 *
 * Patience loop: during a dev:prod restart the OLD server's shutdown tail
 * (audio save, qmd close) can hold the DB for a few seconds after its port
 * closed. A holder that disappears within ~15s is that — wait it out; only a
 * holder that survives every round is a genuine resident co-writer.
 */
export async function assertNoForeignDbHolders(): Promise<void> {
  let holders: DbHolder[] = []
  for (let round = 0; round < 4; round++) {
    if (round > 0) {
      log.web.warn('foreign task-db holder present — waiting for it to exit (old server shutting down?)', { round, holders })
      await new Promise((r) => setTimeout(r, 4000))
    }
    holders = await listPersistentForeignDbHolders()
    if (holders.length === 0) return
  }
  if (process.env.WALNUT_IGNORE_DB_HOLDERS === '1') {
    log.web.error('WALNUT_IGNORE_DB_HOLDERS=1 — starting DESPITE foreign task-db holders (data loss risk)', { holders })
    return
  }
  throw new ForeignDbHolderError(holders)
}

/**
 * Runtime watchdog: catches a rogue writer that appears AFTER startup (an old
 * binary launched later bypasses both the lock file and the startup gate from
 * OUR side — only we can see it arrive). log.web.error routes into the
 * notification center via the log-error bridge, so this surfaces in the UI.
 * Persistence rule (same pid on consecutive ticks) filters transient hooks.
 */
export function startForeignWriterWatchdog(intervalMs = 60_000): { stop: () => void } {
  let prevPids = new Set<number>()
  let alertedPids = new Set<number>()
  const timer = setInterval(() => {
    void listForeignDbHolders().then((holders) => {
      const current = new Set(holders.map((h) => h.pid))
      const persistent = holders.filter((h) => prevPids.has(h.pid))
      const fresh = persistent.filter((h) => !alertedPids.has(h.pid))
      if (fresh.length > 0) {
        log.web.error(
          'SECOND WRITER on the task database — tasks WILL silently disappear. Kill the listed process now.',
          { holders: fresh, dbFile: TASK_DB_FILE },
        )
      }
      alertedPids = new Set(persistent.map((h) => h.pid))
      prevPids = current
    })
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
