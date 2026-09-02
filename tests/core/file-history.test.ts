/**
 * File-history snapshot store (src/core/file-history.ts).
 *
 * The contract being pinned, one line each:
 *   - versions append in order, newest last, and identical content never doubles,
 *   - `live` snapshots inside the coalesce window REPLACE (typing is one version
 *     per minute, not one per keystroke) but never swallow a different writer,
 *   - the per-file cap drops the oldest version AND its blob, while a blob a
 *     surviving entry still references stays,
 *   - oversize content is skipped, not thrown,
 *   - a corrupt index.json reads as "no history" instead of failing a request,
 *   - the global directory budget reclaims the least recently updated files.
 *
 * SAFETY: OPEN_WALNUT_HOME is repointed at a mkdtemp dir for the whole file, so
 * every path touched here lives under that temp tree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const {
  recordSnapshot, listSnapshots, readSnapshot, forgetFile, pruneFileHistoryDirs,
} = await import('../../src/core/file-history.js')

let tmpHome: string
let prevHome: string | undefined
const FILE = '/tmp/marina/project/notes.ts'

/** `<home>/tmp/file-history` — the one directory the store may use. */
const storeRoot = () => path.join(tmpHome, 'tmp', 'file-history')

async function storeDirs(): Promise<string[]> {
  try {
    return (await fs.readdir(storeRoot())).sort()
  } catch {
    return []
  }
}

async function blobsOf(file = FILE): Promise<string[]> {
  const dirs = await storeDirs()
  for (const d of dirs) {
    const full = path.join(storeRoot(), d)
    const raw = JSON.parse(await fs.readFile(path.join(full, 'index.json'), 'utf-8')) as { path: string }
    if (raw.path === file) {
      return (await fs.readdir(full)).filter((n) => n.endsWith('.txt')).sort()
    }
  }
  return []
}

beforeEach(async () => {
  prevHome = process.env.OPEN_WALNUT_HOME
  tmpHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-file-history-')))
  process.env.OPEN_WALNUT_HOME = tmpHome
})

afterEach(async () => {
  vi.useRealTimers()
  if (prevHome === undefined) delete process.env.OPEN_WALNUT_HOME
  else process.env.OPEN_WALNUT_HOME = prevHome
  // `tmpHome` is always the mkdtemp dir from beforeEach — nothing else is removed.
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('recordSnapshot / listSnapshots', () => {
  it('appends versions newest-last and stores under tmp/file-history only', async () => {
    await recordSnapshot({ path: FILE, content: 'one', writer: 'baseline' })
    await recordSnapshot({ path: FILE, content: 'two', writer: 'user' })
    const entries = await listSnapshots({ path: FILE })
    expect(entries.map((e) => e.writer)).toEqual(['baseline', 'user'])
    expect(entries[0]!.at).toBeLessThanOrEqual(entries[1]!.at)
    expect(entries[1]!.size).toBe(3)
    // Nothing outside tmp/ — everything at the WALNUT_HOME root is git-synced.
    expect(await fs.readdir(tmpHome)).toEqual(['tmp'])
    expect((await storeDirs()).length).toBe(1)
  })

  it('keeps host and local histories separate', async () => {
    await recordSnapshot({ path: FILE, content: 'local', writer: 'user' })
    await recordSnapshot({ host: 'marina', path: FILE, content: 'remote', writer: 'user' })
    expect((await listSnapshots({ path: FILE })).length).toBe(1)
    expect((await listSnapshots({ host: 'marina', path: FILE })).length).toBe(1)
    expect((await storeDirs()).length).toBe(2)
  })

  it('skips a snapshot whose content matches the newest entry (any writer)', async () => {
    await recordSnapshot({ path: FILE, content: 'same', writer: 'baseline' })
    await recordSnapshot({ path: FILE, content: 'same', writer: 'user' })
    await recordSnapshot({ path: FILE, content: 'same', writer: 'agent' })
    expect((await listSnapshots({ path: FILE })).length).toBe(1)
  })

  it('coalesces two live snapshots inside the 60s window (replace, not append)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'))
    await recordSnapshot({ path: FILE, content: 'a', writer: 'live' })
    vi.setSystemTime(new Date('2026-09-02T10:00:30Z'))
    await recordSnapshot({ path: FILE, content: 'ab', writer: 'live' })
    const entries = await listSnapshots({ path: FILE })
    expect(entries.length).toBe(1)
    expect(entries[0]!.size).toBe(2)
    expect(entries[0]!.at).toBe(new Date('2026-09-02T10:00:30Z').getTime())
    // The replaced blob is gone — nothing references it any more.
    expect(await blobsOf()).toHaveLength(1)
    // …and the surviving entry's blob really holds the newer content.
    const back = await readSnapshot({ path: FILE, id: entries[0]!.id })
    expect(back?.content).toBe('ab')
  })

  it('appends a live snapshot once the window has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'))
    await recordSnapshot({ path: FILE, content: 'a', writer: 'live' })
    vi.setSystemTime(new Date('2026-09-02T10:01:30Z'))
    await recordSnapshot({ path: FILE, content: 'ab', writer: 'live' })
    expect((await listSnapshots({ path: FILE })).map((e) => e.size)).toEqual([1, 2])
  })

  it('never coalesces a live snapshot onto a different writer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'))
    await recordSnapshot({ path: FILE, content: 'saved', writer: 'user' })
    vi.setSystemTime(new Date('2026-09-02T10:00:05Z'))
    await recordSnapshot({ path: FILE, content: 'typing', writer: 'live' })
    const entries = await listSnapshots({ path: FILE })
    expect(entries.map((e) => e.writer)).toEqual(['user', 'live'])
  })

  it('caps a file at 100 entries, dropping the oldest and its unreferenced blob', async () => {
    // 101 distinct versions, then one that repeats the very first content so a
    // blob still referenced by a surviving entry must NOT be reclaimed.
    for (let i = 0; i < 101; i++) {
      await recordSnapshot({ path: FILE, content: 'v' + i, writer: 'user' })
    }
    let entries = await listSnapshots({ path: FILE })
    expect(entries.length).toBe(100)
    // v0 fell off the front.
    expect(await readSnapshot({ path: FILE, id: entries[0]!.id })).not.toBeNull()
    expect((await readSnapshot({ path: FILE, id: entries[0]!.id }))!.content).toBe('v1')

    // Re-record 'v50' (still in the window) then push one more version: the
    // duplicate keeps 'v50's blob alive even after the older entry is dropped.
    await recordSnapshot({ path: FILE, content: 'v50', writer: 'user' })
    entries = await listSnapshots({ path: FILE })
    const v50Entries = entries.filter((e) => e.size === 3)
    expect(v50Entries.length).toBeGreaterThanOrEqual(1)
    const dupHash = entries[entries.length - 1]!.hash
    expect(entries.filter((e) => e.hash === dupHash).length).toBe(2)
    // Blobs are content-addressed: 100 entries with one duplicated pair → 99 blobs.
    expect((await blobsOf()).length).toBe(99)
  })

  it('skips content over the 8 MB ceiling without throwing', async () => {
    const big = 'x'.repeat(8 * 1024 * 1024 + 1)
    await expect(recordSnapshot({ path: FILE, content: big, writer: 'user' })).resolves.toBeUndefined()
    expect(await listSnapshots({ path: FILE })).toEqual([])
  })

  it('treats a corrupt index.json as empty and can record over it', async () => {
    await recordSnapshot({ path: FILE, content: 'one', writer: 'user' })
    const dir = path.join(storeRoot(), (await storeDirs())[0]!)
    await fs.writeFile(path.join(dir, 'index.json'), '{ not json at all', 'utf-8')
    await expect(listSnapshots({ path: FILE })).resolves.toEqual([])
    await expect(readSnapshot({ path: FILE, id: 'anything' })).resolves.toBeNull()
    await recordSnapshot({ path: FILE, content: 'two', writer: 'user' })
    expect((await listSnapshots({ path: FILE })).length).toBe(1)
  })

  it('answers empty for a file with no history at all', async () => {
    expect(await listSnapshots({ path: '/tmp/marina/never-opened.ts' })).toEqual([])
    expect(await readSnapshot({ path: '/tmp/marina/never-opened.ts', id: 'x' })).toBeNull()
  })
})

