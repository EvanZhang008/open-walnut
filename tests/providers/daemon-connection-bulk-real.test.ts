/**
 * HIGH-FIDELITY bulk-channel tests against the REAL compiled daemon binary.
 *
 * The protocol contract is pinned by daemon-connection-bulk-channel.test.ts
 * (MockDaemon). This file covers what a mock can't:
 *
 *   R1 — the bulk channel establishes against the real daemon (real hello /
 *        instanceId path, real Bun ws server), and a mixed concurrent burst
 *        (fs.read / fs.readRange / fs.stat / fs.ls) through the SHARED
 *        pendingCommands map resolves every response with the RIGHT payload —
 *        no id cross-wiring under concurrency.
 *
 *   R2 — the head-of-line-blocking claim itself. A throttled TCP proxy
 *        emulates the slow SSH-tunnel link (per-connection pacing ≈ SSH
 *        channel lanes). With big fs.reads in flight:
 *          - single socket (bulk closed): small fs.stat replies queue behind
 *            multi-MB frames → hundreds of ms.
 *          - dual socket: small replies ride the idle main lane → fast.
 *        This is the reason the feature exists; assert it, don't assume it.
 *
 * What's real: the compiled daemon binary, real WebSockets, real multi-MB
 * files, a real DaemonConnection (connectDirect). What's mocked: nothing —
 * no Claude CLI involved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'

const ROOT = path.resolve(__dirname, '../..')
const BINARY = path.join(ROOT, 'dist', 'daemon-binaries', 'daemon-darwin-arm64')

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bulk-real-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bulk-real-data-'))

const BIG = path.join(DATA_DIR, 'big.jsonl')       // ~6MB — HOL payload
const MED = path.join(DATA_DIR, 'medium.jsonl')    // ~2MB — stress payload
const SMALL = path.join(DATA_DIR, 'small.jsonl')

const hasBinary = fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

let daemonPid: number | null = null
let daemonPort = 0

async function waitFor(cond: () => boolean, ms: number, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!cond()) throw new Error(`timed out waiting for ${label}`)
}

/**
 * Throttled TCP proxy — emulates the SSH tunnel's constrained link. The
 * daemon→client direction is paced per TCP connection (64KB chunks with a
 * fixed delay ≈ 8MB/s), like SSH giving each forwarded channel its own lane.
 * A multi-MB response frame therefore genuinely OCCUPIES its lane for
 * hundreds of ms — which is what makes HOL blocking measurable and what the
 * bulk channel is for. Client→daemon (small commands) is unpaced.
 */
function startThrottledProxy(targetPort: number): Promise<{ port: number; close: () => void }> {
  const CHUNK = 64 * 1024
  const DELAY_MS = 8 // 64KB / 8ms ≈ 8MB/s per connection
  const sockets = new Set<net.Socket>()

  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort })
    sockets.add(client); sockets.add(upstream)
    client.pipe(upstream) // client→daemon: unpaced

    // daemon→client: paced drain queue
    const queue: Buffer[] = []
    let draining = false
    const drain = () => {
      if (queue.length === 0) { draining = false; upstream.resume(); return }
      draining = true
      const chunk = queue.shift()!
      if (!client.destroyed) client.write(chunk)
      setTimeout(drain, DELAY_MS)
    }
    upstream.on('data', (data: Buffer) => {
      for (let i = 0; i < data.length; i += CHUNK) queue.push(data.subarray(i, i + CHUNK))
      // Crude backpressure so a burst can't buffer unboundedly.
      if (queue.length > 2048) upstream.pause()
      if (!draining) drain()
    })
    const kill = () => { try { client.destroy() } catch {}; try { upstream.destroy() } catch {} }
    upstream.on('close', () => { if (queue.length === 0) kill() })
    upstream.on('error', kill)
    client.on('close', kill)
    client.on('error', kill)
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr !== 'object' || !addr) return reject(new Error('no proxy port'))
      resolve({
        port: addr.port,
        close: () => {
          for (const s of sockets) { try { s.destroy() } catch {} }
          server.close()
        },
      })
    })
    server.on('error', reject)
  })
}

