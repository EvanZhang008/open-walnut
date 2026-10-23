/**
 * A Mac and a host replica, every piece a real process
 * (docs/plan/walnut-replica-servers-impl.md, section 10 and WP7):
 *
 *   Mac server child (startServer, NON-ephemeral: an ephemeral Mac pushes nothing
 *     to a remote host) + its own local daemon, each in its own temp dirs
 *     | direct test transport: getDirectDaemonConnection('devbox', ws://127.0.0.1:<port>)
 *     v
 *   host daemon child (the source twin under node, or the standalone twin under bun)
 *     | server.configure from the Mac's real host-server manager (hosts.devbox
 *     |   server_program: replica), with WALNUT_HOST_SERVER_APP_DIR standing in
 *     |   for an install: <base>/app/dist/cli.js runs this tree's src/cli.ts under tsx
 *     v
 *   the replica child (`web --replica`), supervised by that daemon; the Mac sends
 *     it its copies (tasks, sessions, boards, requests, inbox, devices, and WP5's
 *     routines, conversation lists, config and prefs)
 *
 * The manager's one host probe here (free ports, asked of the app dir's runtime:
 * WALNUT_HOST_SERVER_APP_DIR installs nothing, so there is no target probe) runs
 * on this machine: the test transport IS this machine, so the Mac boot script
 * routes `runRemoteScript` for devbox to a local sh, and refuses any other script. Every `ssh` on any PATH
 * here is a stand-in that refuses at once, every HOME is a throwaway, and the
 * host's name is `devbox.invalid` (never resolvable).
 *
 * sleepMac() = SIGSTOP of the Mac server and its local daemon (a lid close: the
 * sockets stay open and go silent), wakeMac() = SIGCONT. stop() and a process
 * `exit` handler SIGCONT before SIGTERM. Every signal goes to a process this
 * harness can name, checked right before it is sent, never to a pid alone and
 * never to a process matched by the base path alone:
 *   a direct child (the host daemon, the Mac's tsx): its ChildProcess, still running
 *   the Mac server and the Mac's own daemon: pinned when first seen (pid, start
 *     time, command line) and signalled only while all three still match
 *   the replica: its host daemon's pid file, with the start time the file names
 *     equal to the process's, and the replica's command line (`<node> <app>/dist/cli.js web --replica`)
 *   a mock CLI: its command line runs this cluster's own copy of the mock
 *     (`<node> <base>/bin/mock-claude.cjs`)
 * stop() fails when one of those is still running.
 *
 * App: `source` (default) runs this tree's src/cli.ts under tsx, the Mac in dev
 * mode (the browser fixture serves the SPA from Vite). `built` runs a real build
 * of this tree (ROOT/dist, its web/static included: `npm run build`, then the
 * web build) on both sides: the replica `node <app>/dist/cli.js web --replica`
 * (dev:false, its own static), the Mac dev:false over the same static, so the
 * console's page and assets come from the replica itself (S9).
 *
 * The CLI is tests/helpers/replica-mock-cli.cjs (long-running, a think delay,
 * its own transcript), copied into the base.
 *
 * Windows: WALNUT_LEADER_QUIET_MS=6000, WALNUT_TRUSTED_CLIENT_BEAT_MS=1000,
 * WALNUT_LEADER_TAKEOVER_MS=12000 (beat x 3 < quiet < takeover); the harness
 * refuses to run with any other ordering.
 *
 * HOST_SID ran one turn on the host: its stream file (HOST_TURN) is seeded in
 * the host daemon's streams dir, where a turn there leaves it.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import Database from '../../src/lib/sqlite.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
export const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))

export const WINDOWS = { quietMs: 6_000, beatMs: 1_000, takeoverMs: 12_000 } as const
export const HOST_KEY = 'devbox'
/** A session that runs on the Mac (no host). */
export const MAC_SID = 'aaaaaaaa-7001-4001-8001-000000000001'
/** A session that runs on the host. */
export const HOST_SID = 'bbbbbbbb-7002-4002-8002-000000000002'

/** A note in the Mac's vault (its copy reaches the host through the daemon, WP6). */
export const MAC_NOTE = { path: 'Acme/Release notes.md', name: 'Release notes', text: 'The rollback drill checklist for Friday.' } as const
/** A letter in the Mac's inbox (its copy reaches the replica, the inbox kind). */
export const MAC_LETTER = { subject: 'Rollback drill report', text: 'The drill ran green on devbox.' } as const

/** A routine on the Mac (its copy reaches the replica, the routines kind, WP5). */
export const MAC_ROUTINE = { name: 'Acme nightly digest', text: 'Summarize the Acme board.' } as const
/** The Mac's favorites (config.yaml; their copy rides the prefs kind, WP5). */
export const MAC_FAVORITES = { projects: ['Acme'], notes: ['Acme/Release notes.md'] } as const
/** A layout pref of the Mac (config/share/ui-prefs.json; the prefs kind): the theme, Light. */
export const MAC_THEME = { key: 'open-walnut-theme', value: 'light' } as const
/** The Mac's name for its user (config.yaml; its copy rides the config kind, WP5). */
export const MAC_USER_NAME = 'Tester'

/** The host session's one turn, in its stream file and its CLI transcript on the host (read away through the replica). */
export const HOST_TURN = { asked: 'Why does the build fail on devbox?', answered: 'echo: Why does the build fail on devbox?' } as const

