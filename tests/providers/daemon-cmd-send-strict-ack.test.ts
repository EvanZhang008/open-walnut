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
 *
 * send-markers-v1: the marker reaches disk after the body enters the pipe and before the newline; a failure never truncates or rewrites the stream.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
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
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Unexpected process signal in a FIFO test')
    })
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})
    ctx = await buildDeps()
  })

  afterEach(async () => {
    try {
      await ctx.cleanup()
    } finally {
      vi.restoreAllMocks()
    }
  })

  function makeFifo(): string {
    const p = path.join(ctx.tmpDir, `fifo-${Math.random().toString(36).slice(2)}.pipe`)
    try { execFileSync('mkfifo', [p]) } catch (err) {
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
      freshCtx.sessions.set('sid', makeTestSession({
        pid: 200,
        pipePath: path.join(freshCtx.tmpDir, 'precheck.pipe'),
        jsonlPath: path.join(freshCtx.tmpDir, 'precheck.jsonl'),
      }))

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
    ctx.sessions.set('sid', makeTestSession({
      pid: 300, pipePath: fifo, jsonlPath: path.join(ctx.tmpDir, 'no-reader.jsonl'),
    }))

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
      // No uuid was asked for, so the key must be ABSENT (not `null`, not
      // `undefined`): the CLI mints its own, exactly as before this parameter
      // existed. An extra key here is a wire change every older CLI would see.
      expect('uuid' in parsed).toBe(false)
    } finally {
      fs.closeSync(readerFd)
    }
  })

  // S8b — a pre-assigned uuid rides the SAME envelope as a top-level `uuid`.
  // Harness contract: the CLI persists the user line under exactly this uuid
  // (`createUserMessage`: uuid || randomUUID()), which is what lets a client key
  // metadata to a transcript line before the line exists.
  it('written payload carries top-level uuid when one is given', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 601, pipePath: fifo }))
      const uuid = '3f2b1a09-8c7d-4e6f-9a5b-0c1d2e3f4a5b'
      const res = await core.handleSendCommand('sid', 'anchored-send', uuid)
      expect(res).toEqual({ ok: true })

      const buf = Buffer.alloc(4096)
      const n = fs.readSync(readerFd, buf, 0, buf.length, null)
      const parsed = JSON.parse(buf.slice(0, n).toString('utf-8').trim())
      expect(parsed).toEqual({
        type: 'user',
        message: { role: 'user', content: 'anchored-send' },
        uuid,
      })
    } finally {
      fs.closeSync(readerFd)
    }
  })

  it('an empty-string uuid is treated as absent (no uuid key)', async () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 602, pipePath: fifo }))
      await core.handleSendCommand('sid', 'empty-uuid-send', '')

      const buf = Buffer.alloc(4096)
      const n = fs.readSync(readerFd, buf, 0, buf.length, null)
      const parsed = JSON.parse(buf.slice(0, n).toString('utf-8').trim())
      expect('uuid' in parsed).toBe(false)
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

  // send-markers-v1 newline fence: wrap fs to record every write and append, then assert the order from the sequence itself, not from timing.
  interface Traced {
    events: string[]
    fsProxy: typeof fs
  }

  function traceFs(opts: {
    onNewline?: () => void
    failAppend?: boolean
  } = {}): Traced {
    const events: string[] = []
    const fsProxy = {
      ...fs,
      constants: fs.constants,
      // Record only the bytes that really landed, so EAGAIN retries do not turn into phantom segments.
      writeSync: ((fd: number, buf: Buffer, off: number, len: number) => {
        const isNewline = buf.subarray(off, off + len).toString('utf-8') === '\n'
        const n = fs.writeSync(fd, buf, off, len)
        if (n > 0) {
          events.push(isNewline ? 'newline' : 'body')
          if (isNewline) opts.onNewline?.()
        }
        return n
      }) as typeof fs.writeSync,
      appendFileSync: ((p: string, data: string) => {
        events.push('append')
        if (opts.failAppend) {
          const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
          err.code = 'ENOSPC'
          throw err
        }
        return fs.appendFileSync(p, data)
      }) as typeof fs.appendFileSync,
    } as typeof fs
    return { events, fsProxy }
  }

  function jsonlLines(p: string): Record<string, unknown>[] {
    if (!fs.existsSync(p)) return []
    return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }

  function drain(readerFd: number): string {
    const chunks: Buffer[] = []
    for (let i = 0; i < 50; i++) {
      const buf = Buffer.alloc(64 * 1024)
      let n = 0
      try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch { break }
      if (n <= 0) break
      chunks.push(buf.subarray(0, n))
    }
    return Buffer.concat(chunks).toString('utf-8')
  }

  it('markers land between the payload body and its newline', async () => {
    const traced = traceFs()
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'barrier.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'barrier.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 800, pipePath: fifo, jsonlPath }))
        const res = await core.handleSendCommand('sid', 'ordered-send', undefined, [
          { message: 'ordered-send', messageId: 'qm-1' },
        ])
        expect(res).toEqual({ ok: true })
        expect(traced.events).toEqual(['body', 'append', 'newline'])

        const lines = jsonlLines(jsonlPath)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
          type: 'user',
          subtype: 'walnut-injected',
          walnutMessageId: 'qm-1',
          walnutDelivery: 'ordered',
        })
        expect(JSON.parse(drain(readerFd).trim())).toMatchObject({
          message: { role: 'user', content: 'ordered-send' },
        })
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  })

  // The regression this fix targets: the CLI writes its reply through its own O_APPEND fd as soon as it sees a complete line, so the marker must already be ahead of it.
  it('a reply written the instant the newline lands still comes AFTER the marker', async () => {
    const freshCtx = await buildDeps()
    const jsonlPath = path.join(freshCtx.tmpDir, 'reply-race.jsonl')
    const traced = traceFs({
      onNewline: () => {
        fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'assistant', id: 'reply' }) + '\n')
        fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'result', subtype: 'success' }) + '\n')
      },
    })
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'reply-race.pipe')
      execFileSync('mkfifo', [fifo])
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 810, pipePath: fifo, jsonlPath }))
        const res = await core.handleSendCommand('sid', 'race-send', undefined, [
          { message: 'race-send', messageId: 'qm-race' },
        ])
        expect(res).toEqual({ ok: true })
        const kinds = jsonlLines(jsonlPath).map((l) => `${l.type}${l.subtype ? ':' + l.subtype : ''}`)
        expect(kinds).toEqual(['user:walnut-injected', 'assistant', 'result:success'])
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  })

  // One batch = one payload and N markers, and all of them must land before the newline.
  it('every marker of a batch is appended before the newline', async () => {
    const traced = traceFs()
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'batch.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'batch.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 820, pipePath: fifo, jsonlPath }))
        const res = await core.handleSendCommand('sid', 'a\n\nb', undefined, [
          { message: 'a', messageId: 'qm-a' },
          { message: 'b', messageId: 'qm-b' },
        ])
        expect(res).toEqual({ ok: true })
        expect(traced.events).toEqual(['body', 'append', 'append', 'newline'])
        expect(jsonlLines(jsonlPath).map((l) => l.walnutMessageId)).toEqual(['qm-a', 'qm-b'])
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  })

  // A failed append never releases the newline: the body is already in the pipe, which is the existing 'partial' shape (reap, never truncate the stream).
  it('a failed marker append withholds the newline and funnels to session_dead', async () => {
    const traced = traceFs({ failAppend: true })
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'append-fail.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'append-fail.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 830, pipePath: fifo, jsonlPath }))
        const res = await core.handleSendCommand('sid', 'no-marker', undefined, [
          { message: 'no-marker', messageId: 'qm-fail' },
        ])
        expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
        expect(freshCtx.sessions.get('sid')!.exitReason).toBe('send-partial-write')
        expect(traced.events).toEqual(['body', 'append'])
        const wire = drain(readerFd)
        expect(wire.includes('\n')).toBe(false)
        expect(wire.includes('no-marker')).toBe(true)
        expect(fs.readFileSync(jsonlPath, 'utf-8')).toBe('')
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  })

  it('ENXIO before any byte writes no marker at all', async () => {
    const traced = traceFs()
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'no-reader.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'no-reader.jsonl')
      fs.writeFileSync(jsonlPath, '')
      freshCtx.sessions.set('sid', makeTestSession({ pid: 840, pipePath: fifo, jsonlPath }))
      const res = await core.handleSendCommand('sid', 'never-delivered', undefined, [
        { message: 'never-delivered', messageId: 'qm-enxio' },
      ])
      expect(res).toMatchObject({ ok: false, reason: 'ENXIO' })
      expect(traced.events).toEqual([])
      expect(fs.readFileSync(jsonlPath, 'utf-8')).toBe('')
    } finally {
      await freshCtx.cleanup()
    }
  })

  it('EAGAIN with zero bytes accepted writes no marker and stays retriable', async () => {
    const traced = traceFs()
    const freshCtx = await buildDeps({ fifoWriteDeadlineMs: 300 })
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'stall-marker.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'stall-marker.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 850, pipePath: fifo, jsonlPath }))
        const fillFd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
        try {
          const filler = Buffer.alloc(64 * 1024, 0x7a)
          for (;;) {
            try { if (fs.writeSync(fillFd, filler, 0, filler.length) === 0) break } catch { break }
          }
        } finally {
          fs.closeSync(fillFd)
        }

        const res = await core.handleSendCommand('sid', 'never-lands', undefined, [
          { message: 'never-lands', messageId: 'qm-eagain' },
        ])
        expect(res).toEqual({ ok: false, reason: 'EAGAIN', retriable: true })
        expect(freshCtx.sessions.get('sid')!.state).toBe('running')
        expect(traced.events.includes('append')).toBe(false)
        expect(fs.readFileSync(jsonlPath, 'utf-8')).toBe('')
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  }, 15_000)

  // Segmented writes (payload far larger than the pipe buffer + a stalled reader) plus concurrency: each marker may land only inside its own delivery.
  it('segmented + concurrent sends keep each marker inside its own delivery', async () => {
    const traced = traceFs()
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'segmented.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'segmented.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 860, pipePath: fifo, jsonlPath }))
        const first = 'a'.repeat(128 * 1024)
        const second = 'b'.repeat(128 * 1024)
        const p1 = core.handleSendCommand('sid', first, undefined, [{ message: first, messageId: 'qm-1' }])
        const p2 = core.handleSendCommand('sid', second, undefined, [{ message: second, messageId: 'qm-2' }])

        const chunks: Buffer[] = []
        await new Promise((r) => setTimeout(r, 300))
        const pump = setInterval(() => {
          try {
            for (;;) {
              const buf = Buffer.alloc(64 * 1024)
              const n = fs.readSync(readerFd, buf, 0, buf.length, null)
              if (n <= 0) break
              chunks.push(buf.subarray(0, n))
            }
          } catch { /* EAGAIN */ }
        }, 10)
        try {
          expect(await p1).toEqual({ ok: true })
          expect(await p2).toEqual({ ok: true })
        } finally {
          clearInterval(pump)
        }
        chunks.push(Buffer.from(drain(readerFd)))

        // Every delivery is body...append...newline; an append never lands in the middle of another delivery.
        const appendPositions = traced.events
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => e === 'append')
          .map(({ i }) => i)
        expect(appendPositions).toHaveLength(2)
        for (const at of appendPositions) {
          expect(traced.events[at - 1]).toBe('body')
          expect(traced.events[at + 1]).toBe('newline')
        }
        expect(traced.events.filter((e) => e === 'newline')).toHaveLength(2)
        expect(jsonlLines(jsonlPath).map((l) => l.walnutMessageId)).toEqual(['qm-1', 'qm-2'])

        const lines = Buffer.concat(chunks).toString('utf-8').trim().split('\n')
        expect(lines).toHaveLength(2)
        expect(JSON.parse(lines[0]).message.content).toBe(first)
        expect(JSON.parse(lines[1]).message.content).toBe(second)
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  }, 20_000)

  it.each([
    { markers: 'not-an-array', label: 'non-array' },
    { markers: [{ messageId: 'qm-1' }], label: 'missing message' },
    { markers: [{ message: 'hi', messageId: '' }], label: 'empty messageId' },
    { markers: [null], label: 'null entry' },
  ])('invalid markers ($label) error out before any FIFO write', async ({ markers }) => {
    const traced = traceFs()
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const jsonlPath = path.join(freshCtx.tmpDir, 'invalid.jsonl')
      fs.writeFileSync(jsonlPath, '')
      freshCtx.sessions.set('sid', makeTestSession({
        pid: 870,
        pipePath: path.join(freshCtx.tmpDir, 'invalid.pipe'),
        jsonlPath,
      }))
      const res = await core.handleSendCommand('sid', 'hi', undefined, markers as never)
      expect('error' in res).toBe(true)
      expect(traced.events).toEqual([])
      expect(freshCtx.sessions.get('sid')!.state).toBe('running')
      expect(fs.readFileSync(jsonlPath, 'utf-8')).toBe('')
    } finally {
      await freshCtx.cleanup()
    }
  })

  it('a send without markers is byte-identical to the pre-feature payload', async () => {
    const traced = traceFs()
    const freshCtx = await buildDeps()
    freshCtx.deps.fs = traced.fsProxy
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'legacy.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(freshCtx.tmpDir, 'legacy.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        freshCtx.sessions.set('sid', makeTestSession({ pid: 880, pipePath: fifo, jsonlPath }))
        expect(await core.handleSendCommand('sid', 'legacy-send')).toEqual({ ok: true })
        // body+newline go out in one write (no fence split), and the stream file is untouched.
        expect(traced.events).toEqual(['body'])
        expect(fs.readFileSync(jsonlPath, 'utf-8')).toBe('')
        expect(drain(readerFd)).toBe(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'legacy-send' },
        }) + '\n')
      } finally {
        fs.closeSync(readerFd)
      }
    } finally {
      await freshCtx.cleanup()
    }
  })

  // Deadline expiry with ZERO bytes accepted must stay retriable (EAGAIN, no
  // reap) — a CLI that boots slower than the deadline gets another chance.
  it('deadline expiry with zero bytes written returns EAGAIN and does not reap', async () => {
    const freshCtx = await buildDeps({ fifoWriteDeadlineMs: 300 })
    try {
      const core = createDaemonCore(freshCtx.deps)
      const fifo = path.join(freshCtx.tmpDir, 'stall.pipe')
      execFileSync('mkfifo', [fifo])
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
