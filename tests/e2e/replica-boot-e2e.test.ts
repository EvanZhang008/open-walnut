/**
 * `walnut web --replica` boots safely (docs/plan/walnut-replica-servers-impl.md, WP1).
 *
 * A real child process runs the CLI's own entry (runWeb({replica:true})) with
 * the env a host daemon gives it (the spec env, WALNUT_HOST_DAEMON_DIR, the
 * follower token) plus the replica's own run dir. Two boots: one over copies of
 * 6,500 tasks and 5,000 sessions (a leader process writes them first), and a
 * cold one over a data dir with no copy at all (no task, session, search or
 * device copy). The test stands in for the follower link only: the boot script
 * hands sockets of one loopback port to the leader door, as the link does with
 * the streams the daemon relays from the Mac.
 *
 * Asserted: /api/config answers within 15 s of the spawn; no file appears in the
 * host daemon's dir; no cron, plugin or daemon start lines; none of the started
 * lines of the board reminders, the wait_until clock, the title reconciler or
 * the notes indexer, also after a notes route was called; /api/v1/instance is
 * the Mac's id; no token, a direct loopback request and an unpaired token are
 * 401, a token from the device copy 200; every file it made is 0600 and every
 * dir 0700, and a file left 0644 is repaired; logs older than three days are
 * pruned; the boot policy line, with RSS; the idle CPU and RSS of the server
 * process itself (the pid that listens: the bun process this test spawned).
 *
 * Never touching /tmp/open-walnut is checked over each replica's WHOLE life
 * (read after its last test and its stop) by two means,
 * since the production Walnut writes there all the time and a watcher on the
 * dir cannot tell whose write it saw: every bun process of the child loads a
 * preload (BUN_OPTIONS --preload) that records any fs call, socket connect or spawn
 * argument naming /tmp/open-walnut or /tmp/open-walnut-streams (short opens and
 * closes included); and lsof polls the child's long-lived pids the whole time,
 * where a missing or failing lsof fails the test instead of passing it.
 *
 * Isolation: one temp base for HOME, data dir, run dir and host daemon dir; PATH
 * leads with a `claude` that refuses to run; nothing is read from user data. The
 * child is stopped by the pid this test spawned, its whole tree with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const LEADER_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const PHONE_TOKEN = crypto.randomBytes(16).toString('hex')
const sha256 = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let base = ''
const dirs = { home: '', data: '', run: '', hostd: '' }
let child: ChildProcess | null = null
let port = 0
let doorPort = 0
let firstConfigMs = 0
/** The seeded boot (copies of 6,500 tasks and 5,000 sessions). */
let main: Boot | null = null

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

/** A boot's log: its stderr plus the structured files in its own run dir. */
function serverLog(b: Boot = main!): string {
  let files = ''
  try {
    for (const f of fs.readdirSync(b.run)) if (f.startsWith('open-walnut-') && f.endsWith('.log')) files += fs.readFileSync(path.join(b.run, f), 'utf8')
  } catch { /* none yet */ }
  return b.stderr + '\n' + files
}

async function get(p: string, token?: string, at = port): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${at}${p}`, { headers: { connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  const text = await r.text()
  try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
}

function walk(dir: string, out: Array<{ p: string; dir: boolean; mode: number }> = []): typeof out {
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    let st: fs.Stats
    try { st = fs.lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) continue
    out.push({ p, dir: st.isDirectory(), mode: st.mode & 0o777 })
    if (st.isDirectory()) walk(p, out)
  }
  return out
}

/** Paths a pid holds open, from lsof. Throws when lsof is missing, times out or fails: no answer is no evidence. */
function openPaths(pid: number): string[] {
  return execFileSync('lsof', ['-Fn', '-p', String(pid)], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
}

/** What lsof saw over a boot: how often it ran, what failed, what it found under the shared dirs. */
interface LsofWatch { runs: number; errors: string[]; held: string[]; stop: () => Promise<void> }

/** Polls lsof on the child and its direct children (its local daemon among them) until stopped. */
function watchLsof(rootPid: number): LsofWatch {
  const w: LsofWatch = { runs: 0, errors: [], held: [], stop: async () => {} }
  let on = true
  const loop = (async () => {
    while (on) {
      for (const pid of [rootPid, ...directChildren(rootPid)]) {
        try {
          w.held.push(...openPaths(pid).filter(underSharedRunDir))
          w.runs++
        } catch (err) {
          w.errors.push(`${pid}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
        }
      }
      await sleep(200)
    }
  })()
  w.stop = async () => { on = false; await loop }
  return w
}

