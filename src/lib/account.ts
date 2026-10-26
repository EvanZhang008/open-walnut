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

import { spawnSync } from 'node:child_process'
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

function lookup(uid: number): Found {
  const run = (file: string, args: string[]) => spawnSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
  if (process.platform === 'darwin') {
    const r = run('/usr/bin/id', ['-P'])
    if (r.error || r.status !== 0) return { failed: `id -P: ${r.error?.message ?? `exit ${r.status}`}` }
    const entry = find(r.stdout, uid)
    return entry ? { entry } : { none: true }
  }
  try {
    const entry = find(fs.readFileSync('/etc/passwd', 'utf8'), uid)
    if (entry) return { entry }
  } catch { /* no readable /etc/passwd: NSS may still know the account */ }
  // NSS (LDAP, SSSD users have no line in /etc/passwd). By path first: a stripped PATH has no getent.
  for (const getent of ['/usr/bin/getent', '/bin/getent', 'getent']) {
    const r = run(getent, ['passwd', String(uid)])
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue
    if (r.status === 2) return { none: true } // getent: the key is not in the database
    if (r.error || r.status !== 0) return { failed: `getent passwd: ${r.error?.message ?? `exit ${r.status}`}` }
    const entry = find(r.stdout, uid)
    return entry ? { entry } : { none: true }
  }
  return { none: true }
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

/** Tests only: forget the cached entry. */
export function resetAccountForTest(): void {
  cached = null
  failure = null
  failedUntil = 0
}
