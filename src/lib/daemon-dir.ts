/**
 * Where Walnut keeps this machine's runtime files. Two places, chosen apart since 2026-11-26:
 *
 *   the LOG dir     the server's scratch: its logs, pasted images, incident bundles, terminal
 *                   sockets. /tmp/open-walnut. The system's temp cleanup removing what nobody
 *                   touched for days is wanted there (gigabytes of pasted images).
 *   the DAEMON dir  the local session daemon's own files: who it is (daemon.port, daemon.pid,
 *                   daemon.instance), the sessions it holds (sessions.json), its sockets, programs,
 *                   trigger state and logs. $HOME/.cache/open-walnut, which no temp cleanup empties.
 *
 * Both were /tmp/open-walnut. The temp cleanup (macOS: files untouched for 3 days; systemd-tmpfiles:
 * 10 days) then removed a running daemon's files while it ran, and whoever looked for the daemon by
 * those files found none, started a second one, and that one gave way to the first: no session
 * started (2026-11-25, a released 0.6.37 with a daemon from an older release on a Mac and on a dev
 * host). A daemon now freshens its files (daemon-core.ts keepRuntimeFiles) and is found through its
 * instance lock (providers/daemon-lost-files.ts); this rule is the root of it: state that must
 * outlive days of nobody touching it does not live in a temp dir.
 *
 * Nothing that runs is moved: a daemon, and the sessions a daemon started since this machine booted,
 * keep the dir they are in (their registry, sockets and programs are there), so an existing install
 * changes dir only at its next reboot, when none of them is left. Older releases follow: they look
 * for a running daemon in $HOME/.cache/open-walnut too, and their daemons treat it as a production
 * dir (it has been the place for a second user of one machine since 2026-10-30, and for a host
 * whose /tmp cannot hold the daemon: providers/remote-daemon-dir.ts, the same rule for a host).
 * An older release that finds no daemon running starts its own in /tmp/open-walnut (after a
 * downgrade, or beside a newer server): the home daemon holds that dir's instance lock too and
 * leaves its registry linked there (providers/daemon-older-release-door.ts), so that daemon gives
 * way while this one runs and adopts the sessions that still run once it stopped. A link is never
 * one of the markers of rule 4.
 *
 * The DAEMON dir, in order:
 *   1. WALNUT_DAEMON_DIR, when set (tests, ephemeral and isolated servers; the LOG dir too).
 *   2. /tmp/open-walnut, then $HOME/.cache/open-walnut, when a daemon of ours runs there. A pid
 *      file written before the last boot is no running daemon.
 *   3. The one of the two this user's login service pins (`walnut daemon install` chose it), so
 *      the server waits for that daemon instead of starting a second one elsewhere.
 *   4. The one of the two a daemon of ours wrote its files in since this machine booted, the later
 *      one when both: sessions started there may still run, whether their daemon is a program
 *      that stopped, runs inside a server that is restarting, or lost its files to the cleanup.
 *   5. $HOME/.cache/open-walnut.
 *   6. /tmp/open-walnut when the home dir cannot hold the daemon (its socket paths would be too
 *      long, or it cannot be written) and /tmp/open-walnut is ours or free.
 * Root, and a process with no uid (Windows) or no $HOME, always get /tmp/open-walnut, as before.
 *
 * The LOG dir: WALNUT_DAEMON_DIR when it names a dir of its own (not one of the two above, which a
 * daemon hands to its sessions); /tmp/open-walnut when it is ours, or does not exist yet
 * and no other account's system unit runs its daemon there; $HOME/.cache/open-walnut otherwise
 * (another user owns /tmp/open-walnut, or will at its service's start, or it is a symlink or a
 * file: two accounts on one Linux box, 2026-10-30).
 *
 * Read once per process, with a few synchronous stats: it decides module-level
 * constants (src/constants.ts), before any server work runs. scripts/lib/daemon-dir.sh is the
 * same rule for shell scripts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { accountInfo } from './account.js'
import { DAEMON_SERVICE_UNIT_NAME, daemonServiceConfigFiles, readDaemonServiceDir, serviceConfigRunsAs } from '../providers/daemon-service-config.js'
import { isServiceSetRuntimeDir, runtimeDirSocketsFit } from '../providers/service-set.js'

/** The shared default. Remote hosts call it PROD_REMOTE_DAEMON_DIR. */
export const SHARED_DAEMON_DIR = '/tmp/open-walnut'
/** Relative to $HOME. Both daemon builds recognise it as a production dir. */
export const USER_DAEMON_SUBDIR = '.cache/open-walnut'

/** Where the server's scratch goes. */
export interface LogDirLocalChoice {
  dir: string
  /** WALNUT_DAEMON_DIR named it. */
  explicit: boolean
  /** True when the dir is the $HOME one, not /tmp/open-walnut. */
  fallback: boolean
  /** Why /tmp/open-walnut is not used, as a clause. Fallback only. */
  reason?: string
}

/** Where the local session daemon keeps its files. */
export interface DaemonDirLocalChoice {
  dir: string
  /** WALNUT_DAEMON_DIR named it. */
  explicit: boolean
  /** Which rule chose it, as a clause for a log line ("a session daemon is running there"). */
  why: string
}