function directChildren(pid: number): number[] {
  try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number) } catch { return [] }
}

/**
 * Loaded by every bun process of the child (BUN_OPTIONS --preload): records
 * each fs call, socket connect or spawn that names a shared dir, into
 * REPLICA_FS_TRACE, and its own pid into REPLICA_FS_READY (proof it ran).
 *
 * CommonJS on purpose: on bun an ES module import of a builtin (`import { x }
 * from 'node:fs'`, `import * as fs`) is bound when bun first builds that module's
 * ES namespace, and a patch made after that is never seen by it. A preload that
 * patches through require() runs before any ES import builds the namespace, so
 * every import of the server, named ones included, gets the wrapped functions.
 */
const FS_TRACE_PRELOAD = `
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const cp = require('node:child_process')
const path = require('node:path')
const TRACE = process.env.REPLICA_FS_TRACE
const append = fs.appendFileSync.bind(fs)
append(process.env.REPLICA_FS_READY, process.pid + '\\n')
const SHARED = /(^|[\\s=:])(\\/private)?\\/tmp\\/open-walnut(-streams)?(\\/|$|\\s)/
const text = (p) => typeof p === 'string' ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : ''
const check = (name, ...ps) => {
  for (const p of ps) {
    const t = text(p)
    if (!t) continue
    const abs = t.startsWith('/') ? t : path.resolve(t)
    if (SHARED.test(abs) || SHARED.test(t)) { try { append(TRACE, process.pid + ' ' + name + ' ' + t + '\\n') } catch {} }
  }
}
// Every own property of the original (util.promisify.custom included) rides along.
const keep = (w, orig) => {
  for (const k of Reflect.ownKeys(orig)) {
    if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(k)) continue
    try { Object.defineProperty(w, k, Object.getOwnPropertyDescriptor(orig, k)) } catch {}
  }
  return w
}
const wrap = (obj, names, label, two = false) => {
  for (const n of names) {
    const orig = obj[n]
    if (typeof orig !== 'function') continue
    const w = function (...a) { check(label + n, a[0], two ? a[1] : undefined); return orig.apply(this, a) }
    obj[n] = keep(w, orig)
  }
}
const ONE = ['open', 'openSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'readFile', 'readFileSync', 'readdir', 'readdirSync', 'opendir', 'opendirSync', 'createWriteStream', 'createReadStream', 'unlink', 'unlinkSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'truncate', 'truncateSync', 'chmod', 'chmodSync', 'watch', 'watchFile', 'utimes', 'utimesSync']
const TWO = ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'cp', 'cpSync']
wrap(fs, ONE, 'fs.')
wrap(fs, TWO, 'fs.', true)
wrap(fs.promises, ONE, 'fsp.')
wrap(fs.promises, TWO, 'fsp.', true)
if (fsp !== fs.promises) { wrap(fsp, ONE, 'fsp.'); wrap(fsp, TWO, 'fsp.', true) }
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...a) {
  // net.connect hands the socket its args already normalized: [options, cb].
  const o = Array.isArray(a[0]) ? a[0][0] : a[0]
  check('net.connect', typeof o === 'string' ? o : (o && typeof o === 'object') ? o.path : undefined)
  return connect.apply(this, a)
}
for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const orig = cp[n]
  cp[n] = keep(function (...a) {
    check('cp.' + n, a[0], ...(Array.isArray(a[1]) ? a[1] : []))
    const opts = a.find((x) => x && typeof x === 'object' && !Array.isArray(x))
    if (opts) check('cp.' + n + '.cwd', opts.cwd)
    return orig.apply(this, a)
  }, orig)
}
`

/** Descendants of `pid` (the server's own children). */
function childPids(pid: number): number[] {
  let direct: number[] = []
  try { direct = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number) } catch { return [] }
  return direct.flatMap((c) => [c, ...childPids(c)])
}

