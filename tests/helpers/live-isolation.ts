/**
 * The environment and the walls of every process a live e2e test starts
 * (tests/e2e/*-live-e2e.test.ts: real servers, real daemons, a mock CLI).
 *
 * Environment: an allowlist, never `...process.env`. A child gets its own HOME,
 * TMPDIR, XDG dirs and git config under the test's base, the exec guard's PATH and
 * log (tests/setup/exec-guard.ts), and the variables the test names. Nothing else
 * of the runner's environment reaches it: no API root or session id of the Walnut
 * the runner may be a session of, no credentials, no agent socket, no NODE_OPTIONS
 * but the connect guard (tests/helpers/live-connect-guard.cjs), which refuses and
 * logs a dial to a loopback port the test may not use (livePorts) in node and bun,
 * the second line behind the walls and the only one where they do not stand.
 *
 * Walls (macOS, sandbox-exec): a fake HOME does not hide the real one (OpenSSH, the
 * keychain and getpwuid look past it), so the kernel holds the line:
 *  - outbound connections only to loopback, unix sockets only under the base (no
 *    DNS resolver, no SSH agent), and on loopback none to a port of the user's real
 *    Walnut or model proxy, nor to any port that was already listening when the test
 *    began (livePorts: every loopback service the test did not start);
 *  - writes only under the base, the exec guard's logs and /dev's null devices;
 *  - no file contents read, and nothing run, under the account's real home, except
 *    the repo, the node_modules its dependencies live in, and the runtimes it runs on
 *    (the user's real `claude` lives there; a server also looks for one in
 *    /opt/homebrew/bin and /usr/local/bin, denied by name);
 *  - no signal to a process outside the walls (a server sweeps the machine's stale
 *    ephemeral runtimes and their dtach masters: never another Walnut's from here).
 *    A daemon the test starts itself runs under a keeper inside the same walls
 *    (tests/helpers/live-keeper.cjs), whose pid its parent watchdog asks;
 *  - nothing read from the production daemon's dirs (/tmp/open-walnut, its streams),
 *    the account's real temp dir (other runs keep copies of real data there) or an
 *    ephemeral server's dir in /tmp, except the base;
 *  - /bin/ps runs outside the walls: macOS refuses a sandboxed process the setuid ps
 *    (measured: EPERM even under `(allow default)`), and the servers and daemons read
 *    process identity with it (a daemon refuses to stop a CLI it cannot identify). It
 *    only reads the process table;
 *  - no keychain, privacy-prompt or pasteboard service, and none of the tools that
 *    hand work to a process outside the walls (launchctl, open, osascript), reach
 *    another host (ssh, scp, sftp), ask for privileges (sudo) or signal by name
 *    (pkill, killall).
 * The profile holds for everything the child starts (its daemon, a CLI). Elsewhere
 * there are no walls: the tests run there only in CI, a runner with no user data
 * (liveWallsAvailable).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXEC_GUARD_VARS, guardedPath } from '../setup/exec-guard-core.js'
import { daemonLockPort } from '../../src/providers/daemon-instance-lock.js'
import { accountInfo } from '../../src/lib/account.js'
import { SOURCE_TWIN } from './source-twin.js'

/**
 * Set for every child unless the test names its own value: the paths that reach out of
 * the machine or the base stay shut even where the walls do not stand (Linux CI). Before a
 * server listens, an op client falls back to :3456, the user's real Walnut; port 9 answers
 * nothing. A model install, an update or price check, a host warmup or autofix, the stall
 * recorder and Claude Code's own traffic stay off.
 */
