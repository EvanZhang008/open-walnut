/**
 * Process lifecycle for the collector, kept here so each rule is testable:
 *
 *   prepareDirs   a directory that cannot be created waits 10 minutes before
 *                 the process exits, so launchd (ThrottleInterval 60) does not
 *                 restart it every minute forever
 *   acquireLock   one collector at a time: a second one exits instead of
 *                 writing the same state file and store (a stale lock, whose
 *                 pid is gone or is some other program now, is taken over
 *                 atomically; a holder ps cannot check counts as live)
 *   StateWriter   the state file is written only when it changed, at most
 *                 once a minute, and always on demand (shutdown, a sent alert)
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { ensureDir } from './config.mjs'
import { run } from './run.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** true when both dirs exist; false after waiting `waitMs` when one cannot be made. */
export async function prepareDirs(dirs, { waitMs = 600_000, wait = sleep, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  try {
    for (const d of dirs) ensureDir(d)
    return true
  } catch (err) {
    log(`bridge monitor: cannot create ${dirs.join(', ')}: ${err?.message ?? err}; waiting ${Math.round(waitMs / 60_000)} min before exiting`)
    await wait(waitMs)
    return false
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
}

/**
 * The command line of a pid: the text, '' when ps ran and the pid is gone,
 * or null when ps could not be read (timeout, error). Callers must treat
 * null as "unknown", never as "gone".
 */
export async function psCommand(pid, { runImpl = run } = {}) {
  const res = await runImpl('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 3000 })
  if (res.timedOut || res.error) return null
  if (res.code === 0) return res.stdout.trim()
  return res.code === 1 && !res.stdout.trim() ? '' : null
}

function readLock(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try { return { ino: fs.fstatSync(fd).ino, text: fs.readFileSync(fd, 'utf-8') } } finally { fs.closeSync(fd) }
  } catch (err) { return err?.code === 'ENOENT' ? null : { ino: null, text: '' } }
}

/**
 * Take `file` as a lock for this process. Returns {ok:true}, or
 * {ok:false, heldBy} when a live process whose command line contains `match`
 * holds it, or when ps cannot say what the holder is (fail closed: the next
 * start tries again). A lock left by a dead process, or by a pid now reused
 * by another program, is taken over atomically: it is renamed to a name only
 * this process uses, and only the taker whose rename moved exactly the file
 * it judged (same inode, same text) goes on to create the new lock.
 */
export async function acquireLock(file, { pid = process.pid, match = 'collector.mjs', commandOf = psCommand } = {}) {
  const unique = () => `${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    // Written aside, then linked into place: the lock path never exists
    // empty, so a reader can never take a half-written lock for a stale one.
    const fresh = `${file}.new-${unique()}`
    try {
      fs.writeFileSync(fresh, JSON.stringify({ pid, t: new Date().toISOString() }), { mode: 0o600 })
      fs.linkSync(fresh, file)
      return { ok: true }
    } catch (err) {
      if (err?.code !== 'EEXIST') return { ok: false, error: String(err?.message ?? err) }
    } finally {
      try { fs.rmSync(fresh, { force: true }) } catch { /* fine */ }
    }
    const seen = readLock(file)
    if (!seen) continue // released meanwhile
    let holder = null
    try { holder = JSON.parse(seen.text) } catch { /* torn or empty: stale */ }
    const hp = Number(holder?.pid)
    if (Number.isInteger(hp) && hp > 1 && hp !== pid && pidAlive(hp)) {
      const command = await commandOf(hp)
      if (command === null) return { ok: false, heldBy: hp, unknown: true }
      if (command.includes(match)) return { ok: false, heldBy: hp }
    }
    const aside = `${file}.stale-${unique()}`
    try { fs.renameSync(file, aside) } catch { continue } // another taker moved it first
    const moved = readLock(aside)
    if (moved && moved.ino === seen.ino && moved.text === seen.text) {
      try { fs.rmSync(aside, { force: true }) } catch { /* fine */ }
      continue
    }
    // A fresh lock was written between our read and our rename: put it back.
    try { fs.linkSync(aside, file) } catch { /* someone else holds the path now */ }
    try { fs.rmSync(aside, { force: true }) } catch { /* fine */ }
    return { ok: false, error: 'lock contended' }
  }
  return { ok: false, error: 'lock contended' }
}

/** Remove the lock only if this process holds it. */
export function releaseLock(file, pid = process.pid) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf-8')).pid === pid) fs.rmSync(file, { force: true })
  } catch { /* already gone */ }
}

/**
 * Writes the collector state atomically (temp file + rename, mode 0600), only
 * when it changed and at most every `everyMs`, unless forced.
 */
export class StateWriter {
  constructor(file, { everyMs = 60_000, now = Date.now, write = defaultWrite } = {}) {
    Object.assign(this, { file, everyMs, now, write, lastJson: null, lastMs: 0, owed: false })
  }

  /** Ask for the next save to go out regardless of the minute (e.g. an alert was sent). */
  requestWrite() { this.owed = true }

  /** @returns {Promise<'written'|'unchanged'|'deferred'>} */
  async save(state, { force = false } = {}) {
    const forced = force || this.owed
    if (!forced && this.now() - this.lastMs < this.everyMs) return 'deferred'
    const json = JSON.stringify(state)
    this.owed = false
    if (json === this.lastJson) return 'unchanged'
    await this.write(this.file, json)
    this.lastJson = json
    this.lastMs = this.now()
    return 'written'
  }
}

async function defaultWrite(file, json) {
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, json, { mode: 0o600 })
  await fsp.rename(tmp, file)
}
