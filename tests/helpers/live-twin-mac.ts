/**
 * The world of the "Mac goes away" live e2e tests (tests/e2e/*-mac-away-live-e2e.test.ts): a real
 * primary (the Mac) with its own local daemon, a real cloud companion, and ONE real remote daemon
 * that the Mac reaches under two host aliases, as it reached `clouddev` and `newdev` (2026-11-20):
 *
 *   primary ──► devbox        (the row the person added and named)  ─┐ two links, two URLs
 *           └─► devbox-found  (a row found in ~/.ssh/config)        ─┴► ONE daemon (session S)
 *   companion (WALNUT_CLOUD_MODE=1) ◄── /bridge from both daemons
 *
 * Every link of the Mac (to the companion, and one per alias to the daemon) runs through an
 * in-test TCP proxy (silent-link-proxy.ts), so the Mac's network can fail while its processes run;
 * the dev box's own bridge rides the same companion proxy and is exempt (its machine token).
 *
 * The three ways the Mac goes away (macGoes / macReturns):
 *   asleep     SIGSTOP of the primary server and its local daemon (a lid close), later SIGCONT;
 *   offline    every link of the Mac closed and new ones held silent, the processes running (the
 *              incident: the Mac's DNS failed), later restored;
 *   shut down  TERM of the server and the local daemon with proven exits, later a boot on the same
 *              data. A TERM is a graceful stop: it tells the companion "restarting"
 *              (LEADER_RESTART_GRACE_MS), so the companion takes the lead only after that.
 *
 * The links to the daemon are direct (no ssh here): a loop in the boot script dials them, as the
 * product's reconnect loop does for an ssh row, and pools each under its alias, where every feature
 * looks a host's link up (core/hosts/link.ts). `devbox-found` links only once the test allows it
 * (linkBothAliases), and always a few seconds after `devbox`, so the discovered alias pushes last.
 *
 * A leader switch (TwinOptions.leaderSwitch): the Mac (machine A) and a second leader B (`world.standby`,
 * machine B: its own HOME, data dir, daemon dir and local daemon) run the write permission on three
 * witness dirs under the base, as `leader_switch` names them. B boots over a copy of A's leader data made
 * while A is stopped (leader-data-copy.ts: the same auth.json, so the same Walnut id, and the same
 * sync/bridge-tokens.json, so the same `bridge-local` token), as a switch's commit start
 * (WALNUT_LEADER_SWITCH_COMMIT), and reaches the dev box directly (its own network, no proxy). Each
 * leader's local daemon outlives its server, as the production daemon does (a test server's own
 * daemon has a parent watchdog and ends with it, local-daemon.ts parentWatchdogEnv): the test starts
 * it in the leader's daemon dir and the server adopts it. The
 * leader's boot script answers two hooks of src/core/leader/switch/host-follow.ts on its control port
 * (dropOwnDaemonDuties, announceSwitchStop), so they run inside the leader's own process.
 *
 * Isolation and cleanup are tests/e2e/leader-takeover-live-e2e.test.ts's: walls, LiveProcs, fresh
 * auth.json, a refusing `claude` and `ssh` on the servers' PATH, TERM and proven exits only.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { LiveProcs, realProcTable, type Owned } from './live-procs.js'
import { liveEnv } from './live-isolation.js'
import { BOOT_HEAD, BOOT_TAIL, blankServer, bootLiveServer, finishLive, guardLogOf, liveBase, prepareServer, resumeOnTerm, type LiveServer } from './live-run.js'
import { builtDaemonBinary, daemonCall, spawnLiveDaemon, startLiveMockSession, stopLiveMockSessions, writeLiveMockCli, type LiveCli, type LiveDaemon, type LiveDaemonCtx } from './live-daemon.js'
import { startSilentLinkProxy, type SilentLinkProxy } from './silent-link-proxy.js'
import { testBun } from './bun-runtime.js'
import { copyLeaderData, freePort } from './leader-data-copy.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const BUN: string | undefined = testBun()
export const KEEPER = 'devbox'
export const FOUND = 'devbox-found'
/** The session on the dev box, linked to a task the first boot files. */
export const S = 'dddddddd-4444-4444-8444-444444444444'
// The takeover window and beat of tests/e2e/leader-takeover-live-e2e.test.ts (see why there).
export const T = 6_000
export const BEAT = 4_000

export type Way = 'asleep' | 'offline' | 'shut down'
export const WAYS: readonly Way[] = ['asleep', 'offline', 'shut down']