/**
 * The files a daemon writes in its dir when it starts and keeps there while it runs, one of which
 * is left even after the temp cleanup took every regular file (it removes no socket). Names from
 * daemon-standalone.ts and gateway-core.ts (tests/lib/daemon-dir.test.ts holds them together).
 */
export const DAEMON_STATE_MARKERS = ['daemon.instance', 'sessions.json', 'agent-gateway.sock', 'daemon.port', 'daemon.pid'] as const

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
  /** Why `dir` cannot hold the daemon, as a clause, or null when it can. Creates nothing. */
  dirProblem(dir: string): string | null
}

export const realDaemonDirDeps: DaemonDirDeps = {
  lstat: (p) => { try { return fs.lstatSync(p) } catch { return null } },
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  alive: (pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  },
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
  userName: () => { try { return accountInfo().username } catch { return null } },
  platform: process.platform,
  bootTimeMs: () => Date.now() - os.uptime() * 1000,
  dirProblem: (dir) => {
    if (!runtimeDirSocketsFit(dir)) return 'its socket paths would be too long'
    // The dir, or the nearest parent that exists: ours to write in, and a real directory.
    let at = path.resolve(dir)
    for (;;) {
      let st: fs.Stats | null = null
      try { st = fs.statSync(at) } catch { /* not there: look at its parent */ }
      if (st) {
        if (!st.isDirectory()) return `${at} is not a directory`
        try { fs.accessSync(at, fs.constants.W_OK | fs.constants.X_OK) } catch { return `${at} cannot be written` }
        return null
      }
      const up = path.dirname(at)
      if (up === at) return `${dir} cannot be created`
      at = up
    }
  },
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

/**
 * When a daemon of ours last wrote its files in `dir` since this machine booted (ms), or 0: the dir
 * is ours and one of DAEMON_STATE_MARKERS is ours and dated after the boot. Sessions started there
 * may still run. The home dir survives a reboot, and so does /tmp on many Linuxes: files from before
 * the boot belong to nothing that runs.
 */
function daemonStateSinceBoot(dir: string, deps: DaemonDirDeps): number {
  if (dirState(dir, deps) !== 'ours') return 0
  const uid = deps.uid()
  const boot = deps.bootTimeMs() - BOOT_SLACK_MS
  let newest = 0
  for (const name of DAEMON_STATE_MARKERS) {
    const st = deps.lstat(path.join(dir, name))
    if (!st || st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid)) continue
    // Whole seconds, as the shell copies of this rule read a file's time: two dirs written in the
    // same second are a tie in all of them (the home dir then).
    const at = Math.floor(st.mtimeMs / 1000) * 1000
    if (st.mtimeMs >= boot && at > newest) newest = at
  }
  return newest
}

/** /tmp/open-walnut is ours to use: it is ours, or free and no other account's system unit runs its daemon there. */
function sharedDirProblem(deps: DaemonDirDeps): string | null {
  const state = dirState(SHARED_DAEMON_DIR, deps)
  if (state === 'ours') return null
  if (state === 'absent') return otherAccountPinsDir(SHARED_DAEMON_DIR, deps) ? `another user's login service runs its session daemon from ${SHARED_DAEMON_DIR}` : null
  return state === 'not-a-directory' ? `${SHARED_DAEMON_DIR} is not a directory` : `${SHARED_DAEMON_DIR} belongs to another user`
}

/** /tmp/open-walnut or $HOME/.cache/open-walnut: where a Walnut started with no overrides keeps its files. */
function isDefaultProductionDir(dir: string, env: Env): boolean {
  const resolved = path.resolve(dir)
  const user = userDaemonDir(env)
  return resolved === SHARED_DAEMON_DIR || (!!user && resolved === path.resolve(user))
}

/** No uid (Windows), root, or no home: /tmp/open-walnut for everything, as always. */
function homeDirOf(env: Env, deps: DaemonDirDeps): string | null {
  const user = userDaemonDir(env)
  const uid = deps.uid()
  return !user || uid === null || uid === 0 ? null : user
}

/** The local session daemon's dir (the order is in the file header). */
export function chooseLocalDaemonDir(env: Env = process.env, deps: DaemonDirDeps = realDaemonDirDeps): DaemonDirLocalChoice {
  const named = env.WALNUT_DAEMON_DIR
  if (named) return { dir: named, explicit: true, why: 'WALNUT_DAEMON_DIR names it' }
  const shared = (why: string): DaemonDirLocalChoice => ({ dir: SHARED_DAEMON_DIR, explicit: false, why })
  const user = homeDirOf(env, deps)
  if (!user) return shared('this account has no home dir of its own for it')
  const home = (why: string): DaemonDirLocalChoice => ({ dir: user, explicit: false, why })

  if (liveDaemonIn(SHARED_DAEMON_DIR, deps)) return shared('a session daemon is running there')
  if (liveDaemonIn(user, deps)) return home('a session daemon is running there')

  if (servicePinsDir(user, env, deps)) return home('the login service runs the session daemon from there')
  const sharedProblem = sharedDirProblem(deps)
  if (!sharedProblem && servicePinsDir(SHARED_DAEMON_DIR, env, deps)) return shared('the login service runs the session daemon from there')

  const usedShared = daemonStateSinceBoot(SHARED_DAEMON_DIR, deps)
  const usedHome = daemonStateSinceBoot(user, deps)
  const since = 'a session daemon ran there since this machine started, and its sessions may still run'
  if (usedShared > usedHome) return shared(since)
  if (usedHome > 0) return home(since)

  const homeProblem = deps.dirProblem(user)
  if (!homeProblem) return home('no temp cleanup empties it')
  if (!sharedProblem) return shared(`${user} cannot hold it (${homeProblem})`)
  return home(sharedProblem)
}

