/**
 * The session tailer (session-tailer.ts): the pure line assembler, parseOnce, and the tailer
 * itself over an injected file system and injected clocks (no disk, no real interval: each test
 * calls tick() itself).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLineAssembler,
  createSessionTailer,
  parseOnce,
  type SessionTailerOptions,
  type TailedLine,
  type TailerFs,
} from '../../src/providers/session-tailer.js'

const bytes = (s: string) => Buffer.from(s, 'utf-8')

describe('createLineAssembler', () => {
  it('hands over complete lines, each with the byte offset after its newline', () => {
    const a = createLineAssembler(0, 1024)
    const out = a.push(bytes('{"a":1}\n{"b":2}\n'))
    expect(out.lines).toEqual([
      { line: '{"a":1}', v: 8 },
      { line: '{"b":2}', v: 16 },
    ])
    expect(out.overflowed).toBe(false)
    expect(out.carryBytes).toBe(0)
    expect(a.boundary).toBe(16)
    expect(a.cursor).toBe(16)
  })

  it('counts bytes, not characters, for multi-byte UTF-8', () => {
    const a = createLineAssembler(0, 1024)
    // "é" is 2 bytes, "中" is 3 bytes: the line is 1 + 2 + 3 bytes, then the newline.
    const out = a.push(bytes('xé中\nok\n'))
    expect(out.lines).toEqual([
      { line: 'xé中', v: 7 },
      { line: 'ok', v: 10 },
    ])
  })

  it('carries a torn tail across pushes: the boundary stays at the fragment start', () => {
    const a = createLineAssembler(0, 1024)
    const first = a.push(bytes('one\ntw'))
    expect(first.lines).toEqual([{ line: 'one', v: 4 }])
    expect(first.carryBytes).toBe(2)
    expect(a.boundary).toBe(4)
    expect(a.cursor).toBe(a.boundary + a.carryBytes)

    // No newline: nothing completes, the carry grows, the boundary does not move.
    const second = a.push(bytes('o-'))
    expect(second.lines).toEqual([])
    expect(second.carryBytes).toBe(4)
    expect(a.boundary).toBe(4)
    expect(a.cursor).toBe(8)

    const third = a.push(bytes('more\nthree'))
    expect(third.lines).toEqual([{ line: 'two-more', v: 13 }])
    expect(a.boundary).toBe(13)
    expect(a.carryBytes).toBe(5)
    expect(a.cursor).toBe(a.boundary + a.carryBytes)
  })

  it('decodes a UTF-8 character split across two pushes once, whole', () => {
    const a = createLineAssembler(0, 1024)
    const full = bytes('{"s":"é"}\n')
    const split = full.indexOf(0xc3) + 1 // between the two bytes of the character
    expect(a.push(full.subarray(0, split)).lines).toEqual([])
    const out = a.push(full.subarray(split))
    expect(out.lines).toEqual([{ line: '{"s":"é"}', v: full.length }])
    expect(JSON.parse(out.lines[0].line)).toEqual({ s: 'é' })
  })

  it('drops a line over carryMaxBytes and gives the next line its true v', () => {
    const a = createLineAssembler(0, 5)
    const whale = a.push(bytes('abcdefgh'))
    expect(whale.overflowed).toBe(true)
    expect(whale.carryBytes).toBe(8)
    expect(whale.lines).toEqual([])
    expect(a.carryBytes).toBe(0)
    expect(a.boundary).toBe(8)

    // More of the whale, still no newline: dropped too, the boundary follows the cursor.
    const more = a.push(bytes('ij'))
    expect(more.lines).toEqual([])
    expect(more.overflowed).toBe(false)
    expect(a.boundary).toBe(10)

    // The whale's newline ends it; the line after it keeps its true offset in the file.
    const after = a.push(bytes('k\nnext\n'))
    // File so far: "abcdefghijk\n" (12 bytes) + "next\n" (5 bytes).
    expect(after.lines).toEqual([{ line: 'next', v: 17 }])
    expect(after.overflowed).toBe(false)
    expect(a.boundary).toBe(17)
    expect(a.cursor).toBe(17)
  })

  it('drops an oversized torn tail that follows complete lines in the same push', () => {
    const a = createLineAssembler(0, 3)
    const out = a.push(bytes('ok\nabcdef'))
    expect(out.lines).toEqual([{ line: 'ok', v: 3 }])
    expect(out.overflowed).toBe(true)
    const next = a.push(bytes('g\nfine\n'))
    // "ok\n" 3 + "abcdefg\n" 8 + "fine\n" 5.
    expect(next.lines).toEqual([{ line: 'fine', v: 16 }])
  })

  it('starts at a non-zero offset', () => {
    const a = createLineAssembler(1000, 1024)
    expect(a.boundary).toBe(1000)
    expect(a.cursor).toBe(1000)
    const out = a.push(bytes('ab\ncd'))
    expect(out.lines).toEqual([{ line: 'ab', v: 1003 }])
    expect(a.boundary).toBe(1003)
    expect(a.cursor).toBe(1005)
  })

  it('does not alias the pushed buffer in its carry', () => {
    const a = createLineAssembler(0, 1024)
    const buf = bytes('x\nyz')
    a.push(buf)
    buf.fill(0x21) // the caller reuses its buffer
    expect(a.push(bytes('\n')).lines).toEqual([{ line: 'yz', v: 5 }])
  })
})

describe('parseOnce', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('parses at the first call only and returns the same value each time', () => {
    const spy = vi.spyOn(JSON, 'parse')
    const parse = parseOnce('{"a":[1,2]}')
    expect(spy).not.toHaveBeenCalled()
    const first = parse()
    const second = parse()
    expect(first).toEqual({ a: [1, 2] })
    expect(second).toBe(first)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('throws the same error object on every call for a line that is no JSON, parsing once', () => {
    const spy = vi.spyOn(JSON, 'parse')
    const parse = parseOnce('{not json')
    let firstErr: unknown
    try { parse() } catch (err) { firstErr = err }
    let secondErr: unknown
    try { parse() } catch (err) { secondErr = err }
    expect(firstErr).toBeInstanceOf(SyntaxError)
    expect(secondErr).toBe(firstErr)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

// ---- The tailer over a fake file and fake clocks ----

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** One in-memory file; each call can be made to fail or wait. */
function fakeFile() {
  let content = Buffer.alloc(0)
  const calls = { stat: 0, read: [] as Array<{ position: number; length: number }> }
  const failures: unknown[] = []
  let gate: { stat?: Deferred<void>; read?: Deferred<void> } = {}
  const fs: TailerFs = {
    async stat() {
      calls.stat++
      if (gate.stat) await gate.stat.promise
      const fail = failures.shift()
      if (fail) throw fail
      return { size: content.length }
    },
    async read(_path, position, length) {
      calls.read.push({ position, length })
      if (gate.read) await gate.read.promise
      return Buffer.from(content.subarray(position, position + length))
    },
  }
  return {
    fs,
    calls,
    append(s: string) { content = Buffer.concat([content, bytes(s)]) },
    failNextStat(err: unknown) { failures.push(err) },
    holdStat() { gate.stat = deferred<void>(); return gate.stat },
    holdRead() { gate.read = deferred<void>(); return gate.read },
    release() { gate = {} },
  }
}

