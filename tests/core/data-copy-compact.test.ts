/**
 * src/core/data-copy-compact.ts: old, big ad-hoc copies in the data home become `.gz`,
 * losslessly; everything else (young, small, live fallbacks, copies code reads by name,
 * tracked files, symlinks, notes/ and tmp/) stays as it is, and a failure leaves the
 * original untouched with no temp behind. Temp homes only, never the real data home.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WALNUT_HOME } from '../../src/constants.js'
import {
  compactDataCopies, compressCopy, findCompactableCopies, isCompactableCopyName, KEPT_COPY_PATHS,
} from '../../src/core/data-copy-compact.js'

const OLD = new Date('2026-10-01T00:00:00Z')
const roomy = async () => ({ bavail: 1e9, bsize: 4096 })
const opts = { minBytes: 1024, statfs: roomy }

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-compact-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

/** A file of `size` bytes, mostly compressible, with an old mtime unless `young`. */
function put(rel: string, size = 64 * 1024, young = false): string {
  const file = path.join(home, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + (i >> 10)) % 251
  fs.writeFileSync(file, buf)
  if (!young) fs.utimesSync(file, OLD, OLD)
  return file
}
const names = (dir = home) => fs.readdirSync(dir).sort()

describe('isCompactableCopyName', () => {
  it.each([
    ['usage.sqlite.backup-2026-11-20-before-host-dedupe', true],
    ['sessions.sqlite.orphan-repair-2026-08-21T01-51-47-764Z.backup', true],
    ['tasks.sqlite.pre-repair-0805.backup', true],
    ['tasks.sqlite.pre-repair-0805.backup-wal', true],
    ['cron-jobs.json.corrupt-2026-11-24T07-16-00-469Z', true],
    ['x.json.unreadable-1', true],
    ['x.json.conflicted-1', false],
    ['config.yaml.conflicted-secret-1', false],
    ['usage.sqlite.bak-20261101', true],
    ['config.yaml.bak', false],
    ['MEMORY.md.bak.1', false],
    ['usage.sqlite.backup-1.gz', false],
    ['usage.sqlite.backup-1.gz.tmp-123', false],
    ['config.yaml.tmp-123-456', false],
    ['journal.jsonl.migrated', false],
    ['usage.sqlite', false],
  ])('%s -> %s', (name, want) => {
    expect(isCompactableCopyName(name)).toBe(want)
  })
})

describe('compactDataCopies', () => {
  it('compresses a big old copy to a .gz that reads back as the exact original, keeping its mtime', async () => {
    const file = put('usage.sqlite.backup-2026-11-20-before-host-dedupe', 256 * 1024)
    const bytes = fs.readFileSync(file)
    const rows = await compactDataCopies({ home, ...opts })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ file, before: bytes.length })
    expect(rows[0].after).toBeLessThan(bytes.length)
    expect(fs.existsSync(file)).toBe(false)
    const gz = `${file}.gz`
    expect(zlib.gunzipSync(fs.readFileSync(gz)).equals(bytes)).toBe(true)
    expect(fs.statSync(gz).mtimeMs).toBe(OLD.getTime())
    expect(names()).toEqual(['usage.sqlite.backup-2026-11-20-before-host-dedupe.gz'])
  })

  it('goes one folder deep and takes the largest first', async () => {
    put('a.json.corrupt-1', 8 * 1024)
    put('tasks/tasks.sqlite.pre-repair-0805.backup', 32 * 1024)
    put('tasks/deeper/x.backup-1', 32 * 1024)
    const found = await findCompactableCopies(home, opts)
    expect(found.map((f) => f.rel)).toEqual(['tasks/tasks.sqlite.pre-repair-0805.backup', 'a.json.corrupt-1'])
  })

  it('leaves young, small, live-fallback, kept-by-name, compressed, symlinked, notes/ and tmp/ files', async () => {
    const left = [
      put('young.sqlite.backup-1', 64 * 1024, true),
      put('small.sqlite.backup-1', 100),
      put('config.yaml.bak'),
      put('memory/MEMORY.md.bak.1'),
      put('tasks/tasks.sqlite.pre-v5.backup'),
      put('done.sqlite.backup-1.gz'),
      put('notes/vault.sqlite.backup-1'),
      put('tmp/scratch.sqlite.backup-1'),
      put('cache/x.sqlite.backup-1'),
    ]
    const target = put('elsewhere/real.sqlite')
    fs.symlinkSync(target, path.join(home, 'linked.sqlite.backup-1'))
    fs.mkdirSync(path.join(home, 'outside-dir'))
    put('outside-dir/y.backup-1')
    fs.symlinkSync(path.join(home, 'outside-dir'), path.join(home, 'linked-dir'))
    const rows = await compactDataCopies({ home, ...opts })
    expect(rows.map((r) => path.relative(home, r.file))).toEqual(['outside-dir/y.backup-1'])
    for (const f of left) expect(fs.existsSync(f)).toBe(true)
    expect(fs.lstatSync(path.join(home, 'linked.sqlite.backup-1')).isSymbolicLink()).toBe(true)
  })

  it('in a data repo, compresses only what git ignores, never a tracked file', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', home, ...args], { stdio: 'pipe' })
    git('init', '-q')
    fs.writeFileSync(path.join(home, '.gitignore'), '*.backup-*\n')
    const tracked = put('tracked.sqlite.backup-1')
    put('ignored.sqlite.backup-1')
    put('unignored.sqlite.corrupt-1')
    git('add', '-f', '.gitignore', 'tracked.sqlite.backup-1')
    const rows = await compactDataCopies({ home, ...opts })
    expect(rows.map((r) => path.basename(r.file))).toEqual(['ignored.sqlite.backup-1'])
    expect(fs.existsSync(tracked)).toBe(true)
    expect(fs.existsSync(path.join(home, 'unignored.sqlite.corrupt-1'))).toBe(true)
  })

  it('one pass at a time: a second caller joins the pass in flight', async () => {
    put('a.sqlite.backup-1')
    const a = compactDataCopies({ home, ...opts })
    const b = compactDataCopies({ home, ...opts })
    expect(b).toBe(a)
    expect(await a).toHaveLength(1)
  })
})