const sha256 = (t: string): string => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const newToken = (): string => crypto.randomBytes(16).toString('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

const blankWorld = () => ({
  base: '',
  procs: null as LiveProcs | null,
  unhookTerm: null as (() => void) | null,
  tokens: { mac: '', local: '', keeper: '', found: '', phone: '' },
  companion: blankServer('companion') as LiveServer,
  /** `out`: what the first boot's own lines reported (taskId, and whatever the test's snippet adds). */
  primary: { ...blankServer('primary'), controlPort: 0, out: {} as Record<string, any> } as LeaderServer,
  /** The second leader B of a leader switch (TwinOptions.leaderSwitch); booted by bootStandby. */
  standby: { ...blankServer('standby'), controlPort: 0, out: {} as Record<string, any> } as LeaderServer,
  /** The leader switch's places (TwinOptions.leaderSwitch): machine ids, their files and ports, the witness dirs. */
  leaderSwitch: null as LeaderSwitchPlaces | null,
  /** The home whose leader the dev box follows now: the Mac's, or B's once B booted. */
  leaderHome: '',
  devbox: null as unknown as LiveDaemon,
  daemons: [] as LiveDaemon[],
  clis: [] as LiveCli[],
  net: { cloud: null, keeper: null, found: null } as { cloud: SilentLinkProxy | null; keeper: SilentLinkProxy | null; found: SilentLinkProxy | null },
})
/** The world of a test file; setupTwinMac starts it anew, so a file may run one world after another (each describe its own setup and teardown). */
export const world = blankWorld()
export type LeaderServer = LiveServer & { controlPort: number; out: Record<string, any> }
export interface LeaderSwitchPlaces {
  a: { id: string; idFile: string; port: number }
  b: { id: string; idFile: string; port: number }
  witnesses: Array<{ id: string; dir: string }>
}
const daemonCtx = (): LiveDaemonCtx => ({ procs: world.procs!, base: world.base, repo: REPO_ROOT, bun: BUN })
const macNet = (): Array<SilentLinkProxy | null> => [world.net.cloud, world.net.keeper, world.net.found]

function logTail(log: string, chars = 3_500): string {
  return log.split('\n').filter((l) => !/INF \[web\] GET \/api\/(v1\/(sessions\/[^ ]+|status|human-inbox\/[^ ]+)|leader) → 200/.test(l)).join('\n').slice(-chars)
}

export async function waitFor<V>(fn: () => Promise<V | null | undefined | false> | V | null | undefined | false, ms: number, what: string): Promise<V> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as V } catch (e) { last = e }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}\n--- companion ---\n${logTail(world.companion.log)}\n--- primary ---\n${logTail(world.primary.log)}`)
}

function serverEnv(s: LiveServer, extra: Record<string, string>): NodeJS.ProcessEnv {
  return liveEnv({ home: s.home, tmp: path.dirname(s.home), bins: [path.join(s.home, 'bin')], guardLog: guardLogOf(world.base) }, {
    OPEN_WALNUT_HOME: s.data,
    WALNUT_DAEMON_DIR: s.daemonDir,
    WALNUT_STREAMS_DIR: path.join(s.daemonDir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(s.daemonDir, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(s.daemonDir, 'spawn-journal.jsonl'),
    WALNUT_DISABLE_BACKGROUND_AI: '1',
    WALNUT_DISABLE_SEARCH: '1',
    WALNUT_LOCAL_CLAUDE_PROBE: '0',
    WALNUT_LEADER_TAKEOVER_MS: String(T),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT),
    WALNUT_SESSION_HOST: '0',
    WALNUT_TEST_KEEPER_PID: String(process.pid),
    WALNUT_TURN_SNAPSHOTS: '0',
    ...extra,
  })
}

async function bootServer(s: LiveServer, script: string, env: NodeJS.ProcessEnv, ownDaemon: boolean, onLine?: (line: string) => void): Promise<void> {
  await bootLiveServer(world.procs!, s, { base: world.base, repo: REPO_ROOT, file: path.join(world.base, `${s.name}-boot.mts`), script, env, ownDaemon, onLine })
}

async function startCompanion(): Promise<void> {
  const { companion, tokens } = world
  await prepareServer(companion, world.base, 'companion')
  await fsp.mkdir(path.join(world.base, 'hub'), { recursive: true })
  await fsp.writeFile(path.join(companion.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
  const now = new Date().toISOString()
  await fsp.writeFile(path.join(companion.data, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', tokenHash: sha256(tokens.mac), createdAt: now },
    { name: 'phone', tokenHash: sha256(tokens.phone), createdAt: now },
    { name: 'bridge-local', tokenHash: sha256(tokens.local), createdAt: now, kind: 'machine' },
    { name: `bridge-${KEEPER}`, tokenHash: sha256(tokens.keeper), createdAt: now, kind: 'machine' },
    { name: `bridge-${FOUND}`, tokenHash: sha256(tokens.found), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await bootServer(companion, `