/**
 * The stream file a turn of HOST_SID left on the host, shaped as the daemon writes
 * one: the CLI's init, Walnut's marker for the person's words (the CLI does not
 * echo them), the CLI's reply and its result line.
 */
function seedHostStream(streamsDir: string): void {
  fs.mkdirSync(streamsDir, { recursive: true, mode: 0o700 })
  const at = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString()
  const lines = [
    { type: 'system', subtype: 'init', cwd: '/w', model: 'mock-model', tools: [], session_id: HOST_SID },
    { type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: HOST_TURN.asked }, walnutMessageId: 'qm-seed-1', walnutDelivery: 'ordered', timestamp: at(0) },
    { type: 'assistant', message: { id: 'msg_seed_1', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: HOST_TURN.answered }] }, parent_tool_use_id: null, session_id: HOST_SID, timestamp: at(1) },
    { type: 'result', subtype: 'success', is_error: false, result: HOST_TURN.answered, session_id: HOST_SID },
  ]
  fs.writeFileSync(path.join(streamsDir, `${HOST_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 })
}

/**
 * The same turn in the CLI's own transcript on the host (`~/.claude/projects/<cwd>/<sid>.jsonl`),
 * where the CLI files every turn: what WP6's history reads on this host.
 */
function seedHostTranscript(hostHome: string, cwd: string): void {
  const dir = path.join(hostHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const at = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString()
  const shared = { sessionId: HOST_SID, cwd, isSidechain: false, version: '2.1.0' }
  const lines = [
    { ...shared, type: 'user', uuid: 'u-seed-1', parentUuid: null, timestamp: at(0), message: { role: 'user', content: HOST_TURN.asked } },
    { ...shared, type: 'assistant', uuid: 'a-seed-1', parentUuid: 'u-seed-1', timestamp: at(1), message: { id: 'msg_seed_1', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: HOST_TURN.answered }] } },
  ]
  fs.writeFileSync(path.join(dir, `${HOST_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 })
}

export type Twin = 'source' | 'standalone'
/** What runs as the app: this tree's sources under tsx, or its real build (ROOT/dist). */
export type ClusterApp = 'source' | 'built'

/** The build `built` runs: the CLI and the web app's static files. */
export function builtAppMissing(): string | null {
  for (const f of [path.join(ROOT, 'dist', 'cli.js'), path.join(ROOT, 'dist', 'web', 'static', 'index.html')]) {
    if (!fs.existsSync(f)) return f
  }
  return null
}

export interface ClusterIds { board: string; other: string; macSid: string; hostSid: string }

export interface ReplicaCluster {
  base: string
  twin: Twin
  app: ClusterApp
  macPort: number
  macPid: number
  macDaemonPid: number
  hostDaemonPid: number
  /** The replica's public port (what the tunnel reaches). */
  replicaPort: number
  replicaData: string
  macData: string
  ids: ClusterIds
  /** A request to the Mac on its own loopback (the person at the Mac). */
  mac(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }>
  /** A request to the replica's public port, as a paired phone or browser. */
  replica(method: string, p: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; json: any; text: string; headers: http.IncomingHttpHeaders }>
  /** A device token made on the Mac (its copy reaches the replica in the device round). */
  pairDevice(name: string): Promise<string>
  /** A browser sign-in code minted on the Mac (the person at the Mac). */
  browserCode(): Promise<string>
  sleepMac(): void
  wakeMac(): void
  asleep(): boolean
  /** Waits until the replica answers `token`'s reads from its copies (x-walnut-offline). */
  waitAway(token: string, timeoutMs?: number): Promise<number>
  /** Waits until the replica forwards `token`'s reads to the Mac again. */
  waitBack(token: string, timeoutMs?: number): Promise<number>
  /** The replica's device copy (replica/devices.json), or null. */
  deviceCopy(): any
  /** Read-only summary of the copy stores on the replica and the rows on the Mac. */
  stores(): Record<string, unknown>
  /** The tail of each process's log (failures). */
  logs(): Record<string, string>
  stop(): Promise<void>
}

/** beat x 3 < quiet < takeover, with seconds of margin (load averages over 100 are recorded on this machine). */
export function assertWindows(w: { quietMs: number; beatMs: number; takeoverMs: number }): void {
  if (!(w.beatMs * 3 < w.quietMs && w.quietMs < w.takeoverMs && w.takeoverMs - w.quietMs >= 3_000)) {
    throw new Error(`replica-cluster: refusing to run with windows ${JSON.stringify(w)} (need beat x 3 < quiet < takeover)`)
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const sha256 = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, what: string, everyMs = 250): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (err) { last = err }
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (${String(last)})` : ''}`)
    await sleep(everyMs)
  }
}

/** The CLI every session of the cluster runs (tests/helpers/replica-mock-cli.cjs), as copied into `<bin>`. */
const MOCK_CLI_NAME = 'mock-claude.cjs'

/** `<bin>`: a mock `claude` (this cluster's own copy of the mock CLI), and an `ssh` that refuses at once (nothing here may reach a real host). */
export function writeStubBin(bin: string): void {
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
  fs.copyFileSync(path.join(import.meta.dirname, 'replica-mock-cli.cjs'), path.join(bin, MOCK_CLI_NAME))
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, MOCK_CLI_NAME))} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "ssh is disabled in this test" >&2\nexit 255\n', { mode: 0o755 })
}

