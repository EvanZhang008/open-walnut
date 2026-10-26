/**
 * A new Ask Walnut on the host while the Mac is away, on REAL daemon processes, both
 * twins (plan WP12, cap `replica-start-v1`):
 *
 *   test as the Mac ==trusted WS==> daemon (source twin on node, standalone on bun)
 *     leader.configure, host.slice, server.configure, leader.spawnTemplate
 *   test as the replica ==follower WS==> follower.op task_create, follower.start, follower.send
 *   test as the session's `walnut` CLI ==agent gateway socket==> task_get, task_update
 *
 * What's real: the daemon processes, the spawn template they keep, the argv they fill
 * and spawn (a mock CLI records its argv, env and stdin), the journal, the persona file,
 * the spawn journal's owner line that a stop from the Mac is checked against. A host ask
 * mounts no walnut MCP server: its walnut tools are the `walnut` CLI on its PATH, which
 * the daemon points at its gateway socket, as for every session the Mac runs on a host.
 *
 * A daemon that dies between an ask's CLI and its record (WALNUT_TEST_DIE_AFTER_ASK_SPAWN,
 * honoured outside the real daemon dir only) journals the record at its next boot, once.
 *
 * Hygiene: every dir is a temp dir; every daemon is stopped by the pid it wrote into its
 * own temp dir, the fake host server by the pid it logged, each mock CLI by the pid it
 * recorded; nothing touches a real daemon dir or journal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/marina-home'
const OTHER_HOME = '/fixture/acme-other-home'
const WALNUT = 'wmarinahost01'
const LEADER_SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const TASK_LEADER = 'mtaskaaa-0001'
const DEVICE = { kind: 'device', deviceId: 'dev-acme-phone', name: 'Acme phone' }
const PERSONA = 'You are Walnut, the marina assistant.'
const CONTEXT = '## Your task\nAsk Walnut (task mtask-ask)'
const BUN: string | undefined = testBun()

/** The host server: hands its follower token to the test (FAKE_OUT) and idles. */
const FAKE_SERVER = `
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ pid: process.pid, token: process.env.WALNUT_FOLLOWER_TOKEN }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

/**
 * The mock CLI the template names. It records its argv, cwd, the env the daemon gave it
 * and every user line on stdin under OUT, answers each line, and exits after a line
 * that says "please exit" (a stopped session a person's message starts again).
 */
function mockCli(out: string): string {
  return `
