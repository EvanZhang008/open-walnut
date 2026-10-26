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

let cached: Account | Error | null = null

/** A passwd line: name:passwd:uid:gid:gecos:dir:shell, or macOS's master.passwd form with class, change and expire before gecos. */
export function parsePasswdLine(line: string): Account | null {
  const f = line.trim().split(':')
  if (f.length !== 7 && f.length !== 10) return null
  const [username, , uid, gid] = f
  const homedir = f[f.length - 2]
  const shell = f[f.length - 1]
  if (!username || !/^\d+$/.test(uid) || !/^\d+$/.test(gid) || !homedir.startsWith('/')) return null
  return { username, homedir, shell, uid: Number(uid), gid: Number(gid) }
}

function lookup(uid: number): Account {
  const run = (file: string, args: string[]): string => {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return r.status === 0 ? r.stdout : ''
  }
  const sources = process.platform === 'darwin'
    ? [() => run('/usr/bin/id', ['-P'])]
    : [() => { try { return fs.readFileSync('/etc/passwd', 'utf8') } catch { return '' } }, () => run('getent', ['passwd', String(uid)])]
  for (const read of sources) {
    for (const line of read().split('\n')) {
      const entry = parsePasswdLine(line)
      if (entry && entry.uid === uid) return entry
    }
  }
  throw Object.assign(new Error(`no passwd entry for uid ${uid}`), { code: 'ENOENT' })
}

/** The account's passwd entry (name, home, shell, ids), on Node and on bun alike. */
export function accountInfo(): Account {
  if (typeof (process.versions as { bun?: string }).bun !== 'string') {
    const info = os.userInfo()
    return { username: info.username, homedir: info.homedir, shell: info.shell ?? '', uid: info.uid, gid: info.gid }
  }
  if (cached === null) {
    try { cached = lookup(process.getuid?.() ?? os.userInfo().uid) } catch (err) { cached = err as Error }
  }
  if (cached instanceof Error) throw cached
  return cached
}

/** Tests only: forget the cached entry. */
export function resetAccountForTest(): void {
  cached = null
}
