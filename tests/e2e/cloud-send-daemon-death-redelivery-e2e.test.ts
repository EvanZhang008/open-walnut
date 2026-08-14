/**
 * Kill-between-steps redelivery E2E — the acceptance proof for the durable
 * cloud-send path (2026-08-13 phone-send data-loss family).
 *
 * Old failure mode: phone send = status → appendUserMarker → send/bridgeResume
 * directly against the daemon; the daemon died SILENTLY between the marker
 * append and the delivery, so the transcript showed the user's bubble while
 * the CLI never received the message, and the retry hit the respawn blind
 * window. New model: the message lands in the DURABLE queue first (the same
 * store web sends use), so a daemon death anywhere before delivery converts
 * to delayed redelivery.
 *
 * This test drives the REAL artifacts end to end:
 *   1. real source-template daemon (isolated dir) spawns a mock CLI that
 *      echoes every FIFO line into its jsonl (stdout);
 *   2. the phone's message is enqueued durably with its qm-mobile id — and a
 *      phone RETRY of the same id dedupes to one row (idempotent enqueue);
 *   3. the daemon is SIGKILLed BETWEEN enqueue and delivery (the silent
 *      death, exactly where the incident struck);
 *   4. a fresh daemon generation adopts the still-alive CLI from the
 *      registry (Phase C reconcile);
 *   5. redelivery drains the queue through the daemon's real `send` RPC →
 *      FIFO → mock CLI, and the jsonl shows the message EXACTLY ONCE;
 *   6. the queue is empty afterwards (scoped removeProcessed).
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR/WALNUT_STREAMS_DIR temp dirs,
 * never /tmp/open-walnut; mock CLI + daemons killed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-kill-redeliver'))

import { getDaemonSource } from '../../src/providers/daemon-source.js'
import {
  enqueueMessage,
  getQueue,
  markProcessing,
  removeProcessed,
  loadQueue,
  resetCache,
} from '../../src/core/session-message-queue.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = 'phone-kill-redeliver-1'
const MESSAGE = 'phone message that must survive the daemon death'
const MESSAGE_ID = 'qm-mobile-killtest01'

let daemonDir = ''
let streamsDir = ''
let scriptPath = ''
let mockCliPath = ''
let cwdDir = ''
let daemonProc: ChildProcess | null = null
let ws: WebSocket | null = null

async function spawnDaemon(): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: streamsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 20_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  return { proc, port }
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(sock: WebSocket, cmd: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd.cmd}`)), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(async () => {
  await loadQueue()
  resetCache()
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-kill-redeliver-'))
  streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-kill-redeliver-streams-'))
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-kill-redeliver-cwd-'))
  scriptPath = path.join(daemonDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  // Mock CLI: echoes each stdin (FIFO) line to stdout (the daemon points
  // stdout at the session jsonl), then stays alive like a real long-running
  // `claude -p` process.
  mockCliPath = path.join(daemonDir, 'mock-cli.cjs')
  fs.writeFileSync(mockCliPath, [
    "process.stdin.on('data', (d) => process.stdout.write(d));",
    'setInterval(() => {}, 60_000);',
  ].join('\n'), { mode: 0o755 })
}, 60_000)

afterAll(async () => {
  try { ws?.close() } catch { /* already closed */ }
  if (daemonProc && daemonProc.exitCode === null) {
    daemonProc.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 300))
  }
  // Reap the detached mock CLI via its pgid file.
  try {
    const pgid = parseInt(fs.readFileSync(path.join(streamsDir, SID + '.pgid'), 'utf-8').trim(), 10)
    if (pgid > 0) { try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ } }
  } catch { /* never started */ }
  for (const d of [daemonDir, streamsDir, cwdDir]) fs.rmSync(d, { recursive: true, force: true })
  await fs.promises.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 30_000)

describe('daemon death between enqueue and delivery → exactly-once redelivery', () => {
  it('survives the kill and delivers the phone message exactly once', async () => {
    // ── 1. daemon generation A spawns the mock CLI session ──
    const genA = await spawnDaemon()
    daemonProc = genA.proc
    ws = await connect(genA.port)
    const started = await rpc(ws, {
      cmd: 'start', sid: SID, cwd: cwdDir,
      args: [process.execPath, mockCliPath],
      message: '', // spawn idle — the phone message must arrive via redelivery
    }, 20_000)
    expect(started.ok).toBe(true)
    const cliPid = started.pid as number
    expect(cliPid).toBeGreaterThan(0)

    // ── 2. the phone's message lands in the DURABLE queue (idempotent) ──
    const first = await enqueueMessage(SID, MESSAGE, { id: MESSAGE_ID })
    expect(first.id).toBe(MESSAGE_ID)
    // Phone retry with the same id (lost ack) — must NOT create a second row.
    const retry = await enqueueMessage(SID, MESSAGE, { id: MESSAGE_ID })
    expect(retry.id).toBe(MESSAGE_ID)
    expect((await getQueue(SID)).length).toBe(1)

    // ── 3. the silent death, exactly between enqueue and delivery ──
    genA.proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      genA.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
    try { ws.close() } catch { /* dead with the daemon */ }

    // The CLI itself survives (detached process group) and the queue row is
    // on disk — nothing was lost with the daemon.
    expect(() => process.kill(cliPid, 0)).not.toThrow()
    resetCache() // force a disk re-read: the row must be durable, not cached
    expect((await getQueue(SID)).length).toBe(1)

    // ── 4. daemon generation B adopts the orphan from the registry ──
    // (daemon.pid/port files still name the dead generation; remove them the
    // way the supervisor's stale-file probe effectively does.)
    for (const f of ['daemon.pid', 'daemon.port', 'daemon.instance']) {
      try { fs.unlinkSync(path.join(daemonDir, f)) } catch { /* absent */ }
    }
    const genB = await spawnDaemon()
    daemonProc = genB.proc
    ws = await connect(genB.port)
    await waitFor(() => fs.existsSync(path.join(streamsDir, SID + '.jsonl')))
    const status = await rpc(ws, { cmd: 'status', sid: SID })
    expect(status.exists).toBe(true)
    expect(status.alive).toBe(true)

    // ── 5. redelivery: drain the queue through the daemon's real send RPC ──
    // (The production hook is redeliverPendingForHost → processNext on the
    // host-connected callback; the queue semantics it uses are exactly these.)
    const batch = await markProcessing(SID)
    expect(batch.map((m) => m.id)).toEqual([MESSAGE_ID])
    const sent = await rpc(ws, { cmd: 'send', sid: SID, message: batch[0].message })
    expect(sent.ok).toBe(true)
    await removeProcessed(SID, [MESSAGE_ID])

    // ── 6. the CLI received it EXACTLY once; the queue is drained ──
    const jsonlPath = path.join(streamsDir, SID + '.jsonl')
    await waitFor(() => fs.readFileSync(jsonlPath, 'utf-8').includes(MESSAGE))
    const occurrences = fs.readFileSync(jsonlPath, 'utf-8')
      .split('\n').filter((l) => l.includes(MESSAGE)).length
    expect(occurrences).toBe(1)
    expect((await getQueue(SID)).length).toBe(0)

    // A LATE phone retry (after delivery) hitting the queue directly would
    // re-enqueue — that residual window is closed by the relay handler's
    // recentMobileEnqueues ledger (daemon-connection.ts), covered in
    // tests/providers/daemon-connection-message-relay.test.ts.
  }, 120_000)
})