const fs = require('fs')
const OUT = ${JSON.stringify(out)}
const argv = process.argv.slice(2)
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const sid = at('--session-id') || at('--resume') || 'none'
fs.appendFileSync(OUT + '/calls.jsonl', JSON.stringify({ pid: process.pid, sid, argv, cwd: process.cwd(), socket: process.env.WALNUT_AGENT_SOCKET || '', envSid: process.env.WALNUT_SESSION_ID || '', path: process.env.PATH || '', api: process.env.OPEN_WALNUT_API_URL || '' }) + '\\n')
fs.appendFileSync(OUT + '/pids.txt', process.pid + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (!m || m.type !== 'user') continue
    const c = m.message && m.message.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && p.text) || '').join('') : ''
    fs.appendFileSync(OUT + '/stdin.jsonl', JSON.stringify({ sid, text }) + '\\n')
    out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'mock answer: ' + text }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'mock answer: ' + text, session_id: sid })
    out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    if (text.indexOf('please exit') !== -1) setTimeout(() => process.exit(0), 50)
  }
})
setInterval(() => {}, 1 << 30)
`
}

type Twin = 'source' | 'standalone'
interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; sock: string; twin: Twin; jdir: string }
interface Call { pid: number; sid: string; argv: string[]; cwd: string; socket: string; envSid: string; path: string; api: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

let base = ''
const started: number[] = []
const fakePids: number[] = []

async function spawnDaemon(name: string, twin: Twin, extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const dir = path.join(base, name)
  const jdir = path.join(base, name + '-j')
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_JOURNAL_DIR: jdir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '3000',
    ...extraEnv,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR
  // A run from inside a Walnut session inherits that session's API root and gateway: none
  // of it may reach these daemons or their CLIs (a host daemon's env has none of them).
  delete env.OPEN_WALNUT_API_URL; delete env.WALNUT_AGENT_SOCKET; delete env.WALNUT_SESSION_ID
  const stderr = process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'
  let proc: ChildProcess
  if (twin === 'standalone') {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', stderr], cwd: ROOT })
  } else {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    // The trigger sidecar a source-deployed daemon loads from beside its script.
    buildSync({ entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent' })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', stderr] })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, jdir, sock, twin, pid, port: parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10) }
}

async function stopDaemon(d: Daemon): Promise<void> {
  try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ }
  await waitFor(() => !alive(d.pid), 20_000, 'daemon exit')
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let cmdId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 30_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

/** A call of the session's `walnut` CLI through the agent gateway (WALNUT_AGENT_SOCKET). */
function gateway(sock: string, sid: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 15_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function slice(extra: HostSlice['sessions'] = [], tasks: HostSlice['tasks'] = []): HostSlice {
  return {
    v: 1, home: HOME, hash: `h${extra.length}${tasks.length}`, asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: LEADER_SID, taskId: TASK_LEADER, title: 'Leader work' }, ...extra],
    tasks: [{ id: TASK_LEADER, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme', updated_at: '2026-10-14T09:00:00.000Z' }, ...tasks],
    requests: [],
  }
}

/** The Mac connects: describes its Walnut with the v2 drains and pushes the copy. */
async function macConnects(d: Daemon, s: HostSlice = slice()): Promise<WebSocket> {
  const ws = await connectWs(d.port)
  const conf = await cmd(ws, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false, drains: JOURNAL_V2_DRAINS })
  expect(conf.ok, JSON.stringify(conf)).toBe(true)
  expect((await cmd(ws, { cmd: 'host.slice', slice: s })).ok).toBe(true)
  return ws
}

/**
 * The daemon starts the fake host server for this Walnut; its token makes the returned
 * socket the follower. `app`: the server's program sits at `<app>/dist/cli.js`, the shape
 * the Mac installs, so the daemon composes the ask's walnut MCP mount from it.
 */
async function followerSocket(d: Daemon, mac: WebSocket, opts: { app: boolean }): Promise<{ ws: WebSocket; entry: string }> {
  const out = path.join(base, `${path.basename(d.dir)}-fake.jsonl`)
  const entry = opts.app ? path.join(base, `${path.basename(d.dir)}-app`, 'dist', 'cli.js') : path.join(base, `${path.basename(d.dir)}-server.cjs`)
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, FAKE_SERVER)
  const spec = {
    v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [entry], cwd: base,
    env: { FAKE_OUT: out }, log: path.join(base, `${path.basename(d.dir)}-server.log`), port: 41_236, settings: { expose: { enabled: false } },
  }
  const r = await cmd(mac, { cmd: 'server.configure', home: HOME, spec })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim().length > 0, 30_000, 'the host server token')
  const ws = await connectWs(d.port)
  let hello: Record<string, any> = {}
  for (let attempt = 0; attempt < 40; attempt++) {
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const l of lines) if (typeof l.pid === 'number' && fakePids.indexOf(l.pid) === -1) fakePids.push(l.pid)
    hello = await cmd(ws, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token: lines[lines.length - 1].token })
    if (hello.ok) return { ws, entry }
    await sleep(250)
  }
  throw new Error('follower.hello refused: ' + JSON.stringify(hello))
}

/** The Mac's spawn template for this host: the mock CLI, then the flags with their slots, and each agent's tool lists. */
function template(mock: string, cwd: string, persona: 'arg' | 'file' = 'file'): Record<string, unknown> {
  return {
    v: 1, home: HOME,
    argv: [mock, '-p', '--output-format', 'stream-json', { slot: 'sid' }, { slot: 'mode' }, { slot: 'model' },
      { slot: 'effort' }, { slot: 'persona' }, { slot: 'tools' }, '--input-format', 'stream-json'],
    modes: { default: 'default', plan: 'plan' }, defaultMode: 'default',
    models: { sonnet: { cli: 'sonnet', effort: true }, haiku: { cli: 'haiku', effort: false } },
    autoEffort: true, effortRules: { overrides: [{ match: 'haiku-4-5', effort: false }], families: [] }, efforts: ['low', 'medium', 'high'],
    agents: { general: { allowedTools: ['Bash(walnut:*)'] } }, persona, cwd, builtAt: Date.now(),
  }
}

/** The Mac pushes its template on its trusted socket, then goes away (its socket closes). */
async function macPushesTemplateAndLeaves(mac: WebSocket, t: Record<string, unknown>): Promise<void> {
  const r = await cmd(mac, { cmd: 'leader.spawnTemplate', home: HOME, template: t })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  mac.close()
  await sleep(400)
}

function readLines<T>(file: string): T[] {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) } catch { return [] }
}

/** A fresh mock CLI, its output dir and the folder asks run in, for one test. */
function mockFor(name: string): { mock: string; out: string; cwd: string } {
  const out = path.join(base, `${name}-mock-out`)
  const cwd = path.join(base, `${name}-asks`)
  fs.mkdirSync(out, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  const script = path.join(base, `${name}-mock-cli.cjs`)
  fs.writeFileSync(script, mockCli(out))
  // The CLI the template names is ONE program, as `claude` is (a resume puts a flag right after argv[0]).
  const mock = path.join(base, `${name}-claude`)
  fs.writeFileSync(mock, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 })
  return { mock, out, cwd }
}

let sidSeq = 0
/** A v4 session id the replica would mint (crypto.randomUUID shape), unique per test run. */
function newSid(): string {
  sidSeq++
  const hex = (Date.now().toString(16) + sidSeq.toString(16).padStart(4, '0')).slice(-12).padStart(12, '0')
  return `bbbbbbbb-2222-4222-8222-${hex}`
}

function startCmd(sid: string, taskId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cmd: 'follower.start', sid, taskId, agentId: 'general', title: 'Ask Walnut',
    persona: { text: PERSONA, mode: 'append', context: CONTEXT },
    firstMessage: 'hello marina', host: 'devbox', actor: DEVICE, ...over,
  }
}

beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'rask-')) })

afterAll(() => {
  // The mock CLIs these daemons ran for the test (each recorded its own pid), then the rest.
  const mocks: number[] = []
  for (const n of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    if (!n.endsWith('-mock-out')) continue
    try { mocks.push(...fs.readFileSync(path.join(base, n, 'pids.txt'), 'utf8').split('\n').map((l) => parseInt(l, 10)).filter((x) => x > 1)) } catch { /* none started */ }
  }
  for (const pid of [...mocks, ...fakePids, ...started]) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** The Mac stops the host server, then the daemon stops. */
async function teardown(d: Daemon): Promise<void> {
  try {
    const mac = await macConnects(d)
    await cmd(mac, { cmd: 'server.configure', home: HOME, spec: null })
    mac.close()
  } catch { /* the daemon is gone already */ }
  await stopDaemon(d)
}

/** The Mac drains everything with the v2 kinds, acking each batch. */
async function macDrains(ws: WebSocket): Promise<Array<Record<string, any>>> {
  const all: Array<Record<string, any>> = []
  for (let round = 0; round < 20; round++) {
    const r = await cmd(ws, { cmd: 'offline.drain', home: HOME, kinds: JOURNAL_V2_DRAINS })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const recs = (r.records ?? []) as Array<Record<string, any>>
    if (!recs.length) break
    all.push(...recs)
    expect((await cmd(ws, { cmd: 'offline.ack', home: HOME, seqs: recs.map((x) => x.seq) })).ok).toBe(true)
  }
  return all
}

/** The one CLI call the daemon spawned for `sid` (the latest when it ran twice). */
async function callOf(out: string, sid: string, n = 1): Promise<Call> {
  let calls: Call[] = []
  await waitFor(() => (calls = readLines<Call>(path.join(out, 'calls.jsonl')).filter((c) => c.sid === sid)).length >= n, 30_000, `CLI call ${n} of ${sid}`)
  return calls[n - 1]
}

async function stdinOf(out: string, sid: string, text: string): Promise<void> {
  await waitFor(() => readLines<{ sid: string; text: string }>(path.join(out, 'stdin.jsonl')).some((l) => l.sid === sid && l.text === text), 30_000, `stdin "${text.slice(0, 40)}" of ${sid}`)
}

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a new ask on the host while the Mac is away`, () => {
    it('starts from the template, its own walnut calls read and change its new task, everything is journaled, a message resumes it, and the Mac stops it after adoption', async () => {
      const d = await spawnDaemon(`${twin}-main`, twin)
      const m = mockFor(`${twin}-main`)
      let mac = await macConnects(d)
      const { ws: follower, entry } = await followerSocket(d, mac, { app: true })
      mac.close()
      await sleep(400)
      const TASK_ASK = `mtask-ask-${twin}`
      const S1 = newSid()
      // No template from the Mac yet: the ask needs the Mac, and says why.
      const none = await cmd(follower, startCmd(S1, TASK_ASK))
      expect(none, JSON.stringify(none)).toMatchObject({ ok: false, errorKind: 'needs_leader', detail: { why: 'no_spawn_template' } })
      // The replica can never push a template itself (only the Mac's trusted socket).
      const forged = await cmd(follower, { cmd: 'leader.spawnTemplate', home: HOME, template: template(m.mock, m.cwd) })
      expect(forged.ok).toBe(false)
      // While the Mac answers, a start goes through the Mac.
      mac = await macConnects(d)
      expect(await cmd(follower, startCmd(S1, TASK_ASK))).toMatchObject({ ok: false, errorKind: 'leader_answers' })
      await macPushesTemplateAndLeaves(mac, template(m.mock, m.cwd))
      // The ask's task, journaled as the replica files it (Ask <agent>).
      const made = await cmd(follower, { cmd: 'follower.op', op: 'task_create', args: { id: TASK_ASK, title: 'Ask Walnut', project: 'Ask Walnut' }, actor: DEVICE, opId: `op-ask-${twin}` })
      expect(made.ok, JSON.stringify(made)).toBe(true)
      const r = await cmd(follower, startCmd(S1, TASK_ASK, { opId: `op-ask-${twin}`, messageId: `qm-ask-${twin}-1` }))
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, sid: S1, taskId: TASK_ASK, mode: 'default', messageId: `qm-ask-${twin}-1` })
      expect(fs.realpathSync(r.cwd)).toBe(fs.realpathSync(m.cwd))
      // The first message rides stdin; the argv is the template with its slots filled.
      await stdinOf(m.out, S1, 'hello marina')
      const c = await callOf(m.out, S1)
      const personaAt = c.argv.indexOf('--append-system-prompt-file') + 1
      // The tool lists are the template's (the Mac's); no walnut MCP mount.
      expect(c.argv).toEqual(['-p', '--output-format', 'stream-json', '--session-id', S1, '--permission-mode', 'default',
        '--append-system-prompt-file', c.argv[personaAt], '--allowedTools', 'Bash(walnut:*)', '--input-format', 'stream-json'])
      const personaFile = c.argv[personaAt]
      expect(personaFile.startsWith(path.join(d.jdir, 'offline-host', 'personas') + path.sep)).toBe(true)
      expect(fs.readFileSync(personaFile, 'utf8')).toBe(PERSONA + '\n\n' + CONTEXT)
      expect(fs.statSync(personaFile).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(personaFile)).mode & 0o777).toBe(0o700)
      expect(c.argv.join('\n')).not.toContain(entry)
      expect(fs.realpathSync(c.cwd)).toBe(fs.realpathSync(m.cwd))
      // Its walnut tools: the `walnut` CLI on its PATH (the daemon's gateway shim), with this
      // daemon's gateway socket and its own session id, and no Walnut API root to talk to.
      expect(c.envSid).toBe(S1)
      expect(c.socket).toBe(d.sock)
      expect(c.path.split(':')).toContain(path.join(d.dir, 'bin'))
      expect(fs.existsSync(path.join(d.dir, 'bin', 'walnut'))).toBe(true)
      expect(c.api).toBe('')
      expect(c.argv.join('\n')).not.toContain('hello marina')
      // The session's own walnut calls: its new task is found through the overlay and changed.
      const got = await gateway(d.sock, S1, 'task_get', { id: TASK_ASK })
      expect(got.ok, JSON.stringify(got)).toBe(true)
      expect(JSON.stringify(got.result)).toContain('Ask Walnut')
      const upd = await gateway(d.sock, S1, 'task_update', { id: TASK_ASK, title: 'Marina question' })
      expect(upd.ok, JSON.stringify(upd)).toBe(true)
      expect(JSON.stringify((await gateway(d.sock, S1, 'task_get', { id: TASK_ASK })).result)).toContain('Marina question')
      // The replica lists it and its overlay holds the session record.
      const listed = await cmd(follower, { cmd: 'follower.sessions' })
      expect(listed.sessions.map((s: { sid: string }) => s.sid)).toContain(S1)
      const pend = await cmd(follower, { cmd: 'follower.pending', sinceSeq: 0 })
      expect(pend.records.some((x: Record<string, unknown>) => x.kind === 'session' && x.sid === S1)).toBe(true)
      // The CLI ends (its idle reap, a crash): a person's message starts it again here.
      expect((await cmd(follower, { cmd: 'follower.send', sid: S1, text: 'please exit', messageId: `qm-ask-${twin}-2` })).ok).toBe(true)
      await stdinOf(m.out, S1, 'please exit')
      await waitFor(() => !alive(c.pid), 20_000, 'the first CLI exit')
      // The daemon sees the CLI gone (follower.sessions says stopped) before the person writes.
      let state = ''
      for (const end = Date.now() + 20_000; state !== 'stopped' && Date.now() < end; await sleep(200)) {
        const s = await cmd(follower, { cmd: 'follower.sessions' })
        state = (s.sessions as Array<{ sid: string; state: string }>).find((x) => x.sid === S1)?.state ?? ''
      }
      expect(state).toBe('stopped')
      const back = await cmd(follower, { cmd: 'follower.send', sid: S1, text: 'are you back', messageId: `qm-ask-${twin}-3` })
      expect(back, JSON.stringify(back)).toMatchObject({ ok: true, delivered: true, messageId: `qm-ask-${twin}-3` })
      await stdinOf(m.out, S1, 'are you back')
      const again = await callOf(m.out, S1, 2)
      expect(again.argv).toContain('--resume')
      expect(again.argv).not.toContain('--session-id')
      expect(again.argv[again.argv.indexOf('--resume') + 1]).toBe(S1)
      // The Mac is back: one drain hands it the task, the session, the session's own write.
      mac = await macConnects(d)
      const drained = await macDrains(mac)
      const create = drained.find((x) => x.kind === 'task-create')
      const session = drained.find((x) => x.kind === 'session')
      const fields = drained.find((x) => x.kind === 'task-fields')
      expect(create).toMatchObject({ taskId: TASK_ASK, opId: `op-ask-${twin}`, actor: { kind: 'device', deviceId: DEVICE.deviceId } })
      expect(session).toMatchObject({
        sid: S1, taskId: TASK_ASK, host: 'devbox', agentId: 'general', mode: 'default', title: 'Ask Walnut', firstMessage: 'hello marina',
        opId: `op-ask-${twin}-session`, actor: { kind: 'device', deviceId: DEVICE.deviceId },
      })
      expect(fs.realpathSync(session!.cwd)).toBe(fs.realpathSync(m.cwd))
      expect(session!.seq).toBeGreaterThan(create!.seq)
      expect(fields).toMatchObject({ taskId: TASK_ASK, actor: { kind: 'session', sid: S1 } })
      expect(fields!.fields.title.value).toBe('Marina question')
      expect(drained.some((x) => x.kind === 'resume' && x.sid === S1)).toBe(true)
      expect(await macDrains(mac)).toEqual([])
      // Adopted: the Mac's copy lists the session. A stop from another Walnut is refused
      // (owner-home-v1: the spawn journal names this Walnut), the Mac's own is honoured.
      expect((await cmd(mac, { cmd: 'host.slice', slice: slice([{ sid: S1, taskId: TASK_ASK, title: 'Marina question' }], [{ id: TASK_ASK, title: 'Marina question', phase: 'IN_PROGRESS', project: 'Ask Walnut' }]) })).ok).toBe(true)
      const foreign = await cmd(mac, { cmd: 'stop', sid: S1, home: OTHER_HOME, reason: 'user', initiator: 'human' })
      expect(foreign, JSON.stringify(foreign)).toMatchObject({ ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' })
      expect(alive(again.pid)).toBe(true)
      const own = await cmd(mac, { cmd: 'stop', sid: S1, home: HOME, reason: 'user', initiator: 'human' })
      expect(own.ok, JSON.stringify(own)).toBe(true)
      expect(own.stopped).not.toBe(false)
      await waitFor(() => !alive(again.pid), 20_000, 'the stopped CLI exit')
      follower.close()
      mac.close()
      await teardown(d)
    }, 240_000)
  })
}

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: the limits of a new ask on the host`, () => {
    it('a retry starts once, a bad mode, model or folder is refused, ten asks an hour per Walnut, and no walnut mount', async () => {
      const d = await spawnDaemon(`${twin}-limits`, twin)
      const m = mockFor(`${twin}-limits`)
      const mac = await macConnects(d)
      // The host server's program is not `<app>/dist/cli.js`; no MCP mount either way.
      const { ws: follower } = await followerSocket(d, mac, { app: false })
      await macPushesTemplateAndLeaves(mac, template(m.mock, m.cwd))
      const task = (i: number) => `mtask-lim-${twin}-${i}`
      // Refused before anything is journaled or spawned: each names what is wrong.
      // A model outside the template rides as itself only when it is one CLI value.
      for (const over of [{ mode: 'bypass' }, { model: '--dangerously-skip-permissions' }, { model: 'opus sonnet' }, { effort: 'max' }, { cwd: base }, { persona: { text: '--dangerously-skip-permissions' } }]) {
        const no = await cmd(follower, startCmd(newSid(), task(0), over))
        expect(no, JSON.stringify(over)).toMatchObject({ ok: false, errorKind: 'bad_request' })
      }
      // No persona: the ask needs the Mac.
      expect(await cmd(follower, startCmd(newSid(), task(0), { persona: undefined }))).toMatchObject({ ok: false, errorKind: 'needs_leader', detail: { why: 'persona_not_copied' } })
      expect(readLines(path.join(m.out, 'calls.jsonl'))).toEqual([])
      // A lost answer asked again starts the session once.
      const first = newSid()
      expect((await cmd(follower, startCmd(first, task(1), { firstMessage: 'hello' }))).ok).toBe(true)
      expect(await cmd(follower, startCmd(first, task(1), { firstMessage: 'hello' }))).toMatchObject({ ok: true, sid: first, duplicate: true })
      const c = await callOf(m.out, first)
      expect(c.argv).not.toContain('--mcp-config')
      // plan, a model with its effort.
      const planned = newSid()
      expect((await cmd(follower, startCmd(planned, task(2), { mode: 'plan', model: 'sonnet', effort: 'low', firstMessage: 'please exit' }))).ok).toBe(true)
      const p = await callOf(m.out, planned)
      expect(p.argv.slice(3, 11)).toEqual(['--session-id', planned, '--permission-mode', 'plan', '--model', 'sonnet', '--effort', 'low'])
      // A model that takes no effort gets none.
      const quick = newSid()
      expect((await cmd(follower, startCmd(quick, task(3), { model: 'haiku', effort: 'high', firstMessage: 'please exit' }))).ok).toBe(true)
      const q = await callOf(m.out, quick)
      expect(q.argv).toContain('haiku')
      expect(q.argv).not.toContain('--effort')
      // A model value outside the picker (a host catalog id, as a persona's launch model is)
      // rides as itself, as the Mac's send() passes it, with its effort.
      const raw = newSid()
      expect((await cmd(follower, startCmd(raw, task(4), { model: 'global.anthropic.claude-fable-5[1m]', effort: 'low', firstMessage: 'please exit' }))).ok).toBe(true)
      const rw = await callOf(m.out, raw)
      expect(rw.argv.slice(rw.argv.indexOf('--model'), rw.argv.indexOf('--model') + 4)).toEqual(['--model', 'global.anthropic.claude-fable-5[1m]', '--effort', 'low'])
      // Ten asks an hour for this Walnut on this host; the eleventh waits, and says how long.
      for (let i = 5; i <= 10; i++) expect((await cmd(follower, startCmd(newSid(), task(i), { firstMessage: 'please exit' }))).ok, `start ${i}`).toBe(true)
      const over = await cmd(follower, startCmd(newSid(), task(11), { firstMessage: 'please exit' }))
      expect(over, JSON.stringify(over)).toMatchObject({ ok: false, errorKind: 'throttled' })
      expect(over.retryAfterMs).toBeGreaterThan(0)
      await waitFor(() => readLines(path.join(m.out, 'calls.jsonl')).length === 10, 30_000, 'ten CLIs')
      await sleep(500)
      expect(readLines(path.join(m.out, 'calls.jsonl'))).toHaveLength(10)
      follower.close()
      await teardown(d)
    }, 240_000)
  })
}

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: an injection string in every field of a start`, () => {
    it('each field is refused or kept out of the argv; nothing runs it', async () => {
      const d = await spawnDaemon(`${twin}-inject`, twin)
      const m = mockFor(`${twin}-inject`)
      const mac = await macConnects(d)
      const { ws: follower } = await followerSocket(d, mac, { app: true })
      await macPushesTemplateAndLeaves(mac, template(m.mock, m.cwd))
      const marker = path.join(base, `${twin}-pwned`)
      const INJ = `x'"; touch ${marker}; $(touch ${marker}) \`touch ${marker}\` --dangerously-skip-permissions\n--model opus,Bash(*)`
      const task = `mtask-inj-${twin}`
      const persona = { text: PERSONA, mode: 'append', context: CONTEXT }
      const refused: Array<[string, Record<string, unknown>]> = [
        ['sid', { sid: INJ }], ['taskId', { taskId: INJ }], ['agentId', { agentId: INJ }], ['mode', { mode: INJ }],
        ['model', { model: INJ }], ['effort', { effort: INJ }], ['cwd', { cwd: INJ }],
        ['persona.mode', { persona: { ...persona, mode: INJ } }],
        ['persona.allowedTools', { persona: { ...persona, allowedTools: [INJ] } }],
        ['persona.tools', { persona: { ...persona, tools: [INJ] } }],
        ['actor.deviceId', { actor: { kind: 'device', deviceId: INJ } }],
      ]
      for (const [field, over] of refused) {
        const sid = newSid()
        const r = await cmd(follower, startCmd(over.sid === INJ ? INJ : sid, over.taskId === INJ ? INJ : task, { firstMessage: 'please exit', ...over }))
        expect(r, field).toMatchObject({ ok: false, errorKind: 'bad_request' })
      }
      // Kept: each is data (the journal, the persona file, stdin), never an argv string.
      const kept: Array<[string, Record<string, unknown>]> = [
        ['title', { title: INJ }], ['persona.text', { persona: { ...persona, text: INJ } }],
        ['persona.context', { persona: { ...persona, context: INJ } }], ['firstMessage', { firstMessage: INJ + ' please exit' }],
        ['host', { host: INJ }], ['opId', { opId: INJ }], ['messageId', { messageId: INJ }],
        ['actor.name', { actor: { ...DEVICE, name: INJ } }],
      ]
      const sids: Record<string, string> = {}
      for (const [field, over] of kept) {
        const sid = newSid()
        sids[field] = sid
        const r = await cmd(follower, startCmd(sid, task, { firstMessage: 'please exit', persona, ...over }))
        expect(r, `${field}: ${JSON.stringify(r)}`).toMatchObject({ ok: true, sid })
        if (field === 'messageId') expect(r.messageId).toMatch(/^qm-ask-[0-9a-f]{16}$/)
      }
      for (const [field] of kept) {
        const c = await callOf(m.out, sids[field])
        const file = c.argv[c.argv.indexOf('--append-system-prompt-file') + 1]
        expect(c.argv, field).toEqual(['-p', '--output-format', 'stream-json', '--session-id', sids[field], '--permission-mode', 'default',
          '--append-system-prompt-file', file, '--allowedTools', 'Bash(walnut:*)', '--input-format', 'stream-json'])
        expect(c.argv.join('\n'), field).not.toContain('touch')
        expect(file.endsWith(`${sids[field]}.md`)).toBe(true)
        if (field === 'persona.text') expect(fs.readFileSync(file, 'utf8')).toBe(INJ + '\n\n' + CONTEXT)
        if (field === 'persona.context') expect(fs.readFileSync(file, 'utf8')).toBe(PERSONA + '\n\n' + INJ)
      }
      // The whole message reached stdin as one message.
      await stdinOf(m.out, sids.firstMessage, INJ + ' please exit')
      // The journal keeps the words as data: the title as given, no host, the op id the daemon chose.
      mac.close()
      const back = await macConnects(d)
      const sessions = (await macDrains(back)).filter((x) => x.kind === 'session')
      expect(sessions.find((x) => x.sid === sids.title)?.title).toBe(INJ)
      expect(sessions.find((x) => x.sid === sids.host)?.host).toBe('')
      expect(String(sessions.find((x) => x.sid === sids.opId)?.opId ?? '')).not.toContain('touch')
      expect(sessions.find((x) => x.sid === sids['actor.name'])?.actor).toEqual({ kind: 'device', deviceId: DEVICE.deviceId, name: INJ.slice(0, 80) })
      await sleep(500)
      expect(fs.existsSync(marker)).toBe(false)
      follower.close()
      back.close()
      await teardown(d)
    }, 240_000)
  })
}

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a retry while the CLI starts, the precheck, a start that fails`, () => {
    it('two starts of one session id at once start one CLI; a precheck starts and journals nothing; a CLI that cannot start leaves no session record', async () => {
      const d = await spawnDaemon(`${twin}-once`, twin)
      const m = mockFor(`${twin}-once`)
      const mac = await macConnects(d)
      const { ws: follower } = await followerSocket(d, mac, { app: true })
      await macPushesTemplateAndLeaves(mac, template(m.mock, m.cwd))
      const sessionRecords = async (sid: string) => ((await cmd(follower, { cmd: 'follower.pending', sinceSeq: 0 })).records as Array<Record<string, unknown>>)
        .filter((x) => x.kind === 'session' && x.sid === sid)
      // The replica's retry after a lost answer arrives while the first is still starting.
      const S = newSid()
      const [a, b] = await Promise.all([
        cmd(follower, startCmd(S, `mtask-once-${twin}`, { opId: `op-once-${twin}` })),
        cmd(follower, startCmd(S, `mtask-once-${twin}`, { opId: `op-once-${twin}` })),
      ])
      expect(a, JSON.stringify(a)).toMatchObject({ ok: true, sid: S })
      expect(b, JSON.stringify(b)).toMatchObject({ ok: true, sid: S, messageId: a.messageId })
      const c = await callOf(m.out, S)
      await sleep(2_000)
      expect(readLines<Call>(path.join(m.out, 'calls.jsonl')).filter((x) => x.sid === S)).toHaveLength(1)
      expect(alive(c.pid)).toBe(true)
      expect(await sessionRecords(S)).toHaveLength(1)
      // A precheck (no task yet): answered, nothing spawned, nothing journaled; its refusals are the start's.
      const P = newSid()
      const { taskId: _t, ...noTask } = startCmd(P, 'unused')
      expect(await cmd(follower, { ...noTask, check: true }), 'precheck').toMatchObject({ ok: true, sid: P, checked: true })
      expect(await cmd(follower, { ...noTask, check: true, mode: 'bypass' })).toMatchObject({ ok: false, errorKind: 'bad_request' })
      expect(await cmd(follower, { ...noTask, check: true, persona: undefined })).toMatchObject({ ok: false, errorKind: 'needs_leader', detail: { why: 'persona_not_copied' } })
      // A precheck of a start under way (or just answered): answered as that start.
      expect(await cmd(follower, { ...startCmd(S, 'unused'), taskId: undefined, check: true })).toMatchObject({ ok: true, sid: S, checked: true, duplicate: true })
      await sleep(500)
      expect(readLines<Call>(path.join(m.out, 'calls.jsonl')).filter((x) => x.sid === P)).toEqual([])
      expect(await sessionRecords(P)).toEqual([])
      // The folder asks run in is gone: the CLI cannot start, and no session record is kept.
      const gone = mockFor(`${twin}-gone`)
      const back = await macConnects(d)
      await macPushesTemplateAndLeaves(back, template(gone.mock, gone.cwd))
      fs.rmSync(gone.cwd, { recursive: true, force: true })
      const F = newSid()
      const failed = await cmd(follower, startCmd(F, `mtask-gone-${twin}`))
      // (bun: the start's own cwd check; node: the spawn that never got a pid)
      expect(failed, JSON.stringify(failed)).toMatchObject({ ok: false, errorKind: 'internal' })
      expect(await sessionRecords(F)).toEqual([])
      expect(readLines<Call>(path.join(gone.out, 'calls.jsonl'))).toEqual([])
      follower.close()
      await teardown(d)
    }, 240_000)
  })
}

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a daemon that dies while an ask starts`, () => {
    it('dies after the CLI is spawned and before its record: the next boot journals the record, once, the CLI keeps running, and the replica reads its history by the journal', async () => {
      const name = `${twin}-crash`
      let d = await spawnDaemon(name, twin, { WALNUT_TEST_DIE_AFTER_ASK_SPAWN: '1' })
      const m = mockFor(name)
      let mac = await macConnects(d)
      const { ws: follower } = await followerSocket(d, mac, { app: false })
      await macPushesTemplateAndLeaves(mac, template(m.mock, m.cwd))
      const TASK = `mtask-crash-${twin}`
      const S = newSid()
      const made = await cmd(follower, { cmd: 'follower.op', op: 'task_create', args: { id: TASK, title: 'Ask Walnut', project: 'Ask Walnut' }, actor: DEVICE, opId: `op-crash-${twin}` })
      expect(made.ok, JSON.stringify(made)).toBe(true)
      // The start's answer never comes: the daemon dies right after the spawn.
      void cmd(follower, startCmd(S, TASK, { opId: `op-crash-${twin}` })).catch(() => null)
      const c = await callOf(m.out, S)
      await waitFor(() => !alive(d.pid), 20_000, 'the daemon death')
      follower.close()
      expect(alive(c.pid)).toBe(true)
      const reboot = async (): Promise<void> => {
        for (const f of ['daemon.port', 'daemon.pid', 'agent-gateway.sock']) { try { fs.unlinkSync(path.join(d.dir, f)) } catch { /* gone */ } }
        d = await spawnDaemon(name, twin)
      }
      // The next daemon on the same dirs: its boot journals the record the dead one never wrote.
      await reboot()
      expect(alive(c.pid)).toBe(true)
      // One more boot before the Mac drains: the session is this Walnut's by its journal alone
      // (no copy lists it yet), and the replica still reads its history.
      await stopDaemon(d)
      await reboot()
      mac = await macConnects(d)
      const { ws: again } = await followerSocket(d, mac, { app: false })
      const hist = await cmd(again, { cmd: 'read-history', sid: S })
      expect(hist.ok, JSON.stringify(hist)).toBe(true)
      again.close()
      const drained = await macDrains(mac)
      const sessions = drained.filter((x) => x.kind === 'session' && x.sid === S)
      expect(sessions, JSON.stringify(drained.map((x) => x.kind))).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ sid: S, taskId: TASK, mode: 'default', opId: `op-crash-${twin}-session`, actor: { kind: 'device', deviceId: DEVICE.deviceId } })
      expect(drained.some((x) => x.kind === 'task-create' && x.taskId === TASK)).toBe(true)
      expect(fs.readdirSync(path.join(d.jdir, 'offline-host', 'pending-starts')).filter((f) => f.endsWith('.json'))).toEqual([])
      mac.close()
      // Another boot finds nothing left to journal.
      await stopDaemon(d)
      await reboot()
      mac = await macConnects(d)
      expect((await macDrains(mac)).filter((x) => x.kind === 'session')).toEqual([])
      mac.close()
      await teardown(d)
    }, 240_000)
  })
}
