/**
 * The disk copy of a memory cache (src/core/kept-cache-file.ts): asks inside the delay make
 * one write of the state as it is when the write runs, a write is whole or absent, stop
 * flushes, and a file that does not parse or is of another version reads as none.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { keptCacheFile, readKeptJson } from '../../src/core/kept-cache-file.js'
import { writeFileAtomic } from '../../src/core/config-file-io.js'

let dir = ''
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-kept-file-')) })
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }) })
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('keptCacheFile', () => {
  it('asks inside the delay make one write, of the state when the write runs', async () => {
    const file = path.join(dir, 'c.json')
    const written: number[] = []
    const kept = keptCacheFile(file, { delayMs: 80, onError: (err) => { throw err }, onWritten: (b) => written.push(b) })
    let state = 0
    for (let i = 0; i < 20; i++) { state = i; kept.save(() => JSON.stringify({ v: 1, state })) }
    expect(kept.pending).toBe(true)
    await tick(20)
    // Nothing written before the delay: a cache that changes every tick does not write every tick.
    await expect(fsp.stat(file)).rejects.toThrow()
    await tick(150)
    expect(written).toHaveLength(1)
    expect(await readKeptJson(file, 1)).toEqual({ v: 1, state: 19 })
    // A later ask starts a new delay: still at most one write per delay.
    kept.save(() => JSON.stringify({ v: 1, state: 'later' }))
    kept.save(() => JSON.stringify({ v: 1, state: 'latest' }))
    await tick(150)
    expect(written).toHaveLength(2)
    expect((await readKeptJson(file, 1))?.state).toBe('latest')
    // No temp is left beside the file.
    expect(await fsp.readdir(dir)).toEqual(['c.json'])
  })

  it('flush writes what is asked now; an undefined body writes nothing; remove deletes the file', async () => {
    const file = path.join(dir, 'f.json')
    const kept = keptCacheFile(file, { delayMs: 60_000, onError: (err) => { throw err } })
    kept.save(() => '{"v":1,"x":1}')
    await kept.flush()
    expect(kept.pending).toBe(false)
    expect(await readKeptJson(file, 1)).toEqual({ v: 1, x: 1 })
    kept.save(() => undefined)
    await kept.flush()
    expect(await readKeptJson(file, 1)).toEqual({ v: 1, x: 1 })
    kept.save(() => '{"v":1,"x":2}')
    await kept.remove()
    await kept.flush()
    await expect(fsp.stat(file)).rejects.toThrow()
  })

  it('a file that does not parse, is not an object, or carries another version reads as none', async () => {
    const file = path.join(dir, 'bad.json')
    expect(await readKeptJson(file, 1)).toBeNull()
    for (const body of ['{"v":1,', 'null', '[1,2]', '{"v":2,"x":1}', '{"x":1}', '\u0000\u0001']) {
      await fsp.writeFile(file, body)
      expect(await readKeptJson(file, 1)).toBeNull()
    }
  })

  it('two atomic writes of one file in the same instant each use their own temp', async () => {
    const file = path.join(dir, 'same.bin')
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeFileAtomic(file, Buffer.from(`body-${i}`))))
    expect((await fsp.readFile(file, 'utf8'))).toMatch(/^body-\d$/)
    expect(await fsp.readdir(dir)).toEqual(['same.bin'])
  })
})
