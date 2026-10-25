/**
 * One request path on the companion, with the real servers
 * (docs/plan/walnut-control-plane.md "One request path on the companion").
 *
 *   phone ──HTTP──► companion (real Walnut server, WALNUT_CLOUD_MODE=1)
 *                     │ forward (src/web/v1-forward/proxy.ts) while the Mac answers
 *                     ▼ /bridge ◄── the Mac's own daemon (dials out, machine token)
 *                   primary (real Walnut server) runs the call as a paired client
 *
 * Pinned, in order: while the Mac answers, a call the companion refuses by itself
 * is answered by the Mac; a read the companion could answer from its own files
 * is the Mac's; a write is applied once, on the Mac; the Mac's own rules hold
 * (an op that only this Mac may run is refused, as for any paired client); a
 * route the companion keeps is answered there. The user turns "companion takes
 * over" off: the companion answers itself, and on again: the Mac answers. The Mac
 * sleeps (SIGSTOP of the server and its daemon: the sockets stay open and go
 * silent): the first call waits out its read budget and is answered by the
 * companion, every later one at once. The Mac wakes: the Mac answers again.
 *
 * WP13 (bridge-stream-v1): the forward rides a stream through the Mac's own daemon
 * (no size cap: a 4 MB body there and a 4 MB reply back); with the cap dropped from
 * the daemon's bridge hello (an older daemon) it goes through server.http as before.
 * The web console's task writes (/api/tasks, /api/focus) take the same path: once on
 * the Mac while it answers, never first on the companion; away, a local write kept by
 * field in the companion's journal (stage 3a), which the Mac drains when it wakes.
 *
 * Isolation as in leader-takeover-live-e2e.test.ts: own HOME, data dir and
 * daemon dir per server under one temp base, fresh random tokens, a `claude`
 * that refuses to run, every process stopped by the pid it wrote.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
// The companion counts the Mac silent after min(three of its own 15s beats, T).
// T is longer than the read budget (8s), so a call that goes out to a sleeping
// Mac comes back before the Mac counts as silent: the suspect rule is what
// answers the next one at once, as in production (45s).
const T = 20_000
const SILENT_MS = T

const sha256 = (t: string): string => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const newToken = (): string => crypto.randomBytes(16).toString('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

let base = ''
const tokens = { phone: '', local: '' }
interface Server { proc: ChildProcess | null; port: number; log: string; data: string; home: string; daemonDir: string; pid: number }
const companion: Server = { proc: null, port: 0, log: '', data: '', home: '', daemonDir: '', pid: 0 }
const primary: Server = { proc: null, port: 0, log: '', data: '', home: '', daemonDir: '', pid: 0 }

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}\n--- companion ---\n${companion.log.slice(-2500)}\n--- primary ---\n${primary.log.slice(-2500)}`)
}

function serverEnv(s: Server, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(s.home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    OPEN_WALNUT_HOME: s.data,
    HOME: s.home,
    USERPROFILE: s.home,
    SHELL: '/bin/sh',
    WALNUT_DAEMON_DIR: s.daemonDir,
    WALNUT_STREAMS_DIR: path.join(s.daemonDir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(s.daemonDir, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(s.daemonDir, 'spawn-journal.jsonl'),
    WALNUT_DISABLE_BACKGROUND_AI: '1',
    WALNUT_DISABLE_SEARCH: '1',
    WALNUT_LOCAL_CLAUDE_PROBE: '0',
    WALNUT_LEADER_TAKEOVER_MS: String(T),
    VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', VITEST_MODE: '', NODE_ENV: 'production',
    ...extra,
  }
}

async function prepare(s: Server, name: string): Promise<void> {
  s.home = path.join(base, name, 'home')
  s.data = path.join(base, name, 'data')
  s.daemonDir = path.join(base, name.slice(0, 2) + 'd')
  for (const d of [path.join(s.home, 'bin'), s.data, s.daemonDir]) await fsp.mkdir(d, { recursive: true })
  await fsp.writeFile(path.join(s.home, 'bin', 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
}

const BOOT = (data: string, cloud: boolean) => `
const c = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(data)} || c.CLOUD_MODE !== ${cloud}) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))})
const server = await startServer({ port: 0, dev: true })
${cloud ? '' : `const { localDaemon } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/providers/local-daemon.ts'))})
const dc = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/providers/daemon-connection.ts'))})
const { awaitLocalDaemonLink, failBootLink } = await import(${JSON.stringify(path.join(REPO_ROOT, 'tests/helpers/local-daemon-link.ts'))})
// No hand dial: the boot's own local daemon lane must link the Mac to its daemon with no session.
// A failure ends through stopServer and a non-zero exit; no signal handler is armed yet here.
await awaitLocalDaemonLink({
  wsUrl: localDaemon.wsUrl,
  connected: () => dc.getConnectedDaemonConnection('__local__') !== null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}).catch((err) => failBootLink(err, {
  stop: () => stopServer(),
  write: (line) => process.stderr.write(line + '\\n'),
  exit: (code) => process.exit(code),
}))`}
const addr = server.address()
process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n')
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
`

async function bootServer(s: Server, name: string, cloud: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  const file = path.join(base, `${name}-boot.mts`)
  await fsp.writeFile(file, BOOT(s.data, cloud))
  const proc = spawn(TSX, [file], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  s.proc = proc
  proc.stderr!.on('data', (b: Buffer) => { s.log = (s.log + b.toString()).slice(-300_000) })
  if (process.env.DEBUG_LIVE) proc.stderr!.on('data', (b: Buffer) => process.stderr.write(b))
  s.port = await new Promise<number>((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`server did not report a port in 180s\n${s.log.slice(-3000)}`)), 180_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      for (const l of out.split('\n')) {
        if (!l.startsWith('{')) continue
        try { const j = JSON.parse(l); if (typeof j.pid === 'number') s.pid = j.pid } catch { /* partial */ }
      }
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`server exited early (${code})\n${s.log.slice(-3000)}`)) })
  })
}

