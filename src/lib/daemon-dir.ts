/**
 * Where Walnut keeps this machine's runtime files: the server's logs, images and
 * pastes, terminal sockets, and the local session daemon's port, pid and
 * registry files.
 *
 * The default is /tmp/open-walnut, which every Walnut user on a machine used to
 * share. The first one to start owns it (mode 0700), so a second Unix user on
 * the same machine could not start Walnut at all: the server exited at boot with
 * "EACCES: permission denied, mkdir '/tmp/open-walnut/streams'" (2026-10-30,
 * two accounts on one Linux box). Remote hosts already had the answer
 * (src/providers/remote-daemon-dir.ts): /tmp/open-walnut for the user who owns
 * it, $HOME/.cache/open-walnut for anyone else, and a daemon that is running
 * keeps its dir. The local machine now follows the same rule, so the owner of
 * /tmp/open-walnut sees no change at all (its live daemon, sessions and logs
 * stay where they are), and both daemon builds already treat the home dir as a
 * production dir (same streams under ~/.open-walnut/tmp/streams, sessions that
 * outlive the daemon).
 *
 * The order, the same as remote-daemon-dir.ts chooseDaemonDir:
 *   1. WALNUT_DAEMON_DIR, when set (tests, ephemeral and isolated servers).
 *   2. /tmp/open-walnut when a daemon of ours runs there.
 *   3. $HOME/.cache/open-walnut when a daemon of ours runs there, so a server
 *      restart never strands a running daemon (another user's /tmp/open-walnut
 *      may have been swept since the daemon started). A pid file written before
 *      the last boot is no running daemon.
 *   4. $HOME/.cache/open-walnut when this user's login service pins it (`walnut
 *      daemon install` chose it), so the server waits for that daemon instead of
 *      starting a second one in /tmp after a reboot.
 *   5. /tmp/open-walnut when it is ours, or does not exist yet and no other
 *      account's system unit runs its daemon there.
 *   6. $HOME/.cache/open-walnut otherwise (another user owns /tmp/open-walnut,
 *      or will at its service's start, or it is a symlink or a file).
 * Root, and a process with no uid (Windows) or no $HOME, always gets
 * /tmp/open-walnut, as before.
 *
 * Read once per process, with a few synchronous stats: it decides module-level
 * constants (src/constants.ts), before any server work runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_SERVICE_UNIT_NAME, daemonServiceConfigFiles, readDaemonServiceDir, serviceConfigRunsAs } from '../providers/daemon-service-config.js'

/** The shared default. Remote hosts call it PROD_REMOTE_DAEMON_DIR. */
export const SHARED_DAEMON_DIR = '/tmp/open-walnut'
/** Relative to $HOME. Both daemon builds recognise it as a production dir. */
export const USER_DAEMON_SUBDIR = '.cache/open-walnut'

export interface DaemonDirLocalChoice {
  dir: string
  /** WALNUT_DAEMON_DIR named it. */
  explicit: boolean
  /** True when the dir is the $HOME one, not /tmp/open-walnut. */
  fallback: boolean
  /** Why /tmp/open-walnut is not used, as a clause. Fallback only. */
  reason?: string
}

/** The seams the tests replace. */
export interface DaemonDirDeps {
  lstat(p: string): fs.Stats | null
  readFile(p: string): string | null
  /** True when a process with this pid exists and is ours to signal. */
  alive(pid: number): boolean
  uid(): number | null
  userName(): string | null
  platform: string
  /** When this machine last booted (ms since the epoch). */
  bootTimeMs(): number
}

export const realDaemonDirDeps: DaemonDirDeps = {
  lstat: (p) => { try { return fs.lstatSync(p) } catch { return null } },
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  alive: (pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  },
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
  userName: () => { try { return os.userInfo().username } catch { return null } },
  platform: process.platform,
  bootTimeMs: () => Date.now() - os.uptime() * 1000,
}

type Env = Record<string, string | undefined>

/**
 * $HOME/.cache/open-walnut, or null without a $HOME. Only $HOME counts, as in
 * both daemon builds and the remote probe: the passwd home of a process whose
 * $HOME points elsewhere (sudo, a service) is not where its daemon looks.
 */
export function userDaemonDir(env: Env = process.env): string | null {
  const home = env.HOME
  return home && path.isAbsolute(home) ? path.join(home, USER_DAEMON_SUBDIR) : null
}

type DirState = 'absent' | 'ours' | 'not-owned' | 'not-a-directory'

function dirState(dir: string, deps: DaemonDirDeps): DirState {
  const st = deps.lstat(dir)
  if (!st) return 'absent'
  if (st.isSymbolicLink()) return 'not-owned'
  if (!st.isDirectory()) return 'not-a-directory'
  const uid = deps.uid()
  return uid === null || st.uid === uid ? 'ours' : 'not-owned'
}

/**
 * A daemon of ours runs from this dir: the dir and its pid file are ours, the
 * pid file was written since this machine booted (the home dir survives a
 * reboot, and with it a pid that some other process may hold now), the pid is
 * alive and a port file is there (the remote probe's w_live, without the `ps`
 * check, which would cost a child process here).
 */
function liveDaemonIn(dir: string, deps: DaemonDirDeps): boolean {
  if (dirState(dir, deps) !== 'ours') return false
  const pidFile = deps.lstat(path.join(dir, 'daemon.pid'))
  const uid = deps.uid()
  if (!pidFile || !pidFile.isFile() || (uid !== null && pidFile.uid !== uid)) return false
  if (pidFile.mtimeMs < deps.bootTimeMs() - BOOT_SLACK_MS) return false
  const pid = parseInt((deps.readFile(path.join(dir, 'daemon.pid')) ?? '').trim(), 10)
  if (!(pid > 1)) return false
  if (!(deps.readFile(path.join(dir, 'daemon.port')) ?? '').trim()) return false
  return deps.alive(pid)
}

