/**
 * L1.5 daemon-cmd-send strict-ack.
 *
 * Validates P5.1: cmdSend returns a strict status envelope instead of
 * optimistic `ok:true`, with specific reason codes the client can branch on.
 *
 * Branches:
 *   - missing sid/message    → { error: '...' }
 *   - not_found               → { ok:false, reason:'not_found' }
 *   - session_dead            → { ok:false, reason:'session_dead', exitCode }
 *   - precheck ESRCH          → reap(send-precheck-dead) + session_dead
 *   - FIFO write ENXIO        → reap(send-enxio) + reason:'ENXIO'
 *   - FIFO write EAGAIN       → reason:'EAGAIN', retriable:true (no reap)
 *   - FIFO large payload      → loops past PIPE_BUF; full write or session_dead
 *   - successful write        → { ok:true }
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import {
  buildDeps,
  makeTestSession,
  createDaemonCore,
  killWithDead,
} from '../helpers/daemon-core-fixtures.js'

describe('L1.5 daemon cmdSend strict-ack', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    ctx = await buildDeps()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  function makeFifo(): string {
    const p = path.join(ctx.tmpDir, `fifo-${Math.random().toString(36).slice(2)}.pipe`)
    try { execSync(`mkfifo ${p}`) } catch (err) {
      throw new Error('mkfifo failed (needed for strict-ack FIFO tests): ' + (err as Error).message)
    }
    return p
  }

  // S1 — missing fields
  it('missing sid returns {error:...}', async () => {
    const core = createDaemonCore(ctx.deps)
    const res = await core.handleSendCommand(undefined, 'hello')
    expect(res).toMatchObject({ error: expect.stringContaining('missing sid') })
  })

  it('missing message returns {error:...}', async () => {
    const core = createDaemonCore(ctx.deps)
    const res = await core.handleSendCommand('sid-x', undefined)
    expect(res).toMatchObject({ error: expect.stringContaining('missing') })
  })

  // S2 — unknown session
  it('session not in Map returns {ok:false, reason:not_found}', async () => {
    const core = createDaemonCore(ctx.deps)
    const res = await core.handleSendCommand('ghost', 'hello')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  // S3 — session already dead
  it('session with state=dead returns {ok:false, reason:session_dead, exitCode}', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 100, state: 'dead', exitCode: 7 }))

    const res = await core.handleSendCommand('sid', 'hello')
    expect(res).toEqual({ ok: false, reason: 'session_dead', exitCode: 7 })
  })

  // S4 — precheck kill(pid,0) ESRCH reaps + returns session_dead
  it('precheck ESRCH reaps(send-precheck-dead) and returns session_dead', async () => {
    const freshCtx = await buildDeps({ killImpl: killWithDead(new Set([200])) })
    try {
      const core = createDaemonCore(freshCtx.deps)
      freshCtx.sessions.set('sid', makeTestSession({ pid: 200 }))

      const res = await core.handleSendCommand('sid', 'hello')

      expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
      expect(freshCtx.sessions.get('sid')!.state).toBe('dead')
      expect(freshCtx.sessions.get('sid')!.exitReason).toBe('send-precheck-dead')
    } finally {
      await freshCtx.cleanup()
    }
  })

  // S5 — FIFO write ENXIO reaps + returns ENXIO
  it('FIFO write with no reader (ENXIO) reaps(send-enxio) and returns reason=ENXIO', async () => {
    const core = createDaemonCore(ctx.deps)
    // Use a path that doesn't exist — open(O_WRONLY|O_NONBLOCK) will throw
    // ENOENT, but we want ENXIO (readerless FIFO). Make a real FIFO with no
    // reader.
    const fifo = makeFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 300, pipePath: fifo }))

    const res = await core.handleSendCommand('sid', 'hello')

    expect(res).toMatchObject({ ok: false, reason: 'ENXIO' })
    expect(ctx.sessions.get('sid')!.state).toBe('dead')
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-enxio')
  })

  // S6 — successful write when FIFO has a reader
  it('successful FIFO write returns {ok:true} and does NOT reap', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()

    // Open reader in background so writer won't get ENXIO.
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)

    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 400, pipePath: fifo }))
      const res = await core.handleSendCommand('sid', 'hello-world')
      expect(res).toEqual({ ok: true })
      expect(ctx.sessions.get('sid')!.state).toBe('running')
    } finally {
      fs.closeSync(readerFd)
    }
  })

  // S7 — ENOENT (pipe file missing entirely) surfaces as {error:...}
  it('pipePath missing entirely → {error:...}, not ENXIO', async () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({
      pid: 500,
      pipePath: path.join(ctx.tmpDir, 'does-not-exist.pipe'),
    }))
    const res = await core.handleSendCommand('sid', 'hello')
    expect('error' in res).toBe(true)
    // Session NOT reaped (this is a bug signal, not a dead-process signal)
    expect(ctx.sessions.get('sid')!.state).toBe('running')
  })

  // S8a — payload larger than PIPE_BUF writes fully without truncation.
  //
  // Regression: PIPE_BUF on macOS is 512 bytes; the pre-fix code did a single
  // non-blocking writeSync and returned `partial_write` if the kernel didn't
  // accept all bytes, leaving the FIFO holding half a JSON line. The CLI's
  // stdin parser would then splice the truncated fragment with the next
  // write's bytes, JSON.parse would throw, and the CLI would exit with no
  // diagnostic to walnut. The fix loops in writeFifoFully(). This test sends
  // a payload well above PIPE_BUF (and small enough to fit in the kernel's
  // pipe buffer so the test's lazy reader doesn't deadlock) and verifies the
  // bytes round-trip intact.
  it('payload larger than PIPE_BUF writes fully (no truncation)', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 650, pipePath: fifo }))
      const big = 'x'.repeat(4 * 1024) // 4KB ≫ PIPE_BUF (512B), well under pipe buffer
      const res = await core.handleSendCommand('sid', big)
      expect(res).toEqual({ ok: true })

      // Drain the FIFO until we see a newline.
      const chunks: Buffer[] = []
      for (let i = 0; i < 100; i++) {
        const buf = Buffer.alloc(8192)
        let n = 0
        try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) } catch {}
            continue
          }
          throw err
        }
        if (n === 0) break
        chunks.push(buf.slice(0, n))
        if (buf.slice(0, n).includes(0x0a)) break
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8').trim())
      expect(parsed.message.content).toBe(big)
    } finally {
      fs.closeSync(readerFd)
    }
  })

  // S8 — message payload is wrapped {type:'user', message:{role:'user',content}}
  it('written payload is JSON {type:user, message:{role:user, content:...}}', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 600, pipePath: fifo }))
      await core.handleSendCommand('sid', 'payload-shape-test')

      // Drain what was written
      const buf = Buffer.alloc(4096)
      const n = fs.readSync(readerFd, buf, 0, buf.length, null)
      const line = buf.slice(0, n).toString('utf-8').trim()
      const parsed = JSON.parse(line)
      expect(parsed).toEqual({
        type: 'user',
        message: { role: 'user', content: 'payload-shape-test' },
      })
    } finally {
      fs.closeSync(readerFd)
    }
  })

  // ── Boot-race regression (2026-08-13 incident) ──
  //
  // A freshly-spawned CLI takes 2-7s before it reads stdin; a first-turn prompt
  // larger than the kernel pipe buffer therefore goes PARTIAL and stalls until
  // the CLI starts draining. The old writer gave up after a 500ms sync budget
  // and the caller reaped the healthy booting process (sendRaw-partial-write,
  // observed 1.9s after spawn — session then unrecoverable because the CLI
  // never persisted a conversation for --resume to find).
  //
  // This test reproduces the exact shape: a FIFO whose reader exists but does
  // NOT drain for ~2s (the booting CLI holds its read end open without
  // reading), and a payload far beyond the kernel pipe buffer. The fix keeps
  // retrying asynchronously past the stall, so the send must succeed.
  it('slow-boot reader: payload larger than pipe buffer survives a 2s drain stall (no reap)', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    // Reader end open (like a spawned CLI's stdin) but not consuming yet.
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 700, pipePath: fifo }))
      // macOS/Linux default pipe buffer is 64KB — 256KB forces multiple stalls.
      const big = 'y'.repeat(256 * 1024)
      const sendPromise = core.handleSendCommand('sid', big)

      // Simulate the CLI finishing boot after 2s, then draining continuously.
      const chunks: Buffer[] = []
      await new Promise((r) => setTimeout(r, 2000))
      const drain = setInterval(() => {
        try {
          for (;;) {
            const buf = Buffer.alloc(64 * 1024)
            const n = fs.readSync(readerFd, buf, 0, buf.length, null)
            if (n <= 0) break
            chunks.push(buf.slice(0, n))
          }
        } catch { /* EAGAIN — nothing to read yet */ }
      }, 10)
      try {
        const res = await sendPromise
        expect(res).toEqual({ ok: true })
        // The stalled write must NOT have reaped the session.
        expect(ctx.sessions.get('sid')!.state).toBe('running')
      } finally {
        clearInterval(drain)
      }
      // Drain whatever remains and verify the line arrived intact.
      for (let i = 0; i < 200; i++) {
        try {
          const buf = Buffer.alloc(64 * 1024)
          const n = fs.readSync(readerFd, buf, 0, buf.length, null)
          if (n > 0) { chunks.push(buf.slice(0, n)); continue }
          break
        } catch { break }
      }
      const wire = Buffer.concat(chunks).toString('utf-8')
      expect(wire.endsWith('\n')).toBe(true)
      const parsed = JSON.parse(wire.trim())
      expect(parsed.message.content).toBe(big)
    } finally {
      fs.closeSync(readerFd)
    }
  }, 15_000)

  // Concurrent sends must not interleave partial writes: with async retries a
  // second send could otherwise splice its bytes into the middle of the first
  // send's stalled payload, corrupting both lines. The per-session write chain
  // serializes them — both lines must arrive whole and in order.
  it('two concurrent sends to a stalled pipe arrive as two intact ordered lines', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 710, pipePath: fifo }))
      const first = 'a'.repeat(128 * 1024)
      const second = 'b'.repeat(128 * 1024)
      const p1 = core.handleSendCommand('sid', first)
      const p2 = core.handleSendCommand('sid', second)

      const chunks: Buffer[] = []
      await new Promise((r) => setTimeout(r, 500))
      const drain = setInterval(() => {
        try {
          for (;;) {
            const buf = Buffer.alloc(64 * 1024)
            const n = fs.readSync(readerFd, buf, 0, buf.length, null)
            if (n <= 0) break
            chunks.push(buf.slice(0, n))
          }
        } catch { /* EAGAIN */ }
      }, 10)
      try {
        expect(await p1).toEqual({ ok: true })
        expect(await p2).toEqual({ ok: true })
      } finally {
        clearInterval(drain)
      }
      for (let i = 0; i < 200; i++) {
        try {
          const buf = Buffer.alloc(64 * 1024)
          const n = fs.readSync(readerFd, buf, 0, buf.length, null)
          if (n > 0) { chunks.push(buf.slice(0, n)); continue }
          break
        } catch { break }
      }
      const lines = Buffer.concat(chunks).toString('utf-8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).message.content).toBe(first)
      expect(JSON.parse(lines[1]).message.content).toBe(second)
    } finally {
      fs.closeSync(readerFd)
    }
  }, 15_000)

  // Deadline expiry with ZERO bytes accepted must stay retriable (EAGAIN, no
  // reap) — a CLI that boots slower than the deadline gets another chance.
  it('deadline expiry with zero bytes written returns EAGAIN and does not reap', async () => {
    const freshCtx = await buildDeps({ fifoWriteDeadlineMs: 300 })
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'stall.pipe')
      execSync(`mkfifo ${JSON.stringify(fifo)}`)
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 720, pipePath: fifo }))
        // Fill the kernel buffer completely so OUR payload can't land a byte.
        const fillFd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
        try {
          const filler = Buffer.alloc(64 * 1024, 0x7a)
          for (;;) {
            try { if (fs.writeSync(fillFd, filler, 0, filler.length) === 0) break } catch { break }
          }
        } finally {
          fs.closeSync(fillFd)
        }

        const res = await core.handleSendCommand('sid', 'never-lands')
        expect(res).toEqual({ ok: false, reason: 'EAGAIN', retriable: true })
        expect(freshCtx.sessions.get('sid')!.state).toBe('running')
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  }, 15_000)
})