${BOOT_HEAD}
${twinOpts.recordCompanionOutward ? outwardRecorder(companionOutwardLog()) : ''}
const c = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(companion.data)} || !c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))})
const server = await startServer({ port: 0, dev: true, bindAddress: '127.0.0.1' })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
${BOOT_TAIL}`, serverEnv(companion, { WALNUT_CLOUD_MODE: '1', WALNUT_GIT_HUB_DIR: path.join(world.base, 'hub'), WALNUT_LEADER_TICK_MS: '300', ...twinOpts.companionEnv }), false)
}

/**
 * Code a boot script runs first (before the server is imported): every outward connection and fetch
 * the process makes, and every child it starts, one JSON line each in `file` (`{t, kind, what}`), so a
 * test can show what a server sent while it led nothing. It records and changes nothing.
 */
function outwardRecorder(file: string): string {
  return `
{
  const fs = await import('node:fs')
  const rec = (kind, what) => { try { fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({ t: Date.now(), kind, what: String(what).slice(0, 300) }) + '\\n') } catch {} }
  const net = await import('node:net')
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...a) {
    try {
      const o = Array.isArray(a[0]) ? a[0][0] : a[0]
      rec('connect', o && typeof o === 'object' ? (o.path ? 'unix:' + o.path : (o.host ?? 'localhost') + ':' + o.port) : (typeof a[1] === 'string' ? a[1] : 'localhost') + ':' + o)
    } catch {}
    return connect.apply(this, a)
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => { try { rec('fetch', (init?.method ?? 'GET') + ' ' + (typeof input === 'string' ? input : input?.url ?? String(input))) } catch {}; return realFetch(input, init) }
  const cp = (await import('node:child_process')).default
  for (const fn of ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync']) {
    const real = cp[fn]
    if (typeof real === 'function') { try { cp[fn] = function (...a) { rec('child', fn + ' ' + [a[0], ...(Array.isArray(a[1]) ? a[1] : [])].join(' ')); return real.apply(this, a) } } catch {} }
  }
  if (globalThis.Bun?.spawn) { const real = Bun.spawn; try { Bun.spawn = (...a) => { rec('child', 'Bun.spawn ' + JSON.stringify(a[0]?.cmd ?? a[0])); return real(...a) } } catch {} }
}
`
}

/** Where the companion's outward recorder writes (TwinOptions.recordCompanionOutward). */
export const companionOutwardLog = (): string => path.join(world.base, 'companion-outward.jsonl')

/** The leader switch's section of config.yaml (leader data: B's copy carries it). */
function leaderSwitchConfig(ls: LeaderSwitchPlaces): string[] {
  const { primary, standby } = world
  const machine = (m: LeaderSwitchPlaces['a'], s: LiveServer) => [
    `    - id: ${m.id}`, `      home: ${s.data}`, `      standby_dir: ${path.join(path.dirname(s.data), 'standby-in')}`, `      port: ${m.port}`,
  ]
  return [
    'experimental:', '  switchable_leader: true',
    'leader_switch:',
    '  witnesses:', ...ls.witnesses.flatMap((w) => [`    - id: ${w.id}`, `      dir: ${w.dir}`]),
    '  machines:', ...machine(ls.a, primary), ...machine(ls.b, standby),
    '  back_window_hours: 24',
  ]
}

/** A witness dir's record file (local-witnesses.ts, imported with the setup). */
let recordFileOf: ((w: { id: string; dir: string }) => string) | null = null

/** The places of a leader switch, and the witness dirs set up from nothing (local-witnesses.ts, as `walnut leader witnesses init` does). */
async function prepareLeaderSwitch(): Promise<void> {
  const place = async (name: 'a' | 'b') => {
    const idFile = path.join(world.base, `machine-${name}`, 'machine-id')
    await fsp.mkdir(path.dirname(idFile), { recursive: true, mode: 0o700 })
    await fsp.writeFile(idFile, `machine-${name}\n`)
    return { id: `machine-${name}`, idFile, port: await freePort() }
  }
  const witnesses = ['w1', 'w2', 'w3'].map((id) => ({ id, dir: path.join(world.base, 'witnesses', id) }))
  const { setUpLocalWitnesses, witnessRecordFile } = await import('../../src/core/leader/switch/local-witnesses.js')
  setUpLocalWitnesses(witnesses)
  recordFileOf = witnessRecordFile
  world.leaderSwitch = { a: await place('a'), b: await place('b'), witnesses }
}

/** A leader's home: a `claude` and an `ssh` that refuse. */
async function prepareLeaderHome(s: LiveServer, name: 'primary' | 'standby'): Promise<void> {
  await prepareServer(s, world.base, name)
  // No ssh reaches anything from here: a row's own dial fails at once, as an unreachable host does.
  await fsp.writeFile(path.join(s.home, 'bin', 'ssh'), '#!/bin/sh\necho "ssh: disabled in this test" >&2\nexit 255\n', { mode: 0o755 })
}

/** The Mac's data, once: its companion (through the Mac's network), its machine tokens, both rows of the one machine. */
async function preparePrimary(): Promise<void> {
  const { primary, tokens } = world
  await prepareLeaderHome(primary, 'primary')
  if (twinOpts.leaderSwitch) {
    // B's places are named in the config A writes (leader data), so B's are known before B exists.
    world.standby.home = path.join(world.base, 'standby', 'home')
    world.standby.data = path.join(world.base, 'standby', 'data')
    await prepareLeaderSwitch()
  }
  execFileSync('git', ['init', '-q', primary.data], { env: gitEnv() })
  execFileSync('git', ['-C', primary.data, 'remote', 'add', 'cloud', `http://mac:${tokens.mac}@127.0.0.1:${world.net.cloud!.port}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(primary.data, 'sync'), { recursive: true })
  await fsp.writeFile(path.join(primary.data, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.local, [`bridge-${KEEPER}`]: tokens.keeper, [`bridge-${FOUND}`]: tokens.found }), { mode: 0o600 })
  await fsp.writeFile(path.join(primary.data, 'config.yaml'), [
    'version: 1', 'user:', '  name: Tester', 'defaults:', '  priority: none', '  platform: local', 'provider:', '  type: claude-code',
    'hosts:',
    `  ${KEEPER}:`, '    hostname: devbox.invalid', '    label: Dev box',
    `  ${FOUND}:`, '    hostname: devbox.invalid', '    discovered: true',
    ...(world.leaderSwitch ? leaderSwitchConfig(world.leaderSwitch) : []),
    ...(twinOpts.macConfig ?? []), '',
  ].join('\n'))
}

