/**
 * The OS account as the passwd database knows it, never as the environment
 * says. Node's os.userInfo() reads the passwd entry; bun's answers $USER and
 * $HOME instead (username "unknown" when USER is unset). The callers exist
 * exactly because the environment can lie: a test or an ephemeral server runs
 * under a fake HOME, and the guards that keep it away from the real
 * ~/.open-walnut must still see the account's own home.
 *
 * On bun the entry is read once per process from the system, `id -P` on macOS
 * (Directory Services) and /etc/passwd on Linux, else `getent passwd <uid>`
 * (NSS, so LDAP users too), and kept. The one child runs at the first call,
 * which is a guard at boot or a rare user action, never a request's hot path.
 * No entry throws, as os.userInfo() does on Node.
 */

import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

export interface Account {
  username: string
  homedir: string
  shell: string
  uid: number
  gid: number
}

/** An entry, or an answer that there is none: both are kept for the life of the process. */
let cached: Account | Error | null = null
/** A lookup that could not run (a timeout, a failed spawn): tried again after RETRY_MS. */
let failedUntil = 0
let failure: Error | null = null
const RETRY_MS = 30_000

/**
 * A passwd line: name:passwd:uid:gid:gecos:dir:shell, or macOS's master.passwd form with
 * class, change and expire before gecos. The home and shell are read from the end, because
 * Directory Services lets a colon into the full name.
 */
export function parsePasswdLine(line: string): Account | null {
  const f = line.trim().split(':')
  if (f.length < 7) return null
  const [username, , uid, gid] = f
  const homedir = f[f.length - 2]
  const shell = f[f.length - 1]
  if (!username || !/^\d+$/.test(uid) || !/^\d+$/.test(gid) || !homedir.startsWith('/')) return null
  return { username, homedir, shell, uid: Number(uid), gid: Number(gid) }
}

type Found = { entry: Account } | { none: true } | { failed: string }

function find(text: string, uid: number): Account | null {
  for (const line of text.split('\n')) {
    const entry = parsePasswdLine(line)
    if (entry && entry.uid === uid) return entry
  }
  return null
}

/** What a step asks for: a command's outcome (code 0, an exit status, or an error code) or a file's text. */
type Ask = { run: [string, string[]] } | { read: string }
type RunOutcome = { code: string | number; stdout: string }
type ReadOutcome = { text: string } | { error: true }

/**
 * The lookup's steps, written once: `id -P` on macOS, else /etc/passwd, then `getent passwd <uid>`.
 * A generator that yields what it needs, so lookup() runs it with synchronous calls and
 * lookupAsync() with async ones.
 */
function* lookupSteps(uid: number): Generator<Ask, Found, RunOutcome & ReadOutcome> {
  if (process.platform === 'darwin') {
    const r: RunOutcome = yield { run: ['/usr/bin/id', ['-P']] }
    if (r.code !== 0) return { failed: `id -P: ${typeof r.code === 'number' ? `exit ${r.code}` : r.code}` }
    const entry = find(r.stdout, uid)
    return entry ? { entry } : { none: true }
  }
  const passwd: ReadOutcome = yield { read: '/etc/passwd' }
  if ('text' in passwd) {
    const entry = find(passwd.text, uid)
    if (entry) return { entry }
  } // no readable /etc/passwd: NSS may still know the account
  // NSS (LDAP, SSSD users have no line in /etc/passwd). By path first: a stripped PATH has no getent.
  for (const getent of ['/usr/bin/getent', '/bin/getent', 'getent']) {
    const r: RunOutcome = yield { run: [getent, ['passwd', String(uid)]] }
    if (r.code === 'ENOENT') continue
    if (r.code === 2) return { none: true } // getent: the key is not in the database
    if (r.code !== 0) return { failed: `getent passwd: ${typeof r.code === 'number' ? `exit ${r.code}` : r.code}` }
    const entry = find(r.stdout, uid)
    return entry ? { entry } : { none: true }
  }
  return { none: true }
}

function lookup(uid: number): Found {
  const steps = lookupSteps(uid)
  let next = steps.next()
  while (!next.done) {
    const ask = next.value
    if ('run' in ask) {
      const r = spawnSync(ask.run[0], ask.run[1], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      const code = r.error ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message) : (r.status ?? 'killed')
      next = steps.next({ code, stdout: r.stdout ?? '' } as RunOutcome & ReadOutcome)
    } else {
      let read: ReadOutcome
      try { read = { text: fs.readFileSync(ask.read, 'utf8') } } catch { read = { error: true } }
      next = steps.next(read as RunOutcome & ReadOutcome)
    }
  }
  return next.value
}