d('bulk channel against the real daemon binary', () => {
  beforeAll(async () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(1024) }] } }) + '\n'
    const chunk = line.repeat(1024) // ~1MB
    const writeMB = (file: string, mb: number) => {
      const fd = fs.openSync(file, 'w')
      for (let i = 0; i < mb; i++) fs.writeSync(fd, chunk)
      fs.closeSync(fd)
    }
    writeMB(BIG, 6)
    writeMB(MED, 2)
    fs.writeFileSync(SMALL, line)

    // Spawn the real daemon binary against an isolated dir (never /tmp/open-walnut).
    const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR }
    delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
    const proc = spawn(BINARY, ['--start'], { detached: true, stdio: 'ignore', env })
    proc.unref()

    await waitFor(() => fs.existsSync(PORT_FILE), 10_000, 'daemon port file')
    daemonPort = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    daemonPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
  }, 30_000)

  afterAll(() => {
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM') } catch {}
    }
    try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(`${DAEMON_DIR}-streams`, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  })

  // R1 — concurrency stress: 40 mixed commands, every payload verified.
  it('R1: concurrent mixed burst resolves every response with the right payload (no id cross-wiring)', async () => {
    const conn = new DaemonConnection('bulk-real-stress', TARGET)
    try {
      await conn.connectDirect(`ws://127.0.0.1:${daemonPort}`)
      await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel (real daemon)')

      const medBytes = fs.readFileSync(MED)
      const smallText = fs.readFileSync(SMALL, 'utf-8')
      const tasks: Array<Promise<void>> = []

      // 12 × fs.read (bulk lane) — verify exact content round-trip.
      for (let i = 0; i < 6; i++) {
        tasks.push(conn.send('fs.read', { path: MED, encoding: 'utf-8' }, 60_000).then((r) => {
          expect(r.ok).toBe(true)
          expect((r.data as string).length).toBe(medBytes.length)
        }))
        tasks.push(conn.send('fs.read', { path: SMALL, encoding: 'utf-8' }, 60_000).then((r) => {
          expect(r.ok).toBe(true)
          expect(r.data).toBe(smallText)
        }))
      }
      // 12 × fs.readRange (bulk lane) — DISTINCT windows; byte-exact compare
      // proves response id→payload pairing survives concurrency.
      for (let i = 0; i < 12; i++) {
        const start = i * 4096
        const length = 2048 + i // distinct lengths too
        tasks.push(conn.send('fs.readRange', { path: MED, start, length }, 60_000).then((r) => {
          expect(r.ok).toBe(true)
          const got = Buffer.from(r.data as string, 'base64')
          expect(got.equals(medBytes.subarray(start, start + length))).toBe(true)
        }))
      }
      // 8 × fs.stat + 8 × fs.ls (main lane, interleaved with the bulk flood).
      for (let i = 0; i < 8; i++) {
        tasks.push(conn.send('fs.stat', { path: i % 2 ? MED : SMALL }).then((r) => {
          expect(r.ok).toBe(true)
          expect(r.size).toBe(i % 2 ? medBytes.length : Buffer.byteLength(smallText))
        }))
        tasks.push(conn.send('fs.ls', { path: DATA_DIR }).then((r) => {
          expect(r.ok).toBe(true)
          const names = (r.entries as Array<{ name: string }>).map((e) => e.name)
          expect(names).toContain('big.jsonl')
        }))
      }

      await Promise.all(tasks)
      // The channel survived the burst (didn't silently degrade to main).
      expect(conn.bulkChannelActive).toBe(true)
    } finally {
      conn.disconnect()
    }
  }, 60_000)

  // R2 — the HOL-blocking A/B over a throttled link. THE core claim.
  it('R2: on a slow link, small commands stay fast while big reads are in flight (vs single socket)', async () => {
    const proxy = await startThrottledProxy(daemonPort)
    const conn = new DaemonConnection('bulk-real-hol', TARGET)
    try {
      await conn.connectDirect(`ws://127.0.0.1:${proxy.port}`)
      await waitFor(() => conn.bulkChannelActive, 5_000, 'bulk channel (via proxy)')

      // One measurement pass: fire 3 big reads (unawaited), then sequentially
      // time 6 small fs.stat commands while the frames drain through the
      // paced lane (~750ms per 6MB frame at 8MB/s).
      const measure = async () => {
        const bigReads = Array.from({ length: 3 }, () =>
          conn.send('fs.read', { path: BIG, encoding: 'utf-8' }, 60_000))
        await new Promise((r) => setTimeout(r, 150)) // let frames start flowing
        const statMs: number[] = []
        for (let i = 0; i < 6; i++) {
          const t0 = Date.now()
          const r = await conn.send('fs.stat', { path: SMALL }, 30_000)
          statMs.push(Date.now() - t0)
          expect(r.ok).toBe(true)
        }
        const reads = await Promise.all(bigReads)
        for (const r of reads) expect(r.ok).toBe(true)
        statMs.sort((a, b) => a - b)
        return { median: statMs[Math.floor(statMs.length / 2)], max: statMs[statMs.length - 1] }
      }

      const dual = await measure()

      // Baseline: same link, bulk channel closed → everything shares one socket.
      ;(conn as unknown as { closeBulkChannel: () => void }).closeBulkChannel()
      expect(conn.bulkChannelActive).toBe(false)
      const single = await measure()

      // Surface the magnitudes — future regressions show up as a shrinking gap.
      console.log(`[bulk-real HOL A/B] dual: median=${dual.median}ms max=${dual.max}ms | single: median=${single.median}ms max=${single.max}ms`)

      // Single socket: stats queue behind ~6MB frames on an 8MB/s lane —
      // hundreds of ms. Dual socket: main lane is idle — order(ms), noise
      // ceiling 400ms (client-side JSON.parse of big frames still blocks the
      // shared event loop briefly; that hit exists in both variants).
      expect(single.max).toBeGreaterThan(500)
      expect(dual.median).toBeLessThan(400)
      expect(single.max).toBeGreaterThan(dual.median * 3)
    } finally {
      conn.disconnect()
      proxy.close()
    }
  }, 60_000)
})
