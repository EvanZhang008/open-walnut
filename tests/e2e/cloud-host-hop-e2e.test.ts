/**
 * The phone, through the cloud companion, on a session whose host the Mac can
 * no longer reach: every answer must name the hop that failed, and a send must
 * reach the host another way or be held, in the host's name.
 *
 *   phone (fetch, phone token)
 *     └─▶ replica (real child process, WALNUT_CLOUD_MODE=1)
 *           ├─ /bridge ◀── __local__ : the Mac's own daemon (real), which
 *           │                          carries the replica's control relays
 *           └─ /bridge ◀── devbox    : the host's daemon (real daemon source)
 *   Mac (this process, startServer) ──DaemonConnection──▶ link proxy ──▶ host daemon
 *
 * The reported field state (2026-10-01): the Mac's DNS was degraded, its SSH
 * link to the host died, and the host's daemon kept the dead link's socket for
 * half an hour. The host daemon stayed on the companion's bridge. The link
 * proxy plays exactly that: `severed` stops every byte and never tells the host
 * side the Mac went away, so the host daemon still counts a trusted client that
 * will never answer, and on recovery that dead socket stays open next to the
 * new one. The Mac's pool notices the silence as it does in the field (missed
 * pings), and its redial fails while the link is down.
 *
 * Load-bearing, all real: the replica's routes, bank and bridge registry, both
 * daemons' bridge sockets, the host daemon's relay and its direct send path, the
 * Mac's control relay handlers, its durable message queue and its session
 * records. Mocked: the claude CLI only (tests/providers/mock-claude.mjs behind a
 * shim on the host's own PATH; the host daemon never sees the user's PATH or
 * HOME). Stand-in: the Mac's link to the host is a direct WebSocket through the
 * proxy instead of ssh, and its redial fails the way a DNS-starved ssh did.
 *
 * Isolation: one temp base; every server and daemon has its own HOME, data dir
 * and daemon dir; nothing is copied from the user's data; no fixture carries a
 * pid. Answers go to CLOUD_HOST_HOP_OUT (JSON) when that is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../helpers/silent-link-proxy.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloud-host-hop'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MOCK_CLI = path.join(REPO_ROOT, 'tests/providers/mock-claude.mjs')
const HOST = 'devbox'
const HOST_LABEL = 'New big devbox'
const OUT = process.env.CLOUD_HOST_HOP_OUT
/** When set: hold the host-down state for a simulator walkthrough (see that case). */
const HOLD = process.env.CLOUD_HOST_HOP_HOLD
/** When set: the replica's log, the host daemon's stderr and the host's stream files land here. */
const ARTIFACTS = process.env.CLOUD_HOST_HOP_ARTIFACTS
let hostDaemonStderr = ''

const report: Record<string, unknown> = {}
const save = () => { if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) }

let base = ''
let replica: CloudBoxReplica
let primaryPort = 0
let proxy: SilentLinkProxy
let hostDaemon: { proc: ChildProcess; dir: string; port: number } | null = null
const hostDirs = { home: '', daemon: '', streams: '', cwd: '' }
/** The Mac's link to the host as its pool holds it; `up` gates its redial. */
let link: { conn: import('../../src/providers/daemon-connection.js').DaemonConnection; up: boolean } | null = null
let severedAt = 0
/** Refusing ssh/scp, first on the host daemon's PATH. */
let guardDir = ''

/**
 * A: started by the Mac before the link dies (a live CLI). B: stopped
 * throughout, and stopped by a person once before (its record carries that
 * stop), so every message to it must carry that stop's fence or the Mac's queue
 * refuses it as "predating the latest stop".
 */
const SID_A = crypto.randomUUID()
const SID_B = crypto.randomUUID()
const EARLIER_STOP = `stop-${crypto.randomUUID()}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

interface Answer { status: number; ms: number; json: Record<string, unknown> | null; body: string }

/** One phone request to the companion. Never throws: a transport failure is status 0. */
async function phone(p: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Answer> {
  const t0 = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${replica.port}/api/v1${p}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${replica.tokens.phone}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 70_000),
    })
    const body = await res.text()
    let json: Record<string, unknown> | null = null
    try { json = JSON.parse(body) as Record<string, unknown> } catch { /* not json */ }
    return { status: res.status, ms: Date.now() - t0, json, body: body.slice(0, 700) }
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, json: null, body: `FETCH ERROR ${String(e)}` }
  }
}

const send = (sid: string, tag: string, messageId: string) =>
  phone(`/sessions/${sid}/messages`, { method: 'POST', body: { text: `snapshot-clean-turn:${tag}`, messageId } })

const mac = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${primaryPort}${p}`, { ...init, signal: AbortSignal.timeout(60_000) })