/** CPU seconds a process has used (ps TIME, [[dd-]hh:]mm:ss.cc). */
function cpuSeconds(pid: number): number {
  try {
    const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]
    return rest.split(':').map(Number).reduce((acc, v) => acc * 60 + v, 0) + Number(d) * 86_400
  } catch { return NaN }
}

const underSharedRunDir = (p: string) => /^(\/private)?\/tmp\/open-walnut(-streams)?(\/|$)/.test(p)

const BOOT = (data: string, run: string, src: string) => `
const c = await import(${JSON.stringify(path.join(src, 'constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(data)} || c.LOG_DIR !== ${JSON.stringify(run)}) { process.stderr.write('REFUSING: wrong dirs ' + c.WALNUT_HOME + ' ' + c.LOG_DIR + '\\n'); process.exit(3) }
const { runWeb } = await import(${JSON.stringify(path.join(src, 'commands/web.ts'))})
await runWeb({ replica: true, dev: true, port: '3456' })
const { getHostReplicaLeaderDoor } = await import(${JSON.stringify(path.join(src, 'web/server.ts'))})
const door = getHostReplicaLeaderDoor()
if (!door) { process.stderr.write('NO DOOR\\n'); process.exit(4) }
const net = await import('node:net')
const s = net.createServer((sock) => door.accept(sock))
s.listen(0, '127.0.0.1', () => process.stdout.write('SERVER_PID=' + process.pid + ' DOOR_PORT=' + s.address().port + '\\n'))
`

/** Copies of 6,500 tasks and 5,000 sessions, written by the real stores the way a leader writes them. */
const SEED = (src: string) => `
process.umask(0o077)
const taskDb = await import(${JSON.stringify(path.join(src, 'core/task-db.ts'))})
const sessionDb = await import(${JSON.stringify(path.join(src, 'core/session-db.ts'))})
const put = (db, table, row) => { const cols = Object.keys(row).filter((k) => row[k] !== undefined); db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map((c) => '@' + c).join(',') + ')').run(Object.fromEntries(cols.map((c) => [c, row[c]]))) }
const now = Date.now()
const t = taskDb.getDb()
t.transaction(() => { for (let i = 0; i < ${TASKS}; i++) put(t, 'tasks', taskDb.taskToRow({ id: 'task-acme-' + i, title: 'Acme task ' + i, status: 'todo', phase: i % 3 ? 'TODO' : 'COMPLETE', priority: 'none', project: 'acme-' + (i % 40), source: 'local', created_at: new Date(now - i * 60000).toISOString(), updated_at: new Date(now - i * 30000).toISOString(), description: 'Marina notes. '.repeat(20), tags: [] })) })()
const s = sessionDb.getDb()
s.transaction(() => { for (let i = 0; i < ${SESSIONS}; i++) put(s, 'sessions', sessionDb.sessionToRow({ claudeSessionId: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'), taskId: 'task-acme-' + (i % ${TASKS}), project: 'acme-' + (i % 40), process_status: 'stopped', mode: 'default', startedAt: new Date(now - i * 90000).toISOString(), lastActiveAt: new Date(now - i * 45000).toISOString(), messageCount: i % 50, cwd: '/home/marina/acme', host: 'marina-box', title: 'Acme session ' + i })) })()
taskDb.closeDb(); sessionDb.closeDb()
process.stdout.write('SEEDED ' + t.name + '\\n')
`
const TASKS = 6_500
/** The file a host replica writes into a dir it made (src/replica/boot-guard.ts REPLICA_DIR_MARKER). */
const MARKER = '.walnut-replica'
const SESSIONS = 5_000

interface Boot {
  child: ChildProcess; run: string; data: string; hostd: string; port: number
  stderr: string; doorPort: number; firstAnswerMs: number
  lsof: LsofWatch; trace: string; ready: string
  /** The process that runs the server (the child itself, the one that listens), from the boot script. */
  serverPid: number
  /** The boot script's path: the server's command line names it. */
  script: string
}

