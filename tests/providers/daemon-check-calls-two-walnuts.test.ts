/**
 * A trigger check's `walnut` calls on a host whose daemon serves two Walnuts, on the real daemon.
 *
 *   server A (ws, bound HOME_A) ◄═gateway-request═╗
 *   server B (ws, bound HOME_B) ◄═gateway-request═╣ daemon ◄─ check's tools.call (WALNUT_CHECK_TOKEN)
 *                                                 ╚════════ ◄─ an outside `walnut` (sid external)
 *
 * 2026-11-25, a shared host: every check's call went out as `external`, which names no Walnut
 * while two are connected (gateway-identity-core.ts externalOwner), so no socket could take it.
 * It logged "gateway: no server connected, waiting for one" and waited its 90 s; the check's CLI
 * gave up after about 12 s and the trigger never saw an answer. Now the run carries the Walnut
 * whose trigger it is (CheckCaller.home, set by the daemon when it mints the run), and an outside
 * call that names no Walnut on such a host is told so at once (`unknown_caller`). Covered:
 * - a test run asked by A's server, and an armed trigger of B's, each reach only their own server,
 *   within a few seconds, with their triggerCaller;
 * - an outside call with both connected: `unknown_caller` at once, sent to nobody;
 * - after B leaves, its copy is still held here, so an outside call still names no Walnut;
 * - a host only one Walnut ever used relays an outside call to it, as before.
 *
 * What's real: the daemon (daemon-standalone.ts under bun), its gateway socket, a check script.
 * What's mocked: the two Walnut servers (WebSockets that hello, push a copy and answer relays).
 * MACHINE SAFETY: HOME, the daemon dir and the streams dirs are temp paths under /tmp (a unix
 * socket path is at most 104 bytes on macOS); only the daemons this file started are signalled
 * (trigger-daemon.ts, their own process groups).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { TRIGGER_BUN as BUN, TriggerDaemon, killTriggerDaemons, waitFor } from '../helpers/trigger-daemon.js'

// The check: one gateway call as `walnut tools call` makes it over WALNUT_CHECK_SOCKET with its
// token, waiting as the CLI does (waitMs); it writes the answer and how long it took, then its verdict.
const CHECK = `
const net = require('net'), fs = require('fs')
const out = process.argv[2]
const started = Date.now()
const s = net.connect(process.env.WALNUT_CHECK_SOCKET)
let buf = ''
const finish = (answer) => {
  fs.writeFileSync(out, JSON.stringify({ sid: process.env.WALNUT_CHECK_TOKEN || null, answer, ms: Date.now() - started }))
  console.log(JSON.stringify({ fire: false }))
  process.exit(0)
}
s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: process.env.WALNUT_CHECK_TOKEN, waitMs: 90000, args: { name: 'host_exec_read', args: { host: 'h', job_id: 'hx-two-walnuts' } } }) + '\\n'))
s.on('data', (c) => { buf += c; const nl = buf.indexOf('\\n'); if (nl >= 0) { s.destroy(); finish(JSON.parse(buf.slice(0, nl))) } })
s.on('error', (e) => finish({ socketError: String(e) }))
setTimeout(() => finish({ cut: true }), 12000)
`

/** A check's call must reach its server well inside the 12 s the CLI gives it (the old code waited 90 s). */
const ARRIVES_MS = 5_000

/** One Walnut server's socket: its RPCs, the relays it got, each answered at once as a server would. */
class WalnutServer {
  requests: Array<Record<string, any>> = []
  private nextId = 1
  private waiters = new Map<number, (reply: Record<string, unknown>) => void>()
  private constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, any>
      if (msg.ev === 'gateway-request') {
        this.requests.push(msg)
        this.ws.send(JSON.stringify({ id: this.nextId++, cmd: 'gateway-result', relayId: msg.relayId, result: { ok: true, from: this.label } }))
        return
      }
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (waiter) { this.waiters.delete(msg.id); waiter(msg) }
    })
  }
  label = ''

  /** Connects, says hello as its own server run and binds its Walnut with a copy, as a server does. */
  static async connect(port: number, label: string, home: string): Promise<WalnutServer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
    const s = new WalnutServer(ws)
    s.label = label
    expect(await s.rpc({ cmd: 'hello', run: `run-${label}` }), `${label} hello`).toMatchObject({ ok: true })
    const slice = { v: 1, home, hash: `copy-${label}`, asOf: Date.now(), host: 'h', sessions: [], tasks: [], requests: [] }
    expect(await s.rpc({ cmd: 'host.slice', slice }), `${label} binds ${home}`).toMatchObject({ ok: true })
    return s
  }

  rpc(frame: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, any>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`rpc ${String(frame.cmd)} timed out`)) }, timeoutMs)
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id, ...frame }))
    })
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise((res) => { this.ws.once('close', () => res()); this.ws.close() })
  }
}

let root = ''
let checkPath = ''
const servers: WalnutServer[] = []

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wcc2w-'))
  checkPath = path.join(root, 'check.cjs')
  fs.writeFileSync(checkPath, CHECK)
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  killTriggerDaemons()
})