describe('compressCopy failures leave the original as it was and no temp', () => {
  it('a write that fails mid-way (a full disk)', async () => {
    const file = put('usage.sqlite.backup-1', 256 * 1024)
    const bytes = fs.readFileSync(file)
    // Writes the temp's first bytes, then the disk is full.
    const failing = (tmp: string) => new Writable({
      write(chunk, _e, cb) { fs.writeFileSync(tmp, chunk); cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })) },
    })
    await expect(compressCopy(file, { statfs: roomy, createWriteStream: failing })).rejects.toThrow(/ENOSPC/)
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    expect(names()).toEqual(['usage.sqlite.backup-1'])
  })

  it('the same through a pass: logged, the copy left, nothing else written', async () => {
    const file = put('usage.sqlite.backup-1', 256 * 1024)
    const failing = () => new Writable({ write(_c, _e, cb) { cb(new Error('EIO')) } })
    expect(await compactDataCopies({ home, ...opts, createWriteStream: failing })).toEqual([])
    expect(names()).toEqual(['usage.sqlite.backup-1'])
    expect(fs.statSync(file).mtimeMs).toBe(OLD.getTime())
  })

  it('too little free space: skipped before it starts', async () => {
    const file = put('usage.sqlite.backup-1', 256 * 1024)
    const full = async () => ({ bavail: 10, bsize: 4096 })
    expect(await compressCopy(file, { statfs: full })).toBeNull()
    expect(names()).toEqual(['usage.sqlite.backup-1'])
  })

  it('a .gz already there: both left', async () => {
    const file = put('usage.sqlite.backup-1')
    fs.writeFileSync(`${file}.gz`, 'other')
    expect(await compressCopy(file, { statfs: roomy })).toBeNull()
    expect(fs.readFileSync(`${file}.gz`, 'utf8')).toBe('other')
    expect(fs.existsSync(file)).toBe(true)
  })

  it('a temp a stopped run left beside the copy is cleared by the next run', async () => {
    const file = put('usage.sqlite.backup-1')
    fs.writeFileSync(`${file}.gz.tmp-99999`, 'half')
    expect(await compressCopy(file, { statfs: roomy })).not.toBeNull()
    expect(names()).toEqual(['usage.sqlite.backup-1.gz'])
  })
})

describe('every backup Walnut reads by name is kept (class guard)', () => {
  // A new `*_BACKUP_PATH` / `*_BACKUP_FILE` constant names a copy code opens by name: it must
  // join KEPT_COPY_PATHS, or a compaction would hide it from its reader.
  const root = path.resolve(__dirname, '../..')
  const found: Array<{ file: string; name: string }> = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/export const (\w+_BACKUP_(?:PATH|FILE))\b/g)) found.push({ file: p, name: m[1] })
      }
    }
  }
  walk(path.join(root, 'src'))

  it('finds the known ones', () => {
    expect(found.map((f) => f.name)).toEqual(expect.arrayContaining(['TASK_DB_PRE_V5_BACKUP_PATH', 'CONFIG_BACKUP_FILE']))
  })

  it.each(found.map((f) => [f.name, f.file]))('%s is in KEPT_COPY_PATHS', async (name, file) => {
    const mod = await import(file) as Record<string, unknown>
    const value = String(mod[name])
    const rel = (path.isAbsolute(value) ? path.relative(WALNUT_HOME, value) : value).split(path.sep).join('/')
    expect(KEPT_COPY_PATHS).toContain(rel)
  })
})

describe('the disk alarm auto-fix', () => {
  it('compresses the data copies and says so in its detail line', async () => {
    vi.resetModules()
    const sweepTaskDirsNow = vi.fn(async () => [])
    const compactDataCopies = vi.fn(async () => [{ file: '/x/usage.sqlite.backup-1', before: 2 * 1024 ** 3, after: 512 * 1024 ** 2 }])
    vi.doMock('../../src/core/task-dir-sweep.js', () => ({ sweepTaskDirsNow }))
    vi.doMock('../../src/core/data-copy-compact.js', () => ({ compactDataCopies }))
    try {
      const { runAutoFix } = await import('../../src/core/health-monitor/auto-fix.js')
      const r = await runAutoFix('disk-sweep', home)
      expect(r.ok).toBe(true)
      expect(compactDataCopies).toHaveBeenCalled()
      expect(r.detail).toContain('1 data copy compressed (1.5 GB saved)')
    } finally {
      vi.doUnmock('../../src/core/task-dir-sweep.js')
      vi.doUnmock('../../src/core/data-copy-compact.js')
      vi.resetModules()
    }
  })
})