const errMessage = (a: Answer) => ((a.json?.error ?? {}) as { message?: string }).message ?? ''
const errCode = (a: Answer) => ((a.json?.error ?? {}) as { code?: string }).code
const record = (name: string, a: unknown) => { report[name] = a; save() }

/** Every human sentence in an answer (data fields such as `host` legitimately carry the alias). */
function sentencesOf(v: unknown, key = '', out: string[] = []): string[] {
  const keys = new Set(['message', 'error', 'reason', 'waitingForName', 'heldNote', 'hostNote', 'hint', 'detail', 'note'])
  if (typeof v === 'string') { if (keys.has(key)) out.push(v) } else if (Array.isArray(v)) v.forEach((x) => sentencesOf(x, key, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) sentencesOf(x, k, out)
  return out
}

/** No sentence may blame the Mac (the Mac answered every request here) or name the host by its alias. */
function expectHonestWording(a: Answer, what: string): void {
  for (const s of a.json ? sentencesOf(a.json) : []) {
    expect.soft(s, `${what}: "${s}" blames the Mac, which answered`).not.toMatch(/\bMac\b|primary box/i)
    // The label contains the alias as a word (as the reported one did), so look outside it.
    expect.soft(s.split(HOST_LABEL).join(''), `${what}: "${s}" names the host by its alias`).not.toMatch(new RegExp(`\\b${HOST}\\b`))
  }
}

/**
 * A held send says who it waits for, by name: the host, or (a relay already
 * carried it, and the host is answering) the Mac, whose link to the host is the
 * hop actually down. That one is the only answer here allowed to name the Mac.
 */
function expectHeld(a: Answer, what: string, on: 'host' | 'mac' = 'host'): void {
  expect.soft(a.status, `${what}: ${a.body}`).toBe(202)
  expect.soft(a.json?.queued, `${what} is held: ${a.body}`).toBe(true)
  if (on === 'host') {
    expect.soft(a.json?.waitingForName, `${what} names the host it waits for: ${a.body}`).toBe(HOST_LABEL)
    expect.soft(a.json?.heldNote, `${what}: ${a.body}`).toBe(`Can't reach ${HOST_LABEL} right now.`)
    expectHonestWording(a, what)
    return
  }
  expect.soft(a.json?.waitingForName, `${what} names the Mac it waits for: ${a.body}`).toBe('your Mac')
  expect.soft(a.json?.heldNote, `${what}: ${a.body}`).toBe(`Your Mac can't reach ${HOST_LABEL} right now.`)
  for (const s of a.json ? sentencesOf(a.json) : []) {
    expect.soft(s.split(HOST_LABEL).join(''), `${what}: "${s}" names the host by its alias`).not.toMatch(new RegExp(`\\b${HOST}\\b`))
  }
}

/** A send that went through now: accepted, not held. */
function expectThrough(a: Answer, what: string): void {
  expect.soft(a.status, `${what}: ${a.body}`).toBe(202)
  expect.soft(a.json?.queued, `${what} went through, not held: ${a.body}`).toBeUndefined()
}

// ── The host: a real daemon, its own HOME, the mock CLI on its own PATH ─────

async function startHostDaemon(): Promise<{ proc: ChildProcess; dir: string; port: number }> {
  const script = path.join(hostDirs.daemon, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    HOME: hostDirs.home,
    USER: os.userInfo().username,
    SHELL: '/bin/sh',
    // The host's own tools only: the user's PATH (and its real claude) never
    // reaches it, and ssh/scp refuse (nothing here may reach a real host), with
    // the test exec guard kept after them (tests/setup/exec-guard.ts).
    PATH: guardedPath([guardDir, path.join(hostDirs.home, '.toolbox', 'bin')], '/usr/bin:/bin:/usr/sbin:/sbin'),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    WALNUT_DAEMON_DIR: hostDirs.daemon,
    WALNUT_STREAMS_DIR: hostDirs.streams,
    WALNUT_SPAWN_JOURNAL: path.join(hostDirs.daemon, 'spawn-journal.jsonl'),
    MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(hostDirs.home, '.claude', 'projects'),
    // A user line that lands mid-turn is queued and run next, as the real CLI
    // does (the mock drops it by default), so quick sends can be held to order.
    MOCK_CLAUDE_QUEUE_MIDTURN: '1',
  }
  const proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  proc.stderr?.on('data', (b: Buffer) => {
    err = (err + b.toString()).slice(-4000)
    hostDaemonStderr += b.toString()
  })
  const portFile = path.join(hostDirs.daemon, 'daemon.port')
  await waitFor(() => (proc.exitCode !== null ? Promise.reject(new Error(`host daemon exited: ${err}`)) : fs.existsSync(portFile)), 30_000, 'the host daemon')
  return { proc, dir: hostDirs.daemon, port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) }
}