let firstBootSnippet = ''

/**
 * What a test file changes in the world: lines added to the Mac's config.yaml, the Mac's and the
 * companion's extra env. `leaderSwitch`: A and B run the write permission (the file's header).
 * `recordCompanionOutward`: the companion records every outward connection, fetch and child
 * (companionOutwardLog).
 */
export interface TwinOptions { macConfig?: string[]; macEnv?: Record<string, string>; companionEnv?: Record<string, string>; leaderSwitch?: boolean; recordCompanionOutward?: boolean }

/**
 * A leader's local daemon started by the test in its own dir (`<base>/pm` for the Mac, `<base>/sb` for
 * B), so it outlives the leader's server as the production daemon does; the server adopts it.
 */
async function startSurvivingLocalDaemon(s: LiveServer, name: 'pmlocal' | 'sblocal'): Promise<void> {
  // The build the server would spawn itself (a server replaces a daemon of another version with its own).
  if (!builtDaemonBinary(REPO_ROOT)) throw new Error('a leader switch world needs the built daemon (dist/daemon-binaries): run the build first')
  const twin = 'binary'
  const d = await spawnLiveDaemon(daemonCtx(), name, twin, { WALNUT_LEADER_TAKEOVER_MS: String(T), WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT) })
  world.daemons.push(d)
  s.daemonDir = d.dir
}
let twinOpts: TwinOptions = {}

/**
 * Boot a leader's server (the Mac, or B). `fresh`: the Mac's first boot, which files the task and S's
 * record, then runs the test's own snippet (in scope: `task`, `out`, `src(file)`; what it puts in
 * `out` is reported). `links`: the host aliases it dials and their URLs. `env`: on top of the world's.
 */
