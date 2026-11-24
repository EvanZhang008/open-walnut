/**
 * fs-read-range-gz-v1 on a REAL standalone daemon: `fs.readRange {gz: true}` answers a
 * range of 16 KB or more as `dataGz`, byte-exact once unpacked; without `gz`, or for a short
 * range, `data` as before. 2026-11-20: older pages of large transcripts on one dev host
 * moved their 4 MB windows over the tunnel as plain base64, and 8 at a time took over 15 s.
 *
 * What's real: the daemon process (daemon-standalone.ts under bun, when bun is installed) and
 * its WS. Every daemon is killed by the pid it wrote into its own temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')

const BUN: string | undefined = testBun()

interface Daemon { proc: ChildProcess; dir: string; port: number; sock: string; pid: number }

function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for ' + label))
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function spawnDaemon(): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-range-gz-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '2000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  const portFile = path.join(dir, 'daemon.port')
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, 'the daemon')
  return {
    proc, dir, sock,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

function stopDaemon(d: Daemon): void {
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let nextId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, timeoutMs)
    const on = (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', on); resolve(msg) }
      } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply.data && typeof reply.data === 'object' ? reply.data : reply) as Record<string, unknown>
}

it('advertises fs-read-range-gz-v1', () => {
  expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('fs-read-range-gz-v1')
})

describe.skipIf(!BUN)('fs.readRange gz on the real standalone daemon', () => {
  let d: Daemon
  let ws: WebSocket
  let file: string
  let bytes: Buffer

  beforeAll(async () => {
    d = await spawnDaemon()
    ws = await connectWs(d.port)
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"step \\u597d done"}]},"timestamp":"2026-11-20T16:00:00.000Z"}\n'
    bytes = Buffer.from(line.repeat(4000), 'utf8')
    file = path.join(d.dir, 'session.jsonl')
    fs.writeFileSync(file, bytes)
  }, 60_000)

  afterAll(() => {
    try { ws?.close() } catch { /* closed */ }
    if (d) { stopDaemon(d); fs.rmSync(d.dir, { recursive: true, force: true }) }
  })

  it('a range asked with gz comes as dataGz, the same bytes once unpacked', async () => {
    const r = data(await cmd(ws, { cmd: 'fs.readRange', path: file, start: 1000, length: 200_000, gz: true }))
    expect(r.data).toBeUndefined()
    expect(typeof r.dataGz).toBe('string')
    const out = zlib.gunzipSync(Buffer.from(r.dataGz as string, 'base64'))
    expect(out.equals(bytes.subarray(1000, 201_000))).toBe(true)
    expect(r.bytesRead).toBe(200_000)
    expect((r.dataGz as string).length).toBeLessThan(200_000 / 4)
  })

  it('without gz, and for a short range, the answer is data as before', async () => {
    const plain = data(await cmd(ws, { cmd: 'fs.readRange', path: file, start: 0, length: 200_000 }))
    expect(plain.dataGz).toBeUndefined()
    expect(Buffer.from(plain.data as string, 'base64').equals(bytes.subarray(0, 200_000))).toBe(true)
    const short = data(await cmd(ws, { cmd: 'fs.readRange', path: file, start: 0, length: 4096, gz: true }))
    expect(short.dataGz).toBeUndefined()
    expect(Buffer.from(short.data as string, 'base64').equals(bytes.subarray(0, 4096))).toBe(true)
  })

  it('the end of the file still says eof, gzipped or not', async () => {
    const r = data(await cmd(ws, { cmd: 'fs.readRange', path: file, start: bytes.length - 50_000, length: 200_000, gz: true }))
    expect(r.eof).toBe(true)
    expect(zlib.gunzipSync(Buffer.from(r.dataGz as string, 'base64')).equals(bytes.subarray(bytes.length - 50_000))).toBe(true)
  })
})