/** Lays out a host replica's dirs as its daemon would: HOME/.open-walnut-host/{data,run}, the host daemon's dir beside. */
async function replicaDirs(root: string): Promise<{ home: string; data: string; run: string; hostd: string }> {
  const d = { home: path.join(root, 'home'), data: path.join(root, 'home', '.open-walnut-host', 'data'), run: path.join(root, 'home', '.open-walnut-host', 'run'), hostd: path.join(root, 'hostd') }
  for (const x of [path.join(d.home, 'bin'), d.data, d.run, d.hostd]) await fsp.mkdir(x, { recursive: true, mode: 0o700 })
  await fsp.writeFile(path.join(d.home, 'bin', 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
  return d
}

/**
 * Spawns the replica over `d` and waits until /api/config answers `answered`
 * (with `token`) and the door port is known. lsof and the fs trace run from
 * the spawn on.
 */
async function bootReplica(tag: string, d: { home: string; data: string; run: string; hostd: string }, answered: (status: number) => boolean, token?: string): Promise<Boot> {
  const at = await freePort()
  const script = path.join(base, `boot-${tag}.mts`)
  await fsp.writeFile(script, BOOT(d.data, d.run, path.join(REPO_ROOT, 'src')))
  const preload = path.join(base, 'fs-trace.cjs')
  await fsp.writeFile(preload, FS_TRACE_PRELOAD)
  const trace = path.join(base, `fs-trace-${tag}.txt`)
  const ready = path.join(base, `fs-ready-${tag}.txt`)
  // What a host daemon passes (host-server-core: PATH, HOME, WALNUT_HOST_DAEMON_DIR, the spec env, the token).
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.join(d.home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: d.home, USERPROFILE: d.home, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
    WALNUT_HOST_DAEMON_DIR: d.hostd,
    OPEN_WALNUT_HOME: d.data, WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(at),
    WALNUT_LEADER_HOME: '/Users/marina/.open-walnut', WALNUT_WALNUT_ID: LEADER_ID, WALNUT_HOST_LABEL: 'marina-box',
    WALNUT_NO_AUTO_UPDATE: '1', WALNUT_FOLLOWER_TOKEN: 'follower-token-e2e',
    // The replica's own run dir and role (the WP2 spec adds these).
    WALNUT_DAEMON_DIR: d.run, WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host',
    NODE_ENV: 'production',
    BUN_OPTIONS: `--preload ${preload}`, REPLICA_FS_TRACE: trace, REPLICA_FS_READY: ready,
  }
  const spawnedAt = Date.now()
  const proc = spawn(process.execPath, [script], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const b: Boot = { child: proc, run: d.run, data: d.data, hostd: d.hostd, port: at, stderr: '', doorPort: 0, firstAnswerMs: 0, lsof: watchLsof(proc.pid!), trace, ready, serverPid: 0, script }
  proc.stderr!.on('data', (x: Buffer) => { b.stderr = (b.stderr + x.toString()).slice(-400_000) })
  if (process.env.DEBUG_LIVE) proc.stderr!.on('data', (x: Buffer) => process.stderr.write(x))
  const exited = new Promise<never>((_, reject) => proc.once('exit', (code) => reject(new Error(`replica ${tag} exited early (${code})\n${b.stderr.slice(-4000)}`))))
  const door = new Promise<number>((resolve) => {
    let out = ''
    proc.stdout!.on('data', (x: Buffer) => {
      out += x.toString()
      const m = /SERVER_PID=(\d+) DOOR_PORT=(\d+)/.exec(out)
      if (m) { b.serverPid = Number(m[1]); resolve(Number(m[2])) }
    })
  })
  const config = (async () => {
    while (Date.now() - spawnedAt < 180_000) {
      try { if (answered((await get('/api/config', token, at)).status)) return Date.now() - spawnedAt } catch { /* not listening yet */ }
      await sleep(100)
    }
    throw new Error(`no /api/config answer in 180 s\n${b.stderr.slice(-4000)}`)
  })()
  b.firstAnswerMs = await Promise.race([config, exited])
  b.doorPort = await Promise.race([door, exited])
  return b
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** The command line of `pid`, or '' when it is gone. */
function commandOf(pid: number): string {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

/** SIGKILLs `pid` and every descendant still under it (all of them under the pid this test spawned). */
function killTree(pid: number): void {
  for (const p of [...childPids(pid), pid]) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
}

/**
 * Stops a boot by the pid this test spawned (SIGTERM, then SIGKILL on it and
 * on every descendant), and its lsof poller. A server still running after that
 * is stopped by its pid once its command line still names this boot's script.
 */
async function stopBoot(b: Boot | null): Promise<void> {
  if (!b) return
  await b.lsof.stop()
  const c = b.child
  if (c.exitCode === null && c.signalCode === null) {
    const gone = new Promise<void>((r) => c.once('exit', () => r()))
    c.kill('SIGTERM')
    await Promise.race([gone, sleep(12_000)])
    if (c.exitCode === null && c.signalCode === null) { killTree(c.pid!); await Promise.race([gone, sleep(3_000)]) }
  }
  const server = b.serverPid
  if (!server || !alive(server) || !commandOf(server).includes(b.script)) return
  process.kill(server, 'SIGTERM')
  for (let i = 0; i < 50 && alive(server); i++) await sleep(200)
  if (alive(server) && commandOf(server).includes(b.script)) killTree(server)
}

/** The shared-dir evidence of one boot: the trace ran and saw nothing, lsof ran without fail and saw nothing. */
async function expectNoSharedDirTouch(b: Boot): Promise<void> {
  await b.lsof.stop()
  const readyPids = fs.readFileSync(b.ready, 'utf8').split('\n').filter(Boolean).map(Number)
  // Every bun process of the boot loads the preload: the server's own pid must be there.
  expect(b.serverPid).toBeGreaterThan(0)
  expect(readyPids, 'the fs trace preload loaded in the server process').toContain(b.serverPid)
  const traced = fs.existsSync(b.trace) ? fs.readFileSync(b.trace, 'utf8').split('\n').filter(Boolean) : []
  expect(traced).toEqual([])
  expect(b.lsof.errors, 'lsof must answer for every poll').toEqual([])
  expect(b.lsof.runs).toBeGreaterThanOrEqual(4)
  expect(b.lsof.held).toEqual([])
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'replica-boot-'))
  Object.assign(dirs, await replicaDirs(base))
  // The data dir a previous run made (its marker), and the device copy it left
  // (what the Mac's round wrote through the leader door). The run dir is left
  // empty: this boot claims it.
  await fsp.writeFile(path.join(dirs.data, MARKER), 'host replica dir\n', { mode: 0o600 })
  await fsp.mkdir(path.join(dirs.data, 'replica'), { recursive: true, mode: 0o700 })
  await fsp.writeFile(path.join(dirs.data, 'replica', 'devices.json'), JSON.stringify({ v: 1, at: new Date().toISOString(), devices: [{ id: 'd0a1b2c3d4e5f6a7b', name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] }), { mode: 0o600 })
  // The copies, as a leader process writes them (its own run dir, so nothing of its lands in the replica's).
  const seedRun = path.join(base, 'seed-run')
  await fsp.mkdir(seedRun, { recursive: true, mode: 0o700 })
  await fsp.writeFile(path.join(base, 'seed.mts'), SEED(path.join(REPO_ROOT, 'src')))
  const seeded = execFileSync(process.execPath, [path.join(base, 'seed.mts')], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000,
    env: { PATH: process.env.PATH, HOME: dirs.home, TMPDIR: os.tmpdir(), NODE_ENV: 'production', OPEN_WALNUT_HOME: dirs.data, WALNUT_DAEMON_DIR: seedRun },
  })
  expect(seeded).toContain('SEEDED')
  main = await bootReplica('seeded', dirs, (st) => st === 200, PHONE_TOKEN)
  child = main.child
  port = main.port
  doorPort = main.doorPort
  firstConfigMs = main.firstAnswerMs
}, 240_000)

afterAll(async () => {
  await stopBoot(main)
  if (base) await fsp.rm(base, { recursive: true, force: true })
}, 30_000)

describe('walnut web --replica boots safely', () => {
  it('answers /api/config within 15 s of the spawn, as role replica, placement host', async () => {
    expect(firstConfigMs).toBeGreaterThan(0)
    expect(firstConfigMs, `first answer after ${firstConfigMs} ms`).toBeLessThan(15_000)
    const r = await get('/api/config', PHONE_TOKEN)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ role: 'replica', placement: 'host', cloud: false })
  })

  it('/api/v1/instance is the Mac id, public, and no auth.json is minted', async () => {
    const r = await get('/api/v1/instance')
    expect(r).toEqual({ status: 200, body: { instance: LEADER_ID, mode: 'REPLICA' } })
    expect(fs.existsSync(path.join(dirs.data, 'auth.json'))).toBe(false)
  })

  it('no token, a direct loopback request, and an unpaired token are 401; the device copy token is 200', async () => {
    expect((await get('/api/tasks')).status).toBe(401)
    // Direct loopback with a loopback Host and its own Origin: the Mac would waive this one.
    const direct = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { connection: 'close', host: `localhost:${port}`, origin: `http://localhost:${port}` } })
    expect(direct.status).toBe(401)
    expect((await get('/api/config', crypto.randomBytes(16).toString('hex'))).status).toBe(401)
    expect((await get('/api/config', PHONE_TOKEN)).status).toBe(200)
    expect((await get('/api/v1/status', PHONE_TOKEN)).status).not.toBe(401)
  })

  it('listens on loopback only', async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
    if (!lan) return
    const reached = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, lan.address)
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
      setTimeout(() => { s.destroy(); resolve(false) }, 3_000)
    })
    expect(reached).toBe(false)
  })

  it('a device round through the leader door lands 0600 in 0700, and the new token works', async () => {
    const fresh = crypto.randomBytes(16).toString('hex')
    const body = { op: 'put', kind: 'devices', devices: [{ id: 'd0a1b2c3d4e5f6a7b', name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }, { name: 'browser-acme', tokenHash: sha256(fresh) }] }
    const r = await fetch(`http://127.0.0.1:${doorPort}/bridge/replica`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) })
    expect(r.status).toBe(200)
    const file = path.join(dirs.data, 'replica', 'devices.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect((await get('/api/config', fresh)).status).toBe(200)
    // The public port never takes one.
    const pub = await fetch(`http://127.0.0.1:${port}/bridge/replica`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', authorization: `Bearer ${fresh}` }, body: JSON.stringify({ ...body, devices: [] }) })
    expect(pub.status).toBe(404)
    expect((await get('/api/config', fresh)).status).toBe(200)
  })

  it('every file it made is 0600 and every dir 0700 (data dir and run dir)', async () => {
    await sleep(2_500) // the logger flushes on a 2 s timer
    // The run dir was empty at the spawn: the replica claimed it before its first log line.
    expect(fs.statSync(path.join(dirs.run, MARKER)).mode & 0o777).toBe(0o600)
    const loose = [...walk(dirs.data), ...walk(dirs.run)].filter((e) => (e.mode & 0o077) !== 0)
    expect(loose.map((e) => `${e.p.slice(base.length)} ${e.mode.toString(8)}`)).toEqual([])
  })

  it('a notes route on it opens no notes index: no started line, no notes-index.sqlite', async () => {
    // A host replica reads its notes from the host daemon's copy (WP6, replica/notes-routes.ts).
    // No daemon answers here, so the read says the Mac answers it, and no local index opens.
    const r = await get('/api/notes-v2/tags', PHONE_TOKEN)
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ code: 'needs_leader', why: 'copy_unreadable' })
    await sleep(2_500) // the bootstrap is async, and the logger flushes on a 2 s timer
    expect(serverLog()).not.toContain('notes-index: started')
    expect(fs.existsSync(path.join(dirs.data, 'notes-index.sqlite'))).toBe(false)
  })

  it('creates nothing in the host daemon dir', async () => {
    expect(fs.readdirSync(dirs.hostd)).toEqual([])
  })
})

