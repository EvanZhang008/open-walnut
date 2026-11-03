/**
 * A `walnut` call survives a server restart and a link that breaks, on the real
 * daemon twins (the JS source twin under node, the standalone twin under bun when
 * bun is installed).
 *
 * 2026-11-03: a deploy restarted the Mac's server, then the SSH link to clouddev
 * broke six times in eight minutes. Every call in between failed: with no server
 * at once (hub_unreachable), and on a link that broke or stalled after waiting the
 * full 20 s (hub_timeout), because a reply lost with its socket was never asked
 * for again. Now a call waits for a server within the time its CLI gives it, and a
 * relay whose socket closed (or whose answer did not come in time) goes again, but
 * only to the same server run, which answers a call it sees twice once. A read the
 * server names read-only in its hello (`readOps`) may go to the next run as well:
 * later that day a `host_list` sent 0.3 s before a deploy stopped the server was
 * never sent to the next one and ended hub_timeout after 90 s.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths and the
 * daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
const sockets: WebSocket[] = []
let rpcId = 1
let daemonDir = ''
/** One attempt's wait, short so a test sees a resend in a second or two. */
const ATTEMPT_MS = 1500

async function boot(twin: Twin): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wrs-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: String(ATTEMPT_MS),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
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

/** A server's socket: open it and say hello, naming the server run when there is one (an older server names none) and its read-only ops. */
async function connect(port: number, run?: string, readOps?: string[]): Promise<{ ws: WebSocket; requests: Array<Record<string, unknown>>; hello: Record<string, unknown> }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const requests: Array<Record<string, unknown>> = []
  ws.on('message', (data: Buffer) => {
    try { const m = JSON.parse(data.toString()) as Record<string, unknown>; if (m.ev === 'gateway-request') requests.push(m) } catch { /* not a frame */ }
  })
  const reply = await rpc(ws, { cmd: 'hello', ...(run ? { run } : {}), ...(readOps ? { readOps } : {}) })
  expect(reply.ok).toBe(true)
  return { ws, requests, hello: reply }
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/**
 * An env-less `walnut tools call`, one NDJSON line on the gateway socket; `waitMs` as a
 * newer CLI sends it. With `lingerMs` the socket stays open that long after the first
 * answer, and `lines` counts every answer line the daemon wrote by then.
 */
function externalCall(waitMs?: number, lingerMs = 0, op = 'task_send'): Promise<{ resp: Record<string, unknown>; ms: number; lines: number }> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(daemonDir, 'agent-gateway.sock'))
    let buf = ''
    let first: { resp: Record<string, unknown>; ms: number } | null = null
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('gateway timeout')) }, 60_000)
    const done = () => { sock.destroy(); resolve({ ...first!, lines: buf.split('\n').filter(Boolean).length }) }
    sock.on('connect', () => sock.write(JSON.stringify({
      v: 1, op: 'tools.call', sid: 'external', args: { name: op, args: {} }, ...(waitMs ? { waitMs } : {}),
    }) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1 || first) return
      clearTimeout(timer)
      first = { resp: JSON.parse(buf.slice(0, nl)) as Record<string, unknown>, ms: Date.now() - t0 }
      if (lingerMs > 0) setTimeout(done, lingerMs)
      else done()
    })
    sock.on('close', () => { if (first) return; clearTimeout(timer); reject(new Error('gateway socket closed with no answer')) })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