async function bootLeader(s: LeaderServer, o: { fresh: boolean; links: Record<string, string>; listenPort?: number; env?: Record<string, string> }): Promise<void> {
  const { tokens } = world
  const fresh = o.fresh
  const src = (f: string) => JSON.stringify(path.join(REPO_ROOT, f))
  await bootServer(s, `
${BOOT_HEAD}
const c = await import(${src('src/constants.ts')})
if (c.WALNUT_HOME !== ${JSON.stringify(s.data)} || c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${src('src/web/server.ts')})
const server = await startServer({ port: ${o.listenPort ?? 0}, dev: true, bindAddress: '127.0.0.1' })
const out = {}
if (${fresh}) {
  const src = (f) => ${JSON.stringify(REPO_ROOT)} + '/' + f
  const tm = await import(${src('src/core/task-manager.ts')})
  const task = (await tm.addTask({ title: 'Fix the flaky build on the dev box', project: 'Acme' })).task
  const st = await import(${src('src/core/session-tracker.ts')})
  await st.createSessionRecord(${JSON.stringify(S)}, task.id, 'Acme', ${JSON.stringify(world.devbox.dir)}, { host: ${JSON.stringify(KEEPER)}, title: 'Build fix', initialProcessStatus: 'idle' })
  await tm.linkSession(task.id, ${JSON.stringify(S)})
  out.taskId = task.id
  ${firstBootSnippet}
}
const { localDaemon } = await import(${src('src/providers/local-daemon.ts')})
const dc = await import(${src('src/providers/daemon-connection.ts')})
const { awaitLocalDaemonLink, failBootLink } = await import(${src('tests/helpers/local-daemon-link.ts')})
await awaitLocalDaemonLink({
  wsUrl: localDaemon.wsUrl,
  connected: () => dc.getConnectedDaemonConnection('__local__') !== null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}).catch((err) => failBootLink(err, {
  stop: () => stopServer(),
  write: (line) => process.stderr.write(line + '\\n'),
  exit: (code) => process.exit(code),
}))
const links = ${JSON.stringify(o.links)}
const up = (alias) => dc.getConnectedDaemonConnection(alias) !== null
// A link up is the alias's own pooled link, where link(host) looks (an ssh row's link is pooled so).
const dial = async (alias) => {
  const conn = await dc.getDirectDaemonConnection(alias, links[alias]).catch(() => null)
  if (conn && conn.connected && dc.peekDaemonConnection(alias) !== conn) dc.setPooledConnectionForTest(alias, conn)
}
let foundAllowed = false
let keeperUpAt = 0
const keepLinks = async () => {
  for (const alias of Object.keys(links)) {
    const conn = dc.getConnectedDaemonConnection(alias)
    if (conn && dc.peekDaemonConnection(alias) !== conn) dc.setPooledConnectionForTest(alias, conn)
  }
  if (!up(${JSON.stringify(KEEPER)})) { keeperUpAt = 0; await dial(${JSON.stringify(KEEPER)}); return }
  if (!keeperUpAt) keeperUpAt = Date.now()
  if (foundAllowed && links[${JSON.stringify(FOUND)}] && !up(${JSON.stringify(FOUND)}) && Date.now() - keeperUpAt > 3_000) await dial(${JSON.stringify(FOUND)})
}
let keeping = false
setInterval(() => { if (keeping) return; keeping = true; void keepLinks().finally(() => { keeping = false }) }, 1_000).unref()
await keepLinks()
const { createServer } = await import('node:http')
// The test's hooks into this process (the leader switch's own calls, host-follow.ts).
const control = createServer((req, res) => {
  if (req.headers.authorization !== ${JSON.stringify(`Bearer ${tokens.local}`)}) { res.writeHead(401).end(); return }
  res.setHeader('Content-Type', 'application/json')
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/drop-duties' || url.pathname === '/restart-notice') {
    void import(${src('src/core/leader/switch/host-follow.ts')}).then(async (hf) => {
      const r = url.pathname === '/drop-duties'
        ? await hf.dropOwnDaemonDuties({ home: c.WALNUT_HOME })
        : { restartingMs: await hf.announceSwitchStop(Number(url.searchParams.get('ms'))) }
      res.end(JSON.stringify(r))
    }).catch((err) => { res.writeHead(500).end(JSON.stringify({ ok: false, why: String(err) })) })
    return
  }
  if (url.pathname === '/link-found') foundAllowed = true
  res.end(JSON.stringify({ keeper: up(${JSON.stringify(KEEPER)}), found: up(${JSON.stringify(FOUND)}), foundAllowed }))
})
await new Promise((r) => control.listen(0, '127.0.0.1', r))
const addr = server.address()
process.stdout.write(JSON.stringify({ out, controlPort: control.address().port }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
${BOOT_TAIL}`, serverEnv(s, { WALNUT_LEADER_HEARTBEAT_MS: '500', ...twinOpts.macEnv, ...o.env }), true, (line) => {
    try {
      const j = JSON.parse(line)
      if (typeof j.controlPort === 'number') { s.controlPort = j.controlPort; if (fresh) s.out = j.out ?? {} }
    } catch { /* partial */ }
  })
}