describe('readSnapshot', () => {
  it('returns the recorded content, hash, time and writer', async () => {
    await recordSnapshot({ path: FILE, content: 'hello world', writer: 'agent' })
    const [entry] = await listSnapshots({ path: FILE })
    const snap = await readSnapshot({ path: FILE, id: entry!.id })
    expect(snap).toMatchObject({ content: 'hello world', hash: entry!.hash, at: entry!.at, writer: 'agent' })
  })

  it('returns null for an unknown id', async () => {
    await recordSnapshot({ path: FILE, content: 'hello', writer: 'user' })
    expect(await readSnapshot({ path: FILE, id: '1-deadbeef' })).toBeNull()
  })
})

describe('forgetFile', () => {
  it('drops every version of one file and leaves other files alone', async () => {
    const other = '/tmp/marina/project/other.ts'
    await recordSnapshot({ path: FILE, content: 'a', writer: 'user' })
    await recordSnapshot({ path: other, content: 'b', writer: 'user' })
    await forgetFile({ path: FILE })
    expect(await listSnapshots({ path: FILE })).toEqual([])
    expect((await listSnapshots({ path: other })).length).toBe(1)
  })
})

describe('pruneFileHistoryDirs', () => {
  it('removes the least recently updated files when over the budget', async () => {
    const paths = ['a', 'b', 'c', 'd', 'e'].map((n) => `/tmp/marina/project/${n}.ts`)
    for (const p of paths) await recordSnapshot({ path: p, content: p, writer: 'user' })
    expect((await storeDirs()).length).toBe(5)

    // Stamp the index mtimes so "least recently updated" is deterministic:
    // a.ts oldest … e.ts newest.
    const dirs = await storeDirs()
    const byPath = new Map<string, string>()
    for (const d of dirs) {
      const full = path.join(storeRoot(), d)
      const idx = JSON.parse(await fs.readFile(path.join(full, 'index.json'), 'utf-8')) as { path: string }
      byPath.set(idx.path, full)
    }
    for (let i = 0; i < paths.length; i++) {
      const when = new Date(Date.now() - (paths.length - i) * 60_000)
      await fs.utimes(path.join(byPath.get(paths[i]!)!, 'index.json'), when, when)
    }

    expect(await pruneFileHistoryDirs(3)).toBe(2)
    expect(await listSnapshots({ path: paths[0]! })).toEqual([])
    expect(await listSnapshots({ path: paths[1]! })).toEqual([])
    for (const p of paths.slice(2)) expect((await listSnapshots({ path: p })).length).toBe(1)
  })

  it('is a no-op under the budget', async () => {
    await recordSnapshot({ path: FILE, content: 'a', writer: 'user' })
    expect(await pruneFileHistoryDirs(500)).toBe(0)
    expect((await listSnapshots({ path: FILE })).length).toBe(1)
  })
})
