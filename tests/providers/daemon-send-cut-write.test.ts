/**
 * r4c gate F1, daemon half: a daemon that stopped inside a write (between two
 * chunks of a long line) leaves a piece of the line in the CLI's stdin pipe,
 * with no marker and no write record. The resend used to be written straight
 * after that piece: one malformed line the CLI exits on, while the daemon
 * answered a plain ok, so the server counted the line delivered (0 runs after
 * a 202). Now the daemon notes a `begin` before the first byte; a resend into
 * the same process that finds a begin with no whole write after it ends the
 * piece with a newline and answers `{ ok: true, cut: true }`, so the server
 * keeps the line until the CLI names it or hands it to the next process.
 *
 * The stop is reproduced in the writer itself: an fs whose writeSync puts the
 * first `stopAt` bytes of the attempt into the real FIFO and then throws, so
 * nothing after that point runs (no marker, no record), as with a daemon that
 * went away mid write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

describe('a resend after a write the daemon stopped inside (r4c F1)', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>
  let now = 1_000_000

  beforeEach(async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Unexpected process signal in a FIFO test')
    })
    now = 1_000_000
    ctx = await buildDeps({ clockImpl: () => now })
  })

  afterEach(async () => {
    try { await ctx.cleanup() } finally { vi.restoreAllMocks() }
  })

  const batch = [{ message: 'a long first message', messageId: 'qm-1' }]
  const text = 'x'.repeat(4000)
  const lineOf = (uuid: string) => ({ type: 'user', message: { role: 'user', content: text }, uuid })

  function pipe(name: string): { fifo: string; readerFd: number } {
    const fifo = path.join(ctx.tmpDir, `${name}.pipe`)
    execFileSync('mkfifo', [fifo])
    return { fifo, readerFd: fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) }
  }

  function session(name: string, pid: number) {
    const { fifo, readerFd } = pipe(name)
    const jsonlPath = path.join(ctx.tmpDir, `${name}.jsonl`)
    fs.writeFileSync(jsonlPath, '')
    ctx.sessions.set('sid', makeTestSession({ pid, pipePath: fifo, jsonlPath }))
    return { readerFd, jsonlPath }
  }

  /** A daemon whose write stops part way: `stopAt` bytes go in, or the body but not its newline. */
  function stoppingCore(stop: { stopAt?: number; beforeNewline?: boolean }) {
    let put = 0
    const proxy = {
      ...fs,
      constants: fs.constants,
      writeSync: ((fd: number, buf: Buffer, off: number, len: number) => {
        if (stop.beforeNewline && off > 0 && buf.subarray(off, off + len).toString('utf8') === '\n') throw new Error('writer stopped')
        if (stop.stopAt !== undefined) {
          if (put >= stop.stopAt) throw new Error('writer stopped')
          len = Math.min(len, stop.stopAt - put)
        }
        const n = fs.writeSync(fd, buf, off, len)
        put += n
        return n
      }) as typeof fs.writeSync,
    } as typeof fs
    return createDaemonCore({ ...ctx.deps, fs: proxy })
  }

  /** A pipe that stays full for the whole deadline: every write is EAGAIN, and the clock runs past it. */
  function fullPipeCore() {
    const proxy = {
      ...fs,
      constants: fs.constants,
      writeSync: (() => {
        now += 30_000
        throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' })
      }) as typeof fs.writeSync,
    } as typeof fs
    return createDaemonCore({ ...ctx.deps, fs: proxy })
  }

  /** What the CLI's line reader gets: each line a newline ended (blank ones too), and what still waits. */
  function cliReads(readerFd: number): { lines: Array<Record<string, unknown> | '' | 'MALFORMED'>; held: string } {
    const chunks: Buffer[] = []
    for (let i = 0; i < 50; i++) {
      const buf = Buffer.alloc(64 * 1024)
      let n = 0
      try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch { break }
      if (n <= 0) break
      chunks.push(buf.subarray(0, n))
    }
    const parts = Buffer.concat(chunks).toString('utf8').split('\n')
    const held = parts.pop() ?? ''
    return {
      lines: parts.map((l) => {
        if (l === '') return ''
        try { return JSON.parse(l) as Record<string, unknown> } catch { return 'MALFORMED' }
      }),
      held,
    }
  }
  const records = (jsonlPath: string) => fs.readFileSync(`${jsonlPath}.lines`, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const kinds = (jsonlPath: string) => records(jsonlPath)
    .map((r) => ('begin' in r ? 'begin' : 'unbegun' in r ? 'unbegun' : 'ids' in r ? 'ids' : 'other'))

  it('stopped inside the body: the resend ends the piece, writes the line, and says cut', async () => {
    const s = session('mid-body', 930)
    try {
      expect(await stoppingCore({ stopAt: 700 }).handleSendCommand('sid', text, 'u-1', batch)).toHaveProperty('error')
      expect(records(s.jsonlPath)).toMatchObject([{ pid: 930, uuid: 'u-1', begin: ['qm-1'] }])
      now += 5_000
      // The restarted daemon, the same CLI process, the server's resend.
      expect(await createDaemonCore(ctx.deps).handleSendCommand('sid', text, 'u-1', batch, { dedupe: true }))
        .toEqual({ ok: true, cut: true })
      // The CLI reads the piece as one malformed line (it exits on it) and never
      // gets to the copy: the answer must not count as a delivery.
      expect(cliReads(s.readerFd)).toEqual({ lines: ['MALFORMED', lineOf('u-1')], held: '' })
      expect(kinds(s.jsonlPath)).toEqual(['begin', 'begin', 'ids'])
    } finally { fs.closeSync(s.readerFd) }
  })

  // The r5 gate's N3 (probe PB): the resend in between got EAGAIN, and its unbegun took back
  // the first attempt's begin too, so the third write was glued onto the piece.
  it('stopped inside the body, then a resend that put not one byte in: the next resend still ends the piece and says cut', async () => {
    const s = session('eagain-between', 936)
    try {
      expect(await stoppingCore({ stopAt: 700 }).handleSendCommand('sid', text, 'u-1', batch)).toHaveProperty('error')
      now += 5_000
      expect(await fullPipeCore().handleSendCommand('sid', text, 'u-1', batch, { dedupe: true }))
        .toEqual({ ok: false, reason: 'EAGAIN', retriable: true })
      now += 5_000
      expect(await createDaemonCore(ctx.deps).handleSendCommand('sid', text, 'u-1', batch, { dedupe: true }))
        .toEqual({ ok: true, cut: true })
      expect(cliReads(s.readerFd)).toEqual({ lines: ['MALFORMED', lineOf('u-1')], held: '' })
      expect(kinds(s.jsonlPath)).toEqual(['begin', 'begin', 'unbegun', 'begin', 'ids'])
    } finally { fs.closeSync(s.readerFd) }
  })

  it('stopped after the body and its marker, before the newline: a newline first, not cut', async () => {
    const s = session('after-marker', 931)
    try {
      expect(await stoppingCore({ beforeNewline: true }).handleSendCommand('sid', text, 'u-1', batch)).toHaveProperty('error')
      now += 5_000
      expect(await createDaemonCore(ctx.deps).handleSendCommand('sid', text, 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      // Two whole lines under one uuid: the CLI runs the first and drops the copy.
      expect(cliReads(s.readerFd)).toEqual({ lines: [lineOf('u-1'), lineOf('u-1')], held: '' })
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a resend into a new process: no newline, not cut (nothing of the line went into it)', async () => {
    const s = session('respawn', 932)
    try {
      expect(await stoppingCore({ stopAt: 700 }).handleSendCommand('sid', text, 'u-1', batch)).toHaveProperty('error')
    } finally { fs.closeSync(s.readerFd) }
    // That process is gone; the next one has its own pipe and pid.
    const next = pipe('respawn-next')
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 933, pipePath: next.fifo, jsonlPath: s.jsonlPath }))
      now += 5_000
      expect(await createDaemonCore(ctx.deps).handleSendCommand('sid', text, 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      expect(cliReads(next.readerFd)).toEqual({ lines: [lineOf('u-1')], held: '' })
    } finally { fs.closeSync(next.readerFd) }
  })

  it('a finished write is still answered from its record: nothing written, never cut', async () => {
    const s = session('finished', 934)
    try {
      const core = createDaemonCore(ctx.deps)
      expect(await core.handleSendCommand('sid', text, 'u-1', batch)).toEqual({ ok: true })
      now += 5_000
      expect(await core.handleSendCommand('sid', text, 'u-1', batch, { dedupe: true })).toEqual({ ok: true, duplicate: true, fate: 'waiting' })
      expect(cliReads(s.readerFd).lines).toEqual([lineOf('u-1')])
    } finally { fs.closeSync(s.readerFd) }
  })

  it('send-lost-line-v1: a rewrite stopped inside its body makes the next rewrite say cut (the marker is older than the begin)', async () => {
    const s = session('rewrite', 935)
    try {
      const core = createDaemonCore(ctx.deps)
      expect(await core.handleSendCommand('sid', text, 'u-1', batch)).toEqual({ ok: true })
      // Another reader took the line (the server proved the CLI read past it).
      cliReads(s.readerFd)
      now += 30_000
      expect(await stoppingCore({ stopAt: 700 }).handleSendCommand('sid', text, 'u-1', batch, { dedupe: true, lostPid: 935 }))
        .toHaveProperty('error')
      now += 30_000
      expect(await core.handleSendCommand('sid', text, 'u-1', batch, { dedupe: true, lostPid: 935 })).toEqual({ ok: true, cut: true })
      // The first rewrite's own newline, its piece (ended by the second rewrite's newline), then the whole line.
      expect(cliReads(s.readerFd)).toEqual({ lines: ['', 'MALFORMED', lineOf('u-1')], held: '' })
    } finally { fs.closeSync(s.readerFd) }
  })
})
