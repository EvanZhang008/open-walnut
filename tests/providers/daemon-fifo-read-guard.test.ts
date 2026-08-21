/**
 * REGRESSION: daemon fs.read / fs.readRange must never open a FIFO.
 *
 * Root cause (2026-08-15, prod local daemon): cmdFsRead called
 * fs.promises.readFile(path) with no file-type check. open() on a FIFO with no
 * writer blocks in the kernel FOREVER (never returns, not interruptible from
 * JS). Bun's fs thread pool has a fixed number of workers — each FIFO read
 * permanently wedged one, and once all were stuck in __openat_nocancel every
 * subsequent fs command (fs.stat of a 41-byte file included) timed out at the
 * 30s command deadline. Server symptom: 73× "Session file read timeout (30s)"
 * across every local session, history panels stuck on "Loading…".
 *
 * The fix: stat-before-open in both twins; non-regular files are refused with
 * ENOTFILE, which DaemonFileReader maps to null (same as ENOENT).
 *
 * What's real: the compiled daemon binary, a real WebSocket, a real mkfifo'd
 * FIFO. What's mocked: nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execSync } from 'node:child_process'
import { WebSocket } from 'ws'

const ROOT = path.resolve(__dirname, '../..')
const BINARY = path.join(ROOT, 'dist', 'daemon-binaries', `daemon-${process.platform}-${process.arch}`)

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-fifo-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-fifo-data-'))

const FIFO = path.join(DATA_DIR, 'wedge.pipe')
const REGULAR = path.join(DATA_DIR, 'normal.jsonl')

const hasBinary = fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

let daemonPid: number | null = null
let port = 0

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

interface Rpc {
  send: (cmd: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
}

function connect(): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let id = 0
    const pending = new Map<number, (r: Record<string, unknown>) => void>()
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        const mid = msg.id as number
        if (mid && pending.has(mid)) {
          const cb = pending.get(mid)!
          pending.delete(mid)
          cb(msg)
        }
      } catch { /* ignore non-JSON frames */ }
    })
    ws.on('open', () => resolve({
      send: (cmd, params = {}, timeoutMs = 10_000) => new Promise((res, rej) => {
        const myId = ++id
        const timer = setTimeout(() => { pending.delete(myId); rej(new Error(`${cmd} timed out after ${timeoutMs}ms`)) }, timeoutMs)
        pending.set(myId, (r) => { clearTimeout(timer); res(r) })
        ws.send(JSON.stringify({ id: myId, cmd, ...params }))
      }),
      close: () => { try { ws.terminate() } catch { /* already closed */ } },
    }))
    ws.on('error', reject)
  })
}

d('daemon fs.read FIFO guard (real binary)', () => {
  beforeAll(async () => {
    execSync(`mkfifo ${JSON.stringify(FIFO)}`)
    fs.writeFileSync(REGULAR, JSON.stringify({ type: 'assistant' }) + '\n')

    const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR }
    delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
    const proc = spawn(BINARY, ['--start'], { detached: true, stdio: 'ignore', env })
    proc.unref()

    const ok = await waitFor(() => fs.existsSync(PORT_FILE), 10_000)
    if (!ok) throw new Error('daemon did not write port file')
    port = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    daemonPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
  }, 30_000)

  afterAll(() => {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL') } catch { /* already dead */ } }
    fs.rmSync(DAEMON_DIR, { recursive: true, force: true })
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  })

  it('fs.read of a FIFO fails fast with ENOTFILE and does not wedge later commands', async () => {
    const rpc = await connect()
    try {
      // Pre-fix this call never resolved (open() blocked in the kernel).
      const readRes = await rpc.send('fs.read', { path: FIFO, encoding: 'utf-8' }, 5_000)
      expect(readRes.ok).toBe(false)
      expect(String(readRes.error)).toContain('ENOTFILE')

      // The pool thread must NOT be wedged: normal fs traffic still answers.
      const statRes = await rpc.send('fs.stat', { path: REGULAR }, 5_000)
      expect(statRes.ok).toBe(true)
      const normalRead = await rpc.send('fs.read', { path: REGULAR, encoding: 'utf-8' }, 5_000)
      expect(normalRead.ok).toBe(true)
      expect(String(normalRead.data)).toContain('assistant')
    } finally {
      rpc.close()
    }
  }, 20_000)

  it('fs.readRange of a FIFO fails fast with ENOTFILE', async () => {
    const rpc = await connect()
    try {
      const res = await rpc.send('fs.readRange', { path: FIFO, start: 0, length: 1024 }, 5_000)
      expect(res.ok).toBe(false)
      expect(String(res.error)).toContain('ENOTFILE')

      const rangeOk = await rpc.send('fs.readRange', { path: REGULAR, start: 0, length: 1024 }, 5_000)
      expect(rangeOk.ok).toBe(true)
    } finally {
      rpc.close()
    }
  }, 20_000)
})