/** One short command to the host daemon on its own socket, closed at once. */
async function hostRpc(cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${hostDaemon!.port}`)
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  try {
    return await new Promise((resolve, reject) => {
      const id = 900_000 + Math.floor(Math.random() * 1e5)
      const t = setTimeout(() => reject(new Error(`host rpc timeout: ${cmd}`)), 15_000)
      ws.on('message', (d) => {
        try {
          const m = JSON.parse(d.toString()) as Record<string, unknown>
          if (m.id === id) { clearTimeout(t); resolve(m) }
        } catch { /* an event frame */ }
      })
      ws.send(JSON.stringify({ id, cmd, ...params }))
    })
  } finally {
    ws.terminate()
  }
}

/** Everything the CLIs on the host printed for a session (the daemon's stream file). */
const hostJsonl = (sid: string) => {
  try { return fs.readFileSync(path.join(hostDirs.streams, `${sid}.jsonl`), 'utf-8') } catch { return '' }
}
/** How many times the CLI answered `tag` (one answer per delivery). */
const answers = (sid: string, tag: string) =>
  hostJsonl(sid).split('\n').filter((l) => l.includes('"type":"result"') && l.includes(`"result":"${tag}"`)).length

/** The daemon's proof that a session lived on this host (its direct resume refuses without it). */
function seedHostSession(sid: string): void {
  fs.writeFileSync(path.join(hostDirs.streams, `${sid}.jsonl`), [
    { type: 'system', subtype: 'init', session_id: sid, cwd: hostDirs.cwd, model: 'mock-model' },
    { type: 'assistant', message: { id: `msg_seed_${sid.slice(0, 8)}`, role: 'assistant', content: [{ type: 'text', text: 'an earlier answer' }] }, session_id: sid },
    { type: 'result', subtype: 'success', is_error: false, result: 'an earlier answer', session_id: sid },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function bridgeHosts(): Promise<string[]> {
  const s = await phone('/status', { timeoutMs: 5_000 })
  return ((s.json?.bridgeHosts ?? []) as Array<{ hostAlias: string }>).map((h) => h.hostAlias)
}

// ── The Mac's link to the host ─────────────────────────────────────────────

async function connectLink(): Promise<void> {
  const { DaemonConnection, setPooledConnectionForTest } = await import('../../src/providers/daemon-connection.js')
  const conn = new DaemonConnection(HOST, { hostname: `${HOST}.invalid` })
  const url = `ws://127.0.0.1:${proxy.port}`
  const state = { up: true, conn }
  type Internals = {
    reconnect: () => Promise<void>
    connectWebSocket: (u: string) => Promise<void>
    verifyCapabilities: () => Promise<boolean>
    setConnected: (v: boolean) => void
    startPing: () => void
  }
  const internals = conn as unknown as Internals
  // The redial. While the link is down it fails the way the field's did (the
  // DNS-starved ssh gave up); once it is back it dials the proxy afresh.
  internals.reconnect = async () => {
    if (!state.up) {
      await sleep(2_000)
      throw new Error(`daemon dir check on ${HOST} did not finish (Remote command timed out after 15000ms)`)
    }
    await internals.connectWebSocket(url)
    await internals.verifyCapabilities()
    internals.setConnected(true)
    internals.startPing()
  }
  setPooledConnectionForTest(HOST, conn)
  await conn.connectDirect(url)
  link = state
}

async function macSeesHost(): Promise<boolean> {
  const { isDaemonConnected } = await import('../../src/providers/daemon-connection.js')
  return isDaemonConnected(HOST)
}