const MAC_CHECKLIST = '# Mac checklist\n- the build is green\n'
const COMPANION_CHECKLIST = '# Companion checklist\n- an old copy\n'

async function startCompanion(): Promise<void> {
  await prepare(companion, 'companion')
  await fsp.mkdir(path.join(base, 'hub'), { recursive: true })
  await fsp.writeFile(path.join(companion.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
  await fsp.writeFile(path.join(companion.data, 'HEARTBEAT.md'), COMPANION_CHECKLIST)
  const now = new Date().toISOString()
  await fsp.writeFile(path.join(companion.data, 'auth.json'), JSON.stringify({ devices: [
    { name: 'phone', tokenHash: sha256(tokens.phone), createdAt: now },
    { name: 'bridge-local', tokenHash: sha256(tokens.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await bootServer(companion, 'companion', true, serverEnv(companion, {
    WALNUT_CLOUD_MODE: '1', WALNUT_GIT_HUB_DIR: path.join(base, 'hub'), WALNUT_LEADER_TICK_MS: '300',
  }))
}

async function startPrimary(): Promise<void> {
  await prepare(primary, 'primary')
  execFileSync('git', ['init', '-q', primary.data], { env: gitEnv() })
  execFileSync('git', ['-C', primary.data, 'remote', 'add', 'cloud', `http://mac:${tokens.phone}@127.0.0.1:${companion.port}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(primary.data, 'sync'), { recursive: true })
  await fsp.writeFile(path.join(primary.data, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.local }), { mode: 0o600 })
  await fsp.writeFile(path.join(primary.data, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\ndefaults:\n  priority: none\n  platform: local\nprovider:\n  type: claude-code\n')
  await fsp.writeFile(path.join(primary.data, 'HEARTBEAT.md'), MAC_CHECKLIST)
  await bootServer(primary, 'primary', false, serverEnv(primary, { WALNUT_LEADER_HEARTBEAT_MS: '500' }))
}

interface Reply { status: number; by: string | null; json: Record<string, any>; ms: number }

/** The phone's call to the companion. */
async function phone(p: string, init: RequestInit = {}): Promise<Reply> {
  const started = Date.now()
  const res = await fetch(`http://127.0.0.1:${companion.port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokens.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  return { status: res.status, by: res.headers.get('x-walnut-answered-by'), json: await res.json().catch(() => ({})) as Record<string, any>, ms: Date.now() - started }
}

/** A call on the Mac itself (loopback, this machine). */
async function mac(p: string, init: RequestInit = {}): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${primary.port}${p}`, {
    ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

const leaderView = async () => (await phone('/api/leader')).json

function pidIn(dir: string): number | null {
  try { const n = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim()); return Number.isInteger(n) && n > 1 ? n : null } catch { return null }
}
/** The Mac: the primary server and its own local daemon. */
const macPids = (): number[] => [primary.pid, pidIn(primary.daemonDir) ?? 0].filter((p) => p > 1)

describe('one request path on the companion (real servers, the Mac\'s real daemon)', () => {
  beforeAll(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wcf-'))
    tokens.phone = newToken()
    tokens.local = newToken()
    await startCompanion()
    await startPrimary()
    expect(primary.pid).toBeGreaterThan(1)
  }, 400_000)

  afterAll(async () => {
    for (const pid of macPids()) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    for (const s of [primary, companion]) {
      const proc = s.proc
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((r) => proc.once('exit', () => r()))
        proc.kill('SIGTERM')
        await Promise.race([exited, sleep(30_000)])
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      }
    }
    for (const dir of [primary.daemonDir, companion.daemonDir]) {
      const pid = dir ? pidIn(dir) : null
      if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    }
    if (process.env.DEBUG_LIVE) process.stderr.write(`--- companion ---\n${companion.log.slice(-6000)}\n--- primary ---\n${primary.log.slice(-6000)}\n`)
    await sleep(500)
    if (base && !process.env.KEEP_LEADER_LIVE) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  }, 120_000)

  it('the companion hears the Mac, and the Mac lets it stand in', async () => {
    const view = await waitFor(async () => {
      const v = await leaderView()
      return v.primaryHeard === true && v.backupAllowed === true ? v : null
    }, 180_000, 'the companion to hear the Mac\'s heartbeat')
    expect(view).toMatchObject({ role: 'backup', leading: [] })
  }, 200_000)

  it('a call the companion refuses by itself is answered by the Mac', async () => {
    const r = await waitFor(async () => {
      const x = await phone('/api/v1/usage/overview')
      return x.by === 'primary' ? x : null
    }, 30_000, 'a forwarded usage read')
    expect(r.status).toBe(200)
    expect((await mac('/api/v1/usage/overview')).status).toBe(200)
  }, 60_000)

  it('a read the companion could answer from its own files is the Mac\'s', async () => {
    const r = await phone('/api/v1/heartbeat/checklist')
    expect(r).toMatchObject({ status: 200, by: 'primary' })
    expect(r.json.content).toBe(MAC_CHECKLIST)
  })

  it('a write is applied once, on the Mac', async () => {
    const next = '# Mac checklist\n- written from the phone\n'
    const r = await phone('/api/v1/heartbeat/checklist', { method: 'PUT', body: JSON.stringify({ content: next }) })
    expect(r).toMatchObject({ status: 200, by: 'primary' })
    expect(fs.readFileSync(path.join(primary.data, 'HEARTBEAT.md'), 'utf8')).toBe(next)
    expect(fs.readFileSync(path.join(companion.data, 'HEARTBEAT.md'), 'utf8')).toBe(COMPANION_CHECKLIST)
    expect((await phone('/api/v1/heartbeat/checklist')).json.content).toBe(next)
  })

  // WP13: the Mac's own daemon says bridge-stream-v1 in its bridge hello, so the
  // forward rides a stream through it: no size cap either way.
  it('the forward rides a stream through the Mac\'s daemon: a 4 MB body reaches the Mac, a 4 MB reply comes back', async () => {
    const big = '# Mac checklist\n- written from the phone\n' + 'x'.repeat(4 * 1024 * 1024) + '\n'
    const before = (await leaderView()).forward.streamed as number
    const w = await phone('/api/v1/heartbeat/checklist', { method: 'PUT', body: JSON.stringify({ content: big }) })
    expect(w).toMatchObject({ status: 200, by: 'primary' })
    expect(fs.readFileSync(path.join(primary.data, 'HEARTBEAT.md'), 'utf8')).toBe(big)
    const r = await phone('/api/v1/heartbeat/checklist')
    expect(r).toMatchObject({ status: 200, by: 'primary' })
    expect(r.json.content).toBe(big)
    expect((await leaderView()).forward.streamed).toBeGreaterThanOrEqual(before + 2)
    const small = '# Mac checklist\n- written from the phone\n'
    expect((await phone('/api/v1/heartbeat/checklist', { method: 'PUT', body: JSON.stringify({ content: small }) })).status).toBe(200)
    expect(fs.readFileSync(path.join(companion.data, 'HEARTBEAT.md'), 'utf8')).toBe(COMPANION_CHECKLIST)
  }, 120_000)

  // WP13: the companion's task writes go to the Mac while it answers (one writer); its
  // reads stay on its own copy, and nothing is queued on the companion.
  it('a task write goes to the Mac while it answers (one writer); the read stays on the copy, nothing is queued', async () => {
    const created = await phone('/api/v1/tasks', { method: 'POST', body: JSON.stringify({ title: 'Marina harbour plan', project: 'Acme' }) })
    expect(created).toMatchObject({ status: 201, by: 'primary' })
    const id = created.json.task.id as string
    const patched = await phone(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ priority: 'important' }) })
    expect(patched).toMatchObject({ status: 200, by: 'primary' })
    expect(patched.json.task).toMatchObject({ id, priority: 'important' })
    const onMac = await waitFor(async () => {
      const list = (await mac('/api/v1/tasks')).json.tasks as Array<Record<string, unknown>> | undefined
      return list?.find((t) => t.id === id && t.priority === 'important') ?? null
    }, 30_000, 'the Mac to list the task the phone wrote')
    expect(onMac.title).toBe('Marina harbour plan')
    expect((await phone('/api/v1/tasks')).by).toBe('companion')
    const queued = (() => { try { return fs.readdirSync(path.join(companion.data, 'cache', 'task-queue')).filter((f) => f.endsWith('.json')) } catch { return [] } })()
    expect(queued).toEqual([])
  }, 60_000)

  // WP13 review: the web console's task writes take the same one-writer path. Before, the
  // companion applied them to its own store first and then sent an op to the Mac.
  const CONSOLE_TITLE = 'Marina console plan'
  let consoleTaskId = ''
  const queuedOps = (): Array<Record<string, any>> => {
    const dir = path.join(companion.data, 'cache', 'task-queue')
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) } catch { return [] }
  }
  // Stage 3a: the companion's journal v2 (core/companion-journal.ts), read from its files:
  // the records not acked yet, and the kinds the Mac said it drains.
  const journalRecords = (): Array<Record<string, any>> => {
    const dir = path.join(companion.data, 'cache', 'journal')
    const lines: Array<Record<string, any>> = []
    try {
      for (const f of fs.readdirSync(dir).filter((n) => /^journal-.*\.ndjson$/.test(n))) {
        for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { try { lines.push(JSON.parse(l)) } catch { /* header, torn tail */ } }
      }
    } catch { return [] }
    const acked = new Set(lines.flatMap((l) => (Array.isArray(l.ack) ? l.ack : [])))
    const superseded = new Set(lines.map((l) => l.supersedes).filter((n) => typeof n === 'number'))
    return lines.filter((l) => typeof l.seq === 'number' && typeof l.kind === 'string' && !acked.has(l.seq) && !superseded.has(l.seq))
  }
  const drainsKnown = (): string[] => { try { return JSON.parse(fs.readFileSync(path.join(companion.data, 'cache', 'journal', 'drains.json'), 'utf8')).kinds ?? [] } catch { return [] } }
  const titled = (list: unknown): string[] => ((list as Array<Record<string, unknown>> | undefined) ?? []).filter((t) => t.title === CONSOLE_TITLE).map((t) => String(t.id))

  it('a console task write goes to the Mac while it answers: applied once there, never first on the companion', async () => {
    const created = await phone('/api/tasks', { method: 'POST', body: JSON.stringify({ title: CONSOLE_TITLE, project: 'Acme', client_request_id: 'c-live-1' }) })
    expect(created).toMatchObject({ status: 201, by: 'primary' })
    consoleTaskId = created.json.task.id as string
    const patched = await phone(`/api/tasks/${encodeURIComponent(consoleTaskId)}`, { method: 'PATCH', body: JSON.stringify({ priority: 'important' }) })
    expect(patched).toMatchObject({ status: 200, by: 'primary' })
    expect(patched.json.task).toMatchObject({ id: consoleTaskId, priority: 'important' })
    const tier = await phone(`/api/focus/tasks/${encodeURIComponent(consoleTaskId)}/tier`, { method: 'PUT', body: JSON.stringify({ tier: 'focus' }) })
    expect(tier).toMatchObject({ status: 200, by: 'primary' })
    // The companion's copy shows the Mac's row (its id, its values) after the round the Mac sends at once.
    await waitFor(async () => {
      const r = await phone(`/api/tasks/${encodeURIComponent(consoleTaskId)}`)
      return r.json.task?.priority === 'important' && r.json.task?.focus_tier === 'focus' ? r : null
    }, 30_000, 'the companion\'s copy to show the console writes')
    // A second copy would come from an op the companion sent after a local write: give it time to land.
    await sleep(2_000)
    expect(titled((await mac('/api/tasks')).json.tasks)).toEqual([consoleTaskId])
    expect(titled((await phone('/api/tasks')).json.tasks)).toEqual([consoleTaskId])
    expect(queuedOps()).toEqual([])
  }, 60_000)

  it('the Mac\'s own rules hold: an op only this Mac may run is refused, as for any paired client', async () => {
    const r = await phone('/api/v1/actions/invoke', { method: 'POST', body: JSON.stringify({ tool: 'health_status' }) })
    expect(r).toMatchObject({ status: 403, by: 'primary' })
    expect(r.json.error.code).toBe('local_only')
    const local = await mac('/api/v1/actions/invoke', { method: 'POST', body: JSON.stringify({ tool: 'health_status' }) })
    expect(local.json.error?.code).not.toBe('local_only')
  })

  it('a route the companion keeps is answered there', async () => {
    const r = await phone('/api/v1/status')
    expect(r).toMatchObject({ status: 200, by: 'companion' })
    expect(r.json.mode).toBe('REPLICA')
  })

  it('the user turns "companion takes over" off: the companion answers itself; on again: the Mac answers', async () => {
    const before = (await mac('/api/config')).json.cloud_bridge ?? {}
    expect((await mac('/api/config', { method: 'PUT', body: JSON.stringify({ cloud_bridge: { ...before, backup_leader: false } }) })).status).toBe(200)
    await waitFor(async () => (await leaderView()).backupAllowed === false, 20_000, 'the heartbeat to carry the setting')
    const off = await phone('/api/v1/usage/overview')
    expect(off).toMatchObject({ status: 501, by: 'companion' })
    expect((await mac('/api/config', { method: 'PUT', body: JSON.stringify({ cloud_bridge: { ...before, backup_leader: true } }) })).status).toBe(200)
    await waitFor(async () => (await phone('/api/v1/usage/overview')).by === 'primary', 20_000, 'the Mac to answer again')
  }, 60_000)

  it('the Mac sleeps: the first call waits out its read budget, every later one is answered at once', async () => {
    // Stage 3a: the Mac drained the companion's journal when its bridge connected, so the
    // companion knows the Mac takes task-fields records.
    await waitFor(() => drainsKnown().includes('task-fields'), 30_000, 'the Mac to have drained the companion\'s journal once')
    for (const pid of macPids()) process.kill(pid, 'SIGSTOP')
    const stoppedAt = Date.now()
    const first = await phone('/api/v1/heartbeat/checklist')
    expect(first).toMatchObject({ status: 200, by: 'companion' })
    expect(first.json.content).toBe(COMPANION_CHECKLIST)
    expect(first.ms).toBeLessThan(15_000)
    const second = await phone('/api/v1/heartbeat/checklist')
    expect(second).toMatchObject({ status: 200, by: 'companion' })
    expect(second.ms).toBeLessThan(2_000)
    // Long after: the Mac is silent, so nothing waits on it.
    await sleep(Math.max(0, stoppedAt + SILENT_MS + 1_000 - Date.now()))
    const later = await phone('/api/v1/usage/overview')
    expect(later).toMatchObject({ status: 501, by: 'companion' })
    expect(later.ms).toBeLessThan(2_000)
    const status = (await leaderView()).forward
    expect(status.answeredHere).toMatchObject({ unanswered: 1, 'primary-suspect': 1 })
    expect((status.answeredHere['primary-silent'] ?? 0) + (status.answeredHere['no-bridge'] ?? 0)).toBeGreaterThanOrEqual(1)
    // WP13 review: away, a console task write runs here at once. Stage 3a: it is kept for
    // the Mac in the companion's journal by field (not the queue), its base the value the
    // companion's copy took from the Mac.
    const edit = await phone(`/api/tasks/${encodeURIComponent(consoleTaskId)}`, { method: 'PATCH', body: JSON.stringify({ title: `${CONSOLE_TITLE}, edited away` }) })
    expect(edit).toMatchObject({ status: 200, by: 'companion' })
    expect(edit.ms).toBeLessThan(2_000)
    expect(edit.json.task).toMatchObject({ id: consoleTaskId, title: `${CONSOLE_TITLE}, edited away` })
    const rec = await waitFor(() => journalRecords().find((r) => r.kind === 'task-fields' && r.taskId === consoleTaskId) ?? null, 40_000, 'the console edit in the journal')
    expect(rec.fields?.title).toMatchObject({ base: CONSOLE_TITLE, value: `${CONSOLE_TITLE}, edited away` })
    expect(queuedOps().filter((o) => o.task?.id === consoleTaskId)).toEqual([])
  }, 150_000)

  it('keeps seven-minute voice and completed text on the companion while the Mac sleeps, then copies both after wake', async () => {
    const id = crypto.randomUUID()
    const audio = Buffer.alloc(13_440_068, 0x32)
    const text = 'Seven-minute voice kept across a disconnect. ' + String.fromCodePoint(0x4f60, 0x597d).repeat(1500)
    const basePath = `/api/v1/stt/recordings/${id}`
    const audioDigest = crypto.createHash('sha256').update(audio).digest('hex')
    for (const pid of macPids()) process.kill(pid, 'SIGSTOP')
    try {
      let index = 0
      for (let offset = 0; offset < audio.length; offset += 256 * 1024) {
        const reply = await phone(basePath + '/chunks', { method: 'POST', body: JSON.stringify({ index: index++, audio: audio.subarray(offset, offset + 256 * 1024).toString('base64'), format: 'caf', createdAt: '2026-10-11T07:00:00Z', durationSeconds: 420 }) })
        expect(reply.status).toBe(200)
      }
      const committed = await phone(basePath + '/commit', { method: 'POST', body: JSON.stringify({ chunkCount: index, audioSizeBytes: audio.length, audioSha256: audioDigest, text }) })
      expect(committed.status).toBe(200)
      expect(committed.json).toMatchObject({ id, text, storage: 'companion', primarySaved: false })
      const disk = JSON.parse(await fsp.readFile(path.join(companion.data, 'voice-archive', id, 'metadata.json'), 'utf8'))
      expect(disk.record.text).toBe(text)
      expect((await fsp.readFile(path.join(companion.data, 'voice-archive', id, 'audio'))).equals(audio)).toBe(true)
      const cached = await phone(basePath + '/transcribe', { method: 'POST', body: '{}' })
      expect(cached.json).toMatchObject({ text, recordingId: id })
    } finally {
      for (const pid of macPids()) process.kill(pid, 'SIGCONT')
    }
    const synced = await waitFor(async () => {
      const reply = await phone(basePath)
      return reply.status === 200 && reply.json.primarySaved === true ? reply : null
    }, 180_000, 'the voice archive to copy after the Mac wakes')
    expect(synced.json).toMatchObject({ text, storage: 'companion', primarySaved: true })
    const primaryDisk = JSON.parse(await fsp.readFile(path.join(primary.data, 'voice-archive', id, 'metadata.json'), 'utf8'))
    expect(primaryDisk.record.text).toBe(text)
    expect(primaryDisk.record.storage).toBe('primary')
    const copiedAudio = await fsp.readFile(path.join(primary.data, 'voice-archive', id, 'audio'))
    expect(copiedAudio.equals(audio)).toBe(true)
    expect(crypto.createHash('sha256').update(copiedAudio).digest('hex')).toBe(audioDigest)
  }, 300_000)

  it('the Mac wakes: the Mac answers again', async () => {
    for (const pid of macPids()) process.kill(pid, 'SIGCONT')
    const r = await waitFor(async () => {
      const x = await phone('/api/v1/heartbeat/checklist')
      return x.by === 'primary' ? x : null
    }, 60_000, 'the Mac to answer after it wakes')
    expect(r.json.content).toMatch(/written from the phone/)
    // The console edit kept while away reaches the Mac (its drain of the journal), merged by
    // field, and leaves the journal; nothing of it was queued.
    await waitFor(async () => {
      const t = (await mac(`/api/tasks/${encodeURIComponent(consoleTaskId)}`)).json.task
      return t?.title === `${CONSOLE_TITLE}, edited away` && t?.priority === 'important' ? t : null
    }, 90_000, 'the journaled console edit to reach the Mac')
    await waitFor(() => journalRecords().every((r) => r.taskId !== consoleTaskId), 30_000, 'the journal to let the console edit go')
    expect(queuedOps().filter((o) => o.task?.id === consoleTaskId)).toEqual([])
    expect(titled((await mac('/api/tasks')).json.tasks)).toEqual([])
  }, 200_000)

  // WP13: an older daemon (its bridge hello without bridge-stream-v1, the cap dropped
  // with WALNUT_BRIDGE_HIDE_CAPS): the Mac and its daemon start again, and the companion
  // forwards through server.http as before, its 1 MB frame cap included.
  it('an old daemon (the cap dropped): the companion forwards through server.http, as today', async () => {
    const proc = primary.proc!
    const exited = new Promise<void>((r) => proc.once('exit', () => r()))
    proc.kill('SIGTERM')
    await Promise.race([exited, sleep(30_000)])
    const daemonPid = pidIn(primary.daemonDir)
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM') } catch { /* gone */ }
      await waitFor(() => { try { process.kill(daemonPid, 0); return false } catch { return true } }, 30_000, 'the Mac\'s daemon to stop')
    }
    await bootServer(primary, 'primary-old-daemon', false, serverEnv(primary, { WALNUT_LEADER_HEARTBEAT_MS: '500', WALNUT_BRIDGE_HIDE_CAPS: 'bridge-stream-v1' }))
    const before = (await leaderView()).forward
    const r = await waitFor(async () => {
      const x = await phone('/api/v1/heartbeat/checklist')
      return x.by === 'primary' ? x : null
    }, 180_000, 'the Mac to answer again with the older daemon')
    expect(r.json.content).toMatch(/written from the phone/)
    const write = await phone('/api/v1/heartbeat/checklist', { method: 'PUT', body: JSON.stringify({ content: '# Mac checklist\n- over server.http\n' }) })
    expect(write).toMatchObject({ status: 200, by: 'primary' })
    expect(fs.readFileSync(path.join(primary.data, 'HEARTBEAT.md'), 'utf8')).toBe('# Mac checklist\n- over server.http\n')
    const after = (await leaderView()).forward
    expect(after.streamed).toBe(before.streamed)
    // Not a stream that was refused and fell back: the companion never tried one (the hello had no cap).
    expect(after.streamRefused).toBe(before.streamRefused)
    expect(after.forwarded).toBeGreaterThanOrEqual(before.forwarded + 2)
    // The server.http frame keeps its cap: a 2 MB body stays on the companion.
    const big = await phone('/api/v1/heartbeat/checklist', { method: 'PUT', body: JSON.stringify({ content: 'y'.repeat(2 * 1024 * 1024) }) })
    expect(big).toMatchObject({ status: 200, by: 'companion' })
    expect((await leaderView()).forward.answeredHere['body-size']).toBeGreaterThanOrEqual(1)
  }, 300_000)
})