async function answer(ws: WebSocket, relayId: unknown, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  return rpc(ws, { cmd: 'gateway-result', relayId, result })
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-resend-twins-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

for (const twin of TWINS) {
  describe(`a walnut call across a server restart and a broken link, ${twin.name}`, () => {
    it('with no server, the call waits for one and goes when it says hello', async () => {
      const port = await boot(twin)
      const call = externalCall(20_000)
      await new Promise((r) => setTimeout(r, 1_200))
      const server = await connect(port, 'run-a')
      expect(await waitFor(() => server.requests.length > 0)).toBe(true)
      // The relay names its daemon process: the server runs (instance, relayId) once.
      expect(typeof server.hello.instanceId).toBe('string')
      expect(server.requests[0].instanceId).toBe(server.hello.instanceId)
      expect((await answer(server.ws, server.requests[0].relayId, { sent: true })).ok).toBe(true)
      const { resp, ms } = await call
      expect(resp).toEqual({ ok: true, result: { sent: true } })
      expect(ms).toBeGreaterThanOrEqual(1_000)
    }, 90_000)

    it('a call waiting for a server when the daemon stops is told so, not cut off', async () => {
      await boot(twin)
      const call = externalCall(20_000)
      await new Promise((r) => setTimeout(r, 800))
      proc!.kill('SIGTERM')
      const { resp, ms } = await call
      expect(resp).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
      expect(String((resp.error as { message?: unknown }).message)).toMatch(/restarting; nothing was sent/)
      expect(ms).toBeLessThan(10_000)
    }, 90_000)

    it('its socket closes before the answer: it goes again to the same run, and that answer counts', async () => {
      const port = await boot(twin)
      const first = await connect(port, 'run-a')
      const call = externalCall(20_000)
      expect(await waitFor(() => first.requests.length === 1)).toBe(true)
      const relayId = first.requests[0].relayId
      // The same server dials again (its second socket, or its new link) and the old one goes.
      const second = await connect(port, 'run-a')
      first.ws.terminate()
      expect(await waitFor(() => second.requests.length === 1)).toBe(true)
      expect(second.requests[0].relayId).toBe(relayId)
      expect((await answer(second.ws, relayId, { sent: true })).ok).toBe(true)
      expect((await call).resp).toEqual({ ok: true, result: { sent: true } })
    }, 90_000)

    it('no answer in time on a live socket: sent again there, never twice to the CLI', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const call = externalCall(20_000, 1_500)
      expect(await waitFor(() => server.requests.length === 2, ATTEMPT_MS * 3)).toBe(true)
      expect(server.requests[1].relayId).toBe(server.requests[0].relayId)
      expect((await answer(server.ws, server.requests[0].relayId, { sent: true })).ok).toBe(true)
      // A late answer to the same relay (the resend's) is stale, and nothing more reaches the CLI.
      const late = await answer(server.ws, server.requests[0].relayId, { sent: 'again' })
      expect(late).toMatchObject({ ok: true, stale: true })
      const { resp, lines } = await call
      expect(resp).toEqual({ ok: true, result: { sent: true } })
      expect(lines).toBe(1)
    }, 90_000)

    it('a server of another run never gets a call that may change something; it ends hub_timeout', async () => {
      const port = await boot(twin)
      const first = await connect(port, 'run-a')
      const call = externalCall(9_000)
      expect(await waitFor(() => first.requests.length === 1)).toBe(true)
      first.ws.terminate()
      const restarted = await connect(port, 'run-b')
      const { resp, ms } = await call
      expect(restarted.requests).toEqual([])
      expect(resp).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
      expect(ms).toBeLessThan(9_000 + 2_000)
    }, 90_000)

    it('a read the next run names read-only goes to it, and that answer counts', async () => {
      const port = await boot(twin)
      const first = await connect(port, 'run-a', ['host_list', 'task_get'])
      const call = externalCall(20_000, 1_500, 'host_list')
      expect(await waitFor(() => first.requests.length === 1)).toBe(true)
      const relayId = first.requests[0].relayId
      // The deploy stops the server with the call in flight; the next run says hello.
      first.ws.terminate()
      await new Promise((r) => setTimeout(r, 300))
      const restarted = await connect(port, 'run-b', ['host_list', 'task_get'])
      expect(await waitFor(() => restarted.requests.length === 1)).toBe(true)
      expect(restarted.requests[0].relayId).toBe(relayId)
      expect((await answer(restarted.ws, relayId, { hosts: [] })).ok).toBe(true)
      // The old run's late answer is stale, and the CLI hears one answer.
      expect(await answer(restarted.ws, relayId, { hosts: ['late'] })).toMatchObject({ ok: true, stale: true })
      const { resp, lines } = await call
      expect(resp).toEqual({ ok: true, result: { hosts: [] } })
      expect(lines).toBe(1)
    }, 90_000)

    it('a hello that names no run (a diagnostic probe) on the next run\'s socket keeps its list', async () => {
      const port = await boot(twin)
      const first = await connect(port, 'run-a', ['host_list'])
      const call = externalCall(20_000, 0, 'host_list')
      expect(await waitFor(() => first.requests.length === 1)).toBe(true)
      const restarted = await connect(port, 'run-b', ['host_list'])
      expect((await rpc(restarted.ws, { cmd: 'hello' })).ok).toBe(true)
      first.ws.terminate()
      expect(await waitFor(() => restarted.requests.length === 1)).toBe(true)
      expect((await answer(restarted.ws, restarted.requests[0].relayId, { hosts: [] })).ok).toBe(true)
      expect((await call).resp).toEqual({ ok: true, result: { hosts: [] } })
    }, 90_000)

    it('only the next run\'s own list counts: a read it does not name, or a call that may change something, never goes there', async () => {
      for (const [op, nextReads] of [['host_list', undefined], ['task_send', ['host_list', 'task_send_x']]] as const) {
        const port = await boot(twin)
        const first = await connect(port, 'run-a', ['host_list'])
        const call = externalCall(9_000, 0, op)
        expect(await waitFor(() => first.requests.length === 1), op).toBe(true)
        first.ws.terminate()
        const restarted = await connect(port, 'run-b', nextReads ? [...nextReads] : undefined)
        const { resp } = await call
        expect(restarted.requests, op).toEqual([])
        expect(resp, op).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
        for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
        proc!.kill('SIGKILL')
        await new Promise<void>((resolve) => proc!.once('exit', () => resolve()))
        fs.rmSync(root, { recursive: true, force: true })
      }
    }, 120_000)

    it('an older server (no run in its hello) never gets a call twice', async () => {
      const port = await boot(twin)
      const server = await connect(port)
      const call = externalCall(9_000)
      const { resp, ms } = await call
      expect(server.requests.length).toBe(1)
      expect(resp).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
      // It ends when it always did (the hub timeout), not at the end of the CLI's 9 s.
      expect(ms).toBeLessThan(ATTEMPT_MS + 1_500)
    }, 90_000)

    it('a caller that names no waitMs is answered as before: one relay, the hub timeout, and no server is at once', async () => {
      const port = await boot(twin)
      const alone = await externalCall()
      expect(alone.resp).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
      expect(alone.ms).toBeLessThan(1_000)
      const server = await connect(port, 'run-a')
      const { resp, ms } = await externalCall()
      expect(resp).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
      expect(ms).toBeLessThan(ATTEMPT_MS + 1_000)
      expect(server.requests.length).toBe(1)
    }, 90_000)

    it('a caller that names no waitMs still goes again when its socket closes inside the hub timeout', async () => {
      const port = await boot(twin)
      const first = await connect(port, 'run-a')
      const call = externalCall()
      expect(await waitFor(() => first.requests.length === 1)).toBe(true)
      const second = await connect(port, 'run-a')
      first.ws.terminate()
      expect(await waitFor(() => second.requests.length === 1, ATTEMPT_MS)).toBe(true)
      expect((await answer(second.ws, second.requests[0].relayId, { sent: true })).ok).toBe(true)
      expect((await call).resp).toEqual({ ok: true, result: { sent: true } })
    }, 90_000)
  })
}

describe('every relay of a walnut call has an end (both twins, read from the source)', () => {
  // 2026-11-03 review: a plugin job's relay passed no deadline, so its attempt timer was
  // NaN, fired at once and answered hub_timeout while the server ran the op.
  for (const [name, src] of [['standalone', () => fs.readFileSync(STANDALONE, 'utf8')], ['source', () => getDaemonSource()]] as const) {
    it(`${name}: every relayToPrimary call names its deadline`, () => {
      const calls = src().split('\n').filter((l) => /\brelayToPrimary\(/.test(l) && !/function relayToPrimary\(/.test(l))
      expect(calls.length).toBeGreaterThanOrEqual(4)
      for (const line of calls) expect(line, line.trim()).toMatch(/, (deadline|Date\.now\(\) \+ (gatewayHubTimeoutMs\(\)|GATEWAY_HUB_TIMEOUT_MS))\);?\s*$/)
    })
  }
})