describe('what it does not start', () => {
  it('no cron, plugin or daemon start lines, and none of the self-gated started lines', async () => {
    const text = serverLog()
    expect(text).toContain('server role')
    for (const line of [
      'cron started', 'integration plugins loaded', 'local daemon started', 'spawning local daemon', 'local daemon already running',
      'board reminders: started', 'wait_until: started', 'title-reconciler: started', 'notes-index: started',
      'leader loops: started', 'host server: listening', 'notes/memory watcher started',
      // A job the boot policy turned off says it is off for a host replica, never for the companion.
      'cloud mode',
    ]) expect(text, line).not.toContain(line)
    expect(text).toContain('host replica: skipping session reconciliation')
  })

  it('logs one boot policy line: placement host, only the tunnel trust and its own credential on, with RSS', async () => {
    const lines = serverLog().split('\n').filter((l) => l.includes('"boot policy"') || l.includes('boot policy'))
    const json = lines.map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))) } catch { return null } }).find((o) => o && o.placement === 'host')
    expect(json, lines.join('\n').slice(0, 2000)).toBeTruthy()
    const data = json.data ?? json
    expect(data.role).toBe('replica')
    expect([...data.on].sort()).toEqual(['self-api-credential', 'trust-proxy'])
    expect(data.off).toEqual(expect.arrayContaining(['local-daemon', 'plugins', 'cron', 'board-reminders', 'wait-until', 'title-reconciler', 'notes-indexer', 'leader-heartbeat', 'replica-pushes']))
    expect(data.rssMb).toBeGreaterThan(0)
    expect(data.rssMb).toBeLessThan(400)
  })

  it('idles under 1% CPU and 400 MB RSS once booted, with copies of 6,500 tasks and 5,000 sessions', async () => {
    // The server itself: the pid that listens on the replica's port, the bun
    // process this test spawned (never a helper the server process runs).
    const pid = main!.serverPid
    const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 15_000 }).split('\n').filter(Boolean).map(Number)
    expect(listeners).toEqual([pid])
    expect(pid).toBe(child!.pid)
    expect(path.basename(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim())).toBe('bun')
    expect(commandOf(pid)).not.toMatch(/esbuild/)
    await sleep(10_000)
    const a = cpuSeconds(pid)
    const t0 = Date.now()
    await sleep(15_000)
    const used = cpuSeconds(pid) - a
    const share = used / ((Date.now() - t0) / 1000)
    expect(Number.isFinite(share)).toBe(true)
    expect(share, `${used.toFixed(2)} s CPU in 15 s`).toBeLessThan(0.01)
    const rssMb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
    expect(rssMb, `idle RSS ${rssMb.toFixed(0)} MB`).toBeLessThan(400)
  }, 60_000)

  it('reads the task copy it was given (the prewarm holds 6,500 tasks)', async () => {
    expect(serverLog()).toMatch(/startup: task store prewarmed before listen[^\n]*"tasks":6500/)
  })
})