/** lookup() without a synchronous call: the same steps on fs.promises and an async child. */
async function lookupAsync(uid: number): Promise<Found> {
  const run = (file: string, args: string[]) => new Promise<RunOutcome>((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      const e = error as (NodeJS.ErrnoException & { code?: string | number }) | null
      resolve({ code: e ? (e.code ?? 'failed') : 0, stdout: String(stdout ?? '') })
    })
  })
  const steps = lookupSteps(uid)
  let next = steps.next()
  while (!next.done) {
    const ask = next.value
    if ('run' in ask) {
      next = steps.next(await run(ask.run[0], ask.run[1]) as RunOutcome & ReadOutcome)
    } else {
      let read: ReadOutcome
      try { read = { text: await fs.promises.readFile(ask.read, 'utf8') } } catch { read = { error: true } }
      next = steps.next(read as RunOutcome & ReadOutcome)
    }
  }
  return next.value
}

let priming: Promise<Account | null> | null = null
/**
 * Reads the passwd entry ahead, without blocking the thread, so a later accountInfo() or
 * knownAccount() answers from memory (2026-11-22: the semantic-lane check ran `getent` with
 * execFileSync at the first daemon connect, 35 to 60 ms of the server's thread in vfork). Called
 * once at load by the modules that ask on a request's path; resolves to the entry, or null when
 * there is none or the lookup could not run (accountInfo() then tries itself, as before).
 */
export function primeAccount(): Promise<Account | null> {
  if (typeof (process.versions as { bun?: string }).bun !== 'string') return Promise.resolve(knownAccount())
  if (cached !== null) return Promise.resolve(cached instanceof Error ? null : cached)
  if (!priming) {
    const uid = process.getuid?.() ?? os.userInfo().uid
    priming = lookupAsync(uid).then((found) => {
      if ('failed' in found) { priming = null; return null }
      // A synchronous lookup that finished meanwhile keeps its answer.
      if (cached === null) cached = 'entry' in found ? found.entry : Object.assign(new Error(`no passwd entry for uid ${uid}`), { code: 'ENOENT' })
      return cached instanceof Error ? null : cached
    }, () => { priming = null; return null })
  }
  return priming
}

/**
 * The account's passwd entry (name, home, shell, ids), on Node and on bun alike. An entry, or
 * the system's answer that there is none, is kept; a lookup that could not run throws and is
 * tried again after 30 s, so one slow moment (a loaded machine, a login) is not kept forever.
 */
export function accountInfo(): Account {
  if (typeof (process.versions as { bun?: string }).bun !== 'string') {
    const info = os.userInfo()
    return { username: info.username, homedir: info.homedir, shell: info.shell ?? '', uid: info.uid, gid: info.gid }
  }
  if (cached === null) {
    if (failure && Date.now() < failedUntil) throw failure
    const uid = process.getuid?.() ?? os.userInfo().uid
    const found = lookup(uid)
    if ('failed' in found) {
      failure = new Error(`could not read the passwd entry for uid ${uid}: ${found.failed}`)
      failedUntil = Date.now() + RETRY_MS
      throw failure
    }
    failure = null
    cached = 'entry' in found ? found.entry : Object.assign(new Error(`no passwd entry for uid ${uid}`), { code: 'ENOENT' })
  }
  if (cached instanceof Error) throw cached
  return cached
}

/**
 * The account as far as it is already known, without running anything: on Node the passwd entry
 * (os.userInfo() reads it at once), on bun the entry accountInfo() read before, else null.
 * For callers on a request's path: a lookup that could not run is tried again by accountInfo()
 * every 30 s with a spawnSync of up to 5 s, which would freeze every route each time.
 */
export function knownAccount(): Account | null {
  if (typeof (process.versions as { bun?: string }).bun !== 'string') {
    try { return accountInfo() } catch { return null }
  }
  return cached && !(cached instanceof Error) ? cached : null
}

/** Tests only: forget the cached entry. */
export function resetAccountForTest(): void {
  cached = null
  priming = null
  failure = null
  failedUntil = 0
}
