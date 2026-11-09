/**
 * REGRESSION: daemon watcher integrity across restarts/replaces (2026-07-06 audit).
 *
 * 1. Live `jsonl` events must carry `v` (the absolute byte cursor). The
 *    compiled binary's live fan-out omitted it (only the replay path stamped
 *    it), so every binary-daemon session fell back to the client's relative
 *    byte accounting — which drifts on auto-allowed control lines the watcher
 *    skips → replay windows and duplicated blocks on reattach.
 *
 * 2. `cmdStart` replacing an existing session must stop the OLD session's
 *    watcher. The poll timer re-resolves sessions.get(sid) each tick, so with
 *    the new entry in place the orphaned timer tailed the same jsonl at its
 *    own offset — every line fanned TWICE (doubled streamed content after a
 *    respawn) and the timer leaked forever.
 *
 * What's real: the compiled daemon binary, real WS, a fake "CLI" (shell
 * script) so no Claude is involved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'

const ROOT = path.resolve(__dirname, '../..')
const BINARY = path.join(ROOT, 'dist', 'daemon-binaries', `daemon-${process.platform}-${process.arch}`)

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-wi-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const STREAMS_DIR = `${DAEMON_DIR}-streams`

// This machine's own build (a Linux checkout that cross-built darwin-arm64 gets ENOEXEC from it, 2026-11-07).
const hasBinary = fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

let daemonPid: number | null = null
let port = 0
let rpcId = 1

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

/** One RPC's reply (bounded by the test's own timeout: a start spawns a process, slow on a loaded host). */
function rpc(ws: WebSocket, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve) => {
    const onMsg = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) {
          ws.off('message', onMsg)
          resolve(msg)
        }
      } catch { /* event frame */ }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/**
 * Every live `jsonl` event of one session on this socket, in order. `until` resolves as soon
 * as the events satisfy it (the test's own timeout bounds the wait, no shorter clock).
 */
function jsonlEvents(ws: WebSocket, sid: string) {
  const events: Array<{ line: string; v?: number }> = []
  const waiters: Array<{ ok: () => boolean; resolve: () => void }> = []
  ws.on('message', (data: Buffer | string) => {
    try {
      // Daemon event frames are FLAT: { ev: 'jsonl', sid, line, v } (rpc replies carry `id`).
      const msg = JSON.parse(data.toString()) as { ev?: string; sid?: string; line?: string; v?: number }
      if (msg.ev !== 'jsonl' || msg.sid !== sid || !msg.line) return
      events.push({ line: msg.line, v: msg.v })
      for (const w of waiters.splice(0)) { if (w.ok()) w.resolve(); else waiters.push(w) }
    } catch { /* rpc frame */ }
  })
  const until = (ok: () => boolean) => new Promise<void>((resolve) => { if (ok()) resolve(); else waiters.push({ ok, resolve }) })
  const count = (line: string) => events.filter((e) => e.line === line).length
  return { events, until, count }
}

/** Fake long-running "CLI": reads stdin forever, we append to its jsonl ourselves. */
const FAKE_CLI = path.join(DAEMON_DIR, 'fake-cli.sh')

d('daemon watcher integrity (real binary)', () => {
  beforeAll(async () => {
    // Long-running fake CLI. NOT `cat`: the daemon closes its write end of the
    // FIFO after the initial message, which would EOF `cat` → instant exit →
    // reapSession stops the watcher and the test sees zero events.
    fs.writeFileSync(FAKE_CLI, '#!/bin/sh\nsleep 3600\n', { mode: 0o755 })
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
    if (daemonPid && daemonPid > 1) { try { process.kill(daemonPid, 'SIGTERM') } catch {} }
    try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(STREAMS_DIR, { recursive: true, force: true }) } catch {}
  })

  it('live jsonl events carry the absolute v cursor', async () => {
    const sid = 'wi-live-v'
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })

    const started = await rpc(ws, {
      cmd: 'start', sid, args: [FAKE_CLI], cwd: DAEMON_DIR, message: 'hi',
    })
    expect(started.ok).toBe(true)

    const { events, until } = jsonlEvents(ws, sid)

    // Append lines to the jsonl like the CLI would; the watcher polls every 100ms.
    const jsonlPath = path.join(STREAMS_DIR, `${sid}.jsonl`)
    const lineA = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } })
    const lineB = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } })
    fs.appendFileSync(jsonlPath, lineA + '\n')
    fs.appendFileSync(jsonlPath, lineB + '\n')

    await until(() => events.length >= 2)
    for (const e of events) {
      // THE regression: live events had no `v` → client relative-cursor drift.
      expect(typeof e.v).toBe('number')
      expect(e.v!).toBeGreaterThan(0)
    }
    // v is the END-of-line byte offset — strictly monotonic across events.
    const vs = events.map((e) => e.v!)
    expect([...vs].sort((a, b) => a - b)).toEqual(vs)

    ws.close()
  }, 30_000)

  it('cmdStart replace does not leave the old watcher fanning duplicates', async () => {
    const sid = 'wi-replace'
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })

    // Counts how many times each line is delivered.
    const { until, count } = jsonlEvents(ws, sid)

    // First start — creates session + watcher (addSubscriber on this ws).
    const s1 = await rpc(ws, { cmd: 'start', sid, args: [FAKE_CLI], cwd: DAEMON_DIR, message: 'one' })
    expect(s1.ok).toBe(true)

    // Feed a line and wait until it is delivered, so the first watcher is definitely live.
    const jsonlPath = path.join(STREAMS_DIR, `${sid}.jsonl`)
    const warm = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'warm' }] } })
    fs.appendFileSync(jsonlPath, warm + '\n')
    await until(() => count(warm) >= 1)

    // Replace: second start under the SAME sid (resume path appends to the jsonl).
    const s2 = await rpc(ws, { cmd: 'start', sid, args: [FAKE_CLI], cwd: DAEMON_DIR, message: 'two', resume: true })
    expect(s2.ok).toBe(true)

    const marker = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after-replace-' + Date.now() }] } })
    fs.appendFileSync(jsonlPath, marker + '\n')

    await until(() => count(marker) >= 1)
    // Only a check that something did NOT happen: a leaked second watcher (poll = 100 ms)
    // gets a few of its ticks to deliver the line again.
    await new Promise((r) => setTimeout(r, 600))

    // THE regression: a leaked old watcher delivered every line twice.
    expect(count(marker)).toBe(1)

    ws.close()
  }, 30_000)
})