const QUIET: Record<string, string> = {
  OPEN_WALNUT_API_URL: 'http://127.0.0.1:9',
  WALNUT_STT_AUTO_SETUP: '0',
  WALNUT_SEARCH_V2_SEMANTIC: '0',
  WALNUT_PRICE_REFRESH: '0',
  WALNUT_NO_UPDATE_CHECK: '1',
  WALNUT_HOST_WARMUP: '0',
  WALNUT_HOST_AUTOFIX: '0',
  WALNUT_TEST_SERVER: '1',
  WALNUT_STALL_RECORDER: '0',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

/** Runner variables a child keeps (the exec guard's own wiring, the runtime's location). */
const KEPT = [...Object.values(EXEC_GUARD_VARS), 'BUN_INSTALL', 'LANG', 'LC_ALL'] as const

/** Preloaded into every child: node through NODE_OPTIONS, bun through BUN_OPTIONS (and `bun --preload` for the daemon twin). */
export const LIVE_CONNECT_GUARD = path.resolve(import.meta.dirname, 'live-connect-guard.cjs')

/** The parent of a daemon a test starts itself, inside the same walls (its watchdog asks it). */
export const LIVE_KEEPER = path.resolve(import.meta.dirname, 'live-keeper.cjs')

/** True where the tests may run: macOS, behind the walls, or CI, a runner holding no user data. */
export function liveWallsAvailable(): boolean {
  return process.platform === 'darwin' || !!process.env.CI
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i

/**
 * The loopback ports of the user's real Walnut and model access, which no child may dial: the
 * server's default port, the production daemon's port and instance lock, the loopback URLs the
 * runner's own environment names (a Walnut session's API root, a model proxy), and
 * WALNUT_TEST_DENY_PORTS_EXTRA.
 */
export function realWalnutPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const ports = new Set<number>([3456])
  const prodDir = path.join(real('/tmp'), 'open-walnut')
  try { const n = Number(fs.readFileSync(path.join(prodDir, 'daemon.port'), 'utf8').trim()); if (Number.isInteger(n) && n > 0) ports.add(n) } catch { /* no production daemon here */ }
  ports.add(daemonLockPort(process.getuid?.() ?? 0, prodDir))
  for (const k of ['OPEN_WALNUT_API_URL', 'WALNUT_SERVER_URL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    try { const u = new URL(String(env[k])); if (LOOPBACK.test(u.hostname) && u.port) ports.add(Number(u.port)) } catch { /* unset or not a URL */ }
  }
  for (const p of String(env.WALNUT_TEST_DENY_PORTS_EXTRA ?? '').split(',')) { const n = Number(p); if (Number.isInteger(n) && n > 0) ports.add(n) }
  return [...ports].sort((a, b) => a - b)
}

/**
 * The loopback TCP ports listening on the machine, from `lsof` (macOS) or /proc/net (Linux).
 * Throws when they cannot be read on macOS: the walls are built from this list.
 */
export function loopbackListeners(): number[] {
  if (process.platform === 'linux') {
    const ports = new Set<number>()
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text = ''
      try { text = fs.readFileSync(f, 'utf8') } catch { continue }
      for (const p of parseProcNetListen(text)) ports.add(p)
    }
    return [...ports].sort((a, b) => a - b)
  }
  const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 << 20, env: { LC_ALL: 'C' } })
  return parseLsofListen(out)
}

/** `lsof -Fn` name lines (`n127.0.0.1:3456`, `n*:50410`, `n[::1]:8402`): the ports bound to loopback or every address. */
export function parseLsofListen(out: string): number[] {
  const ports = new Set<number>()
  for (const line of out.split('\n')) {
    const m = /^n(\*|127\.\d+\.\d+\.\d+|\[::1\]|\[::\]|localhost):(\d+)$/.exec(line.trim())
    if (m) ports.add(Number(m[2]))
  }
  return [...ports].sort((a, b) => a - b)
}

/** /proc/net/tcp{,6} rows in state LISTEN (0A) on loopback or every address. */
export function parseProcNetListen(text: string): number[] {
  const ports = new Set<number>()
  for (const line of text.split('\n').slice(1)) {
    const w = line.trim().split(/\s+/)
    if (w.length < 4 || w[3] !== '0A') continue
    const [addr, port] = w[1]!.split(':')
    if (procLoopbackOrAny(addr!)) ports.add(parseInt(port!, 16))
  }
  return [...ports].sort((a, b) => a - b)
}

/** A /proc/net address (hex, each 32-bit word little-endian): every address, 127/8, ::1, or ::ffff:127/8. */
function procLoopbackOrAny(a: string): boolean {
  if (/^0+$/.test(a)) return true
  if (a.length === 8) return /7F$/i.test(a)
  return a.toUpperCase() === '00000000000000000000000001000000' || (/^0{16}FFFF0000/i.test(a) && /7F$/i.test(a))
}

let listenersAtStart: number[] | null = null

/**
 * The loopback ports no child may dial: realWalnutPorts, and every port that was listening
 * when this process first asked (before the test started any child), so that only the
 * test's own servers and daemons are reachable. Read once per test process.
 */
export function livePorts(): number[] {
  listenersAtStart ??= loopbackListeners()
  return [...new Set([...realWalnutPorts(), ...listenersAtStart])].sort((a, b) => a - b)
}

