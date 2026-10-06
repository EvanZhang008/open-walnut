/**
 * BOTH real daemon twins under the 5-minute self-heal burst: its bridge uplink
 * never has more than the high-water mark on the wire unconfirmed, cuts big
 * frames once the peer asks, acks mobile-event truthfully, answers
 * bridge.status, and logs one `bridge-conn-open` / `bridge-conn-close` pair per
 * connection with the documented fields.
 *
 * Each twin is spawned as a child process: the daemon-source template under
 * node, and the Bun twin (daemon-standalone.ts) compiled from THIS source when
 * bun is installed (skipped otherwise; the dist binary would test whatever was
 * last built, not the code under review). The twins are kept in sync by hand
 * (CLAUDE.md), and a static ratchet cannot tell a live ack from a dead one, so
 * the same behavior is asserted on both. Each dials a fake
 * cloud WebSocket server that behaves like a replica: it asks for 256KB chunks
 * (`bridge.peer`), as replicas did before 2026-10-05 (a current one asks for
 * 64KB), and the daemon cuts to 64KB anyway, its marker spacing. The cloud
 * reassembles the chunks and answers every `bridge-ping` marker with a `ping`
 * RPC echoing its `seq` after a short delay.
 * The cloud side measures, from its own view, how many bytes it has received
 * beyond its last confirmation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const HOST_ALIAS = 'uplink-e2e-host'
const HWM = 1024 * 1024
const MiB = 1024 * 1024
/** What the fake cloud asks the daemon to cut frames to, and what the daemon cuts to. */
const ASKED_CHUNK = 256 * 1024
const CUT_CHUNK = 64 * 1024
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

/** bun, looked up where scripts/build-daemon.sh looks; null when absent. */
function findBun(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'bun')
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* next */ }
  }
  return null
}

/** Compile the Bun twin from the source under test (not the dist binary, which is whatever was built last). */
function buildBunDaemon(bun: string, outDir: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `daemon-${process.platform}-${process.arch}`)
  return new Promise((resolve, reject) => {
    execFile(bun, [
      'build', '--compile', `--target=bun-${process.platform}-${process.arch}`, '--minify',
      '--outfile', out, 'src/providers/daemon-standalone.ts',
    ], { cwd: REPO_ROOT, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`bun build of the daemon failed: ${stderr || err.message}`))
      else resolve(out)
    })
  })
}

const BUN = findBun()

let workDir: string
let scriptPath: string
let bunDaemon: string | null = null
let daemonDir: string

async function spawnDaemon(cmd: string, args: string[]): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(cmd, [...args, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  return { proc, port }
}

async function stopDaemon(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} resolve() }, 3000)
    proc.once('exit', () => { clearTimeout(t); resolve() })
  })
}

function connectCtl(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

let rpcId = 100
function rpc(ws: WebSocket, cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), 15_000)
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, cmd, ...params }))
  })
}

interface Cloud {
  port: number
  hello: Record<string, unknown> | null
  events: Array<{ kind: string; data: unknown }>
  maxFrameBytes: number
  worstUnconfirmed: number
  chunkFrames: number
  peerReply: Record<string, unknown> | null
  close: () => Promise<void>
  dropSocket: () => void
}

async function startCloud(): Promise<Cloud> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.on('listening', r))
  const addr = wss.address()
  const cloud: Cloud = {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    hello: null, events: [], maxFrameBytes: 0, worstUnconfirmed: 0, chunkFrames: 0, peerReply: null,
    close: () => new Promise((r) => { for (const c of wss.clients) { try { c.close() } catch {} } wss.close(() => r()) }),
    dropSocket: () => { for (const c of wss.clients) c.close(1000, 'test drop') },
  }
  wss.on('connection', (ws) => {
    let received = 0
    let confirmed = 0
    let nextId = 9000
    const parts = new Map<string, string[]>()
    const handle = (raw: string): void => {
      const msg = JSON.parse(raw) as Record<string, unknown>
      if (msg.ev === 'hello') {
        cloud.hello = msg
        if (msg.uplink === 1) ws.send(JSON.stringify({ id: ++nextId, cmd: 'bridge.peer', chunkBytes: ASKED_CHUNK }))
      } else if (msg.ev === 'bridge-ping') {
        const covered = received
        setTimeout(() => {
          confirmed = Math.max(confirmed, covered)
          ws.send(JSON.stringify({ id: ++nextId, cmd: 'ping', ackSeq: msg.seq }))
        }, 30)
      } else if (msg.ev === 'chunk') {
        cloud.chunkFrames++
        const list = parts.get(msg.cid as string) ?? []
        list[msg.i as number] = msg.part as string
        parts.set(msg.cid as string, list)
        if (list.filter((p) => p !== undefined).length === msg.n) { parts.delete(msg.cid as string); handle(list.join('')) }
      } else if (msg.ev === 'mobile-event') {
        cloud.events.push({ kind: msg.kind as string, data: msg.data })
      } else if (typeof msg.id === 'number' && msg.id > 9000 && 'chunkBytes' in msg) {
        cloud.peerReply = msg
      }
    }
    ws.on('message', (data: Buffer) => {
      received += data.length
      cloud.maxFrameBytes = Math.max(cloud.maxFrameBytes, data.length)
      cloud.worstUnconfirmed = Math.max(cloud.worstUnconfirmed, received - confirmed)
      handle(data.toString())
    })
  })
  return cloud
}