/**
 * The app dir the Mac's manager runs on the host (WALNUT_HOST_SERVER_APP_DIR):
 * `<this runtime> <app>/dist/cli.js web --replica` (the manager's appCommand default). `source`: a dist/cli.js that runs this
 * tree's CLI under tsx, the way an install runs its built dist/cli.js. `built`:
 * <app>/dist is this tree's real build (a link to ROOT/dist; node runs it from
 * there, so it finds its own web/static), and the command line still names <app>.
 */
function writeAppDir(app: string, mode: ClusterApp): void {
  if (mode === 'built') {
    fs.mkdirSync(app, { recursive: true })
    fs.symlinkSync(path.join(ROOT, 'dist'), path.join(app, 'dist'))
    return
  }
  fs.mkdirSync(path.join(app, 'dist'), { recursive: true })
  const api = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs')
  fs.writeFileSync(path.join(app, 'dist', 'cli.js'), [
    `const { register } = await import(${JSON.stringify('file://' + api)})`,
    'register()',
    `await import(${JSON.stringify('file://' + path.join(ROOT, 'src', 'cli.ts'))})`,
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'replica-cluster-app', type: 'module', private: true }))
}

function request(port: number, method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body))
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false, timeout: 30_000,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...opts.headers },
    }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8'), headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${p} timed out`)))
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

const parse = (text: string): any => { try { return JSON.parse(text) } catch { return { text } } }
/** Whether any file under `dir` (a few levels down) holds `needle`. */
function treeHolds(dir: string, needle: string, depth = 6): boolean {
  let names: fs.Dirent[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const n of names) {
    const p = path.join(dir, n.name)
    if (n.isDirectory()) { if (depth > 0 && treeHolds(p, needle, depth - 1)) return true; continue }
    try { if (n.isFile() && fs.statSync(p).size < 4 * 1024 * 1024 && fs.readFileSync(p, 'utf8').includes(needle)) return true } catch { /* went */ }
  }
  return false
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
/** The command line of `pid`, or '' when it is gone. */
function commandOf(pid: number): string {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}
/** When `pid` started, as `ps -p <pid> -o lstart=` says it in the C locale (what the daemons write in their pid files), or ''. */
function startTimeOf(pid: number): string {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }).trim() } catch { return '' }
}

/** A process this harness names: its pid, when it started and its command line, as first seen. */
interface Pinned { name: string; pid: number; started: string; command: string }

/** `pid` pinned now, when its command line looks like `name`'s; null otherwise (gone, reused, someone else's). */
function pin(name: string, pid: number, looksRight: (command: string) => boolean): Pinned | null {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null
  const started = startTimeOf(pid)
  const command = commandOf(pid)
  if (!started || !command || !looksRight(command)) return null
  return { name, pid, started, command }
}

/** The pinned process is still the one that was pinned (same start time, same command line). */
function stillPinned(p: Pinned): boolean {
  return startTimeOf(p.pid) === p.started && commandOf(p.pid) === p.command
}

/** A signal to a pinned process, only while it is still that process. */
function signalPinned(p: Pinned | null, sig: NodeJS.Signals): boolean {
  if (!p || !stillPinned(p)) return false
  try { process.kill(p.pid, sig); return true } catch { return false }
}

/** A signal to a direct child, only while it runs (an exited child's pid may be anyone's by now). */
function signalChild(proc: ChildProcess | null | undefined, sig: NodeJS.Signals): boolean {
  if (!proc || proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return false
  try { return proc.kill(sig) } catch { return false }
}
/**
 * A pid file's pid: a daemon's `daemon.pid` is a bare number (maybe with more
 * words after it); the daemon's host server pid file is JSON `{pid, startTime}`
 * (host-server-core.ts). Reading the JSON as a number gave 0, so the replica was
 * never reaped and outlived its test.
 */
const readPid = (file: string): number => {
  let text = ''
  try { text = String(fs.readFileSync(file, 'utf8')).trim() } catch { return 0 }
  if (text.startsWith('{')) {
    try { const pid = Number((JSON.parse(text) as { pid?: unknown }).pid); return Number.isInteger(pid) && pid > 1 ? pid : 0 } catch { return 0 }
  }
  return Number(text.split(/\s+/)[0]) || 0
}
/** Processes whose command line STARTS with `prefix` (an interpreter and a script of this cluster's own). */
function pidsRunning(prefix: string): number[] {
  let out = ''
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }) } catch { return [] }
  return out.split('\n').map((l) => l.trim()).map((l) => {
    const sp = l.indexOf(' ')
    return { pid: Number(l.slice(0, sp)), command: l.slice(sp + 1).trim() }
  }).filter((r) => r.pid > 1 && r.pid !== process.pid && r.command.startsWith(prefix)).map((r) => r.pid)
}

/** The signal guards, for tests/replica/cluster-signal-safety.test.ts and tests/e2e/replica-old-mac-e2e.test.ts only. */
export const _signalSafetyForTesting = { pin, stillPinned, signalPinned, signalChild, pidsRunning, readPid } as const

const windowEnv = (): Record<string, string> => ({
  WALNUT_LEADER_QUIET_MS: String(WINDOWS.quietMs),
  WALNUT_TRUSTED_CLIENT_BEAT_MS: String(WINDOWS.beatMs),
  WALNUT_LEADER_TAKEOVER_MS: String(WINDOWS.takeoverMs),
})

/**
 * The host daemon: a minimal env of its own (no variable of the runner leaks into it, or into the replica it starts).
 * Also tests/e2e/replica-old-mac-e2e.test.ts (an old Mac in front of the same daemon).
 */
