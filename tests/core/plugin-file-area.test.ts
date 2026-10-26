/**
 * A plugin's two file areas beside plugin-data/<id>/ (src/core/plugins/plugin-file-area.ts):
 *
 *   - `walnut.storage.files`: small text in the data folder's git. The rules that keep
 *     the data repo from becoming a commit firehose again are what this pins: text
 *     only, a per-file and per-plugin cap, and writes that reach the folder at most
 *     once every five minutes (read back at once, survive a crash, go out on stop).
 *   - `walnut.storage.tmp`: scratch, never in git, swept after the TTL.
 *
 * Real files in an isolated folder. Timers are faked only where the five-minute rule
 * is the question; the disk work stays real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SYNCED_AREA_DEFAULT_BYTES,
  SYNCED_AREA_MAX_BYTES,
  SYNCED_FILE_MAX_BYTES,
  SYNCED_PUBLISH_INTERVAL_MS,
  SYNCED_PUBLISH_MIN_DELAY_MS,
  SyncedFileArea,
  TMP_DEFAULT_TTL_HOURS,
  TMP_MAX_TTL_HOURS,
  TmpFileArea,
  parseStorageDeclaration,
  sweepPluginTmpOrphans,
  syncedAreaCap,
  tmpTtlMs,
  SYNCED_AREA_MAX_FILES,
  SYNCED_FLUSH_MIN_GAP_MS,
} from '../../src/core/plugins/plugin-file-area.js'

let base: string
let root: string
let pendingRoot: string

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-file-area-'))
  root = path.join(base, 'plugin-files', 'practice')
  pendingRoot = path.join(base, 'plugin-data', '.pending-files', 'practice')
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(base, { recursive: true, force: true })
})

function synced(options: Partial<ConstructorParameters<typeof SyncedFileArea>[0]> = {}) {
  return new SyncedFileArea({ pluginId: 'practice', cap: SYNCED_AREA_DEFAULT_BYTES, root, pendingRoot, replica: false, ...options })
}

const onDisk = (dir: string, name: string) => fs.readFile(path.join(dir, name), 'utf8').catch(() => null)
/** Nothing is waiting to be published (the empty pending folder itself may stay). */
const pendingFiles = async () => (await fs.readdir(pendingRoot, { recursive: true }).catch(() => [] as string[])).length

describe('the manifest declaration', () => {
  it('true takes the defaults; numbers are kept; a bad entry costs only that entry', () => {
    expect(parseStorageDeclaration(undefined)).toEqual({ dropped: [] })
    expect(parseStorageDeclaration({ files: true, tmp: true })).toEqual({ storage: { files: true, tmp: true }, dropped: [] })
    expect(parseStorageDeclaration({ files: { maxBytes: 1000 }, tmp: { ttlHours: 2 } }).storage).toEqual({ files: { maxBytes: 1000 }, tmp: { ttlHours: 2 } })
    expect(parseStorageDeclaration({ files: false, tmp: true }).storage).toEqual({ tmp: true })

    const bad = parseStorageDeclaration({ files: 'yes', tmp: { ttlHours: -1 }, cloud: true })
    // A bad number still opens the area with the default; a wrong shape drops it.
    expect(bad.storage).toEqual({ tmp: true })
    expect(bad.dropped).toEqual([
      'storage.files must be true or an object',
      'storage.tmp.ttlHours must be a positive number',
      'storage.cloud is not an area this Walnut knows',
    ])
    expect(parseStorageDeclaration([]).storage).toBeUndefined()
    expect(parseStorageDeclaration([]).dropped).toHaveLength(1)
  })

  it('caps and TTLs are clamped; an undeclared area has none', () => {
    expect(syncedAreaCap(undefined)).toBeNull()
    expect(syncedAreaCap({ tmp: true })).toBeNull()
    expect(syncedAreaCap({ files: true })).toBe(SYNCED_AREA_DEFAULT_BYTES)
    expect(syncedAreaCap({ files: { maxBytes: 1234.7 } })).toBe(1234)
    expect(syncedAreaCap({ files: { maxBytes: 10 * SYNCED_AREA_MAX_BYTES } })).toBe(SYNCED_AREA_MAX_BYTES)
    expect(tmpTtlMs({ files: true })).toBeNull()
    expect(tmpTtlMs({ tmp: true })).toBe(TMP_DEFAULT_TTL_HOURS * 3_600_000)
    expect(tmpTtlMs({ tmp: { ttlHours: 100_000 } })).toBe(TMP_MAX_TTL_HOURS * 3_600_000)
  })

  it('an area the manifest left out throws on use and says how to open it', async () => {
    const files = synced({ cap: null })
    await expect(files.writeText('a.md', 'x')).rejects.toThrow('"storage": { "files": true }')
    await expect(files.readText('a.md')).rejects.toThrow('no synced files area')
    await expect(files.list()).rejects.toThrow('no synced files area')
    const tmp = new TmpFileArea({ pluginId: 'practice', ttlMs: null, root: path.join(base, 'tmp') })
    await expect(tmp.writeText('a.txt', 'x')).rejects.toThrow('"storage": { "tmp": true }')
    // Nothing reached the disk.
    expect(existsSync(root)).toBe(false)
    expect(existsSync(pendingRoot)).toBe(false)
  })
})