/**
 * The server's scratch dir (the rule is in the file header). A WALNUT_DAEMON_DIR that names one of
 * the two production dirs names no log dir: a daemon hands its own dir to every session it starts,
 * so a `walnut` command or a log script run inside a session would look for the server's logs in
 * the daemon's dir.
 */
export function chooseLocalLogDir(env: Env = process.env, deps: DaemonDirDeps = realDaemonDirDeps): LogDirLocalChoice {
  const named = env.WALNUT_DAEMON_DIR
  if (named && !isDefaultProductionDir(named, env)) return { dir: named, explicit: true, fallback: false }
  const shared: LogDirLocalChoice = { dir: SHARED_DAEMON_DIR, explicit: false, fallback: false }
  const user = homeDirOf(env, deps)
  if (!user) return shared
  const problem = sharedDirProblem(deps)
  return problem ? { dir: user, explicit: false, fallback: true, reason: problem } : shared
}

let cached: DaemonDirLocalChoice | null = null
let cachedProduction: DaemonDirLocalChoice | null = null
let cachedLog: LogDirLocalChoice | null = null
let cachedProductionLog: LogDirLocalChoice | null = null

/** This process's daemon dir, chosen once. */
export function localDaemonDirChoice(): DaemonDirLocalChoice {
  if (!cached) cached = chooseLocalDaemonDir()
  return cached
}

/** This process's log dir, chosen once. */
export function localLogDirChoice(): LogDirLocalChoice {
  if (!cachedLog) cachedLog = chooseLocalLogDir()
  return cachedLog
}

/** The environment a Walnut started with no overrides has. */
function productionEnv(): Env {
  const { WALNUT_DAEMON_DIR: _named, ...env } = process.env
  return env
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
  if (!cachedProduction) cachedProduction = chooseLocalDaemonDir(productionEnv())
  return cachedProduction.dir
}

/** The production log dir, the same way. */
export function localProductionLogDir(): string {
  const own = localLogDirChoice()
  if (!own.explicit) return own.dir
  if (!cachedProductionLog) cachedProductionLog = chooseLocalLogDir(productionEnv())
  return cachedProductionLog.dir
}

/**
 * The production daemon dirs of this user: /tmp/open-walnut and
 * $HOME/.cache/open-walnut. A daemon in either is the production daemon (its
 * sessions outlive it, it may run as a login service); any other dir is an
 * isolated one (tests, sandboxes, ephemeral servers). The home dir counts by
 * the account's own home too: a process that inherited the real dir under a
 * faked HOME (a demo server inside a session) must still see the production
 * daemon there, and leave it alone. A service set's runtime dir (a second Walnut's own service on
 * this account, providers/service-set.ts) is one too: its sessions outlive it the same way.
 */
export function isProductionDaemonDir(dir: string, env: Env = process.env): boolean {
  const resolved = path.resolve(dir)
  if (resolved === SHARED_DAEMON_DIR) return true
  if ([userDaemonDir(env), accountDaemonDir()].some((own) => !!own && resolved === path.resolve(own))) return true
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return [env.HOME, accountHome()].some((home) => isServiceSetRuntimeDir(resolved, home, uid))
}

let accountDir: string | null | undefined

/** $HOME/.cache/open-walnut by the passwd entry's home, whatever $HOME says. */
function accountDaemonDir(): string | null {
  if (accountDir === undefined) {
    const home = accountHome()
    accountDir = home ? path.join(home, USER_DAEMON_SUBDIR) : null
  }
  return accountDir
}

let accountHomeDir: string | null | undefined

/** The passwd entry's home, read once. */
function accountHome(): string | null {
  if (accountHomeDir === undefined) {
    let home = ''
    try { home = os.userInfo().homedir } catch { /* no passwd entry */ }
    accountHomeDir = home && path.isAbsolute(home) ? home : null
  }
  return accountHomeDir
}

/**
 * Where a server appends its exit trace: /tmp/open-walnut-exit.log beside the
 * shared dir (where every Walnut server has always written it), inside the dir
 * otherwise, so a second user never writes into the first one's file.
 */
export function exitTraceFileFor(dir: string): string {
  return path.resolve(dir) === SHARED_DAEMON_DIR ? `${SHARED_DAEMON_DIR}-exit.log` : path.join(dir, 'exit.log')
}