afterAll(() => {
  if (root.startsWith('/tmp/wcc2w-')) fs.rmSync(root, { recursive: true, force: true })
})

/** A daemon in its own temp dirs; resolves once its gateway socket listens. */
async function startDaemon(label: string): Promise<{ daemon: TriggerDaemon; port: number; sock: string; dir: string }> {
  const dir = path.join(root, label)
  const runDir = path.join(dir, 'd')
  const home = path.join(dir, 'h')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string> = {
    HOME: home, PATH: guardedPath([], '/usr/bin:/bin'), SHELL: '/bin/sh', LANG: 'C', TMPDIR: dir,
    WALNUT_DAEMON_DIR: runDir, WALNUT_TRIGGER_STATE_DIR: path.join(dir, 'ts'),
    WALNUT_STREAMS_DIR: path.join(dir, 's'), WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'ls'),
    WALNUT_SPAWN_JOURNAL: path.join(home, 'spawn-journal.jsonl'), WALNUT_TRIGGER_REPLAY_MS: '600000',
  }
  const daemon = await TriggerDaemon.start('standalone', { mode: '--start', env, runDir, cwd: home })
  // The helper's own socket names no Walnut, and one that names none takes a call no Walnut owns
  // (gateway-identity-core.ts pick): closed, so only the two servers below are here.
  const helperWs = (daemon as unknown as { ws?: WebSocket }).ws
  if (!helperWs) throw new Error('trigger-daemon.ts no longer keeps its socket as `ws`: close it another way here')
  await new Promise<void>((res) => { helperWs.once('close', () => res()); helperWs.close() })
  const sock = path.join(runDir, 'agent-gateway.sock')
  await waitFor(() => (fs.existsSync(sock) ? true : undefined), 30_000, 'the gateway socket')
  const port = parseInt(fs.readFileSync(path.join(runDir, 'daemon.port'), 'utf8').trim(), 10)
  return { daemon, port, sock, dir }
}

async function server(port: number, label: string, home: string): Promise<WalnutServer> {
  const s = await WalnutServer.connect(port, label, home)
  servers.push(s)
  return s
}

/** A plain `walnut tools call` from outside any session (no token): its answer and how long it took. */
function outsideCall(sock: string, name: string, budgetMs = 10_000): Promise<{ answer: Record<string, any> | null; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const s = net.connect(sock)
    let buf = ''
    const done = (answer: Record<string, any> | null) => { clearTimeout(t); s.destroy(); resolve({ answer, ms: Date.now() - started }) }
    const t = setTimeout(() => done(null), budgetMs)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: 'external', waitMs: 90_000, args: { name, args: {} } }) + '\n'))
    s.on('data', (c) => { buf += c; const nl = buf.indexOf('\n'); if (nl >= 0) done(JSON.parse(buf.slice(0, nl))) })
    s.on('error', () => done(null))
  })
}

const named = (s: WalnutServer, name: string) => s.requests.filter((r) => r.payload?.name === name)
const checkRun = (out: string) => ({ run: `${JSON.stringify(process.execPath)} ${JSON.stringify(checkPath)} ${JSON.stringify(out)}`, timeoutSeconds: 30 })
const readOut = (out: string) => JSON.parse(fs.readFileSync(out, 'utf8')) as { sid: string | null; answer: Record<string, any>; ms: number }

