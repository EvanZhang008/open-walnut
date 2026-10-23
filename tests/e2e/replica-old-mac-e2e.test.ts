/**
 * An old Mac in front of a new host daemon (docs/plan/walnut-replica-servers-impl.md,
 * section 10 rows R10 and R25; WP10). The old leader is the 1fe1fd194 build (the last
 * one before journal v2), unpacked with `git archive` and run from its own sources
 * under tsx; the new one is this tree. Each Mac is a real, non-ephemeral server child
 * on the SAME data dir (an upgrade and a rollback, the way a person installs one
 * build over another), each with a local daemon dir of its own. The host daemon is
 * this tree's twin (source under node, standalone under bun), and a session runs on it
 * (the cluster's mock CLI). The Mac sleeps by SIGSTOP.
 *
 *   P1 old Mac, fresh data (R10): the session's task_update while it sleeps is a v1
 *      `op` record (no v2 kind is written for it); the Mac wakes and its own drain
 *      applies it once
 *   P2 new Mac on that data (an upgrade): the same write is a v2 `task-fields` record;
 *      the Mac dies asleep (SIGKILL) before it drains
 *   P3 old Mac again (a rollback, R25): the v2 record is never handed out, acked or
 *      lost; the session's next write while it sleeps is a v1 `op` again, and waits
 *      behind the v2 record (an old Mac is handed only the records before the first one
 *      it cannot drain, plan D16)
 *   P4 new Mac again: drains both, in order, each once; nothing is left
 *
 * Not here: the old Mac's own host server. Its manager installs its build over ssh
 * (upload plus install scripts) and the test transport runs no remote script but the
 * new Mac's two host probes, so the Mac's `hosts.devbox.server` is off in this file;
 * which program a Mac installs on which daemon is tests/core/host-server-manager.test.ts
 * (R8). Hygiene: every dir is a temp dir; every signal goes to a process this file
 * started, checked first (tests/helpers/replica-cluster.ts pins); afterAll reaps all.
 *
 * Twins: REPLICA_CLUSTER_TWINS=source|standalone|source,standalone (default: both
 * when bun is on this machine).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from '../../src/lib/sqlite.js'
import {
  BUN, HOST_KEY, ROOT, WINDOWS, _signalSafetyForTesting as guard, sleep, startHostDaemon, waitFor, writeStubBin, type Twin,
} from '../helpers/replica-cluster.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')
const OLD_BUILD = '1fe1fd194'
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
type Pinned = NonNullable<ReturnType<typeof guard.pin>>

/** The 1fe1fd194 sources, unpacked once for the file (its node_modules: this tree's, the package files are the same). */
let oldRoot = ''
function oldTree(): string {
  if (oldRoot) return oldRoot
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-old-mac-'))
  execFileSync('/bin/sh', ['-c', `git -C "${ROOT}" archive ${OLD_BUILD} src package.json tsconfig.json | tar -x -C "${tree}"`])
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'))
  oldRoot = tree
  return tree
}

function macConfig(): string {
  return [
    'version: 1',
    'user:', '  name: Tester',
    'defaults:', '  priority: none', '  platform: local',
    'provider:', '  type: claude-code',
    'hosts:',
    `  ${HOST_KEY}:`,
    // Never resolvable (RFC 6761): the link is the direct test transport, never ssh.
    '    hostname: devbox.invalid',
    `    label: ${HOST_KEY}`,
    '',
  ].join('\n')
}

/**
 * A Mac's boot script, for the build at `root`: its own data or nothing (REFUSING), the
 * direct test transport to the host daemon (redialled once a second, as the ssh path
 * redials), the first boot's one task, then its pid and port on stdout.
 */