describe('what a synced file may be', () => {
  it('only a path inside the area: no "..", no absolute path, no hidden name', async () => {
    const files = synced()
    for (const name of ['../escape.md', 'a/../../b.md', '/etc/passwd.md', 'C:/x.md', '.git/config.md', 'notes/.hidden.md', 'a\0b.md', '', '   ']) {
      await expect(files.writeText(name, 'x'), name).rejects.toThrow(/Invalid plugin file path/)
    }
    expect(existsSync(path.join(base, 'escape.md'))).toBe(false)
  })

  it('text only: the extension list, no NUL, a string', async () => {
    const files = synced()
    // Upper case too: git's whitelist matches case-sensitively on Linux, so it would never sync.
    for (const name of ['photo.png', 'db.sqlite', 'model.onnx', 'README', 'archive.md.gz', 'Review.MD']) {
      await expect(files.writeText(name, 'x'), name).rejects.toThrow(/lower-case extension, one of \.md/)
    }
    await expect(files.writeText('a.txt', 'one\0two')).rejects.toThrow('not binary data')
    await expect(files.writeText('a.txt', 42 as unknown as string)).rejects.toThrow('holds text')
    // git never tracks a node_modules folder under plugin-files/, so neither does the SDK.
    await expect(files.writeText('pkg/node_modules/notes.json', '{}')).rejects.toThrow(/node_modules/)
    await expect(files.writeText('pkg/Node_Modules/notes.json', '{}')).rejects.toThrow(/node_modules/)
    // Nested folders are fine, including names other rules ignore elsewhere.
    await files.writeText('Review.md', '# ok')
    await files.writeText('images/tmp/notes.json', '{}')
    expect(await files.list()).toEqual(['Review.md', 'images/tmp/notes.json'])
  })

  it('one file holds at most 1 MiB, counted in UTF-8 bytes', async () => {
    const files = synced()
    await files.writeText('max.txt', 'x'.repeat(SYNCED_FILE_MAX_BYTES))
    await expect(files.writeText('over.txt', 'x'.repeat(SYNCED_FILE_MAX_BYTES + 1))).rejects.toThrow(RangeError)
    // 3 bytes a character: a third of a MiB of characters already reaches the limit.
    const wide = '\u4e2d'.repeat(Math.floor(SYNCED_FILE_MAX_BYTES / 3) + 1)
    await expect(files.writeText('wide.txt', wide)).rejects.toThrow(/bytes; a synced plugin file holds at most/)
  })

  it('the area as a whole stays under its cap; a rewrite counts once; a delete frees room', async () => {
    const files = synced({ cap: 100 })
    await files.writeText('a.md', 'a'.repeat(60))
    await expect(files.writeText('b.md', 'b'.repeat(60))).rejects.toThrow(/would hold 120 bytes; its limit is 100/)
    await files.writeText('a.md', 'a'.repeat(90))
    await files.delete('a.md')
    await files.writeText('b.md', 'b'.repeat(60))
    expect(await files.list()).toEqual(['b.md'])
  })

  it('the cap holds under concurrent writes', async () => {
    const files = synced({ cap: 1000 })
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => files.writeText(`f${i}.txt`, 'x'.repeat(100))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    expect(await files.list()).toHaveLength(10)
  })

  it('at most 1,000 files, empty ones included; rewriting one that is there still works', async () => {
    const files = synced()
    for (let i = 0; i < SYNCED_AREA_MAX_FILES; i++) await files.writeText(`f/${i}.txt`, '')
    await expect(files.writeText('one-more.txt', '')).rejects.toThrow(/hold 1000 files/)
    await files.writeText('f/7.txt', 'rewritten')
    await files.delete('f/8.txt')
    await files.writeText('one-more.txt', '')
    await files.dispose()
  })

  it('the cap counts what is already published from an earlier run', async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'old.md'), 'o'.repeat(80))
    const files = synced({ cap: 100 })
    await expect(files.writeText('new.md', 'n'.repeat(30))).rejects.toThrow(/would hold 110 bytes/)
  })
})