describe('the seeded boot, over its whole life (every test above, then its stop)', () => {
  // Read once the seeded replica has run all its tests and stopped: a late
  // timer (a warmup, a sweep) that reached /tmp/open-walnut is in the trace.
  beforeAll(async () => { await stopBoot(main) }, 30_000)

  it('never touches /tmp/open-walnut, and leaves no process behind', async () => {
    await expectNoSharedDirTouch(main!)
    expect(fs.readdirSync(dirs.hostd)).toEqual([])
    expect(alive(main!.serverPid), `server ${main!.serverPid} still runs`).toBe(false)
    expect(alive(main!.child.pid!)).toBe(false)
  })
})

describe('a cold boot: no copy at all (no task, session, search or device copy)', () => {
  let cold: Boot | null = null
  let d = { home: '', data: '', run: '', hostd: '' }
  const OLD_LOG = 'open-walnut-2020-01-01.log'
  const LEFTOVER = path.join('cache', 'leftover.bin')

  beforeAll(async () => {
    // One replica at a time: the seeded one has been asserted on by now.
    await stopBoot(main)
    d = await replicaDirs(path.join(base, 'cold'))
    // What an older writer could leave in dirs a replica made (their markers):
    // a 0755 data dir, a 0644 file, and a log from long ago.
    for (const x of [d.data, d.run]) await fsp.writeFile(path.join(x, MARKER), 'host replica dir\n', { mode: 0o600 })
    await fsp.chmod(d.data, 0o755)
    await fsp.mkdir(path.join(d.data, 'cache'), { mode: 0o755 })
    await fsp.chmod(path.join(d.data, 'cache'), 0o755)
    await fsp.writeFile(path.join(d.data, LEFTOVER), 'x')
    await fsp.chmod(path.join(d.data, LEFTOVER), 0o644)
    await fsp.writeFile(path.join(d.run, OLD_LOG), '{}\n', { mode: 0o600 })
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    await fsp.utimes(path.join(d.run, OLD_LOG), tenDaysAgo, tenDaysAgo)
    // With no device copy every token is refused: the first answer is a 401.
    cold = await bootReplica('cold', d, (st) => st === 401)
  }, 240_000)

  afterAll(async () => { await stopBoot(cold) }, 30_000)

  it('answers /api/config within 15 s of the spawn, and a device round through the door then opens it', async () => {
    expect(cold!.firstAnswerMs, `first answer after ${cold!.firstAnswerMs} ms`).toBeLessThan(15_000)
    expect(fs.existsSync(path.join(d.data, 'replica', 'devices.json'))).toBe(false)
    const body = { op: 'put', kind: 'devices', devices: [{ id: 'd0a1b2c3d4e5f6a7b', name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] }
    const r = await fetch(`http://127.0.0.1:${cold!.doorPort}/bridge/replica`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) })
    expect(r.status).toBe(200)
    const config = await get('/api/config', PHONE_TOKEN, cold!.port)
    expect(config.status).toBe(200)
    expect(config.body).toMatchObject({ role: 'replica', placement: 'host' })
    expect((await get('/api/tasks', PHONE_TOKEN, cold!.port)).status).toBeLessThan(500)
  })

  it('the stores came up empty from no file, and /api/v1/instance is the Mac id with no auth.json', async () => {
    expect(serverLog(cold!)).toMatch(/startup: task store prewarmed before listen[^\n]*"tasks":0/)
    expect(await get('/api/v1/instance', undefined, cold!.port)).toEqual({ status: 200, body: { instance: LEADER_ID, mode: 'REPLICA' } })
    expect(fs.existsSync(path.join(d.data, 'auth.json'))).toBe(false)
  })

  it('every file is 0600 and every dir 0700, the ones left looser included; the host daemon dir stays empty', async () => {
    await sleep(2_500) // the logger flushes on a 2 s timer
    expect(fs.statSync(path.join(d.data, LEFTOVER)).mode & 0o777).toBe(0o600)
    const loose = [...walk(d.data), ...walk(d.run)].filter((e) => (e.mode & 0o077) !== 0)
    expect(loose.map((e) => `${e.p.slice(base.length)} ${e.mode.toString(8)}`)).toEqual([])
    expect(fs.statSync(d.data).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(d.hostd)).toEqual([])
  })

  it('prunes logs older than three days in its run dir, and writes today\'s', async () => {
    const logs = fs.readdirSync(d.run).filter((f) => f.startsWith('open-walnut-') && f.endsWith('.log'))
    expect(logs).not.toContain(OLD_LOG)
    expect(logs.length).toBeGreaterThanOrEqual(1)
  })

  it('never touches /tmp/open-walnut over its whole life, and leaves no process behind', async () => {
    await stopBoot(cold)
    await expectNoSharedDirTouch(cold!)
    expect(alive(cold!.serverPid)).toBe(false)
  })
})

