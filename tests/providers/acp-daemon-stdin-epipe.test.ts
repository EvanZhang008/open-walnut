/**
 * A worker whose stdin reader is gone never takes down the process that hosts
 * the ACP daemon.
 *
 * 2026-11-02, CI browser shard 2/16: an "Interrupt & send" on a Codex session
 * tore its worker down while the daemon still had a request in the worker's
 * stdin pipe. Bun failed that write with EPIPE as an 'error' event on the
 * stdin stream, which had no listener, so it became an uncaughtException and
 * the Playwright fixture server (whose in-process MockDaemon embeds this very
 * module) exited; 87 later specs got ECONNREFUSED. In production the module
 * runs inside the local daemon, whose uncaughtException handler exits too,
 * taking every session on the machine with it.
 *
 * The worker here answers the start, then stops reading and exits while a
 * request larger than the pipe buffer is still being written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLOSING_WORKER = path.join(__dirname, 'mock-stdin-closing-acp-worker.mjs')

interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }

let tmpDir: string
let uncaught: unknown[]
const onUncaught = (err: unknown) => { uncaught.push(err) }
// Vitest installs its own listener; with ours beside it a stray EPIPE is
// recorded here (and still reported by vitest) instead of only failing the run.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-epipe-test-'))
  uncaught = []
  process.on('uncaughtException', onUncaught)
})
afterEach(() => {
  process.off('uncaughtException', onUncaught)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type Log = { level: string; msg: string; data?: Record<string, unknown> }
const daemons: Array<ReturnType<typeof createAcpDaemon<FakeWs>>> = []
afterEach(async () => {
  for (const acp of daemons.splice(0)) for (const sid of [...acp.workers.keys()]) await acp.acpStop(sid)
})

/** A real createAcpDaemon running the closing worker; `env` picks its mode. */
async function startClosingWorker(sid: string, env: Record<string, string> = {}) {
  const logs: Log[] = []
  const acp = createAcpDaemon<FakeWs>({
    streamsDir: path.join(tmpDir, 'streams'),
    daemonDir: path.join(tmpDir, 'daemon'),
    sendEvent: (ws, ev, data) => { ws.frames.push({ ev, ...data }) },
    isWsOpen: (ws) => ws.open,
    log: (level, msg, data) => { logs.push({ level, msg, data }) },
    cancelRpcTimeoutMs: 300,
    abortWaitMs: 150,
    killGraceMs: 150,
    setIntervalFn: ((fn: () => void) => setInterval(fn, 60_000)) as typeof setInterval,
  })
  daemons.push(acp)
  const ws: FakeWs = { open: true, frames: [] }
  const started = await acp.acpStart(ws, {
    sid,
    cwd: tmpDir,
    workerCmd: [process.execPath, CLOSING_WORKER],
    adapterCmd: [process.execPath, CLOSING_WORKER],
    env,
  })
  expect(started.ok).toBe(true)
  // The worker stops reading on 'stall' (never answered); a request after it that is far
  // larger than a pipe buffer (64 KB on Linux, 16 KB on macOS) stays pending in the pipe.
  void acp.acpOp(sid, 'stall', {})
  await new Promise((r) => setTimeout(r, 100))
  const big = acp.acpOp(sid, 'prompt', { commandId: 'c1', walnutMessageId: 'qm-1', text: 'x'.repeat(4 * 1024 * 1024) })
  return { acp, logs, big }
}

const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'still pending'>((r) => setTimeout(() => r('still pending'), ms))])
const codes = () => uncaught.map((e) => (e as NodeJS.ErrnoException)?.code ?? String(e))
const stdinClosed = (logs: Log[]) => logs.find((l) => l.msg === 'acp: worker stdin closed')?.data

describe('ACP worker stdin EPIPE', () => {
  it('a request still in the pipe when the worker exits fails as a request, not as a crash', async () => {
    const { acp, logs, big } = await startClosingWorker('epipe-exit')
    const exited = Date.now() + 8_000
    while (!logs.some((l) => l.msg === 'acp: worker exited') && Date.now() < exited) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(logs.some((l) => l.msg === 'acp: worker exited')).toBe(true)
    // Give the rejected write and the stream's destroy their ticks.
    await new Promise((r) => setTimeout(r, 300))

    expect(codes()).toEqual([])
    expect(await within(big, 3_000)).toMatchObject({ ok: false })
    // The broken pipe is logged as the worker's stdin closing, with its code.
    expect(stdinClosed(logs)).toMatchObject({ sid: 'epipe-exit', code: 'EPIPE' })
    expect(acp.workers.has('epipe-exit')).toBe(false)
  }, 20_000)

  it('a worker that closed its stdin but lives on fails the request at once, not at the 120 s op timeout', async () => {
    const { acp, logs, big } = await startClosingWorker('epipe-stay', { MOCK_CLOSING_WORKER_CLOSE_STDIN: '1', MOCK_CLOSING_WORKER_EXIT_MS: '30000' })
    const answer = await within(big, 5_000)
    expect(answer).toMatchObject({ ok: false, error: { kind: 'internal' } })
    expect((answer as { error: { message: string } }).error.message).toMatch(/worker stdin write failed/)
    // The write callback runs first; the stream's 'error' event follows a tick later.
    await new Promise((r) => setTimeout(r, 200))
    expect(codes()).toEqual([])
    expect(stdinClosed(logs)).toMatchObject({ sid: 'epipe-stay', code: 'EPIPE' })
    // Still the worker's to reap: the process lives, so nothing tore it down.
    expect(acp.workers.has('epipe-stay')).toBe(true)
  }, 20_000)

  it('an interrupt that tears the worker down while a request is in its pipe (the CI path) ends cleanly', async () => {
    const { acp, logs, big } = await startClosingWorker('epipe-abort', { MOCK_CLOSING_WORKER_EXIT_MS: '30000' })
    // The cancel queues behind the pending request, goes unanswered, and the abort
    // kills the worker's process group: every byte still in the pipe fails with EPIPE.
    const aborted = await within(acp.acpOp('epipe-abort', 'cancel', { commandId: 'c1' }), 10_000)
    expect(aborted).not.toBe('still pending')
    await new Promise((r) => setTimeout(r, 300))
    expect(codes()).toEqual([])
    expect(await within(big, 3_000)).toMatchObject({ ok: false })
    expect(acp.workers.has('epipe-abort')).toBe(false)
    expect(logs.some((l) => l.msg === 'acp: worker exited')).toBe(true)
  }, 20_000)
})