function macBoot(root: string, o: { macData: string; daemonPort: number; seed: boolean }): string {
  const src = (f: string) => JSON.stringify(path.join(root, f))
  return `
const c = await import(${src('src/constants.ts')})
if (c.WALNUT_HOME !== ${JSON.stringify(o.macData)} || c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const dcm = await import(${src('src/providers/daemon-connection.ts')})
const original = dcm.DaemonConnection.prototype.runRemoteScript
dcm.DaemonConnection.prototype.runRemoteScript = function (script, timeoutMs = 30000) {
  if (this.hostKey !== ${JSON.stringify(HOST_KEY)}) return original.call(this, script, timeoutMs)
  return Promise.reject(new Error('the test transport runs no remote script'))
}
const { startServer, stopServer, armGracefulSignalExit } = await import(${src('src/web/server.ts')})
const server = await startServer({ port: 0, dev: true })
let ids = {}
if (${o.seed ? 'true' : 'false'}) {
  const tm = await import(${src('src/core/task-manager.ts')})
  ids = { chat: (await tm.addTask({ title: 'Host chat', project: 'Acme' })).task.id }
}
const direct = async () => {
  const conn = await dcm.getDirectDaemonConnection(${JSON.stringify(HOST_KEY)}, 'ws://127.0.0.1:${o.daemonPort}')
  dcm.setPooledConnectionForTest(${JSON.stringify(HOST_KEY)}, conn)
  return conn
}
await direct()
setInterval(() => { void direct().catch(() => {}) }, 1000).unref()
const addr = server.address()
process.stdout.write(JSON.stringify({ ids, pid: process.pid }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
`
}
/** A Mac server child: tsx's, the server it runs (pinned), its own local daemon (pinned once there). */
interface Mac {
  build: 'old' | 'new'
  proc: ChildProcess
  server: Pinned
  daemon: Pinned | null
  daemonDir: string
  port: number
  ids: Record<string, string>
  log: { text: string }
}

interface Cluster { base: string; bin: string; macHome: string; macData: string; hostDir: string; hostCwd: string; hostDaemon: Awaited<ReturnType<typeof startHostDaemon>> }

/** Boots a Mac of `build` on the cluster's data (its own local daemon dir per boot); resolves once it reports its port. */
async function bootMac(c: Cluster, build: 'old' | 'new', phase: string, seed: boolean): Promise<Mac> {
  const root = build === 'old' ? oldTree() : ROOT
  const daemonDir = path.join(c.base, `md-${phase}`)
  fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 })
  const file = path.join(c.base, `mac-boot-${phase}.mts`)
  fs.writeFileSync(file, macBoot(root, { macData: c.macData, daemonPort: c.hostDaemon.port, seed }))
  const env: Record<string, string> = {
    PATH: `${c.bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: c.macHome, USERPROFILE: c.macHome, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    OPEN_WALNUT_HOME: c.macData, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(daemonDir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(daemonDir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(daemonDir, 'spawn-journal.jsonl'),
    WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_DISABLE_SEARCH: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
    WALNUT_LEADER_QUIET_MS: String(WINDOWS.quietMs), WALNUT_TRUSTED_CLIENT_BEAT_MS: String(WINDOWS.beatMs), WALNUT_LEADER_TAKEOVER_MS: String(WINDOWS.takeoverMs),
    NODE_ENV: 'production',
  }
  const log = { text: '' }
  const proc = spawn(TSX, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(proc)
  proc.stderr!.on('data', (b: Buffer) => {
    log.text = (log.text + b.toString()).slice(-300_000)
    if (process.env.DEBUG_CLUSTER) process.stderr.write(`[mac ${build} ${phase}] ${b}`)
  })
  const meta = await new Promise<{ port: number; pid: number; ids: Record<string, string> }>((resolve, reject) => {
    let out = ''
    let reported: { ids: Record<string, string>; pid: number } | null = null
    const t = setTimeout(() => { guard.signalChild(proc, 'SIGTERM'); reject(new Error(`the ${build} Mac did not report a port in 240 s\n${log.text.slice(-3000)}`)) }, 240_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      for (const l of out.split('\n')) if (l.startsWith('{"ids"')) { try { reported = JSON.parse(l) } catch { /* partial */ } }
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m && reported) { clearTimeout(t); resolve({ port: Number(m[1]), pid: reported.pid, ids: reported.ids }) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`the ${build} Mac exited early (${code})\n${log.text.slice(-3000)}`)) })
  })
  const server = guard.pin(`mac-${phase}`, meta.pid, (cmd) => cmd.startsWith(`${process.execPath} `) && cmd.includes(file))
  if (!server) throw new Error(`the ${build} Mac reported pid ${meta.pid}, which does not run ${file}`)
  const mac: Mac = { build, proc, server, daemon: null, daemonDir, port: meta.port, ids: meta.ids, log }
  macs.push(mac)
  mac.daemon = await waitFor(() => guard.pin(`mac-daemon-${phase}`, guard.readPid(path.join(daemonDir, 'daemon.pid')), (cmd) => / --start(\s|$)/.test(cmd)), 60_000, `the ${build} Mac's own daemon`)
  return mac
}