export async function startHostDaemon(twin: Twin, dir: string, home: string, bin: string): Promise<{ proc: ChildProcess; pid: number; port: number }> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const env: Record<string, string> = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, TMPDIR: os.tmpdir(),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
    WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(dir, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    ...windowEnv(),
  }
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    // The trigger sidecar a deploy ships beside the script (scripts/build-daemon.sh):
    // without it the source twin has no triggers and no clock routines.
    buildSync({
      entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent',
    })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    if (!BUN) throw new Error('the standalone twin needs bun (BUN_INSTALL, ~/.bun/bin/bun)')
    proc = spawn(BUN, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_CLUSTER) proc.stderr?.on('data', (b) => process.stderr.write(`[host-daemon] ${b}`))
  else proc.stderr?.resume()
  await waitFor(() => {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the host daemon exited (${proc.exitCode ?? proc.signalCode})`)
    return fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid'))
  }, 90_000, 'the host daemon')
  // Both twins run in the foreground: the pid is the child's own (the pid file says the same).
  const filePid = readPid(path.join(dir, 'daemon.pid'))
  if (filePid !== proc.pid) {
    signalChild(proc, 'SIGTERM')
    throw new Error(`the host daemon's pid file names ${filePid}, not its process ${proc.pid}`)
  }
  return { proc, pid: proc.pid!, port: Number(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')) }
}

function macConfig(): string {
  return [
    'version: 1',
    'user:', `  name: ${MAC_USER_NAME}`,
    'defaults:', '  priority: none', '  platform: local',
    'provider:', '  type: claude-code',
    'hosts:',
    `  ${HOST_KEY}:`,
    // Never resolvable (RFC 6761): the link is the direct test transport, never ssh.
    '    hostname: devbox.invalid',
    `    label: ${HOST_KEY}`,
    '    server_program: replica',
    '    server:',
    '      enabled: true',
    'favorites:',
    '  projects:', ...MAC_FAVORITES.projects.map((x) => `    - ${JSON.stringify(x)}`),
    '  notes:', ...MAC_FAVORITES.notes.map((x) => `    - ${JSON.stringify(x)}`),
    '',
  ].join('\n')
}

/** The Mac's boot script: its own data or nothing (REFUSING), the seed, the test transport to the host daemon. */
function macBoot(o: { macData: string; daemonPort: number; macCwd: string; hostCwd: string; dev: boolean }): string {
  const src = (f: string) => JSON.stringify(path.join(ROOT, f))
  return `
const c = await import(${src('src/constants.ts')})
if (c.WALNUT_HOME !== ${JSON.stringify(o.macData)} || c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const dcm = await import(${src('src/providers/daemon-connection.ts')})
const { execFile } = await import('node:child_process')
// The test transport is this machine: the manager's host probe (free ports, asked
// of this runtime) runs in a local sh. Anything else meant for devbox is refused.
const original = dcm.DaemonConnection.prototype.runRemoteScript
const nodeQ = "'" + process.execPath + "' "
dcm.DaemonConnection.prototype.runRemoteScript = function (script, timeoutMs = 30000) {
  if (this.hostKey !== ${JSON.stringify(HOST_KEY)}) return original.call(this, script, timeoutMs)
  if (typeof script !== 'string' || !script.startsWith(nodeQ)) return Promise.reject(new Error('the test transport runs only the host server probes'))
  return new Promise((resolve, reject) => execFile('/bin/sh', ['-c', script], { timeout: timeoutMs, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))))
}
const { startServer, stopServer, armGracefulSignalExit } = await import(${src('src/web/server.ts')})
const server = await startServer({ port: 0, dev: ${o.dev ? 'true' : 'false'} })
const tm = await import(${src('src/core/task-manager.ts')})
const board = (await tm.addTask({ title: 'Release plan', project: 'Acme', description: 'Ship on Friday after the rollback drill.' })).task
const other = (await tm.addTask({ title: 'Fix the flaky build \\u00e9t\\u00e9', project: 'Acme' })).task
const st = await import(${src('src/core/session-tracker.ts')})
await st.createSessionRecord(${JSON.stringify(MAC_SID)}, board.id, 'Acme', ${JSON.stringify(o.macCwd)}, { title: 'Release checklist', initialProcessStatus: 'idle' })
await st.createSessionRecord(${JSON.stringify(HOST_SID)}, other.id, 'Acme', ${JSON.stringify(o.hostCwd)}, { host: ${JSON.stringify(HOST_KEY)}, title: 'Build fix on devbox', initialProcessStatus: 'idle' })
await tm.linkSession(board.id, ${JSON.stringify(MAC_SID)})
await tm.linkSession(other.id, ${JSON.stringify(HOST_SID)})
const bs = await import(${src('src/core/boards/board-store.ts')})
await bs.setBoardHtml(board.id, '<h1>Release</h1><p id="build">Build: green</p>', { by: 'human' })
// A note in the vault and a letter in the inbox (their copies are read away).
const nfs = await import('node:fs')
const npath = await import('node:path')
nfs.mkdirSync(npath.dirname(npath.join(c.NOTES_DIR, ${JSON.stringify(MAC_NOTE.path)})), { recursive: true })
nfs.writeFileSync(npath.join(c.NOTES_DIR, ${JSON.stringify(MAC_NOTE.path)}), ${JSON.stringify(`# ${MAC_NOTE.name}

${MAC_NOTE.text}
`)})
const inbox = await import(${src('src/core/human-inbox/store.ts')})
// A routine (WP5: its copy is what the Routines page reads away). Once a day: it never fires in a run.
const rc = await import(${src('src/core/routines/routines-core.ts')})
await rc.createRoutine({ name: ${JSON.stringify(MAC_ROUTINE.name)}, enabled: true, schedule: { kind: 'every', everyMs: 86400000 }, sessionTarget: 'main', payload: { kind: 'systemEvent', text: ${JSON.stringify(MAC_ROUTINE.text)} } })
await inbox.sendLetter({ subject: ${JSON.stringify(MAC_LETTER.subject)}, type: 'info', markdown: ${JSON.stringify(MAC_LETTER.text)}, sender: { sessionId: ${JSON.stringify(MAC_SID)}, sessionTitle: 'Release checklist', host: '__local__' } })
// The direct link IS the host's link: every lookup of devbox (the host status, a
// session's host, the server manager) gets it, as an ssh link would be pooled.
// Otherwise the host status read devbox as unreachable over ssh and the console
// showed a host problem card.
const direct = async () => {
  const conn = await dcm.getDirectDaemonConnection(${JSON.stringify(HOST_KEY)}, 'ws://127.0.0.1:${o.daemonPort}')
  dcm.setPooledConnectionForTest(${JSON.stringify(HOST_KEY)}, conn)
  return conn
}
await direct()
// The ssh path redials a link the host closed (a Mac asleep past the daemon's
// keepalive); a link dialled straight to the URL never does, so the test
// transport redials it here, once a second, the same way.
setInterval(() => { void direct().catch(() => {}) }, 1000).unref()
const addr = server.address()
process.stdout.write(JSON.stringify({ ids: { board: board.id, other: other.id }, pid: process.pid }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
`
}

/** Boot the Mac child; resolves with its port, pid and the seed's ids. */
async function bootMac(script: string, file: string, env: Record<string, string>, logRef: { text: string }): Promise<{ proc: ChildProcess; port: number; pid: number; ids: { board: string; other: string } }> {
  fs.writeFileSync(file, script)
  const proc = spawn(TSX, [file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr!.on('data', (b: Buffer) => {
    logRef.text = (logRef.text + b.toString()).slice(-300_000)
    if (process.env.DEBUG_CLUSTER) process.stderr.write(`[mac] ${b}`)
  })
  return new Promise((resolve, reject) => {
    let out = ''
    let meta: { ids: { board: string; other: string }; pid: number } | null = null
    let done = false
    const t = setTimeout(() => {
      // Never left behind: the child this harness spawned (tsx relays the signal to the server).
      try { proc.kill('SIGTERM') } catch { /* gone */ }
      reject(new Error(`the Mac did not report a port in 240 s\n${logRef.text.slice(-3000)}`))
    }, 240_000)
    proc.stdout!.on('data', (b: Buffer) => {
      if (done) return
      out += b.toString()
      for (const l of out.split('\n')) if (l.startsWith('{"ids"')) { try { meta = JSON.parse(l) } catch { /* partial */ } }
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m && meta) { done = true; clearTimeout(t); resolve({ proc, port: Number(m[1]), pid: meta.pid, ids: meta.ids }) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`the Mac exited early (${code})\n${logRef.text.slice(-3000)}`)) })
  })
}

/**
 * `seedMac` (WP14, the scale test): writes the Mac's data before the Mac boots (its
 * stores at `macData`, under the Mac's env), e.g. thousands of rows through the real
 * stores. Runs once, after the host daemon started and before the Mac server.
 */
export type SeedMac = (o: { base: string; macData: string; env: Record<string, string> }) => void | Promise<void>

export async function startReplicaCluster(opts: { twin: Twin; app?: ClusterApp; seedMac?: SeedMac }): Promise<ReplicaCluster> {
  assertWindows(WINDOWS)
  const app: ClusterApp = opts.app ?? 'source'
  if (app === 'built') {
    const missing = builtAppMissing()
    if (missing) throw new Error(`replica-cluster: app 'built' runs this tree's build, and ${missing} is missing (npm run build, then cd web && npx vite build)`)
  }
  // Short: the daemons' unix socket paths must fit in 104 bytes on macOS.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-'))
  const d = {
    bin: path.join(base, 'bin'), macHome: path.join(base, 'mh'), macData: path.join(base, 'mh', 'data'), macDaemon: path.join(base, 'md'),
    hostHome: path.join(base, 'hh'), hostDaemon: path.join(base, 'hd'), hostRoot: path.join(base, 'hr'), app: path.join(base, 'app'),
    macCwd: path.join(base, 'mh', 'work'), hostCwd: path.join(base, 'hh', 'work'),
  }
  for (const x of [d.macData, d.macDaemon, d.hostHome, d.hostRoot, d.macCwd, d.hostCwd]) fs.mkdirSync(x, { recursive: true, mode: 0o700 })
  // The sessions' cwds as a CLI sees them (process.cwd() is the real path; the tmpdir may be behind a link).
  d.macCwd = fs.realpathSync(d.macCwd)
  d.hostCwd = fs.realpathSync(d.hostCwd)
  const macBootFile = path.join(base, 'mac-boot.mts')
  const appCli = path.join(d.app, 'dist', 'cli.js')
  const mockCli = path.join(d.bin, MOCK_CLI_NAME)
  // What an install leaves on the host besides the app (core/host-server/install.ts): the server's data, run and log dirs.
  for (const x of ['data', 'run', 'logs']) fs.mkdirSync(path.join(d.hostRoot, x), { recursive: true, mode: 0o700 })
  writeStubBin(d.bin)
  writeAppDir(d.app, app)
  fs.writeFileSync(path.join(d.macData, 'config.yaml'), macConfig())
  // A layout pref the Mac's console saved (its copy rides the prefs kind).
  fs.mkdirSync(path.join(d.macData, 'config', 'share'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(d.macData, 'config', 'share', 'ui-prefs.json'), JSON.stringify({ [MAC_THEME.key]: { v: MAC_THEME.value, ts: Date.now() } }))
  const macLog = { text: '' }
  let paused = false
  let stopped = false
  let hostDaemon: Awaited<ReturnType<typeof startHostDaemon>> | null = null
  let mac: Awaited<ReturnType<typeof bootMac>> | null = null

  /** The Mac server (the process mac-boot reports) and the Mac's own daemon, pinned when first seen. */
  let macPin: Pinned | null = null
  let macDaemonPin: Pinned | null = null
  /** A replica process: `<node> <app>/dist/cli.js web ... --replica`. */
  const isReplicaCommand = (command: string) => command.startsWith(`${process.execPath} ${appCli} web`) && / --replica(\s|$)/.test(command)
  /**
   * The replica's processes: each pid in the host daemon's pid files whose start
   * time is the one the file names and whose command line is the replica's, and
   * any process running this cluster's app (one its daemon respawned after its
   * pid file was read). Each pinned now; a signal checks the pin again.
   */
  const replicaPins = (): Pinned[] => {
    const out = new Map<number, Pinned>()
    const dir = path.join(d.hostDaemon, 'host-server')
    let names: string[] = []
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.pid')) } catch { /* none yet */ }
    for (const n of names) {
      let rec: { pid?: unknown; startTime?: unknown } = {}
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as typeof rec } catch { continue }
      const pid = Number(rec.pid)
      const p = pin('replica', pid, isReplicaCommand)
      if (p && (typeof rec.startTime !== 'string' || rec.startTime.trim() === p.started)) out.set(pid, p)
    }
    // Under `source` the app path is this base's; under `built` it is this base's link to the build.
    for (const pid of pidsRunning(`${process.execPath} ${appCli} `)) {
      const p = pin('replica', pid, isReplicaCommand)
      if (p) out.set(pid, p)
    }
    return [...out.values()]
  }
  /** Mock CLIs this cluster's daemons started: `<node> <base>/bin/mock-claude.cjs ...` (they outlive a daemon by design). */
  const mockPins = (): Pinned[] => pidsRunning(`${process.execPath} ${mockCli}`).map((pid) => pin('mock-cli', pid, (c) => c.startsWith(`${process.execPath} ${mockCli}`))).filter((p): p is Pinned => p !== null)
  /** Everything of this cluster still running (stop() fails on any). */
  const running = (): Pinned[] => [
    ...[macPin, macDaemonPin].filter((p): p is Pinned => p !== null && stillPinned(p)),
    ...replicaPins(), ...mockPins(),
  ]

  /**
   * SIGCONT first (a stopped process keeps a SIGTERM pending), then SIGTERM: the
   * Mac and its daemon, the host daemon (so it starts no replica again), then the
   * replica and the mock CLIs. Every signal checks its process first (signalPinned,
   * signalChild); a SIGKILL only for what outlived its SIGTERM.
   */
  const reap = async (): Promise<void> => {
    const replicas = replicaPins()
    for (const p of [macPin, macDaemonPin, ...replicas]) signalPinned(p, 'SIGCONT')
    signalChild(hostDaemon?.proc, 'SIGCONT')
    paused = false
    signalPinned(macPin, 'SIGTERM')
    signalPinned(macDaemonPin, 'SIGTERM')
    signalChild(hostDaemon?.proc, 'SIGTERM')
    const frontDone = () => (!macPin || !stillPinned(macPin)) && (!macDaemonPin || !stillPinned(macDaemonPin)) && (!hostDaemon || hostDaemon.proc.exitCode !== null || hostDaemon.proc.signalCode !== null)
    await waitFor(frontDone, 20_000, 'the Mac and the daemons to stop').catch(() => undefined)
    // The replica, and the mock CLIs (a CLI a daemon started outlives it by design).
    const left = [...new Map([...replicas, ...replicaPins(), ...mockPins()].map((p) => [p.pid, p])).values()]
    for (const p of left) signalPinned(p, 'SIGTERM')
    await waitFor(() => left.every((p) => !stillPinned(p)), 15_000, 'the replica to stop').catch(() => undefined)
    for (const p of [macPin, macDaemonPin, ...left]) signalPinned(p, 'SIGKILL')
    if (mac?.proc) signalChild(mac.proc, 'SIGKILL')
    if (hostDaemon) signalChild(hostDaemon.proc, 'SIGKILL')
  }
  // A runner that exits without stop(): nothing it started may stay behind (a
  // stopped Mac would hold a pending SIGTERM forever, a replica would run on).
  const onExit = () => {
    const pins = [macPin, macDaemonPin, ...replicaPins()]
    for (const p of pins) signalPinned(p, 'SIGCONT')
    for (const p of pins) signalPinned(p, 'SIGTERM')
    signalChild(mac?.proc, 'SIGTERM')
    signalChild(hostDaemon?.proc, 'SIGCONT')
    signalChild(hostDaemon?.proc, 'SIGTERM')
  }
  process.once('exit', onExit)

  try {
    hostDaemon = await startHostDaemon(opts.twin, d.hostDaemon, d.hostHome, d.bin)
    seedHostStream(path.join(d.hostDaemon, 'streams'))
    seedHostTranscript(d.hostHome, d.hostCwd)
    const macEnv: Record<string, string> = {
      PATH: `${d.bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: d.macHome, USERPROFILE: d.macHome, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      OPEN_WALNUT_HOME: d.macData, WALNUT_DAEMON_DIR: d.macDaemon, WALNUT_STREAMS_DIR: path.join(d.macDaemon, 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(d.macDaemon, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(d.macDaemon, 'spawn-journal.jsonl'),
      WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
      WALNUT_HOST_SERVER_ROOT: d.hostRoot, WALNUT_HOST_SERVER_APP_DIR: d.app,
      // `built`: the Mac serves the console's page from the same build the replica runs.
      ...(app === 'built' ? { WALNUT_WEB_STATIC_DIR: path.join(ROOT, 'dist', 'web', 'static') } : {}),
      ...windowEnv(), NODE_ENV: 'production',
    }
    if (opts.seedMac) await opts.seedMac({ base, macData: d.macData, env: macEnv })
    mac = await bootMac(macBoot({ macData: d.macData, daemonPort: hostDaemon.port, macCwd: d.macCwd, hostCwd: d.hostCwd, dev: app !== 'built' }), macBootFile, macEnv, macLog)
    // The server mac-boot runs (tsx's child): its command line runs that file, under
    // the `node` on PATH (not this runner's runtime when the suite runs on bun).
    macPin = pin('mac', mac.pid, (c) => /^\S*\bnode\s/.test(c) && c.includes(` ${macBootFile}`))
    if (!macPin) throw new Error(`the Mac reported pid ${mac.pid}, which does not run ${macBootFile}`)
    // The Mac's own daemon, pinned the moment it is there (a pid file can outlive its process).
    macDaemonPin = await waitFor(() => pin('mac-daemon', readPid(path.join(d.macDaemon, 'daemon.pid')), (c) => / --start(\s|$)/.test(c)), 60_000, 'the Mac\'s own daemon')
  } catch (err) {
    await reap()
    if (!process.env.KEEP_REPLICA_CLUSTER) fs.rmSync(base, { recursive: true, force: true })
    throw err
  }
  const macPort = mac!.port
  const replicaData = path.join(d.hostRoot, 'data')

  const macCall: ReplicaCluster['mac'] = async (method, p, body) => {
    const r = await request(macPort, method, p, body === undefined ? {} : { body })
    return { status: r.status, json: parse(r.text), headers: r.headers }
  }
  let replicaPort = 0
  const replicaCall: ReplicaCluster['replica'] = async (method, p, o = {}) => {
    const r = await request(replicaPort, method, p, { ...(o.body === undefined ? {} : { body: o.body }), headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers } })
    return { status: r.status, json: parse(r.text), text: r.text, headers: r.headers }
  }
  const copyState = (name: string): any => { try { return JSON.parse(fs.readFileSync(path.join(replicaData, 'cache', name), 'utf8')) } catch { return null } }
  const deviceCopyText = (): string => { try { return fs.readFileSync(path.join(replicaData, 'replica', 'devices.json'), 'utf8') } catch { return '' } }
  const replicaLog = (): string => { try { return fs.readFileSync(path.join(d.hostRoot, 'logs', 'server.log'), 'utf8').slice(-20_000) } catch { return '' } }

  try {
    // The manager picked the replica's port on the host and keeps it in the Mac's data dir.
    replicaPort = await waitFor(() => {
      const all = JSON.parse(fs.readFileSync(path.join(d.macData, 'host-servers.json'), 'utf8')) as Record<string, { publicPort?: number }>
      return all[HOST_KEY]?.publicPort ?? 0
    }, 180_000, 'the Mac to set up the replica')
    // Up: it answers on its port (forwarded to the Mac while the Mac answers).
    await waitFor(async () => (await replicaCall('GET', '/api/v1/instance')).status === 200, 240_000, 'the replica to answer')
    // The first copy rounds landed (tasks, sessions, boards).
    await waitFor(() => copyState('task-replica.json') && copyState('replica/sessions.json') && copyState('replica/boards.json'), 180_000, 'the first copy rounds')
    // The note's copy on the host (the daemon's), the letter's on the replica.
    await waitFor(() => treeHolds(path.join(d.hostDaemon, 'host-replica'), MAC_NOTE.text), 180_000, 'the note to reach the host')
    await waitFor(() => treeHolds(path.join(replicaData, 'human-inbox'), MAC_LETTER.subject), 180_000, 'the letter to reach the replica')
    // The WP5 copies: the routines, the config, and the prefs (the favorites and the theme).
    const holds = (rel: string, ...needles: string[]) => { try { const t = fs.readFileSync(path.join(replicaData, rel), 'utf8'); return needles.every((x) => t.includes(x)) } catch { return false } }
    await waitFor(() => holds('cron-jobs.json', MAC_ROUTINE.name), 180_000, 'the routine to reach the replica')
    await waitFor(() => holds(path.join('cache', 'replica', 'config.json'), MAC_USER_NAME, 'devbox.invalid'), 180_000, 'the config copy to reach the replica')
    await waitFor(() => holds(path.join('cache', 'replica', 'prefs.json'), MAC_THEME.key, MAC_FAVORITES.notes[0]!), 180_000, 'the prefs copy to reach the replica')
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    e.message += `\n--- mac ---\n${macLog.text.slice(-4000)}\n--- replica ---\n${replicaLog().slice(-4000)}`
    await reap()
    if (!process.env.KEEP_REPLICA_CLUSTER) fs.rmSync(base, { recursive: true, force: true })
    throw e
  }

  const macPid = mac!.pid
  const macDaemonPid = macDaemonPin!.pid
  /** The lid: both of the Mac's processes, each checked first; refused when either is not the one pinned. */
  const signalMac = (sig: NodeJS.Signals) => {
    // The Mac may have restarted its daemon (an upgrade): the one its pid file names now, pinned again.
    if (macDaemonPin && !stillPinned(macDaemonPin)) {
      macDaemonPin = pin('mac-daemon', readPid(path.join(d.macDaemon, 'daemon.pid')), (c) => / --start(\s|$)/.test(c)) ?? macDaemonPin
    }
    for (const p of [macPin, macDaemonPin]) {
      if (!signalPinned(p, sig)) throw new Error(`replica-cluster: refusing ${sig}: ${p?.name ?? 'a Mac process'} (${p?.pid ?? '?'}) is not the process this cluster started`)
    }
  }
  const offlineOf = (h: http.IncomingHttpHeaders): number | null => (typeof h['x-walnut-offline'] === 'string' ? Number(h['x-walnut-offline']) : null)

  return {
    base, twin: opts.twin, app, macPort, macPid, macDaemonPid, hostDaemonPid: hostDaemon!.pid, replicaPort, replicaData, macData: d.macData,
    ids: { ...mac!.ids, macSid: MAC_SID, hostSid: HOST_SID },
    mac: macCall,
    replica: replicaCall,
    async pairDevice(name) {
      const r = await macCall('POST', '/api/devices', { name })
      if (r.status !== 201 || typeof r.json.token !== 'string') throw new Error(`pairing refused: ${r.status} ${JSON.stringify(r.json)}`)
      // The device round reaches the replica's copy (what it checks a token against while the Mac is away).
      const hash = sha256(r.json.token as string)
      await waitFor(() => deviceCopyText().includes(hash), 60_000, 'the device to reach the replica')
      return r.json.token as string
    },
    async browserCode() {
      const r = await macCall('POST', '/api/devices/browser-code', {})
      if (r.status !== 200 || typeof r.json.code !== 'string') throw new Error(`no browser code: ${r.status} ${JSON.stringify(r.json)}`)
      return r.json.code as string
    },
    sleepMac() { signalMac('SIGSTOP'); paused = true },
    wakeMac() { signalMac('SIGCONT'); paused = false },
    asleep: () => paused,
    async waitAway(token, timeoutMs = WINDOWS.quietMs + 30_000) {
      const t0 = Date.now()
      await waitFor(async () => offlineOf((await replicaCall('GET', '/api/tasks', { token })).headers) !== null, timeoutMs, 'the replica to answer away', 500)
      return Date.now() - t0
    },
    async waitBack(token, timeoutMs = 60_000) {
      const t0 = Date.now()
      await waitFor(async () => {
        const r = await replicaCall('GET', '/api/tasks', { token })
        return r.status === 200 && offlineOf(r.headers) === null && r.headers['x-walnut-answered-via'] === 'leader'
      }, timeoutMs, 'the replica to forward to the Mac again', 500)
      return Date.now() - t0
    },
    deviceCopy: () => { try { return JSON.parse(deviceCopyText()) } catch { return null } },
    stores() {
      let files: string[] = []
      try { files = fs.readdirSync(replicaData).sort() } catch { /* none yet */ }
      // The replica's own copy of the task rows (what it answers away): each row's id, title and phase, read only.
      let list: Array<{ id?: string; title?: string; phase?: string }> = []
      try {
        const db = new Database(path.join(replicaData, 'tasks', 'tasks.sqlite'), { readonly: true, fileMustExist: true })
        try { list = db.prepare('SELECT id, title, phase FROM tasks').all() as typeof list } finally { db.close() }
      } catch { /* none yet */ }
      return {
        replicaFiles: files,
        tasks: copyState('task-replica.json'),
        sessions: copyState('replica/sessions.json'),
        boards: copyState('replica/boards.json'),
        taskRows: list.map((t) => ({ id: t.id, title: t.title, phase: t.phase })),
        // The WP5 copies as the replica holds them (read only).
        config: copyState('replica/config.json'),
        prefs: copyState('replica/prefs.json'),
        routines: (() => { try { return JSON.parse(fs.readFileSync(path.join(replicaData, 'cron-jobs.json'), 'utf8')) } catch { return null } })(),
      }
    },
    logs: () => ({ mac: macLog.text.slice(-20_000), replica: replicaLog() }),
    async stop() {
      if (stopped) return
      stopped = true
      process.removeListener('exit', onExit)
      await reap()
      signalChild(mac?.proc, 'SIGTERM')
      signalChild(hostDaemon?.proc, 'SIGTERM')
      // Nothing of this cluster may outlive it (a replica once did).
      const left = await waitFor(() => (running().length === 0 ? true : null), 15_000, 'every process of this cluster to stop').then(() => [], () => running())
      if (!process.env.KEEP_REPLICA_CLUSTER) fs.rmSync(base, { recursive: true, force: true })
      if (left.length) throw new Error(`replica-cluster: processes still running from ${base}: ${left.map((p) => `${p.name} ${p.pid} ${p.command}`).join('; ')}`)
    },
  }
}