describe('a host replica refuses a run dir that is not its own', () => {
  it('WALNUT_DAEMON_DIR equal to the host daemon dir: the real CLI entry exits 2 at once, the reason on stderr, nothing made', async () => {
    // Neither dir exists: the CLI's early log setup would make the run dir, so its absence after proves the order.
    const hostd = path.join(base, 'refuse-hostd')
    const data = await fsp.mkdtemp(path.join(base, 'refuse-data-'))
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: dirs.home, TMPDIR: os.tmpdir(), NODE_ENV: 'production',
      WALNUT_HOST_DAEMON_DIR: hostd, WALNUT_DAEMON_DIR: hostd, OPEN_WALNUT_HOME: data,
      WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(await freePort()), WALNUT_WALNUT_ID: LEADER_ID,
      WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_FOLLOWER_TOKEN: 'follower-token-e2e',
    }
    const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'src/cli.ts'), 'web', '--replica', '--dev'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout!.on('data', (b: Buffer) => { out += b.toString() })
    proc.stderr!.on('data', (b: Buffer) => { err += b.toString() })
    const code = await new Promise<number | null>((resolve) => {
      // On a hang the whole tree goes: a SIGKILL to the CLI alone leaves its children running.
      const t = setTimeout(() => { killTree(proc.pid!); resolve(null) }, 120_000)
      proc.once('exit', (c) => { clearTimeout(t); resolve(c) })
    })
    expect(code, err.slice(-2000)).toBe(2)
    expect(out).not.toMatch(/listening/)
    expect(err).toMatch(/Host replica refused to start: WALNUT_DAEMON_DIR equals WALNUT_HOST_DAEMON_DIR/)
    expect(fs.existsSync(hostd)).toBe(false)
    expect(fs.readdirSync(data)).toEqual([])
  }, 150_000)
})