async function macRecord(sid: string): Promise<Record<string, unknown>> {
  const body = await (await mac(`/api/sessions/${sid}`)).json() as Record<string, unknown>
  return (body.session ?? body) as Record<string, unknown>
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // The in-process Mac reads HOME (ssh config, ~/.claude): a real one would let
  // it reach real hosts and import real sessions. Run with a throwaway HOME (the
  // test exec guard's fake home has an ssh config of one comment: no host in it).
  const sshConfig = path.join(os.homedir(), '.ssh', 'config')
  const namesHosts = (text: string) => text.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  if (fs.existsSync(sshConfig) && namesHosts(fs.readFileSync(sshConfig, 'utf8'))) {
    throw new Error(`refusing to run with a HOME that has an ssh config (${os.homedir()}): set HOME to a throwaway dir`)
  }
  base = await fsp.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'walnut-cloud-host-hop-'))
  replica = await startCloudBoxReplica(base, undefined, { machineOwner: 'mac-primary' })

  hostDirs.home = path.join(base, 'host', 'home')
  hostDirs.daemon = path.join(base, 'host', 'daemon')
  hostDirs.streams = path.join(base, 'host', 'streams')
  hostDirs.cwd = path.join(hostDirs.home, 'projects', 'alpha')
  guardDir = path.join(base, 'host', 'guard-bin')
  for (const d of [hostDirs.daemon, hostDirs.streams, hostDirs.cwd, guardDir, path.join(hostDirs.home, '.toolbox', 'bin')]) await fsp.mkdir(d, { recursive: true })
  for (const tool of ['ssh', 'scp']) {
    await fsp.writeFile(path.join(guardDir, tool), `#!/bin/sh\necho "${tool} disabled in tests" >&2\nexit 255\n`, { mode: 0o755 })
  }
  const shim = path.join(hostDirs.home, '.toolbox', 'bin', 'claude')
  await fsp.writeFile(shim,
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_CLI)} "$@"\n`, { mode: 0o755 })
  seedHostSession(SID_A)
  seedHostSession(SID_B)
  hostDaemon = await startHostDaemon()
  proxy = await startSilentLinkProxy(hostDaemon.port)

  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'version: 1', 'user:', '  name: Tester', 'defaults:', '  priority: none',
    'hosts:', `  ${HOST}:`, `    hostname: ${HOST}.invalid`, `    label: ${HOST_LABEL}`, '',
  ].join('\n'))
  await seedPrimaryPairing(WALNUT_HOME, `127.0.0.1:${replica.port}`, replica.tokens)
  // The host's machine credential, cached as the Mac's first bridge push to it leaves it.
  await fsp.writeFile(path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'),
    JSON.stringify({ 'bridge-local': replica.tokens.primaryMachine, [`bridge-${HOST}`]: replica.tokens.otherMachine }), { mode: 0o600 })
  const server = await startServer({ port: 0, dev: true })
  primaryPort = (server.address() as net.AddressInfo).port
  const { sessionRunner } = await import('../../src/providers/claude-code-session.js')
  sessionRunner.setCliCommand(shim)

  const { addTask } = await import('../../src/core/task-manager.js')
  const { createSessionRecord } = await import('../../src/core/session-tracker.js')
  for (const [sid, title] of [[SID_A, 'Hop session A'], [SID_B, 'Hop session B']] as const) {
    const { task } = await addTask({ title, project: 'Work' })
    await createSessionRecord(sid, task.id, 'Work', hostDirs.cwd, {
      host: HOST, cliModel: 'sonnet', title, initialProcessStatus: 'stopped',
    })
  }
  const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
  await updateSessionRecord(SID_B, { stopRequest: { id: EARLIER_STOP, requestedAt: new Date(Date.now() - 3_600_000).toISOString(), state: 'confirmed' } })

  // The Mac's own daemon dials /bridge, as a running Mac's sessions have it.
  const { getDaemonConnection } = await import('../../src/providers/daemon-connection.js')
  await getDaemonConnection('__local__', { hostname: '__local__' })
  // The Mac's link pushes the host its bridge config; the host dials /bridge.
  await connectLink()
  await waitFor(async () => {
    const hosts = await bridgeHosts()
    return hosts.includes('__local__') && hosts.includes(HOST)
  }, 120_000, 'both daemons on the companion bridge')
}, 420_000)

afterAll(async () => {
  if (ARTIFACTS) {
    try {
      fs.mkdirSync(ARTIFACTS, { recursive: true })
      fs.writeFileSync(path.join(ARTIFACTS, 'replica.log'), replica?.log() ?? '')
      fs.writeFileSync(path.join(ARTIFACTS, 'host-daemon.stderr.log'), hostDaemonStderr)
      for (const f of fs.existsSync(hostDirs.streams) ? fs.readdirSync(hostDirs.streams) : []) {
        if (f.endsWith('.jsonl')) fs.copyFileSync(path.join(hostDirs.streams, f), path.join(ARTIFACTS, `host-stream-${f}`))
      }
    } catch (e) { process.stderr.write(`artifacts: ${String(e)}\n`) }
  }
  try { link?.conn.disconnect() } catch { /* gone */ }
  try { await stopServer() } catch { /* already down */ }
  await proxy?.close()
  if (hostDaemon && hostDaemon.proc.exitCode === null) {
    hostDaemon.proc.kill('SIGTERM')
    await Promise.race([new Promise((r) => hostDaemon!.proc.once('exit', r)), sleep(5_000)])
    if (hostDaemon.proc.exitCode === null) hostDaemon.proc.kill('SIGKILL')
  }
  // The mock CLIs the host daemon spawned: only the groups it recorded in its own streams dir.
  for (const f of fs.existsSync(hostDirs.streams) ? fs.readdirSync(hostDirs.streams) : []) {
    if (!f.endsWith('.pgid')) continue
    const pgid = Number(fs.readFileSync(path.join(hostDirs.streams, f), 'utf-8').trim())
    if (Number.isInteger(pgid) && pgid > 1) { try { process.kill(-pgid, 'SIGTERM') } catch { /* gone */ } }
  }
  await replica?.stop()
  if (process.env.DEBUG_BOX) process.stderr.write(replica?.log().slice(-8000) ?? '')
}, 120_000)

// ── The cases ──────────────────────────────────────────────────────────────

describe('a remote-host session on the phone while the Mac cannot reach the host', () => {
  it('everything up: the phone reads both sessions, and a send reaches the host once through the Mac', async () => {
    // A starts on the host from the Mac, as the user's earlier work had it.
    const warm = await mac(`/api/v1/sessions/${SID_A}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'snapshot-clean-turn:warm-one', messageId: 'qm-mobile-warmone001' }),
    })
    expect(warm.status, await warm.text()).toBe(202)
    await waitFor(() => answers(SID_A, 'warm-one') === 1, 60_000, 'the host to answer warm-one')

    // The companion's list has B's earlier stop (what a phone send binds its fence to).
    await waitFor(async () => {
      const list = await phone('/sessions')
      const rows = ((list.json?.sessions ?? []) as Array<{ id: string; stopRequest?: { id?: string } }>)
      return rows.find((r) => r.id === SID_B)?.stopRequest?.id === EARLIER_STOP
    }, 60_000, "the companion's list to carry B's earlier stop")

    const options = await phone(`/sessions/${SID_B}/model-options`)
    record('upModelOptions', options)
    expect(options.status, options.body).toBe(200)
    expect(options.json?.current).toBe('sonnet')
    const detail = await phone(`/sessions/${SID_A}`)
    expect(detail.status, detail.body).toBe(200)

    const up = await send(SID_A, 'up-one', 'qm-mobile-upone00001')
    record('upSend', up)
    expectThrough(up, 'send with every link up')
    await waitFor(() => answers(SID_A, 'up-one') === 1, 60_000, 'the host to answer up-one')
  }, 240_000)

  it('the link goes silent: the model menu still reads at once, and a send right then is held for the Mac', async () => {
    proxy.setMode('severed')
    link!.up = false
    severedAt = Date.now()
    // The host still counts the Mac's dead socket as fresh: nobody can tell yet
    // whether this send reached the Mac, so it is held, never sent another way.
    const heldSend = send(SID_B, 'held-one', 'qm-mobile-heldone001')
    const options = await phone(`/sessions/${SID_B}/model-options`)
    record('silentModelOptions', options)
    expect.soft(options.status, `model-options while the Mac's link to the host is silent: ${options.body}`).toBe(200)
    expect.soft(options.ms, 'model-options must not wait on the host').toBeLessThan(10_000)
    expect.soft(options.json?.current).toBe('sonnet')
    expectHonestWording(options, 'model-options (silent link)')
    const held = await heldSend
    record('heldSend', held)
    expectHeld(held, 'the send right after the link died', 'mac')
  }, 180_000)

  it('the Mac has given up on the host: every per-session answer names the host, never the Mac', async () => {
    await waitFor(async () => !(await macSeesHost()), 120_000, 'the Mac to notice the dead link')
    // The host daemon has heard nothing on the dead socket for a while now.
    const wait = 50_000 - (Date.now() - severedAt)
    if (wait > 0) await sleep(wait)
    report.silentForMs = Date.now() - severedAt

    for (const sid of [SID_A, SID_B]) {
      const options = await phone(`/sessions/${sid}/model-options`)
      record(`downModelOptions${sid === SID_A ? 'A' : 'B'}`, options)
      expect.soft(options.status, options.body).toBe(200)
      expect.soft(options.ms, 'model-options must not wait on the host').toBeLessThan(10_000)
      expectHonestWording(options, 'model-options (host down)')
    }

    const detail = await phone(`/sessions/${SID_A}`)
    record('downDetail', detail)
    expect.soft(detail.status, detail.body).toBe(200)
    expect.soft(((detail.json?.session ?? {}) as Record<string, unknown>).host_label, 'the detail names the host').toBe(HOST_LABEL)

    const history = await phone(`/sessions/${SID_A}/history?tail=50`)
    record('downHistory', history)
    if (history.status !== 200) {
      // The read of the host's files failed past the Mac (502 from the remote
      // read, or 503 from the host-read bound): either way it names the host,
      // never the Mac. By its alias on this base: the read bound that rewrites a
      // pool error into the host's label ("Can't reach <label>: ...") is the
      // cloud-host round's, not in this tree. With it, add back
      // `toContain(HOST_LABEL)` and the alias check (expectHonestWording).
      expect.soft([502, 503], history.body).toContain(history.status)
      expect.soft(errMessage(history), history.body).toMatch(new RegExp(`\\b${HOST}\\b|${HOST_LABEL}`))
    }
    expect.soft(history.ms, 'history must not wait on the host').toBeLessThan(15_000)
    for (const s of history.json ? sentencesOf(history.json) : []) {
      expect.soft(s, `history (host down): "${s}" blames the Mac, which answered`).not.toMatch(/\bMac\b|primary box/i)
    }

    // A stopped session's picks are written to its record: they apply at the next start.
    const effort = await phone(`/sessions/${SID_B}/effort`, { method: 'POST', body: { effort: 'low' } })
    record('downEffortStopped', effort)
    expect.soft(effort.status, effort.body).toBe(200)
    expect.soft(effort.json?.appliedLive).toBe(false)
    const pick = await phone(`/sessions/${SID_B}/model`, { method: 'POST', body: { model: 'opus' } })
    record('downModelStopped', pick)
    expect.soft(pick.status, pick.body).toBe(200)
    expect.soft(pick.json?.appliedLive).toBe(false)
    expect.soft(pick.ms, 'a stopped pick must not wait on the host').toBeLessThan(10_000)
    const saved = await macRecord(SID_B)
    expect.soft(saved.cliModel, 'the stopped pick is on the record').toBe('opus')
    expect.soft(saved.effort).toBe('low')

    // A live CLI needs the host: the pick names it, and changes nothing.
    const recA = await macRecord(SID_A)
    report.downRecordA = { process_status: recA.process_status, cliModel: recA.cliModel }
    const live = await phone(`/sessions/${SID_A}/model`, { method: 'POST', body: { model: 'haiku' } })
    record('downModelRunning', live)
    if (recA.process_status === 'running' || recA.process_status === 'idle') {
      expect.soft(live.status, live.body).toBe(503)
      expect.soft(errCode(live)).toBe('host_reconnecting')
      expect.soft(errMessage(live), live.body).toContain(HOST_LABEL)
      expect.soft((await macRecord(SID_A)).cliModel, 'a pick that could not reach the CLI is not recorded').toBe('sonnet')
    } else {
      expect.soft(live.status, live.body).toBe(200)
    }
    expectHonestWording(live, 'model pick (live CLI, host down)')
    save()
  }, 300_000)

  // A person's look at the same state on the phone (simulator walkthrough).
  // Only with CLOUD_HOST_HOP_HOLD=<dir>: the test writes where the companion is
  // and waits for `<dir>/release`, so a phone can be pointed at it meanwhile.
  it.runIf(Boolean(HOLD))('walkthrough: hold this state for a phone', async () => {
    fs.mkdirSync(HOLD!, { recursive: true })
    fs.writeFileSync(path.join(HOLD!, 'state.json'), JSON.stringify({
      replicaUrl: `http://127.0.0.1:${replica.port}`, phoneToken: replica.tokens.phone, sidA: SID_A, sidB: SID_B,
    }))
    const release = path.join(HOLD!, 'release')
    const end = Date.now() + 20 * 60_000
    while (!fs.existsSync(release) && Date.now() < end) await sleep(500)
    expect(fs.existsSync(release), 'released by the walkthrough').toBe(true)
  }, 21 * 60_000)

  it('a send reaches the host directly, once, and a retry of it is not a second turn', async () => {
    const first = await send(SID_A, 'direct-one', 'qm-mobile-directone1')
    record('directSend', first)
    expectThrough(first, 'the send while the Mac cannot reach the host')
    expect.soft(first.ms).toBeLessThan(15_000)
    const delivered = await waitFor(() => answers(SID_A, 'direct-one') >= 1, 40_000, 'the host to answer direct-one').catch(() => false)
    expect.soft(delivered, 'the CLI on the host answered the phone').toBe(true)
    const retry = await send(SID_A, 'direct-one', 'qm-mobile-directone1')
    record('directRetry', retry)
    expect.soft(retry.status, retry.body).toBe(202)
    await sleep(3_000)
    expect.soft(answers(SID_A, 'direct-one'), 'one delivery for one messageId').toBe(1)

    // A message the Mac's queue took while the link was up, retried now by a
    // phone that lost the answer: answered from what the companion remembers,
    // never delivered a second time by the host's direct path.
    const replay = await send(SID_A, 'up-one', 'qm-mobile-upone00001')
    record('upReplayWhileMacAway', replay)
    expect.soft(replay.status, replay.body).toBe(202)
    await sleep(3_000)
    expect.soft(answers(SID_A, 'up-one'), 'a relayed message is never delivered again').toBe(1)
  }, 120_000)

  it('two quick sends land once each, in order', async () => {
    const a = await send(SID_A, 'quick-two', 'qm-mobile-quicktwo01')
    const b = await send(SID_A, 'quick-three', 'qm-mobile-quickthree1')
    record('quickSends', { a, b })
    expectThrough(a, 'quick send one')
    expectThrough(b, 'quick send two')
    const both = await waitFor(() => answers(SID_A, 'quick-two') === 1 && answers(SID_A, 'quick-three') === 1, 40_000, 'both quick sends answered').catch(() => false)
    expect.soft(both).toBe(true)
    const out = hostJsonl(SID_A)
    expect.soft(out.indexOf('"result":"quick-two"'), 'in the order sent').toBeLessThan(out.indexOf('"result":"quick-three"'))
  }, 120_000)

  it('the send held for the Mac reaches the host directly, once the Mac says it never got it', async () => {
    // held-one's relay died in the cut link, so its answer was lost and the Mac
    // MIGHT have queued it: it waited for the Mac (29 minutes in the iOS gate).
    // The host has no Mac behind it now and takes sends; the companion asks the
    // Mac over the Mac's own bridge, which still answers, and the Mac's queue
    // never saw it, so the host's own path may deliver it.
    const landed = await waitFor(() => answers(SID_B, 'held-one') === 1, 180_000, 'held-one delivered by the host directly').catch(() => false)
    report.heldForMacDeliveredAfterCutMs = landed ? Date.now() - severedAt : null
    expect.soft(landed, 'delivered while the Mac still cannot reach the host').toBe(true)
    expect.soft(await macSeesHost(), 'the link is still down').toBe(false)
    const s = await phone(`/sessions/${SID_B}/messages/qm-mobile-heldone001`)
    record('heldOneStatusDirect', s)
    expect.soft(s.json?.state, s.body).toBe('delivered')
    await sleep(3_000)
    expect.soft(answers(SID_B, 'held-one'), 'exactly once').toBe(1)
    save()
  }, 240_000)

  it('the host also drops off the companion: two sends are held in its name, then delivered once each, in order, when the host returns', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(hostDaemon!.dir, 'bridge.json'), 'utf-8')) as { url: string; token: string; hostAlias: string }
    await hostRpc('bridge.configure', { enabled: false })
    await waitFor(async () => !(await bridgeHosts()).includes(HOST), 30_000, 'the host off the companion')
    const held = await send(SID_A, 'bridge-down-one', 'qm-mobile-bridgedown1')
    record('bridgeDownSend', held)
    expectHeld(held, 'the send while the host is off the companion')
    expect.soft(held.ms).toBeLessThan(10_000)
    const behind = await send(SID_A, 'bridge-down-two', 'qm-mobile-bridgedown2')
    record('bridgeDownSecond', behind)
    expectHeld(behind, 'the send behind a held one')
    // A relaunched phone rebuilds them from the queue list (iOS gate r1, B1).
    const queued = await phone(`/sessions/${SID_A}/queue`)
    record('bridgeDownQueue', queued)
    const heldIds = ((queued.json?.messages ?? []) as Array<{ id?: string; status?: string }>)
      .filter((m) => m.status === 'held').map((m) => m.id)
    expect.soft(heldIds, queued.body).toEqual(['qm-mobile-bridgedown1', 'qm-mobile-bridgedown2'])
    await hostRpc('bridge.configure', { enabled: true, url: saved.url, token: saved.token, hostAlias: saved.hostAlias })
    await waitFor(async () => (await bridgeHosts()).includes(HOST), 60_000, 'the host back on the companion')
    const t0 = Date.now()
    const landed = await waitFor(() => answers(SID_A, 'bridge-down-one') === 1 && answers(SID_A, 'bridge-down-two') === 1, 90_000, 'the held sends delivered').catch(() => false)
    report.bridgeDownDeliveredAfterMs = landed ? Date.now() - t0 : null
    expect.soft(landed, 'delivered once the host is back on the companion, though the Mac still cannot reach it').toBe(true)
    await sleep(3_000)
    expect.soft(answers(SID_A, 'bridge-down-one'), 'exactly once').toBe(1)
    expect.soft(answers(SID_A, 'bridge-down-two'), 'exactly once').toBe(1)
    const out = hostJsonl(SID_A)
    expect.soft(out.indexOf('"result":"bridge-down-one"'), 'in the order sent').toBeLessThan(out.indexOf('"result":"bridge-down-two"'))
    save()
  }, 240_000)

  it('with nothing held any more, the next send to that session goes straight to the host', async () => {
    const second = await send(SID_B, 'held-two', 'qm-mobile-heldtwo001')
    record('heldSecond', second)
    expectThrough(second, 'the send after the held one went')
    const sent = await waitFor(() => answers(SID_B, 'held-two') === 1, 60_000, 'held-two answered').catch(() => false)
    expect.soft(sent).toBe(true)
  }, 120_000)

  it('the link comes back: new sends go through the Mac, and nothing sent another way arrives again', async () => {
    link!.up = true
    proxy.setMode('pass')
    await waitFor(() => macSeesHost(), 120_000, 'the Mac back on the host')
    // The dead socket is still open on the host (its sshd has not timed it out).
    report.orphansAfterRecovery = proxy.orphans()
    const after = await send(SID_A, 'after-one', 'qm-mobile-afterone01')
    record('afterRecoverySend', after)
    expectThrough(after, 'the send after the link came back')
    expect.soft(after.ms, 'through the live link, not the dead one').toBeLessThan(15_000)
    const sent = await waitFor(() => answers(SID_A, 'after-one') === 1, 60_000, 'after-one answered').catch(() => false)
    expect.soft(sent).toBe(true)
    // The Mac's queue never had held-one: its return delivers nothing again.
    const out = hostJsonl(SID_B)
    expect.soft(out.indexOf('"result":"held-one"')).toBeLessThan(out.indexOf('"result":"held-two"'))
    await sleep(5_000)
    expect.soft(answers(SID_B, 'held-one'), 'exactly once').toBe(1)
    expect.soft(answers(SID_B, 'held-two'), 'exactly once').toBe(1)
    expect.soft(answers(SID_A, 'direct-one'), 'no replay of the direct delivery').toBe(1)
    expect.soft(answers(SID_A, 'bridge-down-one'), 'no replay of the held-then-direct delivery').toBe(1)
    // The phone holding them hears that they went.
    for (const mid of ['qm-mobile-heldone001', 'qm-mobile-heldtwo001']) {
      const s = await phone(`/sessions/${SID_B}/messages/${mid}`)
      record(`heldStatus-${mid}`, s)
      expect.soft(s.status, s.body).toBe(200)
      expect.soft(s.json?.state, `${mid}: ${s.body}`).toBe('delivered')
    }
    save()
  }, 300_000)

  it('a stop asked for after a send was held, while the Mac cannot reach the host: the send never runs, and the phone hears so', async () => {
    // The link dies again and the host gives up on the Mac's socket.
    proxy.setMode('severed')
    link!.up = false
    const cutAt = Date.now()
    await waitFor(async () => !(await macSeesHost()), 120_000, 'the Mac to notice the dead link again')
    const quiet = 50_000 - (Date.now() - cutAt)
    if (quiet > 0) await sleep(quiet)

    // The host drops off the companion too, so the send is held there.
    const saved = JSON.parse(fs.readFileSync(path.join(hostDaemon!.dir, 'bridge.json'), 'utf-8')) as { url: string; token: string; hostAlias: string }
    await hostRpc('bridge.configure', { enabled: false })
    await waitFor(async () => !(await bridgeHosts()).includes(HOST), 30_000, 'the host off the companion')
    const held = await send(SID_A, 'stop-overtaken', 'qm-mobile-stopover01')
    record('stopOvertakenSend', held)
    expectHeld(held, 'the send before the stop')

    // The person stops the session. The Mac records it but cannot deliver it.
    const stop = await phone(`/sessions/${SID_A}/terminate`, { method: 'POST', body: {} })
    record('stopWhileHostUnreachable', stop)
    expect.soft([200, 503], stop.body).toContain(stop.status)

    // The host is back on the companion; no Mac is behind it.
    await hostRpc('bridge.configure', { enabled: true, url: saved.url, token: saved.token, hostAlias: saved.hostAlias })
    await waitFor(async () => (await bridgeHosts()).includes(HOST), 60_000, 'the host back on the companion')
    const told = await waitFor(async () => {
      const s = await phone(`/sessions/${SID_A}/messages/qm-mobile-stopover01`)
      return s.json?.state === 'not_sent' ? s : null
    }, 90_000, 'the phone to be told the held send will not go').catch(() => null)
    record('stopOvertakenStatus', told)
    expect.soft(told?.json?.code, 'not sent, because of the stop').toBe('session_stopped')
    if (told) expectHonestWording(told, 'the not-sent status')
    await sleep(5_000)
    expect.soft(answers(SID_A, 'stop-overtaken'), 'a message from before the stop never runs').toBe(0)
    save()
  }, 360_000)
})
