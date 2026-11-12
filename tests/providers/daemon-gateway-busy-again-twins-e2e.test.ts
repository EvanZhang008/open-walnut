/**
 * A `walnut tools call host_exec` the server refuses as busy is asked again by the host's
 * gateway, on the real daemon twins (the JS source twin under node, the standalone twin under
 * bun when bun is installed).
 *
 * 2026-11-04: a session on clouddev ran 12 host_exec at once against one host. The server runs 4
 * per task; a relayed call at the cap waits only about 4 s for a slot (half of what its answer
 * time leaves), so 4 of the 12 were refused though each command took 2 s. A busy refusal comes
 * before anything starts, so the gateway now sends the call again as a NEW relay (the server
 * answers a relay id it saw with the same refusal) while the call's own time allows; when it
 * does not, the refusal is the answer, as before.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths and the daemon is
 * SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import zlib from 'node:zlib'
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
/**
 * The hub timeout. A resend must still have max(8 s, this) of its call (busyRelayMinLeftMs), so
 * any value up to 8 s tests the same rule; 5 s leaves a loaded machine room to answer a relay
 * before the daemon sends that same relay again.
 */
const ATTEMPT_MS = 5000
const BUSY = 'Walnut API error (busy): This task already runs 4 commands on other hosts, and no slot came free in time for this call; nothing ran. '
  + 'Wait for one (host_exec_read) or stop one (host_exec_stop), then run it again.'
const ARGS = { host: 'macbox', command: 'sleep 2; echo done', job_id: 'hx-burst-0001' }

async function boot(twin: Twin): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wba-')))
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

type Relay = Record<string, unknown> & { relayId: number; at: number; payload: { name: string; args: Record<string, unknown> } }

/** A server's socket: open it and say hello with its run; every relay it is sent, with when. */
async function connect(port: number, run: string): Promise<{ ws: WebSocket; requests: Relay[] }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const requests: Relay[] = []
  ws.on('message', (data: Buffer) => {
    try {
      const m = JSON.parse(data.toString()) as Relay
      if (m.ev === 'gateway-request') requests.push({ ...m, at: Date.now() })
    } catch { /* not a frame */ }
  })
  expect((await rpc(ws, { cmd: 'hello', run })).ok).toBe(true)
  return { ws, requests }
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

/** An env-less `walnut tools call <op>`, one NDJSON line on the gateway socket; `waitMs` as a newer CLI sends it. */
function call(op: string, args: Record<string, unknown>, waitMs?: number): Promise<{ resp: Record<string, unknown>; ms: number; lines: number }> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(daemonDir, 'agent-gateway.sock'))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('gateway timeout')) }, 60_000)
    sock.on('connect', () => sock.write(JSON.stringify({
      v: 1, op: 'tools.call', sid: 'external', args: { name: op, args }, ...(waitMs ? { waitMs } : {}),
    }) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      const resp = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      const ms = Date.now() - t0
      // A moment more: a second answer line would be a bug.
      setTimeout(() => { sock.destroy(); resolve({ resp, ms, lines: buf.split('\n').filter(Boolean).length }) }, 300)
    })
    sock.on('close', () => { if (buf.includes('\n')) return; clearTimeout(timer); reject(new Error('gateway socket closed with no answer')) })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

const refuse = (ws: WebSocket, relayId: unknown, error = BUSY) => rpc(ws, { cmd: 'gateway-result', relayId, error, errorCode: 'internal' })
const answer = (ws: WebSocket, relayId: unknown, result: Record<string, unknown>) => rpc(ws, { cmd: 'gateway-result', relayId, result })

/** The relays a server got while a call was out: each one refused busy, as they come. */
function refuseEvery(server: { ws: WebSocket; requests: Relay[] }): () => void {
  let seen = 0
  const tick = setInterval(() => {
    while (seen < server.requests.length) void refuse(server.ws, server.requests[seen++].relayId)
  }, 20)
  return () => clearInterval(tick)
}

