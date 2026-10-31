/**
 * The tail window kept between transcript reads (src/core/history-tail-window.ts).
 * Guard: bytes per poll. An unchanged transcript moves nothing; a grown one moves its
 * last line and what was appended; anything else (a rewrite, a shrink, a jump past the
 * window) reads a fresh window. The answer always equals a fresh window read's.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readTailWindow, MAX_TAIL_WINDOWS, _resetTailWindowsForTesting, type TailReader } from '../../src/core/history-tail-window.js'

/** A file in memory, read the way DaemonFileReader.readFileRange reads (to EOF). */
class FakeFile implements TailReader {
  data = Buffer.alloc(0)
  mtimeMs = 1
  bytes = 0
  reads = 0
  set(text: string): void { this.data = Buffer.from(text, 'utf-8'); this.mtimeMs++ }
  append(text: string): void { this.data = Buffer.concat([this.data, Buffer.from(text, 'utf-8')]); this.mtimeMs++ }
  st() { return { mtimeMs: this.mtimeMs, size: this.data.length } }
  async readFileRange(_path: string, start: number) {
    const slice = this.data.subarray(start)
    this.bytes += slice.length
    this.reads++
    return { content: slice.toString('utf-8'), fileSize: this.data.length }
  }
}

/** "Messages" are the window's lines: what the parse sees, made comparable. */
const parse = async (text: string) => text.split('\n').filter(Boolean)
const line = (i: number, pad = 40) => `{"n":${i},"t":"${'x'.repeat(pad)}"}\n`
const lines = (from: number, to: number, pad?: number) => Array.from({ length: to - from }, (_, k) => line(from + k, pad)).join('')

/** What a fresh window read of the same file answers (a new key, nothing held). */
async function freshOf(f: FakeFile, window: number): Promise<string[] | null> {
  const probe = new FakeFile()
  probe.data = f.data
  return readTailWindow(`probe-${Math.random()}`, probe, '/t.jsonl', f.st(), window, parse)
}

const WINDOW = 2_000

beforeEach(() => _resetTailWindowsForTesting())

describe('tail window kept between reads', () => {
  it('an unchanged transcript moves no bytes and gives the same answer', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    const first = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeLessThanOrEqual(WINDOW)
    f.bytes = 0
    for (let i = 0; i < 5; i++) {
      expect(await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(first)
    }
    expect(f.bytes).toBe(0)
  })

  it('a grown transcript moves its last line and what was appended, and matches a fresh read', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    for (let round = 0; round < 30; round++) {
      const added = lines(200 + round * 3, 203 + round * 3)
      f.append(added)
      f.bytes = 0
      const got = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
      const heldLast = line(199 + round * 3)
      expect(f.bytes).toBe(Buffer.byteLength(added) + Buffer.byteLength(heldLast))
      expect(got).toEqual(await freshOf(f, WINDOW))
    }
  })

  it('a partial line at the end is shown, then read again once complete', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.append('{"n":100,"t":"hal')
    const half = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(half?.at(-1)).toBe('{"n":100,"t":"hal')
    f.append('f"}\n')
    const whole = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(whole?.at(-1)).toBe('{"n":100,"t":"half"}')
    expect(whole).toEqual(await freshOf(f, WINDOW))
  })

  it('a rewrite (compaction) of any size reads a fresh window, never a spliced one', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    // Shorter: a /compact.
    f.set(lines(500, 520))
    expect(await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(await freshOf(f, WINDOW))
    // Longer, but the line held last is gone: not an append.
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.set(lines(600, 621).replace('"n":620', '"n":999'))
    const after = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(after).toEqual(await freshOf(f, WINDOW))
    expect(after?.some((l) => l.includes('"n":519'))).toBe(false)
    // Same size, new bytes (mtime moved): fresh too.
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.set(f.data.toString('utf-8').replace('"n":610', '"n":611'))
    expect(await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)).toEqual(await freshOf(f, WINDOW))
  })

  it('an append bigger than the window reads a fresh window', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    f.append(lines(100, 200))
    f.bytes = 0
    const got = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeLessThanOrEqual(WINDOW)
    expect(got).toEqual(await freshOf(f, WINDOW))
  })

  it('multi-byte text across the window edge keeps exact offsets', async () => {
    const f = new FakeFile()
    // Each line is CJK text (3 bytes a character): a fresh window starts inside one.
    const cjk = (i: number) => `{"n":${i},"t":"${'\u4e2d\u6587'.repeat(13)}"}\n`
    f.set(Array.from({ length: 80 }, (_, i) => cjk(i)).join(''))
    await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW + 1, parse)
    f.append(cjk(80))
    f.bytes = 0
    const got = await readTailWindow('s', f, '/t.jsonl', f.st(), WINDOW + 1, parse)
    expect(f.bytes).toBe(Buffer.byteLength(cjk(79)) + Buffer.byteLength(cjk(80)))
    expect(got).toEqual(await freshOf(f, WINDOW + 1))
  })

  it('a different path for the same key is a fresh read', async () => {
    const f = new FakeFile()
    f.set(lines(0, 100))
    await readTailWindow('s', f, '/a.jsonl', f.st(), WINDOW, parse)
    f.bytes = 0
    await readTailWindow('s', f, '/b.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeGreaterThan(0)
  })

  it(`keeps at most ${MAX_TAIL_WINDOWS} windows, least recently used out first`, async () => {
    const f = new FakeFile()
    f.set(lines(0, 50))
    for (let i = 0; i <= MAX_TAIL_WINDOWS; i++) await readTailWindow(`s${i}`, f, '/t.jsonl', f.st(), WINDOW, parse)
    f.bytes = 0
    await readTailWindow(`s${MAX_TAIL_WINDOWS}`, f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBe(0)
    await readTailWindow('s0', f, '/t.jsonl', f.st(), WINDOW, parse)
    expect(f.bytes).toBeGreaterThan(0)
  })
})