/** Boot the Mac's server (machine A with a leader switch), dialing both aliases through the Mac's network. */
async function bootPrimary(fresh: boolean): Promise<void> {
  const { net } = world
  const ls = world.leaderSwitch
  if (ls && fresh) await startSurvivingLocalDaemon(world.primary, 'pmlocal')
  await bootLeader(world.primary, {
    fresh,
    links: { [KEEPER]: `ws://127.0.0.1:${net.keeper!.port}`, [FOUND]: `ws://127.0.0.1:${net.found!.port}` },
    ...(ls ? { listenPort: ls.a.port, env: { WALNUT_MACHINE_ID_FILE: ls.a.idFile } } : {}),
  })
  world.leaderHome = world.primary.data
}

/** A's server booted again on its own data and its surviving local daemon (a rolled-back switch's start of the old leader, flow.ts 'start-source'). */
export async function restartPrimary(): Promise<void> {
  if (world.primary.server && !world.primary.server.exited) throw new Error('restartPrimary: A\'s server still runs')
  await bootPrimary(false)
}

/** What one witness dir holds now (its permit record file, read as a file: no witness is served from here). */
export interface WitnessHeld { witness: string; number: number; kind: string; holder: string; by: string; from?: string; to?: string; validMs: number }
export function witnessRecords(): Array<WitnessHeld | null> {
  return (world.leaderSwitch?.witnesses ?? []).map((w) => {
    try {
      const h = JSON.parse(fs.readFileSync(recordFileOf!(w), 'utf8')).held
      return h ? { witness: w.id, number: h.number, kind: h.kind, holder: h.holder, by: h.by, ...(h.from ? { from: h.from } : {}), ...(h.to ? { to: h.to } : {}), validMs: h.validMs } : null
    } catch { return null }
  })
}
/** The record a majority of the witness dirs holds (the same number at two of three), or null. */
export function standingRecord(): WitnessHeld | null {
  const held = witnessRecords().filter((r): r is WitnessHeld => r !== null)
  const ls = world.leaderSwitch
  const need = ls ? Math.floor(ls.witnesses.length / 2) + 1 : Infinity
  for (const r of held) if (held.filter((x) => x.number === r.number).length >= need) return r
  return null
}

