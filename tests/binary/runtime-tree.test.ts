/**
 * The compiled file's embedded archive and the runtime tree it unpacks into
 * (src/binary/asset-archive.ts, src/binary/runtime-tree.ts): a round trip keeps
 * every byte, path and mode; an unsafe path never lands outside the tree; a
 * build unpacks once, replaces a broken leftover, and pruning removes only old
 * trees this code made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { checkArchivePath, packArchive, unpackArchive } from '../../src/binary/asset-archive.js'
import { RUNTIME_MARKER, ensureRuntime, pruneRuntimes, unpackRuntime } from '../../src/binary/runtime-tree.js'

const entries = [
  { path: 'package.json', mode: 0o644, data: Buffer.from('{"name":"open-walnut"}\n') },
  { path: 'dist/web/static/index.html', mode: 0o644, data: Buffer.from('<div id="root"></div>') },
  // Test data: a non-ASCII file name and body (Latin and CJK).
  { path: 'dist/data/skills/caf\u00e9/SKILL.md', mode: 0o600, data: Buffer.from('\u65e5\u672c\n') },
  { path: 'dist/empty.txt', mode: 0o644, data: Buffer.alloc(0) },
  { path: 'dist/bin/tool', mode: 0o755, data: Buffer.from([0, 1, 2, 255]) },
]

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-tree-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('asset archive', () => {
  it('round-trips bytes, paths and modes', () => {
    const out = unpackArchive(packArchive(entries, 3))
    expect(out.map((e) => [e.path, e.mode, e.data.toString('hex')])).toEqual(entries.map((e) => [e.path, e.mode, e.data.toString('hex')]))
  })

  it.each(['/etc/passwd', '../escape', 'a/../../b', 'a//b', './a', 'a\\b', ''])('refuses the unsafe path %j', (p) => {
    expect(() => checkArchivePath(p)).toThrow(/unsafe path/)
    expect(() => packArchive([{ path: p, mode: 0o644, data: Buffer.from('x') }], 1)).toThrow(/unsafe path/)
  })

  it('refuses a truncated or foreign blob', () => {
    const packed = packArchive(entries, 3)
    expect(() => unpackArchive(Buffer.from('not an archive'))).toThrow()
    const raw = zlib.zstdDecompressSync(packed)
    expect(() => unpackArchive(zlib.zstdCompressSync(raw.subarray(0, raw.length - 2)))).toThrow(/truncated/)
  })
})

describe('runtime tree', () => {
  const archive = (): Buffer => packArchive(entries, 3)

  it('unpacks once, with the marker naming the build', () => {
    const root = path.join(dir, 'runtime', '1.0.0-aaaaaaaaaaaa')
    unpackRuntime(root, archive(), '1.0.0-aaaaaaaaaaaa')
    expect(fs.readFileSync(path.join(root, RUNTIME_MARKER), 'utf8').trim()).toBe('1.0.0-aaaaaaaaaaaa')
    expect(fs.readFileSync(path.join(root, 'dist/data/skills/caf\u00e9/SKILL.md'), 'utf8')).toBe('\u65e5\u672c\n')
    // Modes go through the umask, as with any extraction; the owner's exec bit survives.
    expect(fs.statSync(path.join(root, 'dist/bin/tool')).mode & 0o100).toBe(0o100)
    expect(fs.statSync(path.join(root, 'package.json')).mode & 0o100).toBe(0)
    // No staging dir is left beside it.
    expect(fs.readdirSync(path.dirname(root))).toEqual(['1.0.0-aaaaaaaaaaaa'])
  })

  it('ensureRuntime reuses a complete tree and replaces a broken leftover', () => {
    const archiveFile = path.join(dir, 'assets.wna')
    fs.writeFileSync(archiveFile, archive())
    const saved = process.env.WALNUT_RUNTIME_DIR
    const root = path.join(dir, 'override')
    process.env.WALNUT_RUNTIME_DIR = root
    try {
      // A leftover without the marker (a crashed unpack under the final name).
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(root, 'dist', 'stale.txt'), 'old')
      expect(ensureRuntime(archiveFile, 'id-1')).toBe(root)
      expect(fs.existsSync(path.join(root, 'dist', 'stale.txt'))).toBe(false)
      expect(fs.existsSync(path.join(root, 'dist/web/static/index.html'))).toBe(true)
      // Complete now: a second start does not touch it.
      fs.writeFileSync(path.join(root, 'dist', 'mine.txt'), 'kept')
      expect(ensureRuntime(archiveFile, 'id-1')).toBe(root)
      expect(fs.readFileSync(path.join(root, 'dist', 'mine.txt'), 'utf8')).toBe('kept')
    } finally {
      if (saved === undefined) delete process.env.WALNUT_RUNTIME_DIR
      else process.env.WALNUT_RUNTIME_DIR = saved
    }
  })

  it('prunes old trees past the newest two others, dead staging dirs, and nothing it did not make', () => {
    const parent = path.join(dir, 'runtime')
    const now = Date.now()
    const ids = ['0.1.0-000000000001', '0.1.0-000000000002', '0.1.0-000000000003', '0.1.0-000000000004']
    ids.forEach((id, i) => {
      unpackRuntime(path.join(parent, id), archive(), id)
      const t = new Date(now - (ids.length - i) * 60_000)
      fs.utimesSync(path.join(parent, id, RUNTIME_MARKER), t, t)
    })
    const current = '0.2.0-00000000000c'
    unpackRuntime(path.join(parent, current), archive(), current)
    fs.mkdirSync(path.join(parent, 'someone-elses-dir'))
    const deadStaging = path.join(parent, `${current}.partial-1-1`)
    const liveStaging = path.join(parent, `${current}.partial-2-2`)
    fs.mkdirSync(deadStaging)
    fs.mkdirSync(liveStaging)
    const old = new Date(now - 2 * 60 * 60_000)
    fs.utimesSync(deadStaging, old, old)

    pruneRuntimes(parent, current, now)
    expect(fs.readdirSync(parent).sort()).toEqual([current, `${current}.partial-2-2`, ids[2], ids[3], 'someone-elses-dir'].sort())
  })

  it('never throws when the parent is missing', () => {
    expect(() => pruneRuntimes(path.join(dir, 'absent'), 'x')).not.toThrow()
  })
})
