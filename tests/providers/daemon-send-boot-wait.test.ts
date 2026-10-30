/**
 * send-boot-wait-v1 in daemon-core.handleSendCommand (the twin's copy runs in
 * daemon-send-boot-wait-twins-e2e.test.ts, against the real daemons).
 *
 * 2026-10-30: the first line after a cold resume was bigger than the pipe buffer,
 * and `claude --resume` of a 136MB transcript took 18 to 22s before it read stdin.
 * Part of the line went in, the 20s write deadline passed, and the daemon reaped
 * the healthy booting CLI ('send-partial-write') twice in a row. A `bootWait` send
 * into a CLI that has not shown its first init line since its spawn now waits until
 * the boot deadline after the spawn; every other send keeps the plain deadline.
 *
 * Deadlines are shortened here (plain 300ms, boot 2.5s); the FIFO and its reader
 * are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

const PLAIN_MS = 300
const BOOT_MS = 2_500
/** Beyond any pipe buffer, so part of the line waits in the write. */
const BIG = 'z'.repeat(256 * 1024)

describe('send-boot-wait-v1: daemon-core', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  const readers: number[] = []

  beforeEach(async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process signal in a FIFO test') })
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})
    ctx = await buildDeps({ fifoWriteDeadlineMs: PLAIN_MS, fifoBootWriteDeadlineMs: BOOT_MS })
  })

  afterEach(async () => {
    for (const fd of readers.splice(0)) { try { fs.closeSync(fd) } catch { /* closed */ } }
    try { await ctx.cleanup() } finally { vi.restoreAllMocks() }
  })

  /** A FIFO with its reader end open and not reading, as a booting CLI holds its stdin. */
  function stalledFifo(): { fifo: string; fd: number } {
    const fifo = path.join(ctx.tmpDir, `boot-${Math.random().toString(36).slice(2)}.pipe`)
    execFileSync('mkfifo', [fifo])
    const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    readers.push(fd)
    return { fifo, fd }
  }

  /** Start reading after `afterMs` (the CLI finished booting); resolves with the bytes read. */
  function drainAfter(fd: number, afterMs: number): { stop: () => string } {
    const chunks: Buffer[] = []
    const read = () => {
      for (;;) {
        try {
          const buf = Buffer.alloc(64 * 1024)
          const n = fs.readSync(fd, buf, 0, buf.length, null)
          if (n <= 0) return
          chunks.push(buf.subarray(0, n))
        } catch { return }
      }
    }
    let timer: ReturnType<typeof setInterval> | null = null
    const start = setTimeout(() => { timer = setInterval(read, 10) }, afterMs)
    return {
      stop: () => {
        clearTimeout(start)
        if (timer) clearInterval(timer)
        read()
        return Buffer.concat(chunks).toString('utf8')
      },
    }
  }

  it('a boot-wait line into a CLI still booting waits past the plain deadline and arrives whole', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 900, pipePath: fifo, spawnTs: Date.now(), sawInit: false }))
    const reader = drainAfter(fd, 1_200)
    const t0 = Date.now()
    const res = await core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })
    const wire = reader.stop()
    expect(res).toEqual({ ok: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
    expect(ctx.sessions.get('sid')!.state).toBe('running')
    expect(JSON.parse(wire.trim()).message.content).toBe(BIG)
    expect(ctx.spies.logger.mock.calls.some(([, msg]) => msg === 'send: a booting CLI took the line')).toBe(true)
    // Settled: a later write is not treated as queued behind it (keeps the shared budget).
    expect(ctx.sessions.get('sid')!.fifoBootWaitUntil).toBeUndefined()
  }, 15_000)

  it('the same line without bootWait keeps the plain deadline: reaped as send-partial-write (the incident)', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 901, pipePath: fifo, spawnTs: Date.now(), sawInit: false }))
    const reader = drainAfter(fd, 1_200)
    const res = await core.handleSendCommand('sid', BIG)
    reader.stop()
    expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-partial-write')
    const warn = ctx.spies.logger.mock.calls.find(([, msg]) => msg === 'send: the CLI did not read the line in time')
    expect(warn?.[2]).toMatchObject({ bootWait: false, sawInit: false })
  }, 15_000)

  it.each([
    ['a CLI that already showed its init line', { spawnTs: Date.now(), sawInit: true }],
    ['an adopted CLI with no spawn time', { sawInit: false }],
    ['a CLI spawned longer ago than the boot deadline', { spawnTs: Date.now() - 10_000, sawInit: false }],
  ])('bootWait into %s gets only the plain deadline', async (_label, extra) => {
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 902, pipePath: fifo, ...extra }))
    const reader = drainAfter(fd, 1_200)
    const t0 = Date.now()
    const res = await core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })
    reader.stop()
    expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-partial-write')
  }, 15_000)

  it('a CLI that never reads is still reaped, at the boot deadline after its spawn', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo } = stalledFifo()
    const spawnTs = Date.now() - 1_000
    ctx.sessions.set('sid', makeTestSession({ pid: 903, pipePath: fifo, spawnTs, sawInit: false }))
    const res = await core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })
    const at = Date.now() - spawnTs
    expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-partial-write')
    expect(at).toBeGreaterThanOrEqual(BOOT_MS - 50)
    expect(at).toBeLessThan(BOOT_MS + 1_500)
  }, 15_000)

  it('a CLI that dies while the line waits ends the wait at once', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo } = stalledFifo()
    const session = makeTestSession({ pid: 904, pipePath: fifo, spawnTs: Date.now(), sawInit: false })
    ctx.sessions.set('sid', session)
    const t0 = Date.now()
    const pending = core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })
    setTimeout(() => core.reapSession('sid', 1, 'proc-exit'), 500)
    const res = await pending
    expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(session.state).toBe('dead')
    expect(session.exitReason).toBe('proc-exit')
  }, 15_000)

  it('a line queued behind a boot-wait line gets its own window once its turn comes (no reap of the booted CLI)', async () => {
    // A plain window long enough to move 256KB through a small pipe (the writer
    // retries every 25ms), but over before the boot-wait line is read at 2s.
    await ctx.cleanup()
    ctx = await buildDeps({ fifoWriteDeadlineMs: 1_000, fifoBootWriteDeadlineMs: 5_000 })
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 906, pipePath: fifo, spawnTs: Date.now(), sawInit: false }))
    const reader = drainAfter(fd, 2_000)
    const first = core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })
    await new Promise((r) => setTimeout(r, 100))
    // A second big line (a trigger delivery, a phone message) while the CLI boots.
    const second = core.handleSendCommand('sid', 'second'.padEnd(BIG.length, 'q'))
    const [a, b] = await Promise.all([first, second])
    const wire = reader.stop()
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(ctx.sessions.get('sid')!.state).toBe('running')
    const lines = wire.trim().split('\n').map((l) => JSON.parse(l).message.content.slice(0, 6))
    expect(lines).toEqual(['zzzzzz', 'second'])
  }, 15_000)

  it('a line that fits the pipe buffer is written at once, bootWait or not', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 905, pipePath: fifo, spawnTs: Date.now(), sawInit: false }))
    const t0 = Date.now()
    expect(await core.handleSendCommand('sid', 'small', undefined, undefined, { bootWait: true })).toEqual({ ok: true })
    expect(Date.now() - t0).toBeLessThan(PLAIN_MS)
    expect(JSON.parse(drainAfter(fd, 0).stop().trim()).message.content).toBe('small')
  }, 15_000)
})
