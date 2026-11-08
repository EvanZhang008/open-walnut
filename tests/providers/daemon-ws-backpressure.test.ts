/**
 * REGRESSION: daemon WebSocket sends must survive backpressure.
 *
 * Root cause (found 2026-07-06, live-probed against prod daemon): Bun's
 * ServerWebSocket.send() returns 0 and PERMANENTLY DROPS the message once the
 * socket's backpressure buffer is saturated (a single 28MB fs.read response of
 * a big session JSONL is enough). daemon-standalone.ts wrapped every send in
 * `try { ws.send(...) } catch {}` — ignoring the return value — so while a
 * large response was in flight on the shared per-host connection:
 *   - concurrent fs.read/fs.stat RPC replies vanished (walnut timed out after
 *     30s → "JSONL read via daemon failed" → history failed to load),
 *   - live `jsonl` stream events for OTHER sessions were silently lost
 *     (UI: frozen streaming, stale Running state until a refresh).
 * Live probe: 6 concurrent fs.read → 1 response delivered, 5 dropped forever.
 *
 * The fix: all daemon sends go through a per-socket FIFO queue that detects
 * the dropped-send case (send() === 0), requeues, and flushes on `drain`.
 *
 * What's real: the actual compiled daemon binary (dist/daemon-binaries),
 * a real WebSocket, real multi-MB files. What's mocked: nothing — no Claude
 * CLI involved, fs.read doesn't need a session.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFailed } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { DIST_DAEMON_BINARY } from '../helpers/cloud-box-daemon-build'

const BINARY = DIST_DAEMON_BINARY

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-bp-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-bp-data-'))

// Two large files comparable to real session JSONLs (prod repro used 28MB).
const BIG_A = path.join(DATA_DIR, 'big-a.jsonl')
const BIG_B = path.join(DATA_DIR, 'big-b.jsonl')
const SMALL = path.join(DATA_DIR, 'small.jsonl')

// This machine's own build (a Linux checkout that cross-built darwin-arm64 gets ENOEXEC from it, 2026-11-07).
const hasBinary = fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

let daemonPid: number | null = null
let port = 0

/**
 * Wait until the daemon has written a port number (the file is created empty before its
 * write, so its existence alone is not the port), or fail as soon as the daemon exits.
 * Bounded by the hook's own timeout, never by a shorter clock of its own.
 */
function daemonReady(proc: ChildProcess): Promise<{ port: number; pid: number }> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => { if (!done) { done = true; clearInterval(poll); fn() } }
    proc.once('error', (err) => finish(() => reject(err)))
    proc.once('exit', (code, signal) => finish(() => reject(new Error(`daemon exited before it wrote its port (code ${code}, signal ${signal})`))))
    const poll = setInterval(() => {
      let text = ''
      try { text = fs.readFileSync(PORT_FILE, 'utf-8').trim() } catch { return }
      const port = Number(text)
      if (!Number.isInteger(port) || port <= 0) return
      const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim())
      finish(() => resolve({ port, pid }))
    }, 25)
  })
}

d('daemon ws backpressure (real binary)', () => {
  beforeAll(async () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(1024) }] } }) + '\n'
    const chunk = line.repeat(1024) // ~1MB
    for (const f of [BIG_A, BIG_B]) {
      const fd = fs.openSync(f, 'w')
      for (let i = 0; i < 25; i++) fs.writeSync(fd, chunk) // ~25MB each
      fs.closeSync(fd)
    }
    fs.writeFileSync(SMALL, line)

    // Spawn the real daemon binary against an isolated dir (never /tmp/open-walnut).
    const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR }
    delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
    const proc = spawn(BINARY, ['--start'], { detached: true, stdio: 'ignore', env })
    proc.unref()
    const ready = await daemonReady(proc)
    port = ready.port
    daemonPid = ready.pid
  }, 30_000)

  afterAll(() => {
    if (daemonPid && daemonPid > 1) {
      try { process.kill(daemonPid, 'SIGTERM') } catch {}
    }
    try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(`${DAEMON_DIR}-streams`, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  })

  it('delivers ALL responses when concurrent large fs.reads saturate the socket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 512 * 1024 * 1024 })
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })

    // The prod repro: multiple concurrent reads on ONE socket. Before the fix,
    // only the first large response survived; everything sent while the buffer
    // was saturated (including small fs.stat replies) returned 0 and vanished.
    const reads: Array<{ id: number; cmd: string; path: string }> = [
      { id: 1, cmd: 'fs.read', path: BIG_A },
      { id: 2, cmd: 'fs.read', path: BIG_B },
      { id: 3, cmd: 'fs.read', path: BIG_A },
      { id: 4, cmd: 'fs.read', path: BIG_B },
      { id: 5, cmd: 'fs.read', path: SMALL },
      { id: 6, cmd: 'fs.stat', path: SMALL },
    ]
    const received = new Map<number, number>() // id → byte length

    const done = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer | string) => {
        const raw = typeof data === 'string' ? data : data.toString()
        try {
          const msg = JSON.parse(raw) as { id?: number; ok?: boolean }
          if (typeof msg.id === 'number') {
            expect(msg.ok).toBe(true)
            received.set(msg.id, raw.length)
            if (received.size === reads.length) resolve()
          }
        } catch { /* non-RPC frame */ }
      })
    })

    for (const r of reads) {
      ws.send(JSON.stringify(r.cmd === 'fs.stat'
        ? { id: r.id, cmd: 'fs.stat', path: r.path }
        : { id: r.id, cmd: 'fs.read', path: r.path, encoding: 'utf-8' }))
    }

    // Before the fix this never resolves: 5 of 6 responses are dropped. Bounded by the test's
    // own timeout, not a shorter clock: ~100 MB through one socket is slow on a loaded host.
    onTestFailed(() => {
      console.error(`only ${received.size}/${reads.length} responses arrived: ids=[${[...received.keys()].sort()}]`)
    })
    await done

    ws.close()
    expect(received.size).toBe(reads.length)
    // Large responses really were large (not error stubs).
    expect(received.get(1)!).toBeGreaterThan(20 * 1024 * 1024)
    expect(received.get(2)!).toBeGreaterThan(20 * 1024 * 1024)
  }, 60_000)
})