function fakeTimers() {
  const handle = { fake: 'interval' } as unknown as ReturnType<typeof globalThis.setInterval>
  const set: Array<{ fn: () => void; ms: number | undefined }> = []
  const cleared: unknown[] = []
  const timers = {
    setInterval: ((fn: () => void, ms?: number) => { set.push({ fn, ms }); return handle }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((h: unknown) => { cleared.push(h) }) as unknown as typeof globalThis.clearInterval,
  }
  return { timers, handle, set, cleared }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function makeTailer(overrides: Partial<SessionTailerOptions> = {}) {
  const file = fakeFile()
  const clock = fakeTimers()
  const batches: Array<{ lines: TailedLine[]; info: { overflowed: boolean; carryBytes: number; cursor: number } }> = []
  const boundaries: number[] = []
  const errors: Array<{ err: unknown; consecutive: number }> = []
  let isActive = true
  const tailer = createSessionTailer({
    path: '/fake/session.jsonl',
    startOffset: 0,
    maxReadBytes: 1024,
    carryMaxBytes: 1024,
    fs: file.fs,
    timers: clock.timers,
    active: () => isActive,
    onLines: (lines, info) => { batches.push({ lines, info }) },
    onBoundary: (b) => { boundaries.push(b) },
    onError: (err, consecutive) => { errors.push({ err, consecutive }) },
    ...overrides,
  })
  const delivered = () => batches.flatMap((b) => b.lines.map(({ line, v }) => ({ line, v })))
  return { tailer, file, clock, batches, boundaries, errors, delivered, setActive: (v: boolean) => { isActive = v } }
}

describe('createSessionTailer', () => {
  it('starts one interval at the given period and the default of 100 ms', () => {
    const t = makeTailer({ intervalMs: 250 })
    expect(t.clock.set.map((s) => s.ms)).toEqual([250])
    expect(t.tailer.timer).toBe(t.clock.handle)
    const d = makeTailer()
    expect(d.clock.set.map((s) => s.ms)).toEqual([100])
  })

  it('delivers complete lines in order with v, and publishes the boundary', async () => {
    const t = makeTailer()
    t.file.append('{"n":1}\n{"n":2}\n{"n":')
    await t.tailer.tick()
    expect(t.delivered()).toEqual([
      { line: '{"n":1}', v: 8 },
      { line: '{"n":2}', v: 16 },
    ])
    expect(t.boundaries).toEqual([16])
    expect(t.tailer.boundary).toBe(16)
    expect(t.tailer.cursor).toBe(21)
    expect(t.batches[0].info).toEqual({ overflowed: false, carryBytes: 5, cursor: 21, last: true })

    t.file.append('3}\n')
    await t.tailer.tick()
    expect(t.delivered().slice(2)).toEqual([{ line: '{"n":3}', v: 24 }])
    expect(t.boundaries).toEqual([16, 24])
    expect(t.batches[1].lines[0].parse()).toEqual({ n: 3 })
  })

  it('reads from startOffset and gives lines their absolute v', async () => {
    const t = makeTailer({ startOffset: 4 })
    t.file.append('old\nnew\n')
    await t.tailer.tick()
    expect(t.file.calls.read[0]).toEqual({ position: 4, length: 4 })
    expect(t.delivered()).toEqual([{ line: 'new', v: 8 }])
  })

  it('reads nothing when the file did not grow', async () => {
    const t = makeTailer()
    t.file.append('a\n')
    await t.tailer.tick()
    await t.tailer.tick()
    expect(t.file.calls.read).toHaveLength(1)
    expect(t.batches).toHaveLength(1)
  })

  it('treats ENOENT as benign and counts other errors, reset by ENOENT and by a good read', async () => {
    const t = makeTailer()
    t.file.failNextStat(errno('ENOENT'))
    await t.tailer.tick()
    expect(t.errors).toEqual([])

    const eio = errno('EIO')
    t.file.failNextStat(eio)
    t.file.failNextStat(errno('EIO'))
    t.file.failNextStat(errno('EACCES'))
    await t.tailer.tick()
    await t.tailer.tick()
    await t.tailer.tick()
    expect(t.errors.map((e) => e.consecutive)).toEqual([1, 2, 3])
    expect(t.errors[0].err).toBe(eio)

    t.file.failNextStat(errno('ENOENT'))
    await t.tailer.tick()
    t.file.failNextStat(errno('EIO'))
    await t.tailer.tick()
    expect(t.errors.map((e) => e.consecutive)).toEqual([1, 2, 3, 1])

    t.file.append('ok\n')
    await t.tailer.tick()
    t.file.failNextStat(errno('EIO'))
    await t.tailer.tick()
    expect(t.errors.map((e) => e.consecutive)).toEqual([1, 2, 3, 1, 1])
    expect(t.delivered()).toEqual([{ line: 'ok', v: 3 }])
  })

  it('keeps one read in flight: a tick during a slow read returns the same promise', async () => {
    const t = makeTailer()
    t.file.append('a\n')
    const held = t.file.holdStat()
    const first = t.tailer.tick()
    const second = t.tailer.tick()
    // The clock firing meanwhile starts nothing either.
    t.clock.set[0].fn()
    expect(second).toBe(first)
    expect(t.file.calls.stat).toBe(1)
    t.file.release()
    held.resolve()
    await first
    expect(t.file.calls.read).toHaveLength(1)
    expect(t.delivered()).toEqual([{ line: 'a', v: 2 }])

    // Once it ended, the next tick reads again.
    t.file.append('b\n')
    const third = t.tailer.tick()
    expect(third).not.toBe(first)
    await third
    expect(t.file.calls.stat).toBe(2)
    expect(t.delivered()).toEqual([{ line: 'a', v: 2 }, { line: 'b', v: 4 }])
  })

  it('caps each read at maxReadBytes and drains a backlog over several ticks', async () => {
    const t = makeTailer({ maxReadBytes: 4 })
    t.file.append('aa\nbb\ncc\n') // 9 bytes
    await t.tailer.tick()
    await t.tailer.tick()
    await t.tailer.tick()
    expect(t.file.calls.read).toEqual([
      { position: 0, length: 4 },
      { position: 4, length: 4 },
      { position: 8, length: 1 },
    ])
    expect(t.delivered()).toEqual([
      { line: 'aa', v: 3 },
      { line: 'bb', v: 6 },
      { line: 'cc', v: 9 },
    ])
    await t.tailer.tick()
    expect(t.file.calls.read).toHaveLength(3)
  })

  it('reads nothing while active() is false', async () => {
    const t = makeTailer()
    t.setActive(false)
    t.file.append('a\n')
    await t.tailer.tick()
    expect(t.file.calls.stat).toBe(0)
    expect(t.batches).toEqual([])
    t.setActive(true)
    await t.tailer.tick()
    expect(t.delivered()).toEqual([{ line: 'a', v: 2 }])
  })

  it('drops a read that resolves after active() turned false, and reads it again later', async () => {
    const t = makeTailer()
    t.file.append('a\n')
    const held = t.file.holdRead()
    const pending = t.tailer.tick()
    await vi.waitFor(() => expect(t.file.calls.read).toHaveLength(1))
    t.setActive(false)
    held.resolve()
    await pending
    expect(t.batches).toEqual([])
    expect(t.tailer.cursor).toBe(0)
    t.file.release()
    t.setActive(true)
    await t.tailer.tick()
    expect(t.delivered()).toEqual([{ line: 'a', v: 2 }])
  })

  it('stop() clears its interval and a stat in flight delivers nothing', async () => {
    const t = makeTailer()
    t.file.append('a\n')
    const held = t.file.holdStat()
    const pending = t.tailer.tick()
    t.tailer.stop()
    expect(t.clock.cleared).toEqual([t.clock.handle])
    held.resolve()
    await pending
    expect(t.file.calls.read).toHaveLength(0)
    expect(t.batches).toEqual([])
    expect(t.boundaries).toEqual([])
  })

  it('stop() during a read in flight delivers nothing, and later ticks read nothing', async () => {
    const t = makeTailer()
    t.file.append('a\n')
    const held = t.file.holdRead()
    const pending = t.tailer.tick()
    await vi.waitFor(() => expect(t.file.calls.read).toHaveLength(1))
    t.tailer.stop()
    held.resolve()
    await pending
    expect(t.batches).toEqual([])
    expect(t.boundaries).toEqual([])
    t.file.release()
    await t.tailer.tick()
    expect(t.file.calls.stat).toBe(1)
    expect(t.batches).toEqual([])
  })

  it('reports an overflowed batch and realigns on the next newline', async () => {
    const t = makeTailer({ carryMaxBytes: 4 })
    t.file.append('abcdefgh')
    await t.tailer.tick()
    expect(t.batches[0].info.overflowed).toBe(true)
    expect(t.batches[0].lines).toEqual([])
    t.file.append('\nok\n')
    await t.tailer.tick()
    expect(t.delivered()).toEqual([{ line: 'ok', v: 12 }])
  })

  it('parses a line once however many consumers ask it', async () => {
    const t = makeTailer()
    t.file.append('{"k":"v"}\n')
    await t.tailer.tick()
    const [line] = t.batches[0].lines
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const a = line.parse()
      const b = line.parse()
      expect(a).toEqual({ k: 'v' })
      expect(b).toBe(a)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })

  it('does not parse a line nobody asks', async () => {
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const t = makeTailer()
      t.file.append('{"k":"v"}\n')
      await t.tailer.tick()
      expect(t.batches[0].lines).toHaveLength(1)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