/** The uptime clock is read to the second: a pid file this close to the boot still counts. */
const BOOT_SLACK_MS = 5_000

/** This user's login service runs its daemon from `dir` (an installed config pins it). */
function servicePinsDir(dir: string, env: Env, deps: DaemonDirDeps): boolean {
  const home = env.HOME
  if (!home) return false
  const me = { name: deps.userName(), uid: deps.uid() }
  return daemonServiceConfigFiles(deps.platform, home).some((file) => {
    const text = deps.readFile(file)
    if (text === null || !serviceConfigRunsAs(deps.platform, text, me)) return false
    const pinned = readDaemonServiceDir(deps.platform as 'linux' | 'darwin', text)
    return pinned !== null && path.resolve(pinned) === path.resolve(dir)
  })
}

/**
 * Another account's system unit (readable by everyone) runs its daemon from
 * `dir`: after a reboot that account's service must find it free, so taking it
 * first would leave that service failing on another user's dir.
 */
function otherAccountPinsDir(dir: string, deps: DaemonDirDeps): boolean {
  if (deps.platform !== 'linux') return false
  const text = deps.readFile(path.join('/etc', 'systemd', 'system', DAEMON_SERVICE_UNIT_NAME))
  if (text === null || serviceConfigRunsAs('linux', text, { name: deps.userName(), uid: deps.uid() })) return false
  const pinned = readDaemonServiceDir('linux', text)
  return pinned !== null && path.resolve(pinned) === path.resolve(dir)
}

export function chooseLocalDaemonDir(env: Env = process.env, deps: DaemonDirDeps = realDaemonDirDeps): DaemonDirLocalChoice {
  const named = env.WALNUT_DAEMON_DIR
  if (named) return { dir: named, explicit: true, fallback: false }
  const shared: DaemonDirLocalChoice = { dir: SHARED_DAEMON_DIR, explicit: false, fallback: false }
  const user = userDaemonDir(env)
  // No uid (Windows), root, or no home: no fallback, the shared dir as always.
  const uid = deps.uid()
  if (!user || uid === null || uid === 0) return shared
  if (liveDaemonIn(SHARED_DAEMON_DIR, deps)) return shared
  const cache: DaemonDirLocalChoice = { dir: user, explicit: false, fallback: true }
  if (liveDaemonIn(user, deps)) return { ...cache, reason: 'the session daemon is running from there' }
  if (servicePinsDir(user, env, deps)) return { ...cache, reason: 'the login service runs the session daemon from there' }
  const state = dirState(SHARED_DAEMON_DIR, deps)
  if (state === 'ours') return shared
  if (state === 'absent') {
    if (!otherAccountPinsDir(SHARED_DAEMON_DIR, deps)) return shared
    return { ...cache, reason: `another user's login service runs its session daemon from ${SHARED_DAEMON_DIR}` }
  }
  return { ...cache, reason: state === 'not-a-directory' ? `${SHARED_DAEMON_DIR} is not a directory` : `${SHARED_DAEMON_DIR} belongs to another user` }
}

let cached: DaemonDirLocalChoice | null = null
let cachedProduction: DaemonDirLocalChoice | null = null

/** This process's choice, made once. */
export function localDaemonDirChoice(): DaemonDirLocalChoice {
  if (!cached) cached = chooseLocalDaemonDir()
  return cached
}

/**
 * The production daemon dir of this user on this machine, whatever
 * WALNUT_DAEMON_DIR says: what a Walnut started with no overrides uses. Without
 * an override it is this process's own choice, never a second look that could
 * land elsewhere.
 */
export function localProductionDaemonDir(): string {
  const own = localDaemonDirChoice()
  if (!own.explicit) return own.dir
  if (!cachedProduction) {
    const { WALNUT_DAEMON_DIR: _named, ...env } = process.env
    cachedProduction = chooseLocalDaemonDir(env)
  }
  return cachedProduction.dir
}

/**
 * The production daemon dirs of this user: /tmp/open-walnut and
 * $HOME/.cache/open-walnut. A daemon in either is the production daemon (its
 * sessions outlive it, it may run as a login service); any other dir is an
 * isolated one (tests, sandboxes, ephemeral servers). The home dir counts by
 * the account's own home too: a process that inherited the real dir under a
 * faked HOME (a demo server inside a session) must still see the production
 * daemon there, and leave it alone.
 */
export function isProductionDaemonDir(dir: string, env: Env = process.env): boolean {
  const resolved = path.resolve(dir)
  if (resolved === SHARED_DAEMON_DIR) return true
  return [userDaemonDir(env), accountDaemonDir()].some((own) => !!own && resolved === path.resolve(own))
}

let accountDir: string | null | undefined

/** $HOME/.cache/open-walnut by the passwd entry's home, whatever $HOME says. */
function accountDaemonDir(): string | null {
  if (accountDir === undefined) {
    let home = ''
    try { home = os.userInfo().homedir } catch { /* no passwd entry */ }
    accountDir = home && path.isAbsolute(home) ? path.join(home, USER_DAEMON_SUBDIR) : null
  }
  return accountDir
}

/**
 * Where a server appends its exit trace: /tmp/open-walnut-exit.log beside the
 * shared dir (where every Walnut server has always written it), inside the dir
 * otherwise, so a second user never writes into the first one's file.
 */
export function exitTraceFileFor(dir: string): string {
  return path.resolve(dir) === SHARED_DAEMON_DIR ? `${SHARED_DAEMON_DIR}-exit.log` : path.join(dir, 'exit.log')
}