/** A hook of the leader switch run inside a leader's own process (host-follow.ts), or the link state. */
export async function leaderControl(s: LeaderServer, p: '/links' | '/link-found' | '/drop-duties' | `/restart-notice?ms=${number}`): Promise<Record<string, any>> {
  const res = await fetch(`http://127.0.0.1:${s.controlPort}${p}`, { method: p === '/links' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${world.tokens.local}` }, signal: AbortSignal.timeout(30_000) })
  return await res.json() as Record<string, any>
}

const control = (p: '/links' | '/link-found') => leaderControl(world.primary, p) as Promise<{ keeper: boolean; found: boolean }>

/** Both links up, `devbox` first: once the companion knows the daemon as `devbox`, the discovered row links. */
export async function linkBothAliases(): Promise<void> {
  await waitFor(async () => (await control('/links')).keeper, 60_000, 'the devbox link')
  await waitFor(async () => (await bridgeAliases()).includes(KEEPER), 60_000, 'the companion to know the daemon as devbox')
  await control('/link-found')
  await waitFor(async () => (await control('/links')).found, 60_000, 'the devbox-found link')
}

export type Reply = { status: number; json: Record<string, any>; text: string; ms: number }
export async function api(s: LiveServer, p: string, init: RequestInit = {}, token = world.tokens.mac): Promise<Reply> {
  const started = Date.now()
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let json: Record<string, any> = {}
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, text, ms: Date.now() - started }
}
/** The phone: a paired device's token on the companion. */
export const phone = (p: string, init: RequestInit = {}) => api(world.companion, p, init, world.tokens.phone)

/** The aliases the companion holds a bridge for, this Mac's own daemon left out. */
export const bridgeAliases = async (): Promise<string[]> =>
  (((await api(world.companion, '/api/v1/status')).json.bridgeHosts ?? []) as Array<{ hostAlias: string }>).map((b) => b.hostAlias).filter((a) => a !== '__local__').sort()
export const companionLeads = async () => ((await api(world.companion, '/api/leader')).json.leading ?? []) as Array<{ host: string; epoch: number }>
/** Whether the companion's one view of the Mac (server-role.ts leaderAnswers) says it answers. */
export const companionHearsMac = async (): Promise<boolean> => (await api(world.companion, '/api/leader')).json.leader?.answers === true

const macProcs = (): Owned[] => {
  const { primary } = world
  if (!primary.server || !primary.daemon) throw new Error('the Mac\'s server and daemon are not registered')
  return [primary.server, primary.daemon]
}

/** Throws when a step that must happen did not (a signal not sent, an exit not proven). */
function must(ok: boolean, what: string): void { if (!ok) throw new Error(`${what}: ${[...world.procs!.refused, ...world.procs!.failures].join('; ')}`) }

export async function macGoes(way: Way): Promise<void> {
  const { procs } = world
  if (way === 'asleep') {
    for (const o of macProcs()) must(await procs!.pause(o), `SIGSTOP ${o.label}`)
  } else if (way === 'offline') {
    for (const p of macNet()) p!.setMode('drop-hold')
    must((await procs!.state(world.primary.server!)) === 'ours', 'the Mac\'s server keeps running offline')
  } else {
    for (const o of macProcs()) must(await procs!.stop(o, 30_000), `TERM ${o.label}`)
  }
}

export async function macReturns(way: Way): Promise<void> {
  if (way === 'asleep') {
    // The daemon first, so the server finds it answering.
    for (const o of [...macProcs()].reverse()) must(await world.procs!.resume(o), `SIGCONT ${o.label}`)
  } else if (way === 'offline') {
    for (const p of macNet()) p!.setMode('pass')
  } else {
    await bootPrimary(false)
    await linkBothAliases()
  }
}

/** The Mac back: it holds devbox again and the companion let go of it. */
export async function macHoldsDevboxAgain(): Promise<void> {
  await waitFor(async () => {
    const mine = (await api(world.primary, '/api/leader')).json.hosts?.[KEEPER]
    return mine?.holder === 'primary' && (await companionLeads()).length === 0
  }, 120_000, 'the Mac to take devbox back and the companion to let go')
}

// ---- a leader switch: A (the Mac) to B (TwinOptions.leaderSwitch) ----------------------------------

/** A command to a leader's own local daemon (its port file in the server's daemon dir), over a plain socket of this test. */
export async function localDaemonCall(s: LiveServer, payload: Record<string, unknown>, ms = 10_000): Promise<Record<string, any>> {
  const port = Number(fs.readFileSync(path.join(s.daemonDir, 'daemon.port'), 'utf8').trim())
  return daemonCall({ name: `${s.name} daemon`, port } as LiveDaemon, payload, ms)
}

/** TERM of a leader's server alone, its exit proven: its local daemon keeps running (its sessions, its bridge). */
export async function stopLeaderServer(s: LiveServer): Promise<void> {
  if (!s.server) throw new Error(`${s.name}: no server registered`)
  must(await world.procs!.stop(s.server, 30_000), `TERM ${s.server.label}`)
}

/**
 * B's data dir, as the switch's final batch and promotion leave it: a copy of A's leader data made
 * while A is stopped, and the promotion record the switch writes before the commit start
 * (flow.ts 'commit': state 'promoted', the handover it commits on, the data dir A spoke from on its
 * hosts). Returns how many files were copied.
 */
export async function prepareStandby(o: { switchId: string; handover: number }): Promise<number> {
  const { primary, standby } = world
  const ls = world.leaderSwitch
  if (!ls) throw new Error('prepareStandby: the world has no leader switch (TwinOptions.leaderSwitch)')
  if (primary.server && !primary.server.exited) throw new Error('prepareStandby: A\'s server still runs; its copy is made while it is stopped')
  await prepareLeaderHome(standby, 'standby')
  copyLeaderData(primary.data, standby.data)
  let files = 0
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files++ }
  walk(standby.data)
  const { writePromoted } = await import('../../src/core/leader/switch/records.js')
  writePromoted(standby.data, { switchId: o.switchId, state: 'promoted', from: primary.data, to: ls.b.id, handover: o.handover, fromHomeOnHosts: primary.data, fromFormerHomes: [], at: new Date().toISOString() })
  return files
}

/**
 * Boot B as the switch's commit start (WALNUT_LEADER_SWITCH_COMMIT = the handover's number, and
 * WALNUT_LEADER_SWITCH_START = the switch, as side.ts starts it, so the promotion wait lets it boot),
 * on its config port, its own local daemon, the dev box dialed directly. `commitUntil`: the commit
 * window's end (WALNUT_LEADER_SWITCH_COMMIT_UNTIL); none, as a start the window does not bound.
 * The dev box follows B's home from here.
 */
export async function bootStandby(o: { commitHandover: number; switchId: string; commitUntil?: number }): Promise<void> {
  const ls = world.leaderSwitch!
  await startSurvivingLocalDaemon(world.standby, 'sblocal')
  await bootLeader(world.standby, {
    fresh: false,
    links: { [KEEPER]: `ws://127.0.0.1:${world.devbox.port}` },
    listenPort: ls.b.port,
    env: {
      WALNUT_MACHINE_ID_FILE: ls.b.idFile, WALNUT_LEADER_SWITCH_COMMIT: String(o.commitHandover), WALNUT_LEADER_SWITCH_START: o.switchId,
      ...(o.commitUntil ? { WALNUT_LEADER_SWITCH_COMMIT_UNTIL: String(o.commitUntil) } : {}),
    },
  })
  world.leaderHome = world.standby.data
}