/**
 * The whole environment of a child: its home and temp dir, the exec guard's PATH
 * with `bins` in front, the connect guard (attempts go to `guardLog`), QUIET, and
 * `vars`. `home` and `tmp` are created; `home` gets a git config with no credential
 * helper (git otherwise reaches the system's keychain helper). Keep a server's data
 * dir under `tmp`: a server skips some setup (the voice model download) for a data
 * dir under its temp dir, as before the env was isolated.
 */
export function liveEnv(dirs: { home: string; tmp: string; bins: readonly string[]; guardLog: string }, vars: Record<string, string>): NodeJS.ProcessEnv {
  const { home, tmp, bins } = dirs
  for (const d of [home, tmp, path.join(home, '.config'), path.join(home, '.cache'), path.join(home, '.local', 'share'), path.join(home, '.local', 'state')]) fs.mkdirSync(d, { recursive: true })
  const gitconfig = path.join(home, '.gitconfig')
  if (!fs.existsSync(gitconfig)) fs.writeFileSync(gitconfig, '[user]\n\tname = Live Test\n\temail = live-test@example.invalid\n[credential]\n\thelper =\n[init]\n\tdefaultBranch = main\n')
  const env: NodeJS.ProcessEnv = {}
  for (const k of KEPT) if (process.env[k] !== undefined) env[k] = process.env[k]
  return {
    ...env,
    PATH: guardedPath(bins),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    SHELL: '/bin/sh',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_TERMINAL_PROMPT: '0',
    // Bun keeps its transpile cache under BUN_INSTALL (the real ~/.bun) unless told otherwise.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(tmp, 'bun-cache'),
    NODE_ENV: 'production',
    NODE_OPTIONS: `--require ${JSON.stringify(LIVE_CONNECT_GUARD)}`,
    // Bun reads no NODE_OPTIONS: its preload comes from BUN_OPTIONS, which splits on spaces
    // and keeps no quotes (a quoted path loads nothing, silently).
    BUN_OPTIONS: `--preload ${bunOptionPath(LIVE_CONNECT_GUARD)}`,
    WALNUT_TEST_DENY_PORTS: livePorts().join(','),
    WALNUT_TEST_CONNECT_GUARD_LOG: dirs.guardLog,
    ...QUIET,
    ...vars,
  }
}

/** A path BUN_OPTIONS can carry: one with no white space, or the guard would not load. */
function bunOptionPath(p: string): string {
  if (/\s/.test(p)) throw new Error(`BUN_OPTIONS cannot carry a path with a space, so the connect guard would not load: ${p}`)
  return p
}

const sb = (s: string): string => JSON.stringify(s)

/** The sandbox profile for a child of the test whose base is `base` (exported for its unit test). */
export function liveProfile(input: {
  base: string; repo: string; realHome: string; prodDir: string; userTemp: string; runtimes: readonly string[]; writable: readonly string[]; noExec: readonly string[]
  denyPorts: readonly number[]
}): string {
  // An exception that holds the whole home (node installed as ~/bin/node) would take both home walls down.
  for (const p of [input.base, input.repo, ...input.runtimes]) {
    if (p === input.realHome || input.realHome.startsWith(p + '/')) throw new Error(`live walls: ${p} holds the real home ${input.realHome}`)
  }
  if (!input.denyPorts.length) throw new Error('live walls: no ports to deny')
  const readable = [input.repo, ...input.runtimes].filter((p) => p.startsWith(input.realHome + '/'))
  const inHome = `(require-all (subpath ${sb(input.realHome)}) (require-not (require-any (subpath ${sb(input.base)})${readable.map((p) => ` (subpath ${sb(p)})`).join('')})))`
  return [
    '(version 1)',
    '(allow default)',
    // One deny with a require-not: a blanket deny then an allow of loopback would outrank any port deny below.
    `(deny network-outbound (require-all (require-not (remote ip "localhost:*")) (require-not (remote unix-socket (subpath ${sb(input.base)})))))`,
    `(deny network-outbound${input.denyPorts.map((p) => ` (remote ip "localhost:${p}")`).join('')})`,
    `(deny file-write* (require-not (require-any (subpath ${sb(input.base)})${input.writable.map((p) => ` (literal ${sb(p)})`).join('')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))))`,
    `(deny file-read-data ${inHome})`,
    `(deny process-exec ${inHome})`,
    ...(input.noExec.length ? [`(deny process-exec${input.noExec.map((p) => ` (literal ${sb(p)})`).join('')})`] : []),
    `(deny file-read-data (subpath ${sb(input.prodDir)}) (subpath ${sb(input.prodDir + '-streams')}))`,
    `(deny file-read-data (require-all (require-any (subpath ${sb(input.userTemp)}) (regex #"^/private/tmp/open-walnut-(eph-|[0-9]+-)")) (require-not (subpath ${sb(input.base)}))))`,
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.secur") (global-name "com.apple.SecurityServer") (global-name "com.apple.tccd") (global-name "com.apple.tccd.system") (global-name "com.apple.pasteboard.1"))',
    // macOS runs no setuid binary in a sandbox; ps reads only the process table.
    '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
    `(deny process-exec${['/bin/launchctl', '/usr/bin/open', '/usr/bin/osascript', '/usr/bin/ssh', '/usr/bin/scp', '/usr/bin/sftp', '/usr/bin/security', '/usr/bin/sudo', '/usr/bin/pkill', '/usr/bin/killall'].map((p) => ` (literal ${sb(p)})`).join('')})`,
  ].join('\n')
}

