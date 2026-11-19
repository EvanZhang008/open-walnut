/**
 * A plugin job's call in the seconds after its leader went quiet, on REAL daemon
 * processes, both twins (follower-gateway-core.ts routeJob, the one rule for "away"):
 *
 *   test as the Mac ==trusted WS (no auto pong)==> daemon
 *     leader.configure, server.configure, jobs.configure; app pings while it is awake
 *   test as the host's Walnut server ==follower WS==> follower.hello {answersLocal: true}
 *   a real job run (the daemon's own `walnut plugin-job`): its run id is the caller
 *
 * The Mac stops pinging: after three beats the gateway passes over it, while the follower
 * may not write until the Mac's whole quiet window has passed. A job's call made in that
 * window waits, within its deadline, and then goes the right way:
 *   - the window ends: to the follower (`gateway-request` naming the job), never an error
 *   - the Mac pings again first: to the Mac, the follower asked nothing
 *   - the job's call leaves (its socket closes) while it waits: asked of no one, even once the
 *     Mac answers again (its next run would retry it: applied twice)
 *
 * Hygiene: every dir is a temp dir (short: socket paths); each daemon is stopped by the pid
 * it wrote into its own dir, the fake host server and the job run by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinahost01'
const BUN: string | undefined = testBun()
/** Beats of 400 ms: the gateway passes over a silent Mac after 3 (1.2 s), the keepalive closes it after 8 (3.2 s). */
const BEAT_MS = 400
/** Between the two: the follower may write once the Mac has been quiet this long. */
const QUIET_MS = 3_000