/** The lid: the Mac server and its local daemon, each checked first. */
function lid(mac: Mac, sig: 'SIGSTOP' | 'SIGCONT'): void {
  for (const p of [mac.server, mac.daemon]) {
    if (!guard.signalPinned(p, sig)) throw new Error(`refusing ${sig}: ${p?.name ?? 'a Mac process'} is not the process this file started`)
  }
}

/** Stops a Mac: SIGCONT, then SIGTERM (gracefully) or SIGKILL (it dies asleep, before any drain), and its local daemon. */
async function stopMac(mac: Mac, how: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (how === 'SIGKILL') guard.signalPinned(mac.server, 'SIGKILL')
  else { guard.signalPinned(mac.server, 'SIGCONT'); guard.signalPinned(mac.server, 'SIGTERM') }
  guard.signalPinned(mac.daemon, 'SIGCONT')
  guard.signalPinned(mac.daemon, 'SIGTERM')
  await waitFor(() => !guard.stillPinned(mac.server) && (!mac.daemon || !guard.stillPinned(mac.daemon)), 30_000, `the ${mac.build} Mac to stop`)
  guard.signalChild(mac.proc, 'SIGTERM')
}

async function macGet(mac: Mac, p: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${mac.port}${p}`)
  return { status: r.status, json: await r.json().catch(() => null) }
}
async function macPost(mac: Mac, p: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${mac.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
/** Every tsx child and every Mac this file started (afterAll reaps whatever is left). */
const started: ChildProcess[] = []
const macs: Mac[] = []

/** Files under `dir` (a few levels down) whose name matches `re`. */
function filesUnder(dir: string, re: RegExp, depth = 4): string[] {
  let ents: fs.Dirent[] = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return ents.flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return depth > 0 ? filesUnder(p, re, depth - 1) : []
    return re.test(e.name) ? [p] : []
  })
}

/**
 * The host daemon's journal for this Walnut, every record by seq (its latest line). An
 * acked record leaves the file at the next compaction, so a record once seen and now
 * gone was acked: `seen` keeps every record of the run.
 */
const seen = new Map<number, Record<string, any>>()
function journal(c: Cluster): { records: Array<Record<string, any>>; pending: Array<Record<string, any>> } {
  const inFile = new Map<number, Record<string, any>>()
  const acked = new Set<number>()
  for (const f of filesUnder(path.join(c.hostDir, 'offline-host'), /^journal-.*\.ndjson$/, 0)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let o: Record<string, any>
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o.seq === 'number') inFile.set(o.seq, o)
      if (Array.isArray(o.ack)) for (const q of o.ack) acked.add(q)
    }
  }
  for (const [q, r] of inFile) seen.set(q, r)
  for (const q of seen.keys()) if (!inFile.has(q)) acked.add(q)
  const records = [...seen.values()].sort((a, b) => a.seq - b.seq)
  return { records, pending: records.filter((r) => !acked.has(r.seq)) }
}

/** The drains the host daemon's leader book holds for this Walnut (null: an old Mac's configure, none). */
function bookDrains(c: Cluster): string[] | null | undefined {
  const files = filesUnder(c.hostDir, /^leader-.*\.json$/)
  if (!files.length) return undefined
  const rec = JSON.parse(fs.readFileSync(files[0], 'utf8')) as { drains?: string[]; home?: string }
  return Array.isArray(rec.drains) ? rec.drains : null
}

/** The host copy (slice) the Mac pushed: its task row of `taskId`, once it names session `sid`. */
function sliceTask(c: Cluster, taskId: string, sid: string): Record<string, any> | null {
  for (const f of filesUnder(path.join(c.hostDir, 'offline-host'), /^slice-.*\.json$/, 0)) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8')) as { sessions?: Array<{ sid: string }>; tasks?: Array<{ id: string }> }
      if (!s.sessions?.some((x) => x.sid === sid)) continue
      const t = s.tasks?.find((x) => x.id === taskId)
      if (t) return t
    } catch { /* mid-write */ }
  }
  return null
}

/** A call through the host daemon's agent gateway as the session `sid` (its `walnut tools call`). */
function gateway(c: Cluster, sid: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(c.hostDir, 'agent-gateway.sock'))
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 30_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args } }) + '\n'))
    s.on('data', (b) => {
      buf += b.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** The Mac's task row on disk, read only. */
function macTask(c: Cluster, id: string): { title: string; phase: string } | null {
  const db = new Database(path.join(c.macData, 'tasks', 'tasks.sqlite'), { readonly: true, fileMustExist: true })
  try { return (db.prepare('SELECT title, phase FROM tasks WHERE id = ?').get(id) as { title: string; phase: string } | undefined) ?? null } finally { db.close() }
}

/** The Mac's structured log lines (its LOG_DIR is its daemon dir) that match `re`. */
function macLog(mac: Mac, re: RegExp): string[] {
  return filesUnder(mac.daemonDir, /\.log$/, 0).sort().flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')).filter((l) => re.test(l))
}

/** The mock CLIs this cluster's host daemon started (`<node> <bin>/mock-claude.cjs`): they outlive a daemon by design. */
function mockPins(c: Cluster): Pinned[] {
  const prefix = `${process.execPath} ${path.join(c.bin, 'mock-claude.cjs')}`
  return guard.pidsRunning(prefix).map((pid) => guard.pin('mock-cli', pid, (cmd) => cmd.startsWith(prefix))).filter((p): p is Pinned => p !== null)
}
/** The host session's stream lines (the host daemon's file). */
function hostStream(c: Cluster, sid: string): Array<Record<string, any>> {
  try {
    return fs.readFileSync(path.join(c.hostDir, 'streams', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, any> } catch { return {} } })
  } catch { return [] }
}

afterAll(() => {
  if (oldRoot && !process.env.KEEP_REPLICA_CLUSTER) fs.rmSync(oldRoot, { recursive: true, force: true })
})

describe.each(TWINS)('an old Mac in front of a new host daemon (%s twin)', (twin) => {
  let c: Cluster
  let mac: Mac | null = null
  const ids = { chat: '', sid: '' }
  const TITLES = { p1: 'Host chat, renamed under the old Mac', p2: 'Host chat, renamed under the new Mac', p3: 'Host chat, renamed after the rollback' }

  /** A Mac of `build` boots and configures the host: its leader record says which (drains, or none). */
  const boot = async (build: 'old' | 'new', phase: string, seed = false): Promise<Mac> => {
    mac = await bootMac(c, build, phase, seed)
    await waitFor(() => { const d = bookDrains(c); return build === 'new' ? Array.isArray(d) : d === null }, 120_000, `the ${build} Mac to configure the host`)
    return mac
  }
  /** The lid closes and the quiet window passes: the host answers its session itself. */
  const sleepMac = async (m: Mac): Promise<void> => {
    lid(m, 'SIGSTOP')
    await sleep(WINDOWS.quietMs + 2_000)
  }
  /** The host session renames its task through the gateway while the Mac sleeps: the record that wrote. */
  const renameAway = async (title: string): Promise<Record<string, any>> => {
    const before = journal(c).records.length
    const r = await gateway(c, ids.sid, 'task_update', { id: ids.chat, title })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    await waitFor(() => journal(c).records.length > before, 10_000, 'the write in the host journal')
    return journal(c).records.at(-1)!
  }
  const fail = (what: string) => `${what}\njournal: ${JSON.stringify(journal(c).records.map((r) => ({ seq: r.seq, kind: r.kind, op: r.op })))}\nmac log:\n${mac ? macLog(mac, /offline handover/).slice(-12).map((l) => l.slice(0, 300)).join('\n') : ''}`

  beforeAll(async () => {
    seen.clear()
    // Short: the daemons' unix socket paths must fit in 104 bytes on macOS.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rom-'))
    const bin = path.join(base, 'bin')
    const macHome = path.join(base, 'mh')
    const macData = path.join(macHome, 'data')
    const hostHome = path.join(base, 'hh')
    const hostDir = path.join(base, 'hd')
    for (const d of [macData, hostHome, path.join(hostHome, 'work')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    writeStubBin(bin)
    fs.writeFileSync(path.join(macData, 'config.yaml'), macConfig())
    oldTree()
    const hostDaemon = await startHostDaemon(twin, hostDir, hostHome, bin)
    c = { base, bin, macHome, macData, hostDir, hostCwd: fs.realpathSync(path.join(hostHome, 'work')), hostDaemon }
    process.stdout.write(`replica-old-mac-e2e: ${twin} at ${base}\n`)
  }, 300_000)

  afterAll(async () => {
    if (!c) return
    for (const m of macs.splice(0)) await stopMac(m, 'SIGTERM').catch(() => {})
    guard.signalChild(c.hostDaemon.proc, 'SIGTERM')
    await waitFor(() => c.hostDaemon.proc.exitCode !== null || c.hostDaemon.proc.signalCode !== null, 20_000, 'the host daemon to stop').catch(() => guard.signalChild(c.hostDaemon.proc, 'SIGKILL'))
    // The mock CLI the host daemon ran (a CLI outlives its daemon by design).
    for (const p of mockPins(c)) guard.signalPinned(p, 'SIGTERM')
    await waitFor(() => mockPins(c).length === 0, 10_000, 'the mock CLIs to stop').catch(() => { for (const p of mockPins(c)) guard.signalPinned(p, 'SIGKILL') })
    for (const proc of started.splice(0)) guard.signalChild(proc, 'SIGKILL')
    if (!process.env.KEEP_REPLICA_CLUSTER) fs.rmSync(c.base, { recursive: true, force: true })
  }, 120_000)
  /** waitFor, and on a timeout the journal and the Mac's handover lines. */
  const until = async (fn: () => unknown, ms: number, what: string): Promise<void> => {
    try { await waitFor(fn, ms, what) } catch (err) { throw new Error(fail(String(err))) }
  }
  /** The host daemon's `journal: drained` lines since `t` (each a batch it handed a Mac). */
  const drainedSince = (t: number): Array<Record<string, any>> => filesUnder(c.hostDir, /^daemon-.*\.log$/, 0)
    .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n'))
    .map((l) => { try { return JSON.parse(l) as Record<string, any> } catch { return null } })
    .filter((o): o is Record<string, any> => !!o && o.msg === 'journal: drained' && Date.parse(o.ts) >= t)

  it('P1 (R10): under the old Mac a session write made while it sleeps is a v1 op (no v2 kind), and its own drain applies it once', async () => {
    const m = await boot('old', 'p1-old', true)
    ids.chat = m.ids.chat
    expect(ids.chat).toBeTruthy()
    const st = await macPost(m, `/api/v1/tasks/${ids.chat}/start`, { host: HOST_KEY, cwd: c.hostCwd, mode: 'default', message: 'hello host' })
    expect([200, 202], JSON.stringify(st.json)).toContain(st.status)
    ids.sid = typeof st.json?.sessionId === 'string' ? st.json.sessionId : ''
    expect(ids.sid, JSON.stringify(st.json)).toBeTruthy()
    await until(() => hostStream(c, ids.sid).some((l) => l.type === 'result' && String(l.result).includes('hello host')), 120_000, 'the host session to answer')
    await until(() => sliceTask(c, ids.chat, ids.sid), 60_000, 'the old Mac\'s copy for the host to name the session')
    await sleepMac(m)
    const rec = await renameAway(TITLES.p1)
    expect(rec, fail('P1')).toMatchObject({ kind: 'op', op: 'task_update', args: { id: ids.chat, title: TITLES.p1 } })
    // No v2 kind is written while an old Mac leads.
    expect(journal(c).records.map((r) => r.kind)).toEqual(['op'])
    lid(m, 'SIGCONT')
    await until(() => macTask(c, ids.chat)?.title === TITLES.p1, 90_000, 'the old Mac to apply its v1 record')
    await until(() => journal(c).pending.length === 0, 60_000, 'the old Mac to ack it')
    // The Mac's log is written behind its work: its line comes within seconds.
    await until(() => macLog(m, /offline handover: queued write applied/).some((l) => l.includes(ids.chat)), 15_000, 'the old Mac\'s applied line')
    expect(macLog(m, /offline handover: queued write applied/).filter((l) => l.includes(ids.chat))).toHaveLength(1)
  }, 600_000)

  it('P2: the new Mac on the same data (an upgrade): a session write made while it sleeps is a v2 task-fields record; it dies asleep', async () => {
    await stopMac(mac!, 'SIGTERM')
    const m = await boot('new', 'p2-new')
    await until(() => sliceTask(c, ids.chat, ids.sid)?.title === TITLES.p1, 60_000, 'the new Mac\'s copy')
    await sleepMac(m)
    const rec = await renameAway(TITLES.p2)
    expect(rec, fail('P2')).toMatchObject({ kind: 'task-fields', op: 'task_update', taskId: ids.chat, fields: { title: { base: TITLES.p1, value: TITLES.p2 } } })
    // A lid closed for good: no drain ran.
    await stopMac(m, 'SIGKILL')
    expect(macTask(c, ids.chat)?.title).toBe(TITLES.p1)
    expect(journal(c).pending.map((r) => r.kind)).toEqual(['task-fields'])
  }, 600_000)

  it('P3 (R25): the old Mac again (a rollback) is handed no v2 record; its next write is a v1 op and waits behind it', async () => {
    const t0 = Date.now()
    const m = await boot('old', 'p3-old')
    // Its drain on connect: the v2 record heads the journal, so nothing is handed out.
    await sleep(8_000)
    expect(journal(c).pending.map((r) => r.kind), fail('P3 connect')).toEqual(['task-fields'])
    expect(macTask(c, ids.chat)?.title).toBe(TITLES.p1)
    await sleepMac(m)
    const rec = await renameAway(TITLES.p3)
    expect(rec, fail('P3')).toMatchObject({ kind: 'op', op: 'task_update', args: { id: ids.chat, title: TITLES.p3 } })
    lid(m, 'SIGCONT')
    // Its drains on wake: still nothing handed out, nothing acked, nothing lost.
    await sleep(10_000)
    expect(journal(c).pending.map((r) => r.kind), fail('P3 wake')).toEqual(['task-fields', 'op'])
    expect(drainedSince(t0)).toEqual([])
    expect(macTask(c, ids.chat)?.title).toBe(TITLES.p1)
    expect(macLog(m, /offline handover: queued write applied/)).toEqual([])
    await stopMac(m, 'SIGTERM')
  }, 600_000)

  it('P4 (R25): the new Mac again drains both, in order, each once; the journal is empty', async () => {
    const t0 = Date.now()
    const m = await boot('new', 'p4-new')
    await until(() => journal(c).pending.length === 0, 120_000, 'the new Mac to drain both records')
    // In seq order: the v2 rename, then the v1 one queued after it (the later write wins).
    expect(macTask(c, ids.chat)?.title, fail('P4')).toBe(TITLES.p3)
    const handed = drainedSince(t0)
    expect(handed.reduce((n, o) => n + Number(o.records), 0)).toBe(2)
    await until(() => macLog(m, /offline handover: queued write applied/).some((l) => l.includes(ids.chat)), 15_000, 'the new Mac\'s applied line')
    expect(macLog(m, /offline handover: queued write applied/).filter((l) => l.includes(ids.chat))).toHaveLength(1)
    expect(macLog(m, /queued write skipped/)).toEqual([])
    expect(journal(c).records.map((r) => r.kind)).toEqual(['op', 'task-fields', 'op'])
  }, 600_000)
})
