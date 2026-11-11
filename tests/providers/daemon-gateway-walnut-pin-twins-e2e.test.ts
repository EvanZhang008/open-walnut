/**
 * A session's `walnut` call never reaches another Walnut's server, on the real daemon
 * twins (the JS source twin, and the standalone twin under bun when bun is installed).
 *
 * 2026-11-10 (a Mac shared by two people's Walnuts): the first person's link to the
 * daemon dropped three times in ten minutes. Each time, the gateway's fallback to "any
 * trusted client that never identified itself" sent that person's sessions' calls,
 * first calls and resends alike, to the other person's Walnut: its bulk socket, which
 * opens beside its main socket and names no Walnut. Reads there answered "No task
 * found"; a write that names no id would have landed in the wrong Walnut.
 *
 * Here Walnut B stays connected the whole time (its main socket bound, its bulk socket
 * naming only its server run) beside an older server's socket that names nothing, while
 * Walnut A's link drops again and again: closed at once on some rounds, stalled (it
 * stops answering pings until it goes quiet) on the others, each time coming back as a
 * new server run. Calls from A's session are made before, during and after every drop;
 * calls from B's session go on throughout. Every relay frame any socket received is
 * recorded, and the test fails if one of A's calls ever reached a socket of B or the
 * nameless one, or if B's server could settle one of A's calls.
 *
 * MACHINE SAFETY: HOME, the daemon dir, the streams dir and the spawn journal are temp
 * paths under /tmp (a unix socket path is at most 104 bytes on macOS); the only
 * processes signalled are the daemon and the stand-in CLIs this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
let scriptPath = ''
let cliPath = ''
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

/** The daemon's beat to its server sockets: quiet after 3, closed after 8. */
const BEAT = 400
/** One relay attempt's wait. */
const ATTEMPT_MS = 1200
const HOME_A = '/home/alice/.open-walnut'
const HOME_B = '/home/bob/.open-walnut'
const ROUNDS = 4

// The stand-in CLI: says init and stays (a session the daemon tracks).
const FAKE_CLI = `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

type Frame = Record<string, any>
interface Sock { name: string; walnut: 'A' | 'B' | 'none'; ws: WebSocket; requests: Frame[]; pinger?: ReturnType<typeof setInterval> }

let root = ''
let daemonDir = ''
let proc: ChildProcess | null = null
const socks: Sock[] = []
const sids: string[] = []
let rpcId = 1

function walnutIdOf(home: string): string {
  return `w${crypto.createHash('sha1').update(home).digest('hex').slice(0, 12)}`
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Frame> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Frame
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function boot(twin: Twin): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wgp-'))
  daemonDir = path.join(root, 'd')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 's'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: String(ATTEMPT_MS),
    WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'agent-gateway.sock')), 30_000)).toBe(true)
  return port
}

/**
 * A server socket: says hello (naming `run` when given), binds `home` when given, and
 * answers the daemon's pings until `stall` (autoPong off, so a stalled link says nothing).
 */
async function open(port: number, name: string, walnut: Sock['walnut'], run?: string, home?: string, binds = true): Promise<Sock> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false })
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  const s: Sock = { name, walnut, ws, requests: [] }
  ws.on('ping', (data) => { if (s.pinger !== undefined) { try { ws.pong(data) } catch { /* closed */ } } })
  ws.on('message', (data: Buffer) => {
    try { const m = JSON.parse(data.toString()) as Frame; if (m.ev === 'gateway-request') s.requests.push(m) } catch { /* not a frame */ }
  })
  // A live server is heard every beat: a frame of its own keeps it fresh.
  s.pinger = setInterval(() => { try { ws.send(JSON.stringify({ id: rpcId++, cmd: 'ping' })) } catch { /* closed */ } }, Math.round(BEAT / 2))
  socks.push(s)
  // A server of today names its run and says it binds; an older one names neither.
  expect((await rpc(ws, { cmd: 'hello', ...(run ? { run, ...(binds ? { binds: true } : {}) } : {}) })).ok).toBe(true)
  if (home) {
    const r = await rpc(ws, { cmd: 'leader.configure', home, walnutId: walnutIdOf(home), backup: false })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
  return s
}

/** The link stalls: nothing more from this socket, not even a pong. */
function stall(s: Sock): void {
  clearInterval(s.pinger)
  s.pinger = undefined
}
function cut(s: Sock): void {
  stall(s)
  try { s.ws.terminate() } catch { /* closed */ }
}

async function startSession(via: Sock, home: string): Promise<string> {
  const sid = crypto.randomUUID()
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"`
  const r = await rpc(via.ws, {
    cmd: 'start', sid, cwd: root, message: '', resume: true, mode: 'default',
    origin: { home }, args: ['/bin/sh', '-c', sh, 'sh', '--resume', sid],
  })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  sids.push(sid)
  return sid
}

