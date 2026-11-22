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
import { spawnLiveDaemon, startLiveMockSession, stopLiveMockSessions, writeLiveMockCli, type LiveCli, type LiveDaemon, type LiveDaemonCtx } from './live-daemon.js'
import { startSilentLinkProxy, type SilentLinkProxy } from './silent-link-proxy.js'
import { testBun } from './bun-runtime.js'

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

/** One world per test file (each file runs in its own worker). */
export const world = {
  base: '',
  procs: null as LiveProcs | null,
  unhookTerm: null as (() => void) | null,
  tokens: { mac: '', local: '', keeper: '', found: '', phone: '' },
  companion: blankServer('companion') as LiveServer,
  /** `out`: what the first boot's own lines reported (taskId, and whatever the test's snippet adds). */
  primary: { ...blankServer('primary'), controlPort: 0, out: {} as Record<string, any> } as LiveServer & { controlPort: number; out: Record<string, any> },
  devbox: null as unknown as LiveDaemon,
  daemons: [] as LiveDaemon[],
  clis: [] as LiveCli[],
  net: { cloud: null, keeper: null, found: null } as { cloud: SilentLinkProxy | null; keeper: SilentLinkProxy | null; found: SilentLinkProxy | null },
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
const c = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(companion.data)} || !c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))})
const server = await startServer({ port: 0, dev: true, bindAddress: '127.0.0.1' })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
${BOOT_TAIL}`, serverEnv(companion, { WALNUT_CLOUD_MODE: '1', WALNUT_GIT_HUB_DIR: path.join(world.base, 'hub'), WALNUT_LEADER_TICK_MS: '300', ...twinOpts.companionEnv }), false)
}

/** The Mac's data, once: its companion (through the Mac's network), its machine tokens, both rows of the one machine. */
async function preparePrimary(): Promise<void> {
  const { primary, tokens } = world
  await prepareServer(primary, world.base, 'primary')
  // No ssh reaches anything from here: a row's own dial fails at once, as an unreachable host does.
  await fsp.writeFile(path.join(primary.home, 'bin', 'ssh'), '#!/bin/sh\necho "ssh: disabled in this test" >&2\nexit 255\n', { mode: 0o755 })
  execFileSync('git', ['init', '-q', primary.data], { env: gitEnv() })
  execFileSync('git', ['-C', primary.data, 'remote', 'add', 'cloud', `http://mac:${tokens.mac}@127.0.0.1:${world.net.cloud!.port}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(primary.data, 'sync'), { recursive: true })
  await fsp.writeFile(path.join(primary.data, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.local, [`bridge-${KEEPER}`]: tokens.keeper, [`bridge-${FOUND}`]: tokens.found }), { mode: 0o600 })
  await fsp.writeFile(path.join(primary.data, 'config.yaml'), [
    'version: 1', 'user:', '  name: Tester', 'defaults:', '  priority: none', '  platform: local', 'provider:', '  type: claude-code',
    'hosts:',
    `  ${KEEPER}:`, '    hostname: devbox.invalid', '    label: Dev box',
    `  ${FOUND}:`, '    hostname: devbox.invalid', '    discovered: true',
    ...(twinOpts.macConfig ?? []), '',
  ].join('\n'))
}

let firstBootSnippet = ''

/** What a test file changes in the world: lines added to the Mac's config.yaml, the Mac's and the companion's extra env. */
export interface TwinOptions { macConfig?: string[]; macEnv?: Record<string, string>; companionEnv?: Record<string, string> }
let twinOpts: TwinOptions = {}

/**
 * Boot the Mac's server. `fresh`: the first boot, which files the task and S's record, then runs
 * the test's own snippet (in scope: `task`, `out`, `src(file)`; what it puts in `out` is reported).
 */
async function bootPrimary(fresh: boolean): Promise<void> {
  const { primary, tokens, net } = world
  const src = (f: string) => JSON.stringify(path.join(REPO_ROOT, f))
  const links = { [KEEPER]: `ws://127.0.0.1:${net.keeper!.port}`, [FOUND]: `ws://127.0.0.1:${net.found!.port}` }
  await bootServer(primary, `
${BOOT_HEAD}
const c = await import(${src('src/constants.ts')})
if (c.WALNUT_HOME !== ${JSON.stringify(primary.data)} || c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${src('src/web/server.ts')})
const server = await startServer({ port: 0, dev: true, bindAddress: '127.0.0.1' })
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
const links = ${JSON.stringify(links)}
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
  if (foundAllowed && !up(${JSON.stringify(FOUND)}) && Date.now() - keeperUpAt > 3_000) await dial(${JSON.stringify(FOUND)})
}
let keeping = false
setInterval(() => { if (keeping) return; keeping = true; void keepLinks().finally(() => { keeping = false }) }, 1_000).unref()
await keepLinks()
const { createServer } = await import('node:http')
const control = createServer((req, res) => {
  if (req.headers.authorization !== ${JSON.stringify(`Bearer ${tokens.local}`)}) { res.writeHead(401).end(); return }
  if (req.url === '/link-found') foundAllowed = true
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ keeper: up(${JSON.stringify(KEEPER)}), found: up(${JSON.stringify(FOUND)}), foundAllowed }))
})
await new Promise((r) => control.listen(0, '127.0.0.1', r))
const addr = server.address()
process.stdout.write(JSON.stringify({ out, controlPort: control.address().port }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
${BOOT_TAIL}`, serverEnv(primary, { WALNUT_LEADER_HEARTBEAT_MS: '500', ...twinOpts.macEnv }), true, (line) => {
    try {
      const j = JSON.parse(line)
      if (typeof j.controlPort === 'number') { primary.controlPort = j.controlPort; if (fresh) primary.out = j.out ?? {} }
    } catch { /* partial */ }
  })
}

async function control(p: '/links' | '/link-found'): Promise<{ keeper: boolean; found: boolean }> {
  const res = await fetch(`http://127.0.0.1:${world.primary.controlPort}${p}`, { method: p === '/links' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${world.tokens.local}` }, signal: AbortSignal.timeout(10_000) })
  return await res.json() as { keeper: boolean; found: boolean }
}

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
  world.base = await liveBase(prefix, ['prd', 'cod', 'de'])
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
    await finishLive(procs, world.base, [world.primary, world.companion], () => stopLiveMockSessions(daemonCtx(), world.daemons, world.clis, world.primary.data))
  } finally {
    for (const p of macNet()) await p?.close()
    world.unhookTerm?.()
  }
}
