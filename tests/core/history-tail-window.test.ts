/**
 * The tail window kept between transcript reads (src/core/history-tail-window.ts).
 * Guard: bytes per poll. An unchanged transcript moves nothing; a grown one moves its
 * last line and what was appended; anything else (a rewrite, a shrink, a jump past the
 * window) reads a fresh window. The answer always equals a fresh window read's.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readTailWindowRead, MAX_TAIL_WINDOWS, MAX_TAIL_WINDOW_BYTES, setTailWindowShedding, _resetTailWindowsForTesting, type TailReader } from '../../src/core/history-tail-window.js'

/** A file in memory, read the way DaemonFileReader.readFileRange reads (to EOF). */
class FakeFile implements TailReader {
  data = Buffer.alloc(0)
  mtimeMs = 1
  /** The file's incarnation as the daemon stat says it (undefined: an older daemon). */
  epoch: string | undefined = undefined
  bytes = 0
  reads = 0
  set(text: string): void { this.data = Buffer.from(text, 'utf-8'); this.mtimeMs++ }
  append(text: string): void { this.data = Buffer.concat([this.data, Buffer.from(text, 'utf-8')]); this.mtimeMs++ }
  st() { return { mtimeMs: this.mtimeMs, size: this.data.length, ...(this.epoch !== undefined ? { epoch: this.epoch } : {}) } }
  /** Bytes that land after the read (an append between the caller's stat and its read). */
  landing: Buffer | null = null
  fail = false
  async readFileRangeBuffer(_path: string, start: number) {
    if (this.fail) throw new Error('fs.readRange transport failure: test')
    if (this.landing) { this.data = Buffer.concat([this.data, this.landing]); this.landing = null; this.mtimeMs++ }
    const slice = Buffer.from(this.data.subarray(start))
    this.bytes += slice.length
    this.reads++
    return { buf: slice, fileSize: this.data.length }
  }
}

/** "Messages" are the window's lines: what the parse sees, made comparable. */
const parse = async (text: string) => text.split('\n').filter(Boolean)
/** The parse a window read answers (null: unreadable). */
const windowValue = async (...args: Parameters<typeof readTailWindowRead<string[]>>) => (await readTailWindowRead(...args))?.value ?? null
const line = (i: number, pad = 40) => `{"n":${i},"t":"${'x'.repeat(pad)}"}\n`
const lines = (from: number, to: number, pad?: number) => Array.from({ length: to - from }, (_, k) => line(from + k, pad)).join('')

/** What a fresh window read of the same file answers (a new key, nothing held). */
async function freshOf(f: FakeFile, window: number): Promise<string[] | null> {
  const probe = new FakeFile()
  probe.data = f.data
  return windowValue(`probe-${Math.random()}`, probe, '/t.jsonl', f.st(), window, parse)
}

const WINDOW = 2_000

beforeEach(() => _resetTailWindowsForTesting())

