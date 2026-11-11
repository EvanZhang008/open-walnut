/**
 * send-boot-wait-v1 in daemon-core.handleSendCommand (the twin's copy runs in
 * daemon-send-boot-wait-twins-e2e.test.ts, against the real daemons).
 *
 * 2026-10-30: the first line after a cold resume was bigger than the pipe buffer,
 * and `claude --resume` of a 136MB transcript took 18 to 22s before it read stdin.
 * Part of the line went in, the 20s write deadline passed, and the daemon reaped
 * the healthy booting CLI ('send-partial-write') twice in a row. A `bootWait` send
 * into a CLI that has not shown its first init line since its spawn now waits until
 * the boot deadline after the spawn.
 *
 * write-boot-wait-v1 (2026-11-05): so does EVERY other write into such a CLI, a
 * plain send and a raw line alike. A 7KB status question (sendRaw) written 5s after
 * a spawn under load 300 filled the pipe of a CLI still booting, and the 20s plain
 * deadline reaped it ('sendRaw-partial-write', exit -1, no transcript).
 *
 * The boot hold (2026-11-11): past the boot deadline, part of a line in a CLI that
 * still has not shown its init waits for it to read on, until the hold after its
 * spawn. Under memory pressure a resume's 11 KB first line went 8 KB in, and the
 * daemon reaped the booting CLI and started it again three times, 4 to 5 minutes
 * after each spawn: the message took 16.6 minutes, the fourth start read it 106 s
 * after its spawn.
 *
 * Deadlines are shortened here (plain 300ms, boot 2.5s, hold 6s); the FIFO and its
 * reader are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

const PLAIN_MS = 300
const BOOT_MS = 2_500
const HOLD_MS = 6_000
/** Beyond any pipe buffer, so part of the line waits in the write. */
const BIG = 'z'.repeat(256 * 1024)

