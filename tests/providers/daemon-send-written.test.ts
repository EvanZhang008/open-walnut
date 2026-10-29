/**
 * A FIFO write of a user line that failed part way says how far it got.
 *
 * Before (2026-10-24 diagnosis): EPIPE at any offset answered `ENXIO`, and a
 * write that put a prefix in and then hit its deadline answered `session_dead`,
 * the same two shapes a session that died before the first byte gives. The
 * companion's direct send read both as "not sent", cleared its intent and told
 * the phone so, though part or all of the line might be in the CLI, and a retry
 * could run the message twice.
 *
 * Now each failed write's answer carries `written`: none | prefix | body | line
 * (lineWrittenPart). The reason, the reap and EAGAIN stay exactly as before.
 *
 * What's real: daemon-core's handleSendCommand, chainFifoWrite and
 * writeFifoFullyAsync, real FIFOs. What's faked: fs.writeSync where a test needs
 * the kernel to refuse at an exact byte (EPIPE, EIO), and no process is signalled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

type Ctx = Awaited<ReturnType<typeof buildDeps>>

/** fs whose writeSync takes at most `after` bytes in total, then throws `code`. */
function refuseAfter(after: number, code: string): typeof fs {
  let total = 0
  return {
    ...fs,
    constants: fs.constants,
    writeSync: ((fd: number, buf: Buffer, off: number, len: number) => {
      if (total >= after) {
        const err = new Error(`${code}: refused by the test`) as NodeJS.ErrnoException
        err.code = code
        throw err
      }
      const n = fs.writeSync(fd, buf, off, Math.min(len, after - total))
      total += n
      return n
    }) as typeof fs.writeSync,
  } as typeof fs
}

describe('a failed FIFO write says how much of the line went in', () => {
  let ctx: Ctx
  let readers: number[] = []

  beforeEach(async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process signal in a FIFO test') })
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {})
    readers = []
  })

  afterEach(async () => {
    for (const fd of readers) { try { fs.closeSync(fd) } catch { /* closed */ } }
    try { await ctx?.cleanup() } finally { vi.restoreAllMocks() }
  })

  /** A session on a real FIFO with an open reader, so the write is not refused at open. */
  async function session(opts: { fsProxy?: typeof fs; deadlineMs?: number; pid?: number } = {}) {
    ctx = await buildDeps(opts.deadlineMs ? { fifoWriteDeadlineMs: opts.deadlineMs } : {})
    if (opts.fsProxy) ctx.deps.fs = opts.fsProxy
    const fifo = path.join(ctx.tmpDir, `w-${Math.random().toString(36).slice(2)}.pipe`)
    execFileSync('mkfifo', [fifo])
    const jsonlPath = path.join(ctx.tmpDir, 'w.jsonl')
    fs.writeFileSync(jsonlPath, '')
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    readers.push(readerFd)
    const pid = opts.pid ?? 960
    ctx.sessions.set('sid', makeTestSession({ pid, pipePath: fifo, jsonlPath }))
    return { core: createDaemonCore(ctx.deps), fifo, readerFd, pid }
  }
  const batch = [{ message: 'hello', messageId: 'qm-w' }]

  it('EPIPE after part of the body: ENXIO as before, written prefix', async () => {
    const { core } = await session({ fsProxy: refuseAfter(10, 'EPIPE') })
    const res = await core.handleSendCommand('sid', 'hello', 'u-1', batch)
    expect(res).toMatchObject({ ok: false, reason: 'ENXIO', written: 'prefix' })
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-enxio')
  })

  it('EPIPE on the final newline (the whole body is in): written body', async () => {
    // The line's bytes without its newline: the marker barrier writes the newline on its own.
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u-1' })
    const { core } = await session({ fsProxy: refuseAfter(Buffer.byteLength(payload), 'EPIPE') })
    const res = await core.handleSendCommand('sid', 'hello', 'u-1', batch)
    expect(res).toMatchObject({ ok: false, reason: 'ENXIO', written: 'body' })
  })

  it('EPIPE before the first byte: written none (nothing of the line can be in the CLI)', async () => {
    const { core } = await session({ fsProxy: refuseAfter(0, 'EPIPE') })
    expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toMatchObject({ ok: false, reason: 'ENXIO', written: 'none' })
  })

  it('no reader at open (the process is gone): ENXIO, written none', async () => {
    ctx = await buildDeps()
    const fifo = path.join(ctx.tmpDir, 'gone.pipe')
    execFileSync('mkfifo', [fifo])
    ctx.sessions.set('sid', makeTestSession({ pid: 961, pipePath: fifo, jsonlPath: path.join(ctx.tmpDir, 'gone.jsonl') }))
    const res = await createDaemonCore(ctx.deps).handleSendCommand('sid', 'hello', 'u-1', batch)
    expect(res).toMatchObject({ ok: false, reason: 'ENXIO', written: 'none' })
  })

  it('a rewrite cut right after its leading newline: written none (a blank line runs nothing)', async () => {
    // lostPid of the running process: the daemon writes "\n" + the line (send-lost-line-v1).
    const { core } = await session({ fsProxy: refuseAfter(1, 'EPIPE'), pid: 962 })
    const res = await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true, lostPid: 962 })
    expect(res).toMatchObject({ ok: false, reason: 'ENXIO', written: 'none' })
  })

  it('the deadline passes with a prefix in the pipe: session_dead as before, written prefix', async () => {
    const { core, fifo } = await session({ deadlineMs: 300 })
    // Fill the pipe, then make room for only a few bytes of the line.
    const w = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    try {
      const filler = Buffer.alloc(64 * 1024, 0x0a)
      for (;;) { try { if (fs.writeSync(w, filler, 0, filler.length) === 0) break } catch { break } }
    } finally { fs.closeSync(w) }
    const big = 'x'.repeat(200 * 1024)
    // Free one page so a prefix fits, and no more: the reader then stalls.
    fs.readSync(readers[0], Buffer.alloc(4096), 0, 4096, null)
    const res = await core.handleSendCommand('sid', big, 'u-1', [{ message: big, messageId: 'qm-w' }])
    expect(res).toMatchObject({ ok: false, reason: 'session_dead', written: 'prefix' })
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-partial-write')
  }, 15_000)

  it('a failed marker append withholds the newline: session_dead, written body', async () => {
    const proxy = {
      ...fs, constants: fs.constants,
      appendFileSync: ((p: string, data: string) => {
        if (String(p).endsWith('.lines')) return fs.appendFileSync(p, data)
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
        err.code = 'ENOSPC'
        throw err
      }) as typeof fs.appendFileSync,
    } as typeof fs
    const { core } = await session({ fsProxy: proxy })
    expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toMatchObject({ ok: false, reason: 'session_dead', written: 'body' })
  })

  it('an unclassified write error after a prefix: the error, written prefix', async () => {
    const { core } = await session({ fsProxy: refuseAfter(5, 'EIO') })
    const res = await core.handleSendCommand('sid', 'hello', 'u-1', batch)
    expect(res).toEqual({ error: expect.stringMatching(/^send failed: EIO/), written: 'prefix' })
  })

  it('a whole line written is a plain ok, unchanged', async () => {
    const { core } = await session()
    expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: true })
  })
})
