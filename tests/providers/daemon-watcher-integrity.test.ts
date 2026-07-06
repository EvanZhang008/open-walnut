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
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const ROOT = path.resolve(__dirname, '../..')
const BINARY = path.join(ROOT, 'dist', 'daemon-binaries', 'daemon-darwin-arm64')

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-wi-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const STREAMS_DIR = `${DAEMON_DIR}-streams`

const hasBinary = fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

let daemonPid: number | null = null
let port = 0
let rpcId = 1

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`rpc timeout: ${cmd.cmd}`)) }, timeoutMs)
    const onMsg = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(msg)
        }
      } catch { /* event frame */ }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
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
    const ok = await waitFor(() => fs.existsSync(PORT_FILE), 10_000)
    if (!ok) throw new Error('daemon did not write port file')
    port = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    daemonPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
  }, 30_000)

  afterAll(() => {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM') } catch {} }
    try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(STREAMS_DIR, { recursive: true, force: true }) } catch {}
  })

  it('live jsonl events carry the absolute v cursor', async () => {
    const sid = 'wi-live-v'
    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })

    const started = await rpc(ws, {
      cmd: 'start', sid, args: [FAKE_CLI], cwd: DAEMON_DIR, message: 'hi',
    })
    expect(started.ok).toBe(true)

    const events: Array<{ line: string; v?: number }> = []
    ws.on('message', (data: Buffer | string) => {
      try {
        // Daemon event frames are FLAT: { ev: 'jsonl', sid, line, v } (rpc replies carry `id`).
        const msg = JSON.parse(data.toString()) as { ev?: string; sid?: string; line?: string; v?: number }
        if (msg.ev === 'jsonl' && msg.sid === sid && msg.line) {
          events.push({ line: msg.line, v: msg.v })
        }
      } catch { /* rpc frame */ }
    })

    // Append lines to the jsonl like the CLI would; the watcher polls every 100ms.
    const jsonlPath = path.join(STREAMS_DIR, `${sid}.jsonl`)
    const lineA = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } })
    const lineB = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } })
    fs.appendFileSync(jsonlPath, lineA + '\n')
    fs.appendFileSync(jsonlPath, lineB + '\n')

    await waitFor(() => events.length >= 2, 5_000)
    expect(events.length).toBeGreaterThanOrEqual(2)
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
    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })

    // First start — creates session + watcher (addSubscriber on this ws).
    const s1 = await rpc(ws, { cmd: 'start', sid, args: [FAKE_CLI], cwd: DAEMON_DIR, message: 'one' })
    expect(s1.ok).toBe(true)

    // Feed a line so the first watcher is definitely live.
    const jsonlPath = path.join(STREAMS_DIR, `${sid}.jsonl`)
    fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'warm' }] } }) + '\n')
    await new Promise((r) => setTimeout(r, 400))

    // Replace: second start under the SAME sid (resume path appends to the jsonl).
    const s2 = await rpc(ws, { cmd: 'start', sid, args: [FAKE_CLI], cwd: DAEMON_DIR, message: 'two', resume: true })
    expect(s2.ok).toBe(true)

    // Now count how many times each NEW line is delivered.
    const seen = new Map<string, number>()
    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as { ev?: string; sid?: string; line?: string }
        if (msg.ev === 'jsonl' && msg.sid === sid && msg.line) {
          seen.set(msg.line, (seen.get(msg.line) ?? 0) + 1)
        }
      } catch { /* rpc frame */ }
    })

    const marker = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after-replace-' + Date.now() }] } })
    fs.appendFileSync(jsonlPath, marker + '\n')

    await waitFor(() => (seen.get(marker) ?? 0) >= 1, 5_000)
    // Give a leaked second watcher time to double-deliver (poll = 100ms).
    await new Promise((r) => setTimeout(r, 600))

    // THE regression: a leaked old watcher delivered every line twice.
    expect(seen.get(marker)).toBe(1)

    ws.close()
  }, 30_000)
})
