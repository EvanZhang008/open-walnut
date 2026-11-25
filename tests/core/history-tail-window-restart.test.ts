/**
 * A host's tail windows outlive a server restart (src/core/history-tail-window-disk.ts).
 *
 * 2026-11-25: about 70 restarts a day, and each emptied the windows, so the first read of
 * every big remote transcript after a deploy moved its whole window (4 MB) over the host's
 * link again. Pinned, with a new module instance standing for the new process:
 *  - a transcript that only grew moves its last line (the check) and the appended bytes;
 *  - an unchanged one moves only its last line, and is never answered unchecked;
 *  - a rewritten one (the last line differs, or a new epoch, or a shrink) reads fresh, and the
 *    copy kept after is the new file's; every answer equals a fresh window read;
 *  - a one-off reader neither holds a kept copy nor removes it;
 *  - a corrupt, truncated or foreign file is removed at boot and never read back;
 *  - only `persist` windows are written, at most once per TAIL_WINDOW_SAVE_EVERY_MS, within caps;
 *  - a save writes about the bytes appended since, never the whole window again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TailReader } from '../../src/core/history-tail-window.js'

type Win = typeof import('../../src/core/history-tail-window.js')
type Disk = typeof import('../../src/core/history-tail-window-disk.js')

class FakeFile implements TailReader {
  data = Buffer.alloc(0)
  mtimeMs = 1
  epoch: string | undefined = 'e1'
  bytes = 0
  set(text: string): void { this.data = Buffer.from(text, 'utf-8'); this.mtimeMs++ }
  append(text: string): void { this.data = Buffer.concat([this.data, Buffer.from(text, 'utf-8')]); this.mtimeMs++ }
  st() { return { mtimeMs: this.mtimeMs, size: this.data.length, ...(this.epoch !== undefined ? { epoch: this.epoch } : {}) } }
  async readFileRangeBuffer(_path: string, start: number) {
    const slice = Buffer.from(this.data.subarray(start))
    this.bytes += slice.length
    return { buf: slice, fileSize: this.data.length }
  }
}

const parse = async (text: string) => text.split('\n').filter(Boolean)
const line = (i: number, tag = 'x') => `{"n":${i},"t":"${tag.repeat(40)}"}\n`
const lines = (from: number, to: number, tag?: string) => Array.from({ length: to - from }, (_, k) => line(from + k, tag)).join('')
const WINDOW = 2_000
const KEY = 'sid@devbox|2000'
const P = '/t.jsonl'

let dir = ''
let proc: { win: Win; disk: Disk } | null = null

/** A server process: fresh module instances, the kept windows' headers read back from `dir`. */
async function boot(): Promise<{ win: Win; disk: Disk }> {
  vi.resetModules()
  const win = await import('../../src/core/history-tail-window.js')
  const disk = await import('../../src/core/history-tail-window-disk.js')
  await disk.startTailWindowDisk(dir)
  proc = { win, disk }
  return proc
}
async function stop(): Promise<void> {
  if (!proc) return
  await proc.disk.flushTailWindowDisk()
  proc.disk._stopTailWindowDiskForTesting()
  proc = null
}
const read = (win: Win, f: FakeFile, key = KEY, opts: { keep?: boolean; persist?: boolean } = { persist: true }) =>
  win.readTailWindowRead(key, f, P, f.st(), WINDOW, parse, opts)
/** What a fresh window read of the file answers (nothing held, nothing kept). */
async function freshOf(win: Win, f: FakeFile): Promise<string[] | null> {
  const probe = new FakeFile()
  probe.data = f.data
  return (await win.readTailWindowRead(null, probe, P, f.st(), WINDOW, parse))?.value ?? null
}
const files = async () => (await fsp.readdir(dir)).sort()
/** The kept windows' data files (each has a `.json` description beside it). */
const windowFiles = async () => (await files()).filter((n) => n.endsWith('.win'))

beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-tail-restart-')) })
afterEach(async () => {
  await stop()
  vi.useRealTimers()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('tail windows after a restart', () => {
  it('a transcript that only grew moves its last line and the appended bytes, not the window', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    let { win } = await boot()
    expect((await read(win, f))?.how).toBe('fresh')
    await stop()
    expect(await windowFiles()).toHaveLength(1)
    expect(await files()).toHaveLength(2)

    for (let round = 0; round < 3; round++) {
      ;({ win } = await boot())
      const added = lines(200 + round * 3, 203 + round * 3)
      const heldLast = line(199 + round * 3)
      f.append(added)
      f.bytes = 0
      const got = await read(win, f)
      // Old code: a new process holds nothing, so this was a fresh read of about WINDOW bytes.
      expect(got?.how).toBe('grown')
      expect(f.bytes).toBe(Buffer.byteLength(added) + Buffer.byteLength(heldLast))
      expect(got?.value).toEqual(await freshOf(win, f))
      await stop()
    }
  })

  it('an unchanged transcript is checked by its last line once, then held', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    let { win } = await boot()
    await read(win, f)
    await stop()
    ;({ win } = await boot())
    f.bytes = 0
    const first = await read(win, f)
    expect(first?.how).toBe('grown')
    expect(f.bytes).toBe(Buffer.byteLength(line(199)))
    expect(first?.value).toEqual(await freshOf(win, f))
    f.bytes = 0
    expect((await read(win, f))?.how).toBe('held')
    expect(f.bytes).toBe(0)
  })

  it('a rewritten transcript reads fresh and its kept copy goes: a changed last line, a new epoch, a shrink', async () => {
    const f = new FakeFile()
    const rewrites: Array<() => void> = [
      () => f.set(lines(0, 200, 'y') + lines(200, 210)), // same epoch, grown, the line at the old end differs
      () => { f.epoch = 'e2'; f.append(line(500)) },      // another incarnation
      () => f.set(lines(0, 50)),                           // shorter
    ]
    for (const rewrite of rewrites) {
      f.epoch = 'e1'
      f.set(lines(0, 200))
      let { win } = await boot()
      await read(win, f)
      await stop()
      ;({ win } = await boot())
      rewrite()
      const got = await read(win, f)
      expect(got?.how).toBe('fresh')
      expect(got?.value).toEqual(await freshOf(win, f))
      await stop()
      // The copy kept now is the rewritten file's: the next process checks it and grows it.
      ;({ win } = await boot())
      f.bytes = 0
      const next = await read(win, f)
      expect(next?.how).toBe('grown')
      expect(next?.value).toEqual(await freshOf(win, f))
      await stop()
    }
  })

  it('a one-off reader (keep false) neither takes a kept copy into memory nor removes it', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    let { win } = await boot()
    await read(win, f)
    await stop()
    ;({ win } = await boot())
    expect((await read(win, f, KEY, { persist: true, keep: false }))?.how).toBe('fresh')
    await stop()
    expect(await windowFiles()).toHaveLength(1)
    ;({ win } = await boot())
    expect((await read(win, f))?.how).toBe('grown')
  })

  it('a corrupt, truncated or foreign file is removed at boot and never read back', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    let { win } = await boot()
    await read(win, f)
    await read(win, f, 'other@devbox|2000')
    await stop()
    const [a, b] = await windowFiles()
    // One data file cut short, one description garbage, plus stray files a stop cut short or no window wrote.
    const body = await fsp.readFile(path.join(dir, a))
    await fsp.writeFile(path.join(dir, a), body.subarray(0, body.length - 10))
    await fsp.writeFile(path.join(dir, b.replace(/\.win$/, '.json')), 'not a window at all')
    await fsp.writeFile(path.join(dir, 'x.win.tmp-1-2-3'), 'half')
    await fsp.writeFile(path.join(dir, 'deadbeef.win'), '{"v":1,"id":"k","base":0}\n')
    ;({ win } = await boot())
    expect(await files()).toEqual([])
    f.bytes = 0
    expect((await read(win, f))?.how).toBe('fresh')
    expect((await read(win, f, 'other@devbox|2000'))?.how).toBe('fresh')
  })

  it('a version an older or newer Walnut wrote is ignored', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    let { win } = await boot()
    await read(win, f)
    await stop()
    const [a] = (await files()).filter((n) => n.endsWith('.json'))
    const body = (await fsp.readFile(path.join(dir, a), 'utf8')).replace('"v":1,', '"v":2,')
    await fsp.writeFile(path.join(dir, a), body)
    ;({ win } = await boot())
    expect((await read(win, f))?.how).toBe('fresh')
  })

  it('only persist windows are written; a busy one writes at most once per its interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = new FakeFile()
    f.set(lines(0, 200))
    const { win, disk } = await boot()
    await read(win, f, 'local-sid|2000', {})
    for (let i = 0; i < 10; i++) {
      f.append(line(200 + i))
      await read(win, f)
    }
    // Ten changes and no write yet: the first waits out the interval.
    expect(await files()).toEqual([])
    await vi.advanceTimersByTimeAsync(disk.TAIL_WINDOW_SAVE_EVERY_MS + 10)
    await disk.flushTailWindowDisk()
    // One file: the host's window, never the local one.
    expect(await windowFiles()).toHaveLength(1)
    const written = await fsp.readFile(path.join(dir, (await windowFiles())[0]))
    expect(written.toString('utf-8')).toContain(line(209).trim())
  })

  it('at most MAX_DISK_WINDOWS are kept, the least recently written going first', async () => {
    const { win, disk } = await boot()
    const f = new FakeFile()
    f.set(lines(0, 100))
    for (let i = 0; i < disk.MAX_DISK_WINDOWS + 4; i++) {
      await read(win, f, `s${i}@devbox|2000`)
      await disk.flushTailWindowDisk()
    }
    expect(await windowFiles()).toHaveLength(disk.MAX_DISK_WINDOWS)
    await stop()
    const next = await boot()
    f.bytes = 0
    // The newest is still kept (checked by its last line), the oldest is not.
    expect((await read(next.win, f, `s${disk.MAX_DISK_WINDOWS + 3}@devbox|2000`))?.how).toBe('grown')
    expect((await read(next.win, f, 's0@devbox|2000'))?.how).toBe('fresh')
  })

  /**
   * 2026-11-25, the Walnut VP: rewriting a busy session's whole window (4 MB) every 30 s is
   * about 80 MB a minute for ten sessions. A save after the first writes only what was appended
   * (plus a small description), and the whole window again only when its data reached
   * COMPACT_FACTOR windows: about 1.5 bytes written per byte appended, whatever the window.
   */
  it('a save writes about the appended bytes, not the window; rare whole rewrites keep the data bounded', async () => {
    const BIG_WINDOW = 64 * 1024
    const f = new FakeFile()
    f.set(lines(0, 2_000))
    const { win, disk } = await boot()
    const readBig = () => win.readTailWindowRead(KEY, f, P, f.st(), BIG_WINDOW, parse, { persist: true })
    await readBig()
    await disk.flushTailWindowDisk()
    const first = disk._tailWindowDiskBytesWrittenForTesting()
    expect(first).toBeGreaterThan(BIG_WINDOW - 200)

    let appended = 0
    let before = first
    for (let round = 0; round < 10; round++) {
      const added = lines(2_000 + round * 10, 2_010 + round * 10)
      appended += Buffer.byteLength(added)
      f.append(added)
      await readBig()
      await disk.flushTailWindowDisk()
      const wrote = disk._tailWindowDiskBytesWrittenForTesting() - before
      before += wrote
      // Old code: the whole window (64 KB) per save. Now the appended bytes and a description.
      expect(wrote).toBeLessThanOrEqual(Buffer.byteLength(added) + 1_024)
    }

    // Many more saves, past the data's cap: a few whole rewrites, the total still a small multiple.
    let next = 2_100
    for (let round = 0; round < 60; round++) {
      const added = lines(next, next + 300)
      next += 300
      appended += Buffer.byteLength(added)
      f.append(added)
      await readBig()
      await disk.flushTailWindowDisk()
    }
    const total = disk._tailWindowDiskBytesWrittenForTesting() - first
    expect(total).toBeLessThan(2 * appended)
    const [data] = await windowFiles()
    expect((await fsp.stat(path.join(dir, data))).size).toBeLessThanOrEqual(disk.COMPACT_FACTOR * 256 * 1024 + 1_024)
    await stop()

    // What was kept, appends and rewrites included, reads back as the file is.
    const again = await boot()
    f.bytes = 0
    const got = await again.win.readTailWindowRead(KEY, f, P, f.st(), BIG_WINDOW, parse, { persist: true })
    expect(got?.how).toBe('grown')
    expect(f.bytes).toBe(Buffer.byteLength(line(next - 1)))
    const probe = new FakeFile()
    probe.data = f.data
    expect(got?.value).toEqual((await again.win.readTailWindowRead(null, probe, P, f.st(), BIG_WINDOW, parse))?.value)
  })

  it('the disk keeps at least the windows memory holds, at their largest', async () => {
    const { win, disk } = await boot()
    expect(disk.MAX_DISK_WINDOWS).toBeGreaterThanOrEqual(win.MAX_TAIL_WINDOWS)
    expect(disk.MAX_DISK_WINDOW_BYTES).toBeGreaterThanOrEqual(disk.MAX_DISK_WINDOWS * disk.COMPACT_FACTOR * 4 * 1024 * 1024)
  })

  /**
   * More host sessions active than the caps hold (review, 2026-11-25): each save pushed out the
   * window due next by its save time, which then came back whole, about 136 MB a minute in
   * production. A window new on disk that would push out a recent one now waits for the stop.
   */
  it('more active sessions than the caps: a round of saves writes about the appended bytes, not windows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const BIG_WINDOW = 64 * 1024
    const { win, disk } = await boot()
    const n = disk.MAX_DISK_WINDOWS + 6
    const sessions = Array.from({ length: n }, (_, k) => {
      const f = new FakeFile()
      f.set(lines(0, 2_000))
      return { f, key: `s${k}@devbox|${BIG_WINDOW}` }
    })
    const readAll = async () => {
      for (const { f, key } of sessions) await win.readTailWindowRead(key, f, `/${key}`, f.st(), BIG_WINDOW, parse, { persist: true })
    }
    const saveRound = async () => {
      await vi.advanceTimersByTimeAsync(disk.TAIL_WINDOW_SAVE_EVERY_MS + 10)
      await disk._settleTailWindowDiskForTesting()
    }
    await readAll()
    await saveRound()
    let before = disk._tailWindowDiskBytesWrittenForTesting()
    let next = 2_000
    for (let round = 0; round < 5; round++) {
      const added = line(next++)
      for (const { f } of sessions) f.append(added)
      await readAll()
      await saveRound()
      const wrote = disk._tailWindowDiskBytesWrittenForTesting() - before
      before += wrote
      // Old code: several whole windows (64 KB each) every round. Now the appended lines and descriptions.
      expect(wrote).toBeLessThanOrEqual(n * (Buffer.byteLength(added) + 1_024))
    }
    expect((await windowFiles()).length).toBeLessThanOrEqual(disk.MAX_DISK_WINDOWS)
  })

  /**
   * A removal racing a write of the same key (review, 2026-11-25): the write ended after the
   * removal was decided and put its entry back, then the queued removal took its files, so
   * later appends failed with ENOENT and the disk held fewer windows than its entries said.
   */
  it('saves racing the cap\'s removals leave every entry with its files, and every kept window reads back', async () => {
    const f = new FakeFile()
    f.set(lines(0, 300))
    let { win, disk } = await boot()
    const n = disk.MAX_DISK_WINDOWS + 6
    const keys = Array.from({ length: n }, (_, k) => `r${k}@devbox|2000`)
    for (let round = 0; round < 4; round++) {
      f.append(line(300 + round))
      for (const key of keys) await read(win, f, key)
      await disk.flushTailWindowDisk()
      const names = await files()
      const metas = names.filter((x) => x.endsWith('.json'))
      expect(metas).toHaveLength(disk.MAX_DISK_WINDOWS)
      for (const m of metas) expect(names).toContain(m.replace(/\.json$/, '.win'))
    }
    await stop()
    ;({ win, disk } = await boot())
    let back = 0
    for (const key of keys) if ((await read(win, f, key))?.how === 'grown') back++
    expect(back).toBe(disk.MAX_DISK_WINDOWS)
  })

  it('a kept window whose data file vanished is written whole again, never left failing', async () => {
    const f = new FakeFile()
    f.set(lines(0, 200))
    const { win, disk } = await boot()
    await read(win, f)
    await disk.flushTailWindowDisk()
    for (const name of await windowFiles()) await fsp.rm(path.join(dir, name))
    f.append(line(200))
    await read(win, f)
    await disk.flushTailWindowDisk()
    expect(await windowFiles()).toHaveLength(1)
    await stop()
    const next = await boot()
    expect((await read(next.win, f))?.how).toBe('grown')
  })
})