async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function daemonLog(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const f of fs.readdirSync(daemonDir)) {
    if (!/^daemon-.*\.log$/.test(f)) continue
    for (const line of fs.readFileSync(path.join(daemonDir, f), 'utf-8').split('\n')) {
      if (line.trim()) { try { out.push(JSON.parse(line)) } catch { /* partial */ } }
    }
  }
  return out
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-uplink-e2e-'))
  scriptPath = path.join(workDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  if (BUN) bunDaemon = await buildBunDaemon(BUN, path.join(workDir, 'bun'))
}, 240_000)

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

const twins: Array<{ name: string; skip: boolean; command: () => [string, string[]] }> = [
  { name: 'source twin (node)', skip: false, command: () => ['node', [scriptPath]] },
  { name: 'Bun twin, compiled from this source', skip: !BUN, command: () => [bunDaemon!, []] },
]

describe.each(twins)('daemon bridge uplink: $name', ({ skip, command }) => {
  it.skipIf(skip)('a 2MB self-heal burst stays under the high-water mark, arrives whole and in order, and is logged per connection', async () => {
    daemonDir = fs.mkdtempSync(path.join(workDir, 'dir-'))
    const cloud = await startCloud()
    const [cmd, args] = command()
    const { proc, port } = await spawnDaemon(cmd, args)
    const ctl = await connectCtl(port)
    try {
      await rpc(ctl, 'bridge.configure', {
        enabled: true, url: `ws://127.0.0.1:${cloud.port}/bridge`, token: 't', hostAlias: HOST_ALIAS,
      })
      await waitFor(() => cloud.hello !== null && cloud.peerReply !== null)
      expect(cloud.hello?.uplink).toBe(1)
      expect(typeof cloud.hello?.connId).toBe('string')
      expect(cloud.peerReply).toMatchObject({ ok: true, chunkBytes: CUT_CHUNK })

      const status = await rpc(ctl, 'bridge.status')
      expect(status).toMatchObject({ ok: true, connected: true, connId: cloud.hello?.connId })

      const burst: Array<{ kind: string; data: unknown }> = [
        { kind: 'projection-upsert', data: { which: 'tasks', data: { tasks: '{"id":"t","title":"a task"},'.repeat(1.5 * MiB / 26) } } },
        { kind: 'projection-upsert', data: { which: 'sessions', data: { sessions: 's'.repeat(158 * 1024) } } },
        ...Array.from({ length: 10 }, (_, i) => ({ kind: 'transcript-upsert', data: { sid: `sid-${i}`, data: String(i).repeat(35 * 1024) } })),
      ]
      // Fired back to back, as the old sweep did.
      const acks = await Promise.all(burst.map((b) => rpc(ctl, 'mobile-event', b)))
      expect(acks.every((a) => a.ok === true && a.relayed === true && a.connId === cloud.hello?.connId)).toBe(true)
      expect(acks.some((a) => a.queued === true)).toBe(true)

      await waitFor(() => cloud.events.length === burst.length)
      expect(cloud.events).toEqual(burst)
      expect(cloud.worstUnconfirmed).toBeLessThanOrEqual(HWM)
      expect(cloud.maxFrameBytes).toBeLessThanOrEqual(CUT_CHUNK)
      expect(cloud.chunkFrames).toBeGreaterThan(20)

      // Close from the cloud side: one close line with the documented fields.
      cloud.dropSocket()
      await waitFor(() => daemonLog().some((l) => l.msg === 'bridge-conn-close'))
      const open = daemonLog().find((l) => l.msg === 'bridge-conn-open')
      const close = daemonLog().find((l) => l.msg === 'bridge-conn-close')!
      expect(open).toMatchObject({ connId: cloud.hello?.connId })
      expect(typeof open?.dialMs).toBe('number')
      expect(close).toMatchObject({ connId: cloud.hello?.connId, code: 1000, reason: 'test drop', maxOutFrameKind: 'chunk' })
      for (const field of [
        'uptimeMs', 'bytesIn', 'bytesOut', 'framesIn', 'framesOut', 'maxOutFrameBytes', 'bufferedAmountPeak',
        'bufferedAmountAtClose', 'lastInboundAgeMs', 'rttMsP50', 'rttMsMax', 'loopDriftMax60sMs', 'loopDriftMax5sMs',
      ]) {
        expect(typeof close[field], field).toBe('number')
      }
      expect(close).toHaveProperty('wasClean')
      expect(close).toHaveProperty('lastError')
      expect(close.bytesOut as number).toBeGreaterThan(1.9 * MiB)
      expect(close.bufferedAmountPeak as number).toBeLessThanOrEqual(HWM)
      expect(close.maxOutFrameBytes as number).toBeLessThanOrEqual(CUT_CHUNK)
      expect(close.rttMsP50 as number).toBeGreaterThanOrEqual(25)
      // Every marker was confirmed by a ping: none had to fail open.
      expect(close.ackTimeouts).toBe(0)
    } finally {
      try { ctl.close() } catch { /* closed */ }
      await stopDaemon(proc)
      await cloud.close()
    }
  }, 90_000)
})