describe('tail window kept between reads', () => {
  it('an unchanged transcript moves no bytes and gives the same answer', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    const first = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeLessThanOrEqual(WINDOW)
    f.bytes = 0
    for (let i = 0; i < 5; i++) {
      expect(await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(first)
    }
    expect(f.bytes).toBe(0)
  })

  it('a grown transcript moves its last line and what was appended, and matches a fresh read', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    for (let round = 0; round < 30; round++) {
      const added = lines(200 + round * 3, 203 + round * 3)
      f.append(added)
      f.bytes = 0
      const got = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
      const heldLast = line(199 + round * 3)
      expect(f.bytes).toBe(Buffer.byteLength(added) + Buffer.byteLength(heldLast))
      expect(got).toEqual(await freshOf(f, WINDOW))
    }
  })

  it('a partial line at the end is shown, then read again once complete', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.append('{"n":100,"t":"hal')
    const half = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(half?.at(-1)).toBe('{"n":100,"t":"hal')
    f.append('f"}\n')
    const whole = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(whole?.at(-1)).toBe('{"n":100,"t":"half"}')
    expect(whole).toEqual(await freshOf(f, WINDOW))
  })

  it('a rewrite (compaction) of any size reads a fresh window, never a spliced one', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    // Shorter: a /compact.
    f.set(lines(500, 520))
    expect(await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(await freshOf(f, WINDOW))
    // Longer, but the line held last is gone: not an append.
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.set(lines(600, 621).replace('"n":620', '"n":999'))
    const after = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(after).toEqual(await freshOf(f, WINDOW))
    expect(after?.some((l) => l.includes('"n":519'))).toBe(false)
    // Same size, new bytes (mtime moved): fresh too.
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.set(f.data.toString('utf-8').replace('"n":610', '"n":611'))
    expect(await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(await freshOf(f, WINDOW))
  })

  it('an append bigger than the window reads a fresh window', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.append(lines(100, 200))
    f.bytes = 0
    const got = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeLessThanOrEqual(WINDOW)
    expect(got).toEqual(await freshOf(f, WINDOW))
  })

  it('multi-byte text across the window edge keeps exact offsets', async () => {
    const f = new FakeFile()
    // Each line is CJK text (3 bytes a character): a fresh window starts inside one.
    const cjk = (i: number) => `{"n":${i},"t":"${'\u4e2d\u6587'.repeat(13)}"}\n`
    f.set(Array.from({ length: 80 }, (_, i) => cjk(i)).join(''))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW + 1, parse)
    f.append(cjk(80))
    f.bytes = 0
    const got = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW + 1, parse)
    expect(f.bytes).toBe(Buffer.byteLength(cjk(79)) + Buffer.byteLength(cjk(80)))
    expect(got).toEqual(await freshOf(f, WINDOW + 1))
  })

  it('an append that lands between the stat and the read costs one line on the next poll, not a window', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.append(line(200))
    const stale = f.st()
    f.landing = Buffer.from(line(201))
    await windowValue('s', f, '/t.jsonl', stale, WINDOW, parse)
    f.bytes = 0
    const got = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBe(Buffer.byteLength(line(201)))
    expect(got).toEqual(await freshOf(f, WINDOW))
    f.bytes = 0
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBe(0)
  })

  it('a character cut at the end of the file keeps exact offsets', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    const cjkLine = Buffer.from(`{"n":100,"t":"\u4e2d\u6587"}\n`, 'utf-8')
    // The CLI has written the line up to the middle of its first 3-byte character.
    const cut = cjkLine.indexOf(0xe4) + 1
    f.data = Buffer.concat([f.data, cjkLine.subarray(0, cut)]); f.mtimeMs++
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.data = Buffer.concat([f.data, cjkLine.subarray(cut)]); f.mtimeMs++
    f.bytes = 0
    const got = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBe(Buffer.byteLength(line(99)) + cjkLine.length)
    expect(got?.at(-1)).toBe(`{"n":100,"t":"\u4e2d\u6587"}`)
  })

  it('a read that fails throws and leaves the next read working', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.append(line(100))
    f.fail = true
    await expect(windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)).rejects.toThrow(/transport failure/)
    f.fail = false
    expect(await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(await freshOf(f, WINDOW))
  })

  it('a different path for the same key is a fresh read', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await windowValue('s', f, '/a.jsonl', f.st(), WINDOW, parse)
    f.bytes = 0
    await windowValue('s', f, '/b.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeGreaterThan(0)
  })

  it('keeps its bytes under the budget, and a quarter of it under memory pressure', async () => {
    const f = new FakeFile()
    const big = 4 * 1024 * 1024
    f.set(lines(0, Math.ceil(big / Buffer.byteLength(line(0))) + 10))
    const fits = Math.floor(MAX_TAIL_WINDOW_BYTES / (big * 2))
    for (let i = 0; i < fits + 2; i++) await windowValue(`b${i}`, f, '/t.jsonl', f.st(), big, parse)
    f.bytes = 0
    await windowValue('b0', f, '/t.jsonl', f.st(), big, parse)
    expect(f.bytes).toBeGreaterThan(0)
    setTailWindowShedding(true)
    f.bytes = 0
    await windowValue('b0', f, '/t.jsonl', f.st(), big, parse) // the newest, kept
    expect(f.bytes).toBe(0)
    // An older window the shedding dropped is read fresh again.
    await windowValue('b3', f, '/t.jsonl', f.st(), big, parse)
    expect(f.bytes).toBeGreaterThan(0)
    setTailWindowShedding(false)
  })

  it(`keeps at most ${MAX_TAIL_WINDOWS} windows, least recently used out first`, async () => {
    const f = new FakeFile()
    f.set(lines(0, 50))
    for (let i = 0; i <= MAX_TAIL_WINDOWS; i++) await windowValue(`s${i}`, f, '/t.jsonl', f.st(), WINDOW, parse)
    f.bytes = 0
    await windowValue(`s${MAX_TAIL_WINDOWS}`, f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBe(0)
    await windowValue('s0', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeGreaterThan(0)
  })

  it('a file cut shorter, then grown past the end it had, reads a fresh window, never a spliced one', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    // Cut (a rewrite to fewer lines), then grown longer than before, with no read in between.
    f.set(lines(0, 50))
    f.append(lines(1000, 1200))
    f.bytes = 0
    const got = await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(got).toEqual(await freshOf(f, WINDOW))
    expect(got?.some((l) => l.includes('"n":199'))).toBe(false)
  })

  it('another incarnation of the file (a new epoch) reads fresh, even with the same bytes', async () => {
    const f = new FakeFile()
    f.epoch = 'e1'
    f.set(lines(0, 100))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.epoch = 'e2'
    f.bytes = 0
    const got = await readTailWindowRead('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(got?.how).toBe('fresh')
    expect(f.bytes).toBeGreaterThan(0)
  })

  it('no key reads fresh and keeps nothing; keep:false reads through a kept window but keeps no new one', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await windowValue('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    // No key (a parse with options of its own): a window is held, and still not used.
    f.bytes = 0
    expect((await readTailWindowRead(null, f, '/t.jsonl', f.st(), WINDOW, parse))?.how).toBe('fresh')
    expect(f.bytes).toBeGreaterThan(0)
    // keep:false on the held key: answered from it.
    f.bytes = 0
    const held = await readTailWindowRead('s', f, '/t.jsonl', f.st(), WINDOW, parse, { keep: false })
    expect(held?.how).toBe('held')
    expect(held?.endsWithLine).toBe(true)
    expect(held?.text()).toBe(lines(0, 100).slice(-held!.text().length))
    expect(f.bytes).toBe(0)
    // keep:false on a key with nothing held: read, and still nothing held afterwards.
    await readTailWindowRead('other', f, '/t.jsonl', f.st(), WINDOW, parse, { keep: false })
    f.bytes = 0
    expect((await readTailWindowRead('other', f, '/t.jsonl', f.st(), WINDOW, parse, { keep: false }))?.how).toBe('fresh')
    expect(f.bytes).toBeGreaterThan(0)
  })
})