describe('writes are coalesced', () => {
  it('kept and read back at once, published after a short delay, then at most once every five minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const files = synced()
    await files.writeText('review.md', 'v1')
    // Read-your-writes, while nothing has reached the synced folder (or git) yet.
    expect(await files.readText('review.md')).toBe('v1')
    expect(await onDisk(root, 'review.md')).toBeNull()
    expect(await onDisk(pendingRoot, 'review.md')).toBe('v1')

    // A burst within the first delay goes out as one change.
    await files.writeText('review.md', 'v2')
    await files.writeText('log.json', '[]')
    await vi.advanceTimersByTimeAsync(SYNCED_PUBLISH_MIN_DELAY_MS)
    // All three together: the publish may still be moving files when the first one lands.
    await vi.waitFor(async () => {
      expect(await onDisk(root, 'review.md')).toBe('v2')
      expect(await onDisk(root, 'log.json')).toBe('[]')
      expect(await pendingFiles()).toBe(0)
    })

    // Many writes right after a publish: nothing goes out until five minutes have passed.
    for (let i = 3; i <= 30; i++) {
      await files.writeText('review.md', `v${i}`)
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(await onDisk(root, 'review.md')).toBe('v2')
    expect(await files.readText('review.md')).toBe('v30')
    await vi.advanceTimersByTimeAsync(SYNCED_PUBLISH_INTERVAL_MS - 28 * 5_000 - 1_000)
    expect(await onDisk(root, 'review.md')).toBe('v2')
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(async () => expect(await onDisk(root, 'review.md')).toBe('v30'))
    await files.dispose()
  })

  it('stopping the plugin publishes what is pending; the area is closed afterwards', async () => {
    const files = synced()
    await files.writeText('notes/today.md', '# today\n\u00e9')
    await files.dispose()
    expect(await onDisk(root, 'notes/today.md')).toBe('# today\n\u00e9')
    expect(await pendingFiles()).toBe(0)
    await expect(files.writeText('x.md', 'y')).rejects.toThrow('closed')
  })

  it('flush publishes now', async () => {
    const files = synced()
    await files.writeText('a.md', 'now')
    await files.flush()
    expect(await onDisk(root, 'a.md')).toBe('now')
    await files.dispose()
  })

  it('a plugin\'s own flush publishes at most once a minute; a sooner one waits for the minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const files = synced()
    await files.writeText('a.md', 'one')
    await files.flush()
    expect(await onDisk(root, 'a.md')).toBe('one')
    await files.writeText('a.md', 'two')
    let done = false
    const held = files.flush().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(SYNCED_FLUSH_MIN_GAP_MS - 1_000)
    expect(done).toBe(false)
    expect(await onDisk(root, 'a.md')).toBe('one')
    await vi.advanceTimersByTimeAsync(2_000)
    await held
    expect(await onDisk(root, 'a.md')).toBe('two')
    // Stopping the plugin publishes at once, whatever the last publish was.
    await files.writeText('a.md', 'three')
    await files.dispose()
    expect(await onDisk(root, 'a.md')).toBe('three')
  })

  it('a flush held when the plugin stops resolves with the final publish', async () => {
    const files = synced()
    await files.writeText('a.md', 'one')
    await files.flush()
    await files.writeText('a.md', 'two')
    const held = files.flush()
    await files.dispose()
    await held
    expect(await onDisk(root, 'a.md')).toBe('two')
  })

  it('a write while a publish runs is never lost', async () => {
    const files = synced()
    await files.writeText('a.md', 'first')
    const publishing = files.flush()
    const writing = files.writeText('a.md', 'second')
    await Promise.all([publishing, writing])
    expect(await files.readText('a.md')).toBe('second')
    await files.dispose()
    expect(await onDisk(root, 'a.md')).toBe('second')
  })

  it('a crash left writes pending: the next start publishes them without a new write', async () => {
    await fs.mkdir(path.join(pendingRoot, 'sub'), { recursive: true })
    await fs.writeFile(path.join(pendingRoot, 'sub', 'left.md'), 'from before the crash')
    const files = synced({ minDelayMs: 0 })
    await files.resume()
    await vi.waitFor(async () => expect(await onDisk(root, 'sub/left.md')).toBe('from before the crash'))
    expect(await pendingFiles()).toBe(0)
    await files.dispose()
  })

  it('delete removes the pending copy and the published one, and the folders it emptied', async () => {
    const files = synced()
    await files.writeText('deep/dir/a.md', 'a')
    await files.flush()
    await files.writeText('deep/dir/a.md', 'a2')
    await files.delete('deep/dir/a.md')
    expect(await files.readText('deep/dir/a.md')).toBeNull()
    expect(existsSync(path.join(root, 'deep'))).toBe(false)
    expect(existsSync(path.join(pendingRoot, 'deep'))).toBe(false)
    await files.dispose()
  })

  it('list unions pending and published, filtered by a folder prefix', async () => {
    const files = synced()
    await files.writeText('reviews/a.md', 'a')
    await files.flush()
    await files.writeText('reviews/b.md', 'b')
    await files.writeText('rules.yaml', 'r: 1')
    expect(await files.list()).toEqual(['reviews/a.md', 'reviews/b.md', 'rules.yaml'])
    expect(await files.list('reviews')).toEqual(['reviews/a.md', 'reviews/b.md'])
    await expect(files.list('../x')).rejects.toThrow(/Invalid plugin file path/)
    await files.dispose()
  })

  it('readJson / writeJson round-trip', async () => {
    const files = synced()
    expect(await files.readJson('state.json', { n: 0 })).toEqual({ n: 0 })
    await files.writeJson('state.json', { n: 1, s: '\u00e9' })
    expect(await files.readJson('state.json', { n: 0 })).toEqual({ n: 1, s: '\u00e9' })
    await files.dispose()
  })
})