describe.skipIf(!BUN)('a trigger check\'s calls on a host two Walnuts share', () => {
  it('each run\'s call goes to the server of its own Walnut, at once, and an outside call is told it names none', async () => {
    const { port, sock, dir } = await startDaemon('two')
    const HOME_A = path.join(dir, 'walnut-a')
    const HOME_B = path.join(dir, 'walnut-b')
    const a = await server(port, 'a', HOME_A)
    const b = await server(port, 'b', HOME_B)

    // 1. A test of A's trigger, asked by A's server for a task's session.
    const testOut = path.join(dir, 'test.json')
    const started = Date.now()
    const tested = await a.rpc({ cmd: 'triggers.test', home: HOME_A, check: checkRun(testOut), checkCaller: 'tt-twowalnutsA1234' })
    expect(tested.ok, JSON.stringify(tested)).toBe(true)
    expect(tested.result.ok, JSON.stringify(tested.result)).toBe(true)
    const test = readOut(testOut)
    expect(test.sid).toMatch(/^trigger-check:/)
    expect(test.answer, 'answered by A, not cut by the CLI\'s own time').toMatchObject({ ok: true, result: { from: 'a' } })
    expect(test.ms).toBeLessThan(ARRIVES_MS)
    expect(Date.now() - started).toBeLessThan(ARRIVES_MS + 3_000)
    expect(named(a, 'host_exec_read')).toHaveLength(1)
    const req = named(a, 'host_exec_read')[0]!
    // How long its caller still waits rides along, so the leader can tell a too-slow answer at once.
    expect(req.callerWaitsMs).toBeGreaterThan(0)
    expect(req.callerWaitsMs).toBeLessThanOrEqual(90_000)
    expect(req.callerSid).toBe('external')
    expect(req.payload.triggerCaller, 'the run\'s caller only; the home stays in the daemon').toEqual({ kind: 'test', id: 'tt-twowalnutsA1234' })
    expect(named(b, 'host_exec_read'), 'B never hears A\'s check').toHaveLength(0)

    // 2. An armed trigger of B's: its run's call goes to B only.
    const armedOut = path.join(dir, 'armed.json')
    const configured = await b.rpc({
      cmd: 'triggers.configure', home: HOME_B,
      config: { version: 1, triggers: [{ id: 'trg-b-watch', name: 'B watch', everyMs: 3_600_000, check: checkRun(armedOut) }] },
    })
    expect(configured, JSON.stringify(configured)).toMatchObject({ ok: true, count: 1 })
    const ran = await b.rpc({ cmd: 'triggers.run', triggerId: 'trg-b-watch', home: HOME_B })
    expect(ran.ok, JSON.stringify(ran)).toBe(true)
    const armedReq = await waitFor(() => named(b, 'host_exec_read')[0], ARRIVES_MS, 'B\'s armed check call on B')
    expect(armedReq.callerSid).toBe('external')
    expect(armedReq.payload.triggerCaller).toEqual({ kind: 'armed', id: 'trg-b-watch' })
    await waitFor(() => (fs.existsSync(armedOut) ? true : undefined), ARRIVES_MS, 'the armed check to finish')
    expect(readOut(armedOut).answer).toMatchObject({ ok: true, result: { from: 'b' } })
    expect(named(a, 'host_exec_read'), 'A never hears B\'s armed check').toHaveLength(1)

    // 3. A test from A's socket that names no home: the socket's trigger Walnut (its configure).
    expect(await a.rpc({ cmd: 'triggers.configure', home: HOME_A, config: { version: 1, triggers: [] } })).toMatchObject({ ok: true })
    const scopedOut = path.join(dir, 'scoped.json')
    const scoped = await a.rpc({ cmd: 'triggers.test', check: checkRun(scopedOut), checkCaller: 'tt-twowalnutsA5678' })
    expect(scoped.ok, JSON.stringify(scoped)).toBe(true)
    expect(readOut(scopedOut).answer).toMatchObject({ ok: true, result: { from: 'a' } })
    expect(named(a, 'host_exec_read').map((r) => r.payload.triggerCaller.id)).toEqual(['tt-twowalnutsA1234', 'tt-twowalnutsA5678'])
    expect(named(b, 'host_exec_read')).toHaveLength(1)

    // 4. An outside call names no Walnut while both are here: told at once, sent to nobody.
    const outside = await outsideCall(sock, 'task_list')
    expect(outside.answer, 'answered, not left waiting for a server').not.toBeNull()
    expect(outside.answer!.ok).toBe(false)
    expect(outside.answer!.error.code).toBe('unknown_caller')
    expect(outside.answer!.error.message).toMatch(/more than one Walnut/)
    expect(outside.ms).toBeLessThan(ARRIVES_MS)
    // Refused before any relay: nothing can reach a server after the answer.
    expect(named(a, 'task_list'), 'never sent to A').toHaveLength(0)
    expect(named(b, 'task_list'), 'never sent to B').toHaveLength(0)

    // 5. B leaves. Its copy stays on this host (its sessions may still run here), so an outside
    //    call still names no Walnut: told at once again, never relayed to A as if it were A's.
    await b.close()
    servers.splice(servers.indexOf(b), 1)
    const afterB = await outsideCall(sock, 'task_list')
    expect(afterB.answer?.error?.code, JSON.stringify(afterB.answer)).toBe('unknown_caller')
    expect(afterB.ms).toBeLessThan(ARRIVES_MS)
    expect(named(a, 'task_list')).toHaveLength(0)
    // A's own check still goes to A.
    const lastOut = path.join(dir, 'last.json')
    expect((await a.rpc({ cmd: 'triggers.test', home: HOME_A, check: checkRun(lastOut), checkCaller: 'tt-twowalnutsA9999' })).ok).toBe(true)
    expect(readOut(lastOut).answer).toMatchObject({ ok: true, result: { from: 'a' } })
  }, 120_000)

  it('on a host only one Walnut uses, an outside call still goes to its server', async () => {
    const { port, sock, dir } = await startDaemon('one')
    const a = await server(port, 'a', path.join(dir, 'walnut-a'))
    const outside = await outsideCall(sock, 'task_list')
    expect(outside.answer, JSON.stringify(outside.answer)).toMatchObject({ ok: true, result: { from: 'a' } })
    expect(outside.ms).toBeLessThan(ARRIVES_MS)
    expect(named(a, 'task_list')).toHaveLength(1)
    expect(named(a, 'task_list')[0]!.callerSid).toBe('external')
    expect(named(a, 'task_list')[0]!.payload.triggerCaller).toBeUndefined()
  }, 60_000)
})
