/**
 * send-dedupe-v1: a resend of a line whose first send may already have landed.
 *
 * The server asks again with the same uuid, markers and `dedupe:true`. The
 * daemon writes the line only when nothing proves what became of it, and
 * otherwise answers `{ ok, duplicate, fate }` from evidence it holds:
 *
 * - the CLI's own `command_lifecycle` frames for the uuid in the stream file
 *   (ran / cancelled / dropped), whatever process printed them;
 * - its own write record (`<stream>.lines`), appended only after the final
 *   newline went into the pipe of the CLI running now (waiting);
 * - a marker stamped with that pid AND a later `queued` frame for the uuid.
 *
 * A marker alone is no proof: it is written before the newline, so a write cut
 * short by the daemon's death leaves one for a line the CLI never got (it must
 * be written again, never answered "duplicate"). A marker from an older daemon
 * has no pid and never counts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { buildDeps, makeTestSession, createDaemonCore } from '../helpers/daemon-core-fixtures.js'

const ROOT = path.resolve(__dirname, '../..')

describe('daemon send with dedupe (send-dedupe-v1)', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Unexpected process signal in a FIFO test')
    })
    ctx = await buildDeps()
  })

  afterEach(async () => {
    try { await ctx.cleanup() } finally { vi.restoreAllMocks() }
  })

  function fifoWithReader(name: string): { fifo: string; readerFd: number } {
    const fifo = path.join(ctx.tmpDir, `${name}.pipe`)
    execFileSync('mkfifo', [fifo])
    return { fifo, readerFd: fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) }
  }

  function drain(readerFd: number): string[] {
    const chunks: Buffer[] = []
    for (let i = 0; i < 50; i++) {
      const buf = Buffer.alloc(64 * 1024)
      let n = 0
      try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch { break }
      if (n <= 0) break
      chunks.push(buf.subarray(0, n))
    }
    return Buffer.concat(chunks).toString('utf-8').split('\n').filter(Boolean)
  }

  function markers(jsonlPath: string): Array<{ walnutMessageId?: string; walnutPid?: number }> {
    return fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((row) => row.subtype === 'walnut-injected')
  }

  const marker = (id: string, pid?: number) => JSON.stringify({
    type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'x' },
    walnutMessageId: id, walnutDelivery: 'ordered', ...(pid ? { walnutPid: pid } : {}),
  })
  const lifecycle = (uuid: string, state: string) => JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state })

  const batch = [{ message: 'hello', messageId: 'qm-1' }]

  function session(name: string, pid: number, stream = '') {
    const { fifo, readerFd } = fifoWithReader(name)
    const jsonlPath = path.join(ctx.tmpDir, `${name}.jsonl`)
    fs.writeFileSync(jsonlPath, stream)
    ctx.sessions.set('sid', makeTestSession({ pid, pipePath: fifo, jsonlPath }))
    return { readerFd, jsonlPath }
  }

  it('stamps each marker with the CLI pid and records the whole line after its newline', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('stamp', 900)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: true })
      expect(markers(s.jsonlPath)).toMatchObject([{ walnutMessageId: 'qm-1', walnutPid: 900 }])
      const records = fs.readFileSync(`${s.jsonlPath}.lines`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      expect(records).toMatchObject([{ pid: 900, uuid: 'u-1', ids: ['qm-1'] }])
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a resend into the process that already has the whole line writes nothing (waiting)', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('same', 901)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: true })
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true }))
        .toEqual({ ok: true, duplicate: true, fate: 'waiting' })
      expect(drain(s.readerFd)).toHaveLength(1)
      expect(markers(s.jsonlPath)).toHaveLength(1)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a resend that races the first write still waits for it, then writes nothing', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('race', 902)
    try {
      const first = core.handleSendCommand('sid', 'hello', 'u-1', batch)
      const again = core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })
      expect(await first).toEqual({ ok: true })
      expect(await again).toEqual({ ok: true, duplicate: true, fate: 'waiting' })
      expect(drain(s.readerFd)).toHaveLength(1)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a resend whose first attempt never arrived writes the line once', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('lost', 903)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      expect(drain(s.readerFd)).toHaveLength(1)
      expect(markers(s.jsonlPath)).toMatchObject([{ walnutMessageId: 'qm-1', walnutPid: 903 }])
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a write cut short by the daemon\'s death (marker, no record) is written again, never "duplicate"', async () => {
    const core = createDaemonCore(ctx.deps)
    // The old daemon wrote the body and the marker, then died before the newline.
    const s = session('torn', 904, `${marker('qm-1', 904)}\n`)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      expect(drain(s.readerFd)).toHaveLength(1)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a marker from an older daemon (no pid) never counts', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('old', 905, `${marker('qm-1')}\n${lifecycle('u-1', 'queued')}\n`)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      expect(drain(s.readerFd)).toHaveLength(1)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('a marker for this process plus the CLI\'s queued frame proves the line is in (record lost)', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('queued', 906, `${marker('qm-1', 906)}\n${lifecycle('u-1', 'queued')}\n`)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true }))
        .toEqual({ ok: true, duplicate: true, fate: 'waiting', state: 'queued' })
      expect(drain(s.readerFd)).toHaveLength(0)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('the CLI\'s own word settles it in any process: started, cancelled, discarded', async () => {
    const core = createDaemonCore(ctx.deps)
    for (const [state, fate] of [['started', 'ran'], ['completed', 'ran'], ['cancelled', 'cancelled'], ['discarded', 'dropped'], ['refused', 'dropped']]) {
      // Printed by an earlier process (another pid); this one is new.
      const s = session(`word-${state}`, 907, `${marker('qm-1', 1)}\n${lifecycle('u-1', 'queued')}\n${lifecycle('u-1', state)}\n`)
      try {
        expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true }))
          .toEqual({ ok: true, duplicate: true, fate, state })
        expect(drain(s.readerFd)).toHaveLength(0)
      } finally { fs.closeSync(s.readerFd) }
    }
  })

  it('a resend into a new process writes the line: the one that had it died before running it', async () => {
    const core = createDaemonCore(ctx.deps)
    const jsonlPath = path.join(ctx.tmpDir, 'respawn.jsonl')
    fs.writeFileSync(jsonlPath, '')
    const old = fifoWithReader('old-proc')
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 908, pipePath: old.fifo, jsonlPath }))
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: true })
    } finally { fs.closeSync(old.readerFd) }
    const fresh = fifoWithReader('fresh-proc')
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 909, pipePath: fresh.fifo, jsonlPath }))
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      expect(drain(fresh.readerFd)).toHaveLength(1)
      expect(markers(jsonlPath).map((m) => m.walnutPid)).toEqual([908, 909])
    } finally { fs.closeSync(fresh.readerFd) }
  })

  it('a batch counts as written only when every one of its rows is in the record', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('partial', 910)
    try {
      expect(await core.handleSendCommand('sid', 'a', undefined, [{ message: 'a', messageId: 'qm-a' }])).toEqual({ ok: true })
      const both = [{ message: 'a', messageId: 'qm-a' }, { message: 'b', messageId: 'qm-b' }]
      expect(await core.handleSendCommand('sid', 'a\n\nb', undefined, both, { dedupe: true })).toEqual({ ok: true })
      expect(drain(s.readerFd)).toHaveLength(2)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('MU11: a write that put nothing into the pipe (EAGAIN) records nothing, so its resend writes the line', async () => {
    const fresh = await buildDeps({ fifoWriteDeadlineMs: 300 })
    try {
      const core = createDaemonCore(fresh.deps)
      const fifo = path.join(fresh.tmpDir, 'full.pipe')
      execFileSync('mkfifo', [fifo])
      const jsonlPath = path.join(fresh.tmpDir, 'full.jsonl')
      fs.writeFileSync(jsonlPath, '')
      const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      try {
        fresh.sessions.set('sid', makeTestSession({ pid: 912, pipePath: fifo, jsonlPath }))
        // A CLI still booting: its stdin is full, so not one byte of the line goes in.
        const fillFd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
        const filler = Buffer.alloc(64 * 1024, 0x7a)
        try { for (;;) { try { if (fs.writeSync(fillFd, filler, 0, filler.length) === 0) break } catch { break } } } finally { fs.closeSync(fillFd) }
        expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: false, reason: 'EAGAIN', retriable: true })
        expect(fs.existsSync(`${jsonlPath}.lines`)).toBe(false)
        // The CLI drains its stdin; the caller's retry asks first, and must write.
        for (let i = 0; i < 64; i++) { try { if (fs.readSync(readerFd, Buffer.alloc(64 * 1024), 0, 64 * 1024, null) <= 0) break } catch { break } }
        expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
        expect(drain(readerFd).filter((l) => l.includes('"hello"'))).toHaveLength(1)
      } finally { fs.closeSync(readerFd) }
    } finally { await fresh.cleanup() }
  }, 15_000)

  it('P3: the check reads the stream window piece by piece, never holding the loop', async () => {
    const core = createDaemonCore(ctx.deps)
    // 6 MiB of other output after the line's lifecycle word: inside the 8 MiB window.
    const filler = `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'x'.repeat(200) } } })}\n`
    const s = session('window', 913, `${lifecycle('u-1', 'queued')}\n${lifecycle('u-1', 'started')}\n${filler.repeat(Math.ceil(6 * 1024 * 1024 / filler.length))}`)
    try {
      let ticks = 0
      let on = true
      const tick = () => { ticks++; if (on) setImmediate(tick) }
      setImmediate(tick)
      const res = await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })
      on = false
      expect(res).toEqual({ ok: true, duplicate: true, fate: 'ran', state: 'started' })
      // A synchronous 8 MiB read and scan would let no tick run before the answer.
      expect(ticks).toBeGreaterThan(5)
      expect(drain(s.readerFd)).toHaveLength(0)
    } finally { fs.closeSync(s.readerFd) }
  })

  it('P3: a word further back than the window is not read (the CLI\'s own uuid check is the backstop)', async () => {
    const core = createDaemonCore(ctx.deps)
    const filler = `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'y'.repeat(200) } } })}\n`
    const s = session('far', 914, `${lifecycle('u-1', 'started')}\n${filler.repeat(Math.ceil(9 * 1024 * 1024 / filler.length))}`)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true })).toEqual({ ok: true })
      expect(drain(s.readerFd)).toHaveLength(1)
    } finally { fs.closeSync(s.readerFd) }
  })

  // send-lost-line-v1: the record says the whole line went into the pipe of the
  // CLI running now, never that the CLI read it. Another reader of the pipe (an
  // agent's grep that named the FIFO) takes the bytes and the record answers
  // "waiting" forever. The server proves the CLI read past the line (it answered
  // a request written after it, with no word on the line) and asks with lostPid.
  function drainRaw(readerFd: number): string {
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
  const records = (jsonlPath: string) => fs.readFileSync(`${jsonlPath}.lines`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

  it('send-lost-line-v1: a line the CLI read past is written again under its uuid, after a lone newline', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('read-past', 915)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: true })
      // Something else read the pipe: the CLI never got the line, the record stays.
      drainRaw(s.readerFd)
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true }))
        .toEqual({ ok: true, duplicate: true, fate: 'waiting' })
      expect(drainRaw(s.readerFd)).toBe('')

      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true, lostPid: 915 })).toEqual({ ok: true })
      const raw = drainRaw(s.readerFd)
      // The newline first ends any fragment the CLI holds, so the line never glues onto one.
      expect(raw.startsWith('\n{')).toBe(true)
      expect(raw.endsWith('}\n')).toBe(true)
      expect(raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        .toMatchObject([{ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hello' } }])
      expect(records(s.jsonlPath)).toMatchObject([{ pid: 915, uuid: 'u-1' }, { pid: 915, uuid: 'u-1' }])
    } finally { fs.closeSync(s.readerFd) }
  })

  it('send-lost-line-v1: the CLI\'s own word still settles it, lostPid or not', async () => {
    const core = createDaemonCore(ctx.deps)
    const cases: Array<[string, Record<string, unknown>]> = [
      [`${marker('qm-1', 916)}\n${lifecycle('u-1', 'queued')}\n`, { ok: true, duplicate: true, fate: 'waiting', state: 'queued' }],
      [`${lifecycle('u-1', 'started')}\n`, { ok: true, duplicate: true, fate: 'ran', state: 'started' }],
      [`${lifecycle('u-1', 'cancelled')}\n`, { ok: true, duplicate: true, fate: 'cancelled', state: 'cancelled' }],
    ]
    for (const [i, [stream, expected]] of cases.entries()) {
      const s = session(`word-lost-${i}`, 916, stream)
      try {
        expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toMatchObject({ ok: true })
        drainRaw(s.readerFd)
        expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true, lostPid: 916 })).toEqual(expected)
        expect(drainRaw(s.readerFd)).toBe('')
      } finally { fs.closeSync(s.readerFd) }
    }
  })

  it('send-lost-line-v1: a lostPid for an earlier process changes nothing for the one running now', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('lost-other', 917)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch)).toEqual({ ok: true })
      drainRaw(s.readerFd)
      expect(await core.handleSendCommand('sid', 'hello', 'u-1', batch, { dedupe: true, lostPid: 900 }))
        .toEqual({ ok: true, duplicate: true, fate: 'waiting' })
      expect(drainRaw(s.readerFd)).toBe('')
    } finally { fs.closeSync(s.readerFd) }
    // A first write into a new process carries no leading newline: no fragment can be there.
    const fresh = session('lost-fresh', 918)
    try {
      expect(await core.handleSendCommand('sid', 'hello', 'u-2', batch, { dedupe: true, lostPid: 900 })).toEqual({ ok: true })
      expect(drainRaw(fresh.readerFd).startsWith('{')).toBe(true)
    } finally { fs.closeSync(fresh.readerFd) }
  })

  it('without markers, dedupe changes nothing (there is nothing to recognise the line by)', async () => {
    const core = createDaemonCore(ctx.deps)
    const s = session('bare', 911)
    try {
      expect(await core.handleSendCommand('sid', 'x')).toEqual({ ok: true })
      expect(await core.handleSendCommand('sid', 'x', undefined, undefined, { dedupe: true })).toEqual({ ok: true })
      expect(drain(s.readerFd)).toHaveLength(2)
    } finally { fs.closeSync(s.readerFd) }
  })
})

describe('send-dedupe-v1 twins', () => {
  const template = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')

  it('both daemons pass the dedupe flag and lostPid from the wire into the send', () => {
    const wire = /handleSendCommand\([^)]*\{ dedupe: cmd\.dedupe === true, lostPid: typeof cmd\.lostPid === 'number' \? cmd\.lostPid : null \}\)/
    expect(standalone).toMatch(wire)
    expect(template).toMatch(wire)
  })

  it('the JS twin runs the very same scan and verdict text (behavior: daemon-send-dedupe-twins-e2e.test.ts)', async () => {
    const { getDaemonSource } = await import('../../src/providers/daemon-source.js')
    const { lineFateScan, lineFateVerdict } = await import('../../src/providers/line-fate-core.js')
    const src = getDaemonSource()
    expect(src).not.toContain('__LINE_FATE_')
    expect(src).toContain(`const lineFateScan = (${lineFateScan.toString()});`)
    expect(src).toContain(`const lineFateVerdict = (${lineFateVerdict.toString()});`)
  })

  it('both twins ask piece by piece and await the answer inside the write chain', () => {
    for (const src of [template, fs.readFileSync(path.join(ROOT, 'src/providers/daemon-core.ts'), 'utf-8')]) {
      expect(src).toContain('await line.fate()')
      expect(src).toContain('DEDUPE_SCAN_CHUNK_BYTES')
      expect(src).toContain('await fs.promises.open(filePath, \'r\')')
    }
  })

  it('the JS twin records a line only when its write put the whole line in the pipe (MU11, as in daemon-core)', () => {
    expect(template).toContain("if (written === 'ok' && line && line.written) line.written();")
  })

  it('the daemon advertises the capability', async () => {
    const { ADVERTISED_DAEMON_CAPABILITIES } = await import('../../src/providers/daemon-capabilities.js')
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('send-dedupe-v1')
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('send-lost-line-v1')
  })
})