describe('on a replica', () => {
  it('reads what git brought, refuses writes, and publishes nothing', async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'from-primary.md'), 'primary')
    await fs.mkdir(pendingRoot, { recursive: true })
    await fs.writeFile(path.join(pendingRoot, 'stray.md'), 'stray')
    const files = synced({ replica: true, minDelayMs: 0 })
    expect(await files.readText('from-primary.md')).toBe('primary')
    await expect(files.writeText('x.md', 'y')).rejects.toThrow('read-only on a replica')
    await expect(files.delete('from-primary.md')).rejects.toThrow('read-only on a replica')
    await files.resume()
    await files.dispose()
    expect(await onDisk(root, 'stray.md')).toBeNull()
    expect(await onDisk(root, 'from-primary.md')).toBe('primary')
  })
})

describe('the tmp area', () => {
  const tmpRoot = () => path.join(base, 'tmp', 'plugins', 'practice')

  it('reads and writes any file inside it, and refuses ".."', async () => {
    const tmp = new TmpFileArea({ pluginId: 'practice', ttlMs: 3_600_000, root: tmpRoot() })
    expect(tmp.dir).toBe(tmpRoot())
    await tmp.writeText('run/out.log', 'log')
    await tmp.writeJson('cache.json', { a: 1 })
    expect(await tmp.readText('run/out.log')).toBe('log')
    expect(await tmp.readJson('cache.json', {})).toEqual({ a: 1 })
    expect(await tmp.list()).toEqual(['cache.json', 'run/out.log'])
    await expect(tmp.writeText('../../escape.txt', 'x')).rejects.toThrow(/Invalid Plugin storage path/)
    await tmp.dispose()
  })

  const plant = async (name: string, ageMs: number, now = Date.now()) => {
    const file = path.join(tmpRoot(), name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'x')
    const at = new Date(now - ageMs)
    await fs.utimes(file, at, at)
  }

  it('the area sweeps when the plugin starts, before any write: scratch it never touches again still expires', async () => {
    await plant('old/deep/a.bin', 2 * 3_600_000)
    await plant('fresh.txt', 0)
    const tmp = new TmpFileArea({ pluginId: 'practice', ttlMs: 3_600_000, root: tmpRoot() })
    await vi.waitFor(() => expect(existsSync(path.join(tmpRoot(), 'old'))).toBe(false))
    expect(existsSync(path.join(tmpRoot(), 'fresh.txt'))).toBe(true)
    await tmp.dispose()
  })

  it('a sweep removes files past the TTL and the folders they leave empty, and keeps fresh ones', async () => {
    const now = Date.now()
    const tmp = new TmpFileArea({ pluginId: 'practice', ttlMs: 3_600_000, root: tmpRoot(), now: () => now })
    // The sweep at start has nothing to do yet; wait it out so it cannot take the file below.
    await tmp.sweep()
    await plant('old/deep/a.bin', 2 * 3_600_000, now)
    await plant('fresh.txt', 0, now)
    expect(await tmp.sweep()).toBe(1)
    expect(existsSync(path.join(tmpRoot(), 'old'))).toBe(false)
    expect(existsSync(path.join(tmpRoot(), 'fresh.txt'))).toBe(true)
    await tmp.dispose()
  })

  it('an area the manifest did not declare never sweeps', async () => {
    await plant('kept.txt', 365 * 24 * 3_600_000)
    const tmp = new TmpFileArea({ pluginId: 'practice', ttlMs: null, root: tmpRoot() })
    expect(await tmp.sweep()).toBe(0)
    await tmp.dispose()
    expect(existsSync(path.join(tmpRoot(), 'kept.txt'))).toBe(true)
  })

  it('at boot, scratch older than the longest TTL goes, whichever plugin left it', async () => {
    const tmpDir = path.join(base, 'tmp')
    const gone = path.join(tmpDir, 'plugins', 'uninstalled', 'x.txt')
    const kept = path.join(tmpDir, 'plugins', 'practice', 'y.txt')
    const outside = path.join(tmpDir, 'stt-recordings', 'z.wav')
    for (const file of [gone, kept, outside]) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, 'x')
    }
    const old = new Date(Date.now() - (TMP_MAX_TTL_HOURS + 1) * 3_600_000)
    await fs.utimes(gone, old, old)
    await fs.utimes(outside, old, old)
    expect(await sweepPluginTmpOrphans(tmpDir)).toBe(1)
    expect(existsSync(path.join(tmpDir, 'plugins', 'uninstalled'))).toBe(false)
    expect(existsSync(kept)).toBe(true)
    // Only tmp/plugins/ is this sweep's business.
    expect(existsSync(outside)).toBe(true)
  })
})