/** The sessions of the read copy the daemon answers from while the Mac is away (offline-host-core.ts). */
export function sliceSids(d: LiveDaemon): string[] | null {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /^slice-[0-9a-f]+\.json$/.test(e.name) ? [path.join(dir, e.name)] : [])
  for (const f of walk(d.dir)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { home?: string; sessions?: Array<{ sid: string }> }
      if (j.home === world.primary.data) return (j.sessions ?? []).map((s) => s.sid)
    } catch { /* being replaced */ }
  }
  return null
}

/**
 * Start the world: the companion, the Mac's network, the daemon with S on it, and the Mac booted
 * with `firstBoot` run once on its first boot. `prefix`: the temp base's.
 */
export async function setupTwinMac(prefix: string, firstBoot = '', opts: TwinOptions = {}): Promise<void> {
  firstBootSnippet = firstBoot
  twinOpts = opts
  // A world after another in the same file starts from nothing of the one before.
  Object.assign(world, blankWorld())
  world.base = await liveBase(prefix, ['prd', 'cod', 'de', 'std', 'pm', 'sb'])
  world.procs = new LiveProcs(realProcTable(), world.base)
  world.unhookTerm = resumeOnTerm(world.procs)
  for (const k of Object.keys(world.tokens) as Array<keyof typeof world.tokens>) world.tokens[k] = newToken()
  writeLiveMockCli(world.base)
  await startCompanion()
  // The dev box's own bridge rides the same companion proxy and never fails with the Mac's network.
  world.net.cloud = await startSilentLinkProxy(world.companion.port, '127.0.0.1', {
    exempt: (head) => { const h = head.toString('latin1'); return h.includes(world.tokens.keeper) || h.includes(world.tokens.found) },
  })
  // The standalone twin here; node-side (test:source-twin-node-suites) the JS twin, on Node.
  const twin = BUN && process.env.WALNUT_REQUIRE_NODE !== '1' ? 'standalone' : 'source'
  world.devbox = await spawnLiveDaemon(daemonCtx(), 'devbox', twin, { WALNUT_LEADER_TAKEOVER_MS: String(T), WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT) })
  world.daemons.push(world.devbox)
  world.net.keeper = await startSilentLinkProxy(world.devbox.port)
  world.net.found = await startSilentLinkProxy(world.devbox.port)
  await preparePrimary()
  world.clis.push(await startLiveMockSession(daemonCtx(), world.devbox, S, world.primary.data))
  await bootPrimary(true)
  if (!world.primary.out.taskId) throw new Error('the first boot reported no task')
}

/** The Mac is up: it leads devbox, the companion hears it and holds S. */
export async function macIsUp(): Promise<void> {
  const { primary, companion } = world
  await waitFor(async () => (await api(primary, '/api/leader')).json.hosts?.[KEEPER]?.holder === 'primary', 120_000, 'the Mac to lead devbox')
  await waitFor(async () => (await api(companion, '/api/leader')).json.primaryHeard === true, 120_000, 'the companion to hear the Mac')
  const knows = (file: string) => { try { return fs.readFileSync(path.join(companion.data, 'cache', file), 'utf8').includes(S) } catch { return false } }
  await waitFor(() => knows(path.join('replica', 'sessions.json')) || knows(path.join('projections', 'sessions.json')), 120_000, 'S on the companion')
}

export async function teardownTwinMac(): Promise<void> {
  const { procs } = world
  if (!procs) return
  try {
    for (const p of macNet()) p?.setMode('pass')
    const servers = [world.primary, ...(world.standby.data && world.standby.daemonDir ? [world.standby] : []), world.companion]
    // A host follows the leader's home now: after a switch it refuses the old one (walnut_home_busy).
    await finishLive(procs, world.base, servers, () => stopLiveMockSessions(daemonCtx(), world.daemons, world.clis, world.leaderHome || world.primary.data))
  } finally {
    for (const p of macNet()) await p?.close()
    world.unhookTerm?.()
  }
}