const real = (p: string): string => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

/** Where the repo's dependencies really live (a clone may link them from another checkout, a workspace package too). */
function depRoots(repo: string): string[] {
  const roots = new Set<string>([real(path.join(repo, 'node_modules'))])
  const top = path.join(repo, 'node_modules')
  let names: string[] = []
  try { names = fs.readdirSync(top) } catch { return [...roots] }
  for (const n of names) {
    const entries = n.startsWith('@') ? (() => { try { return fs.readdirSync(path.join(top, n)).map((m) => path.join(n, m)) } catch { return [] } })() : [n]
    for (const e of entries) {
      const p = path.join(top, e)
      try { if (!fs.lstatSync(p).isSymbolicLink()) continue } catch { continue }
      const target = real(p)
      const at = target.lastIndexOf('/node_modules/')
      roots.add(at > 0 ? target.slice(0, at + '/node_modules'.length) : target)
    }
  }
  return [...roots]
}

/**
 * `[file, args]` that runs `cmd args` inside the walls on macOS (sandbox-exec execs
 * the command, so the spawned pid is the command's own), or as is elsewhere.
 */
export function walled(cmd: string, args: readonly string[], input: { base: string; repo: string }): [string, string[]] {
  if (process.platform !== 'darwin') return [cmd, [...args]]
  // The account's own home, never $HOME: bun's os.userInfo() answers the faked one.
  const realHome = accountInfo().homedir
  const tmp = os.tmpdir()
  const writable = [
    process.env[EXEC_GUARD_VARS.log],
    path.join(tmp, 'open-walnut-exec-guard-unattributed.log'),
    '/private/tmp/open-walnut-exec-guard-unattributed.log',
  ].filter((p): p is string => !!p).map((p) => path.join(real(path.dirname(p)), path.basename(p)))
  // bun, and the Node the daemon's JS twin runs on (an nvm or volta Node lives under the home).
  const runtimes = [path.dirname(path.dirname(real(process.execPath))), path.dirname(path.dirname(real(SOURCE_TWIN.file))), process.env.BUN_INSTALL ? real(process.env.BUN_INSTALL) : '', real(path.join(realHome, '.bun')), ...depRoots(input.repo)].filter(Boolean)
  // The real `claude` outside the home, by name and by what the name points at.
  const noExec = [...new Set(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].flatMap((p) => (fs.existsSync(p) ? [p, real(p)] : [p])))]
  const profile = liveProfile({
    base: real(input.base), repo: real(input.repo), realHome: real(realHome), prodDir: path.join(real('/tmp'), 'open-walnut'), userTemp: userTempDir(),
    runtimes, writable, noExec, denyPorts: livePorts(),
  })
  return ['/usr/bin/sandbox-exec', ['-p', profile, cmd, ...args]]
}

let userTemp: string | null = null
/** The account's real temp dir (TMPDIR may point elsewhere in a test), read once. */
function userTempDir(): string {
  userTemp ??= real(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 10_000 }).trim().replace(/\/$/, ''))
  return userTemp
}

/**
 * The daemon dirs among `dirs` whose instance-lock port is the production daemon's
 * (a hash of the uid and the dir into 12000 ports): a test daemon holding it would make
 * a production daemon that restarts meanwhile refuse to start. Pick another base.
 */
export function prodLockClash(dirs: readonly string[]): string[] {
  const uid = process.getuid?.() ?? 0
  const canonical = (d: string) => path.join(real(path.dirname(d)), path.basename(d))
  const prod = daemonLockPort(uid, canonical('/tmp/open-walnut'))
  return dirs.filter((d) => daemonLockPort(uid, canonical(d)) === prod)
}