function daemonLog(): string {
  try {
    return fs.readdirSync(daemonDir).filter((f) => /^daemon-.*\.log$/.test(f)).map((f) => fs.readFileSync(path.join(daemonDir, f), 'utf8')).join('\n')
  } catch { return '' }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-busy-twins-src-'))
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
  describe(`a host_exec refused busy is asked again, ${twin.name}`, () => {
    it('a big answer sent gzipped (gateway-result-gz-v1) reaches the caller whole', async () => {
      // 2026-11-12: answers to a host's sessions were the top upload on its session link.
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const pending = call('task_history', { id: 'mtaskaaa-0001' }, 20_000)
      expect(await waitFor(() => server.requests.length === 1)).toBe(true)
      const result = { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: `row ${i} \u4e2d `.repeat(20) })) }
      const resultGz = zlib.gzipSync(Buffer.from(JSON.stringify(result))).toString('base64')
      expect(resultGz.length).toBeLessThan(JSON.stringify(result).length / 5)
      expect((await rpc(server.ws, { cmd: 'gateway-result', relayId: server.requests[0].relayId, resultGz })).ok).toBe(true)
      const { resp, lines } = await pending
      expect(resp).toEqual({ ok: true, result })
      expect(lines).toBe(1)
      // A resultGz that is not gzipped JSON is refused, and the relay stays open for a real answer.
      const next = call('task_history', { id: 'mtaskaaa-0002' }, 20_000)
      expect(await waitFor(() => server.requests.length === 2)).toBe(true)
      const relayId = server.requests[1].relayId
      expect((await rpc(server.ws, { cmd: 'gateway-result', relayId, resultGz: 'bm90IGd6aXA=' })).ok).toBe(false)
      expect((await answer(server.ws, relayId, { ok: 1 })).ok).toBe(true)
      expect((await next).resp).toEqual({ ok: true, result: { ok: 1 } })
    })

    it('refused busy, then asked again as a new relay a second later: the caller gets the run', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const pending = call('host_exec', ARGS, 20_000)
      expect(await waitFor(() => server.requests.length === 1)).toBe(true)
      const first = server.requests[0]
      expect(first.payload).toMatchObject({ name: 'host_exec', args: ARGS })
      expect((await refuse(server.ws, first.relayId)).ok).toBe(true)
      expect(await waitFor(() => server.requests.length === 2, 5_000)).toBe(true)
      const second = server.requests[1]
      // A NEW relay id: the server answers one it saw with the same refusal. The call is the
      // same, job_id included, so the run it starts is the one the caller names.
      expect(second.relayId).not.toBe(first.relayId)
      expect(second.instanceId).toBe(first.instanceId)
      expect(second.payload).toEqual(first.payload)
      expect(second.at - first.at).toBeGreaterThanOrEqual(900)
      // The daemon's own word beside the payload: this is an ask again (the server does not
      // charge it to the caller's write budget). The first ask carries none.
      expect(first.busyAgain).toBeUndefined()
      expect(second.busyAgain).toBe(1)
      // The refused relay is gone: a late word to it is stale.
      expect(await refuse(server.ws, first.relayId)).toMatchObject({ ok: true, stale: true })
      const run = { host: 'macbox', jobId: ARGS.job_id, running: false, exitCode: 0, output: 'done\n' }
      expect((await answer(server.ws, second.relayId, run)).ok).toBe(true)
      const { resp, lines } = await pending
      expect(resp).toEqual({ ok: true, result: run })
      expect(lines).toBe(1)
      expect(server.requests.length).toBe(2)
      expect(await waitFor(() => /gateway: host_exec waits for a slot; asking again/.test(daemonLog()), 3_000)).toBe(true)
      const said = daemonLog().split('\n').find((l) => l.includes('waits for a slot; asking again')) ?? ''
      expect(said).toContain(`"relayId":${first.relayId}`)
      expect(said).toContain(`"next":${second.relayId}`)
      expect(said).toContain('"callerSid":"external"')
      expect(said).toContain('"attempt":1')
    }, 90_000)

    it('a call with too little of its time left gets the refusal, as before', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      // A newer CLI's shortest call (8 s: GATEWAY_MIN_RELAY_MS), and one that names no waitMs
      // (one hub timeout in all): neither has a resend's minimum after the pause.
      for (const waitMs of [8_000, undefined]) {
        const before = server.requests.length
        const pending = call('host_exec', ARGS, waitMs)
        expect(await waitFor(() => server.requests.length === before + 1), String(waitMs)).toBe(true)
        expect((await refuse(server.ws, server.requests[before].relayId)).ok).toBe(true)
        const { resp, ms, lines } = await pending
        expect(resp, String(waitMs)).toEqual({ ok: false, error: { code: 'internal', message: BUSY } })
        expect(ms, String(waitMs)).toBeLessThan(1_000)
        expect(lines).toBe(1)
        expect(server.requests.length, String(waitMs)).toBe(before + 1)
      }
    }, 90_000)

    it('asked again while the call has time; then the refusal is the answer, once', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const stop = refuseEvery(server)
      try {
        // 12 s, refused at once each time: resends at about 1, 2 and 3 s, then 12 - 4.x s
        // would leave a resend less than 8 s, so the fourth refusal is handed back.
        const { resp, ms, lines } = await call('host_exec', ARGS, 12_000)
        expect(resp).toEqual({ ok: false, error: { code: 'internal', message: BUSY } })
        expect(lines).toBe(1)
        expect(ms).toBeGreaterThanOrEqual(2_700)
        expect(ms).toBeLessThan(12_000 - 8_000 + 1_500)
        const ids = server.requests.map((r) => r.relayId)
        expect(ids.length).toBeGreaterThanOrEqual(3)
        expect(ids.length).toBeLessThanOrEqual(5)
        expect(new Set(ids).size).toBe(ids.length)
        expect(server.requests.map((r) => r.busyAgain)).toEqual([undefined, ...ids.slice(1).map((_, i) => i + 1)])
      } finally { stop() }
      // One line per resend, counting up.
      const attempts = () => daemonLog().split('\n').filter((l) => l.includes('waits for a slot; asking again')).map((l) => /"attempt":(\d+)/.exec(l)?.[1])
      expect(await waitFor(() => attempts().length === server.requests.length - 1, 3_000)).toBe(true)
      expect(attempts()).toEqual(server.requests.slice(1).map((_, i) => String(i + 1)))
    }, 90_000)

    it('only a busy host_exec: another op\'s busy and host_exec\'s other refusals are handed back at once', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['host_copy', { from_host: 'macbox', from: '/tmp/a', to: '/tmp/a' }, 'Walnut API error (busy): This task already copies 2 files between hosts; wait for one (host_copy_result).'],
        ['host_exec', ARGS, 'Walnut API error (host_offline): Walnut lost macbox while it answered. It may have started there as job hx-burst-0001: read it with host_exec_read before running it again.'],
      ]
      for (const [op, args, error] of cases) {
        const before = server.requests.length
        const pending = call(op, args, 20_000)
        expect(await waitFor(() => server.requests.length === before + 1), op).toBe(true)
        expect((await refuse(server.ws, server.requests[before].relayId, error)).ok).toBe(true)
        const { resp, ms } = await pending
        expect(resp, op).toEqual({ ok: false, error: { code: 'internal', message: error } })
        expect(ms, op).toBeLessThan(1_000)
        // Nothing more went out for it.
        await new Promise((r) => setTimeout(r, 1_500))
        expect(server.requests.length, op).toBe(before + 1)
      }
    }, 90_000)

    it('no server when it is due: it waits for one, and goes to the one that says hello', async () => {
      const port = await boot(twin)
      const first = await connect(port, 'run-a')
      const pending = call('host_exec', ARGS, 20_000)
      expect(await waitFor(() => first.requests.length === 1)).toBe(true)
      expect((await refuse(first.ws, first.requests[0].relayId)).ok).toBe(true)
      // The server goes away inside the pause (a deploy's restart) and the next run says hello later.
      first.ws.terminate()
      await new Promise((r) => setTimeout(r, 2_000))
      const next = await connect(port, 'run-b')
      expect(await waitFor(() => next.requests.length === 1, 5_000)).toBe(true)
      // A new relay, so the next run may take it: nothing of it ran anywhere.
      expect(next.requests[0].relayId).not.toBe(first.requests[0].relayId)
      expect(next.requests[0].payload).toEqual(first.requests[0].payload)
      expect((await answer(next.ws, next.requests[0].relayId, { jobId: ARGS.job_id, running: true })).ok).toBe(true)
      expect((await pending).resp).toEqual({ ok: true, result: { jobId: ARGS.job_id, running: true } })
    }, 90_000)

    it('a caller that left (its walnut was stopped) is not asked for again', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const sock = net.connect(path.join(daemonDir, 'agent-gateway.sock'))
      await new Promise<void>((resolve, reject) => { sock.once('connect', () => resolve()); sock.once('error', reject) })
      sock.write(JSON.stringify({ v: 1, op: 'tools.call', sid: 'external', args: { name: 'host_exec', args: ARGS }, waitMs: 20_000 }) + '\n')
      expect(await waitFor(() => server.requests.length === 1)).toBe(true)
      // Gone before the refusal: nobody would read a run started now.
      sock.destroy()
      await new Promise((r) => setTimeout(r, 200))
      expect((await refuse(server.ws, server.requests[0].relayId)).ok).toBe(true)
      expect(await waitFor(() => /busy call not asked again, its caller left/.test(daemonLog()), 5_000)).toBe(true)
      await new Promise((r) => setTimeout(r, 1_000))
      expect(server.requests.length).toBe(1)
    }, 90_000)

    it('the daemon stops inside the pause: the call is told nothing was sent, not cut off', async () => {
      const port = await boot(twin)
      const server = await connect(port, 'run-a')
      const pending = call('host_exec', ARGS, 20_000)
      expect(await waitFor(() => server.requests.length === 1)).toBe(true)
      expect((await refuse(server.ws, server.requests[0].relayId)).ok).toBe(true)
      proc!.kill('SIGTERM')
      const { resp, ms } = await pending
      expect(resp).toMatchObject({ ok: false, error: { code: 'hub_unreachable', detail: { stopping: true } } })
      expect(String((resp.error as { message?: unknown }).message)).toMatch(/restarting; nothing was sent/)
      expect(ms).toBeLessThan(10_000)
    }, 90_000)
  })
}