/** One gateway line naming the session (as its CLI's `walnut` would), with the time its CLI gives it. */
function call(sid: string, op: string, waitMs: number): Promise<Frame> {
  return new Promise((resolve) => {
    const sock = net.connect(path.join(daemonDir, 'agent-gateway.sock'))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, error: { code: 'test_timeout' } }) }, waitMs + 15_000)
    sock.on('connect', () => sock.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: op, args: { title: 'x' } }, waitMs }) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      sock.destroy()
      resolve(JSON.parse(buf.slice(0, nl)) as Frame)
    })
    sock.on('error', () => { clearTimeout(timer); resolve({ ok: false, error: { code: 'socket_error' } }) })
  })
}

/** An env-less `walnut` (the user's own terminal): no session. */
function external(op: string, waitMs: number): Promise<Frame> {
  return call('external', op, waitMs)
}

/** Answer every relay a socket of `walnut` holds, from that socket; returns how many. */
async function answerAll(walnut: 'A' | 'B', done: Set<unknown>): Promise<number> {
  let n = 0
  for (const s of socks) {
    // A stalled link says nothing, an answer included.
    if (s.walnut !== walnut || s.ws.readyState !== WebSocket.OPEN || s.pinger === undefined) continue
    for (const r of s.requests) {
      if (done.has(r.relayId)) continue
      done.add(r.relayId)
      void rpc(s.ws, { cmd: 'gateway-result', relayId: r.relayId, result: { from: walnut, sid: r.callerSid } }, 5_000).catch(() => undefined)
      n += 1
    }
  }
  return n
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gateway-pin-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  const live = socks.find((s) => s.ws.readyState === WebSocket.OPEN)
  for (const sid of sids.splice(0)) if (live) await rpc(live.ws, { cmd: 'stop', sid }, 10_000).catch(() => undefined)
  for (const s of socks.splice(0)) { clearInterval(s.pinger); try { s.ws.terminate() } catch { /* closed */ } }
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

for (const twin of TWINS) {
  describe(`a session's call stays with its own Walnut, ${twin.name}`, () => {
    it('A\'s link drops again and again beside B and a nameless server: none of A\'s calls reach them', async () => {
      const port = await boot(twin)
      // Walnut B: its main socket bound, its bulk socket naming only its run (as a real server's does).
      const mainB = await open(port, 'mainB', 'B', 'run-b', HOME_B)
      await open(port, 'bulkB', 'B', 'run-b')
      // An older server that names no Walnut and no run.
      await open(port, 'legacy', 'none')
      let mainA = await open(port, 'mainA-0', 'A', 'run-a-0', HOME_A)
      let bulkA = await open(port, 'bulkA-0', 'A', 'run-a-0')
      const sidA = await startSession(mainA, HOME_A)
      const sidB = await startSession(mainB, HOME_B)
      const answered = new Set<unknown>()
      const pending: Array<Promise<Frame>> = []
      const answers = setInterval(() => { void answerAll('A', answered); void answerAll('B', answered) }, 100)
      try {
        // Before any drop: both sessions' calls are answered by their own Walnut.
        expect(await call(sidA, 'task_create', 8_000)).toMatchObject({ ok: true, result: { from: 'A', sid: sidA } })
        expect(await call(sidB, 'task_create', 8_000)).toMatchObject({ ok: true, result: { from: 'B', sid: sidB } })

        for (let round = 1; round <= ROUNDS; round++) {
          const stalls = round % 2 === 1
          // A call in flight when the link goes (a resend's turn comes while it is down).
          pending.push(call(sidA, round % 2 ? 'task_create' : 'task_get', 5_000))
          await sleep(50)
          if (stalls) { stall(mainA); stall(bulkA) } else { cut(mainA); cut(bulkA) }
          // Calls while A is going quiet and while it is gone, reads and writes.
          for (let i = 0; i < 3; i++) {
            pending.push(call(sidA, i % 2 ? 'task_get' : 'note_write', 4_000))
            pending.push(call(sidB, 'task_create', 4_000))
            await sleep(stalls ? BEAT * 2 : BEAT)
          }
          // Long enough for A to read quiet (3 beats) and, when stalled, be closed (8 beats).
          await sleep(stalls ? BEAT * 10 : BEAT * 3)
          // A comes back as a new server run.
          mainA = await open(port, `mainA-${round}`, 'A', `run-a-${round}`, HOME_A)
          bulkA = await open(port, `bulkA-${round}`, 'A', `run-a-${round}`)
          await sleep(BEAT)
        }

        // B's server tries to settle a call of A's: refused, and A's own answer goes through.
        await sleep(300)
        clearInterval(answers)
        await answerAll('A', answered)
        const before = new Set([...mainA.requests, ...bulkA.requests].map((r) => r.relayId))
        const held = call(sidA, 'task_create', 8_000)
        const fresh = () => [...mainA.requests, ...bulkA.requests].filter((r) => !before.has(r.relayId))
        expect(await waitFor(() => fresh().length > 0)).toBe(true)
        const relay = fresh()[0]!
        const stolen = await rpc(mainB.ws, { cmd: 'gateway-result', relayId: relay.relayId, result: { from: 'B' } })
        expect(stolen).toMatchObject({ ok: false })
        expect((await rpc(mainA.ws, { cmd: 'gateway-result', relayId: relay.relayId, result: { from: 'A', sid: sidA } })).ok).toBe(true)
        expect(await held).toMatchObject({ ok: true, result: { from: 'A' } })

        const results = await Promise.all(pending)
        // Every frame any socket got: A's calls only ever on A's sockets, B's only on B's.
        const wrong: string[] = []
        let onA = 0
        for (const s of socks) {
          for (const r of s.requests) {
            if (r.callerSid === sidA && s.walnut !== 'A') wrong.push(`${s.name} got A's relay ${r.relayId} (${r.payload?.name})`)
            if (r.callerSid === sidB && s.walnut !== 'B') wrong.push(`${s.name} got B's relay ${r.relayId}`)
            if (r.callerSid === sidA && s.walnut === 'A') onA += 1
          }
        }
        expect(wrong).toEqual([])
        expect(onA).toBeGreaterThanOrEqual(ROUNDS)
        // A's calls end answered by A, or with an error that says nothing was answered for it.
        for (const r of results) {
          if (r.ok) expect(r.result.from === 'A' || r.result.sid === sidB).toBe(true)
          else expect(['hub_unreachable', 'hub_timeout']).toContain(r.error?.code)
        }
        // B was never interrupted: every one of its calls answered by B.
        const bAnswers = results.filter((r) => r.ok && r.result.sid === sidB)
        expect(bAnswers.length).toBe(ROUNDS * 3)
        expect(bAnswers.every((r) => r.result.from === 'B')).toBe(true)
      } finally {
        clearInterval(answers)
      }
    }, 180_000)

    it('an older Walnut that never names itself: its call never reaches a new server between its hello and its bind', async () => {
      const port = await boot(twin)
      const legacy = await open(port, 'legacyB', 'B')
      const sidB = await startSession(legacy, HOME_B)
      cut(legacy)
      await sleep(BEAT)
      // A new server's socket says hello; its leader.configure has not come yet.
      const mainA = await open(port, 'mainA', 'A', 'run-a')
      const pendingCall = call(sidB, 'task_create', 20_000)
      await sleep(600)
      expect(mainA.requests).toEqual([])
      // Bound now: it speaks for A, never for B.
      expect((await rpc(mainA.ws, { cmd: 'leader.configure', home: HOME_A, walnutId: walnutIdOf(HOME_A), backup: false })).ok).toBe(true)
      await sleep(600)
      expect(mainA.requests).toEqual([])
      // B's own (older) server comes back: the call goes there.
      const back = await open(port, 'legacyB-2', 'B')
      expect(await waitFor(() => back.requests.length > 0)).toBe(true)
      expect(back.requests[0]!.callerSid).toBe(sidB)
      expect((await rpc(back.ws, { cmd: 'gateway-result', relayId: back.requests[0]!.relayId, result: { from: 'B' } })).ok).toBe(true)
      expect(await pendingCall).toMatchObject({ ok: true, result: { from: 'B' } })
      expect(mainA.requests).toEqual([])
    }, 60_000)

    it('an older server that names its run but never binds still gets its own session\'s calls at once', async () => {
      const port = await boot(twin)
      const old = await open(port, 'oldB', 'B', 'run-old', undefined, false)
      const sidB = await startSession(old, HOME_B)
      const pendingCall = call(sidB, 'task_create', 4_000)
      expect(await waitFor(() => old.requests.length > 0, 3_000)).toBe(true)
      expect((await rpc(old.ws, { cmd: 'gateway-result', relayId: old.requests[0]!.relayId, result: { from: 'B' } })).ok).toBe(true)
      expect(await pendingCall).toMatchObject({ ok: true, result: { from: 'B' } })
    }, 60_000)

    it('a call from outside any session goes to the one Walnut connected, and to none when two are', async () => {
      const port = await boot(twin)
      const mainA = await open(port, 'mainA', 'A', 'run-a', HOME_A)
      const bulkA = await open(port, 'bulkA', 'A', 'run-a')
      const one = external('task_list', 4_000)
      expect(await waitFor(() => mainA.requests.length > 0)).toBe(true)
      expect(bulkA.requests).toEqual([])
      expect((await rpc(mainA.ws, { cmd: 'gateway-result', relayId: mainA.requests[0]!.relayId, result: { from: 'A' } })).ok).toBe(true)
      expect(await one).toMatchObject({ ok: true, result: { from: 'A' } })
      // A second Walnut on the host: nothing says which one the terminal means.
      const mainB = await open(port, 'mainB', 'B', 'run-b', HOME_B)
      const bulkB = await open(port, 'bulkB', 'B', 'run-b')
      const two = await external('task_list', 1_000)
      expect(two).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
      expect(mainA.requests).toHaveLength(1)
      expect([...mainB.requests, ...bulkB.requests, ...bulkA.requests]).toEqual([])
    }, 60_000)

    it('with no server of its Walnut connected, the call fails at once, retryable, naming why', async () => {
      const port = await boot(twin)
      const mainA = await open(port, 'mainA', 'A', 'run-a', HOME_A)
      await open(port, 'mainB', 'B', 'run-b', HOME_B)
      await open(port, 'bulkB', 'B', 'run-b')
      const sidA = await startSession(mainA, HOME_A)
      cut(mainA)
      expect(await waitFor(() => mainA.ws.readyState === WebSocket.CLOSED)).toBe(true)
      const r = await call(sidA, 'task_create', 1_000)
      expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
      expect(String(r.error.message)).toMatch(/another Walnut's server on this host was not asked\); nothing was sent, try again/)
      expect(socks.filter((s) => s.walnut === 'B').every((s) => s.requests.length === 0)).toBe(true)
    }, 60_000)
  })
}