/** The host server the daemon starts: hands its follower token to the test (FAKE_OUT) and idles. */
const FAKE_SERVER = `
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ pid: process.pid, token: process.env.WALNUT_FOLLOWER_TOKEN }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

/** The plugin's job, as the Mac bundles it: tells the test its run id and waits. */
const BUNDLE = `
import fs from 'node:fs'
export const jobs = {
  worker: async (walnut, signal) => {
    const info = JSON.parse(process.env.WALNUT_PLUGIN_JOB)
    fs.appendFileSync(process.env.JOB_OUT, JSON.stringify({ pid: process.pid, sid: info.sid }) + '\\n')
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
  },
}
`

type Twin = 'source' | 'standalone'
interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; sock: string }

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
function lines(file: string): Array<Record<string, any>> {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

let base = ''
const started: number[] = []

async function spawnDaemon(name: string, twin: Twin, jobOut: string): Promise<Daemon> {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_JOURNAL_DIR: path.join(base, name + '-j'),
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT_MS),
    WALNUT_LEADER_QUIET_MS: String(QUIET_MS),
    WALNUT_GATEWAY_TIMEOUT_MS: '20000',
    JOB_OUT: jobOut,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR
  delete env.OPEN_WALNUT_API_URL; delete env.WALNUT_AGENT_SOCKET; delete env.WALNUT_SESSION_ID
  const stderr = process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'
  let proc: ChildProcess
  if (twin === 'standalone') {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', stderr], cwd: ROOT })
  } else {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', stderr] })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, sock, pid, port: parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10) }
}

/** `autoPong: false`: the Mac is heard only while the test says it is awake (a frozen Mac answers nothing). */
function connectWs(port: number, autoPong = true): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong })
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

/** A server end: answers every gateway request with who it is; returns what it was asked. */
function answersAs(ws: WebSocket, who: string): Array<Record<string, any>> {
  const asked: Array<Record<string, any>> = []
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (m.ev !== 'gateway-request') return
    asked.push(m)
    ws.send(JSON.stringify({ id: cmdId++, cmd: 'gateway-result', relayId: m.relayId, result: { who, op: m.payload?.name } }))
  })
  return asked
}

/**
 * One call on the agent gateway socket under `sid`, as the job's walnut.ops.call sends it:
 * `sent` settles once the request left this process, `done` with the daemon's answer.
 */
function startGatewayCall(sock: string, sid: string, name: string): { sent: Promise<void>; done: Promise<{ at: number; reply: Record<string, any> }> } {
  let wrote!: () => void
  const sent = new Promise<void>((resolve) => { wrote = resolve })
  const done = new Promise<{ at: number; reply: Record<string, any> }>((resolve, reject) => {
    const c = net.connect(sock)
    let buf = ''
    c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args: {} } }) + '\n', () => wrote()))
    c.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { c.destroy(); resolve({ at: Date.now(), reply: JSON.parse(buf.slice(0, buf.indexOf('\n'))) }) } })
    c.on('error', reject)
  })
  return { sent, done }
}

const gatewayCall = (sock: string, sid: string, name: string) => startGatewayCall(sock, sid, name).done

interface Rig { d: Daemon; mac: WebSocket; follower: WebSocket; macAsked: Array<Record<string, any>>; followerAsked: Array<Record<string, any>>; jobSid: string; awake: (on: boolean) => void }

async function rig(twin: Twin, name: string): Promise<Rig> {
  const jobOut = path.join(base, `${name}-job.jsonl`)
  const d = await spawnDaemon(name, twin, jobOut)
  const mac = await connectWs(d.port, false)
  let beat: ReturnType<typeof setInterval> | null = null
  const awake = (on: boolean) => {
    if (beat) { clearInterval(beat); beat = null }
    if (on) beat = setInterval(() => { try { mac.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, BEAT_MS / 2)
  }
  awake(true)
  const macAsked = answersAs(mac, 'mac')
  expect((await cmd(mac, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false })).ok).toBe(true)
  // The host server this daemon starts; its token makes the second socket the follower.
  const fakeOut = path.join(base, `${name}-fake.jsonl`)
  const entry = path.join(base, `${name}-server.cjs`)
  fs.writeFileSync(entry, FAKE_SERVER)
  const spec = { v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [entry], cwd: base, env: { FAKE_OUT: fakeOut }, log: path.join(base, `${name}-server.log`), port: 41_237, settings: { expose: { enabled: false } } }
  expect((await cmd(mac, { cmd: 'server.configure', home: HOME, spec })).ok).toBe(true)
  await waitFor(() => lines(fakeOut).length > 0, 30_000, 'the host server token')
  const follower = await connectWs(d.port)
  let hello: Record<string, any> = {}
  for (let attempt = 0; attempt < 40 && hello.ok !== true; attempt++) {
    hello = await cmd(follower, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token: lines(fakeOut).at(-1)!.token, answersLocal: true })
    if (hello.ok !== true) await sleep(250)
  }
  expect(hello.ok, JSON.stringify(hello)).toBe(true)
  const followerAsked = answersAs(follower, 'follower')
  // A real job run: its run id is the caller the gateway knows.
  const sha256 = crypto.createHash('sha256').update(BUNDLE).digest('hex')
  const file = path.join(d.dir, 'plugin-jobs', 'bundles', `${sha256}.mjs`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, BUNDLE)
  const jobs = [{ plugin: 'acme-sync', version: '1.0.0', job: 'worker', kind: 'long-running', bundle: { sha256, file }, config: {}, host: 'devbox' }]
  expect((await cmd(mac, { cmd: 'jobs.configure', home: HOME, spec: { v: 1, home: HOME, walnutId: WALNUT, jobs } })).ok).toBe(true)
  await waitFor(() => lines(jobOut).some((l) => typeof l.sid === 'string'), 30_000, 'the job run')
  const jobSid = String(lines(jobOut).find((l) => typeof l.sid === 'string')!.sid)
  return { d, mac, follower, macAsked, followerAsked, jobSid, awake }
}

/**
 * Waits until the daemon passes over its silent leader: three missed beats, plus the beat of
 * the sweep that notices them, read from the daemon's own clock for the leader (the follower
 * view's `primaryHeardAgoMs`), never from a fixed wait here.
 */
async function leaderPassedOver(r: Rig): Promise<void> {
  const end = Date.now() + 30_000
  for (;;) {
    const view = await cmd(r.follower, { cmd: 'follower.status' })
    if (Number(view.primaryHeardAgoMs) >= BEAT_MS * 4 + 100) return
    if (Date.now() > end) throw new Error('timed out waiting for the daemon to pass over its leader: ' + JSON.stringify(view).slice(0, 300))
    await sleep(50)
  }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fgj-'))
})

afterAll(() => {
  for (const f of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const l of lines(path.join(base, f))) if (typeof l.pid === 'number' && l.pid > 1 && alive(l.pid)) { try { process.kill(l.pid, 'SIGKILL') } catch { /* gone */ } }
  }
  for (const pid of started) if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a plugin job's call right after its leader went quiet`, () => {
    it('awake: the call goes to the Mac, the follower is asked nothing', async () => {
      const r = await rig(twin, `${twin.slice(0, 2)}a`)
      try {
        const { reply } = await gatewayCall(r.d.sock, r.jobSid, 'task_list')
        expect(reply).toMatchObject({ ok: true, result: { who: 'mac' } })
        expect(r.followerAsked).toEqual([])

        // The Mac falls silent: past three beats the gateway passes over it, and the follower
        // may write only once the whole quiet window has passed. A call in between waits.
        r.awake(false)
        const quietAt = Date.now()
        await leaderPassedOver(r)
        const { at, reply: waited } = await gatewayCall(r.d.sock, r.jobSid, 'task_create')
        expect(waited, JSON.stringify(waited)).toMatchObject({ ok: true, result: { who: 'follower', op: 'task_create' } })
        expect(at - quietAt).toBeGreaterThanOrEqual(QUIET_MS - 500)
        expect(r.followerAsked).toHaveLength(1)
        expect(r.followerAsked[0]).toMatchObject({ callerSid: 'external', caller: { kind: 'plugin-job', plugin: 'acme-sync', job: 'worker' } })
        expect(r.macAsked.map((m) => m.payload?.name)).toEqual(['task_list'])
      } finally {
        r.awake(false)
        r.mac.close(); r.follower.close()
      }
    }, 120_000)

    it('the Mac speaks again before its window ends: the waiting call goes to it, never to the follower', async () => {
      const r = await rig(twin, `${twin.slice(0, 2)}b`)
      try {
        r.awake(false)
        await leaderPassedOver(r)
        // The call is on its way before the Mac's next beat (half a beat after it wakes).
        const pending = startGatewayCall(r.d.sock, r.jobSid, 'task_update')
        await pending.sent
        r.awake(true)
        const { reply } = await pending.done
        expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, result: { who: 'mac', op: 'task_update' } })
        expect(r.followerAsked).toEqual([])
      } finally {
        r.awake(false)
        r.mac.close(); r.follower.close()
      }
    }, 120_000)

    it('the job\'s call leaves while it waits: never relayed, even once the Mac answers again', async () => {
      const r = await rig(twin, `${twin.slice(0, 2)}c`)
      try {
        r.awake(false)
        await leaderPassedOver(r)
        const c = net.connect(r.d.sock)
        await new Promise<void>((resolve, reject) => { c.on('connect', () => resolve()); c.on('error', reject) })
        c.write(JSON.stringify({ v: 1, op: 'tools.call', sid: r.jobSid, args: { name: 'task_create', args: {} } }) + '\n')
        await sleep(400)
        c.destroy()
        r.awake(true)
        // Well past the quiet window: had the wait gone on, the call would have gone to one of them.
        await sleep(QUIET_MS + 1_000)
        expect(r.macAsked.map((m) => m.payload?.name)).toEqual([])
        expect(r.followerAsked).toEqual([])
      } finally {
        r.awake(false)
        r.mac.close(); r.follower.close()
      }
    }, 120_000)
  })
}