describe('send-boot-wait-v1: daemon-core', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  const readers: number[] = []

  beforeEach(async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process signal in a FIFO test') })
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})
    ctx = await buildDeps({ fifoWriteDeadlineMs: PLAIN_MS, fifoBootWriteDeadlineMs: BOOT_MS, fifoBootHoldMaxMs: HOLD_MS })
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

  it.each([
    ['a plain send', (core: ReturnType<typeof createDaemonCore>) => core.handleSendCommand('sid', BIG)],
    ['a raw line (a status question, a control response)', (core: ReturnType<typeof createDaemonCore>) =>
      core.handleSendRawCommand('sid', JSON.stringify({ type: 'control_request', request_id: 'sq-1', request: { subtype: 'side_question', question: BIG } }))],
  ])('%s into a CLI still booting waits through the boot too (the 2026-11-05 incident)', async (_label, write) => {
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 901, pipePath: fifo, spawnTs: Date.now(), sawInit: false }))
    const reader = drainAfter(fd, 1_200)
    const t0 = Date.now()
    const res = await write(core)
    const wire = reader.stop()
    expect(res).toMatchObject({ ok: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
    expect(ctx.sessions.get('sid')!.state).toBe('running')
    expect(wire.trim().length).toBeGreaterThan(BIG.length)
    expect(ctx.sessions.get('sid')!.fifoBootWaitUntil).toBeUndefined()
  }, 15_000)

  it('a raw line into a booted CLI that stops reading keeps the plain deadline', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo } = stalledFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 907, pipePath: fifo, spawnTs: Date.now(), sawInit: true }))
    const t0 = Date.now()
    const res = await core.handleSendRawCommand('sid', JSON.stringify({ type: 'control_request', request_id: 'sq-2', request: { subtype: 'side_question', question: BIG } }))
    expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(ctx.sessions.get('sid')!.exitReason).toBe('sendRaw-partial-write')
    const warn = ctx.spies.logger.mock.calls.find(([, msg]) => msg === 'sendRaw: the CLI did not read the line in time')
    expect(warn?.[2]).toMatchObject({ sawInit: true })
  }, 15_000)

  it.each([
    ['a CLI that already showed its init line', { spawnTs: Date.now(), sawInit: true }],
    ['an adopted CLI with no spawn time', { sawInit: false }],
    ['a CLI spawned longer ago than the boot hold', { spawnTs: Date.now() - 10_000, sawInit: false }],
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

  it('a CLI that never reads is still reaped, at the boot hold after its spawn', async () => {
    const core = createDaemonCore(ctx.deps)
    const { fifo } = stalledFifo()
    const spawnTs = Date.now() - 1_000
    ctx.sessions.set('sid', makeTestSession({ pid: 903, pipePath: fifo, spawnTs, sawInit: false }))
    const res = await core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })
    const at = Date.now() - spawnTs
    expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-partial-write')
    expect(at).toBeGreaterThanOrEqual(HOLD_MS - 50)
    expect(at).toBeLessThan(HOLD_MS + 1_500)
    expect(ctx.spies.logger.mock.calls.filter(([, msg]) => msg === 'send: a booting CLI holds part of the line; waiting for it to read on')).toHaveLength(1)
  }, 15_000)

  it.each([
    ['a boot-wait send', (core: ReturnType<typeof createDaemonCore>) => core.handleSendCommand('sid', BIG, undefined, undefined, { bootWait: true })],
    ['a plain send', (core: ReturnType<typeof createDaemonCore>) => core.handleSendCommand('sid', BIG)],
    ['a raw line', (core: ReturnType<typeof createDaemonCore>) =>
      core.handleSendRawCommand('sid', JSON.stringify({ type: 'control_request', request_id: 'sq-3', request: { subtype: 'side_question', question: BIG } }))],
  ])('%s into a CLI booting past the boot deadline waits for it, never reaps it (the 2026-11-11 kill loop)', async (_label, write) => {
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    // Spawned past the boot deadline, still inside the hold, as each 2026-11-11 start was.
    ctx.sessions.set('sid', makeTestSession({ pid: 908, pipePath: fifo, spawnTs: Date.now() - BOOT_MS - 500, sawInit: false }))
    const reader = drainAfter(fd, 1_500)
    const t0 = Date.now()
    const res = await write(core)
    const wire = reader.stop()
    expect(res).toMatchObject({ ok: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_300)
    expect(ctx.sessions.get('sid')!.state).toBe('running')
    expect(wire.trim().length).toBeGreaterThan(BIG.length)
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

  it('a line queued behind a hold gets its own window once the CLI boots (no reap of the booted CLI)', async () => {
    await ctx.cleanup()
    ctx = await buildDeps({ fifoWriteDeadlineMs: 1_000, fifoBootWriteDeadlineMs: 1_500, fifoBootHoldMaxMs: 20_000 })
    const core = createDaemonCore(ctx.deps)
    const { fifo, fd } = stalledFifo()
    // Past its boot deadline already: the first write is held from its first full pipe.
    const session = makeTestSession({ pid: 909, pipePath: fifo, spawnTs: Date.now() - 2_000, sawInit: false })
    ctx.sessions.set('sid', session)
    const first = core.handleSendCommand('sid', BIG)
    // Queued once the first write holds (its plain window ran out at 1 s).
    await new Promise((r) => setTimeout(r, 1_300))
    const second = core.handleSendCommand('sid', 'second'.padEnd(BIG.length, 'q'))
    // The CLI reads 2.5 s later, past the second write's own plain window, and shows its
    // init once it took the first line, before the second one is in.
    await new Promise((r) => setTimeout(r, 2_500))
    void first.then(() => { session.sawInit = true })
    const reader = drainAfter(fd, 0)
    const [a, b] = await Promise.all([first, second])
    const wire = reader.stop()
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(session.state).toBe('running')
    expect(wire.trim().split('\n').map((l) => JSON.parse(l).message.content.slice(0, 6))).toEqual(['zzzzzz', 'second'])
    expect(session.fifoBootWaitUntil).toBeUndefined()
  }, 20_000)

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