describe('walnut-plugin validate', () => {
  async function validateStorage(storage: unknown) {
    const dir = path.join(base, 'validate', 'acme-plugin')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'acme-plugin', name: 'Acme', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, storage }))
    const { validatePlugin } = await import('../../packages/plugin-cli/src/manifest.js')
    const { errors, warnings } = await validatePlugin(dir)
    return { errors: errors.filter((e) => e.includes('storage')), warnings: warnings.filter((w) => w.includes('storage')) }
  }

  it('reports what the host would drop as an error, and a value it would clamp as a warning', async () => {
    expect(await validateStorage({ files: true, tmp: { ttlHours: 2 } })).toEqual({ errors: [], warnings: [] })
    expect((await validateStorage({ files: 'yes', cloud: true })).errors).toEqual([
      'manifest.storage.cloud is not an area; use "files" or "tmp"',
      'manifest.storage.files must be true or an object',
    ])
    expect((await validateStorage({ tmp: { ttlHours: -1 } })).errors).toEqual(['manifest.storage.tmp.ttlHours must be a positive number'])
    expect((await validateStorage({ files: { maxBytes: SYNCED_AREA_MAX_BYTES * 2 } })).warnings).toEqual([`manifest.storage.files.maxBytes is above ${SYNCED_AREA_MAX_BYTES}; Walnut uses ${SYNCED_AREA_MAX_BYTES}`])
    expect((await validateStorage([])).errors).toEqual(['manifest.storage must be an object like { "files": true, "tmp": true }'])
  })
})
