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
  compactDataCopies, compressCopy, findCompactableCopies, isCompactableCopyName,
} from '../../src/core/data-copy-compact.js'
import { GITIGNORE_CONTENT } from '../../src/integrations/git-sync.js'

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
    ['tasks.sqlite.pre-repair-0805.backup-wal', false],
    ['tasks.sqlite.pre-repair-0805.backup-shm', false],
    ['tasks.sqlite.pre-v5.backup', false],
    ['cron-jobs.backup.json', false],
    ['tasks.backup.sqlite', false],
    ['index.json.corrupt', false],
    ['library.unreadable.json', false],
    ['2026-11-01.bak.md', false],
    ['.usage.sqlite.123.1795546720563.backup', false],
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

  it('the .gz keeps the original\'s permissions (a 0600 copy stays owner-only)', async () => {
    const file = put('usage.sqlite.backup-1')
    fs.chmodSync(file, 0o600)
    expect(await compressCopy(file, { statfs: roomy })).not.toBeNull()
    expect(fs.statSync(`${file}.gz`).mode & 0o777).toBe(0o600)
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
      put('cron-jobs.backup.json'),
      put('tasks/tasks.backup.sqlite'),
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

  it('with the real data-repo .gitignore, every copy it compresses stays ignored as a .gz', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', home, ...args], { stdio: 'pipe' })
    git('init', '-q')
    fs.writeFileSync(path.join(home, '.gitignore'), GITIGNORE_CONTENT)
    put('usage.sqlite.backup-2026-11-20-before-host-dedupe')
    put('sessions.sqlite.orphan-repair-2026-08-21T01-51-47-764Z.backup') // `/*.backup.gz` covers its .gz
    put('tasks/tasks.sqlite.pre-repair-0805.backup')
    const rows = await compactDataCopies({ home, ...opts })
    expect(rows.map((r) => path.relative(home, r.file)).sort()).toEqual([
      'sessions.sqlite.orphan-repair-2026-08-21T01-51-47-764Z.backup', 'tasks/tasks.sqlite.pre-repair-0805.backup', 'usage.sqlite.backup-2026-11-20-before-host-dedupe',
    ])
    expect(execFileSync('git', ['-C', home, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('.gz'))).toEqual([])
  })

  it('a copy whose .gz the repo would not ignore stays as it is', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', home, ...args], { stdio: 'pipe' })
    git('init', '-q')
    fs.writeFileSync(path.join(home, '.gitignore'), '/*.backup\n') // an older install's rule, no .gz line
    const file = put('sessions.sqlite.orphan-repair-2026-08-21T01-51-47-764Z.backup')
    expect(await compactDataCopies({ home, ...opts })).toEqual([])
    expect(fs.existsSync(file)).toBe(true)
  })

  it('every compactable copy kind: the original and its .gz are both ignored by the real template, or it is skipped', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', home, ...args], { stdio: 'pipe' })
    git('init', '-q')
    fs.writeFileSync(path.join(home, '.gitignore'), GITIGNORE_CONTENT)
    const samples = ['x.sqlite.backup-1', 'x.json.corrupt-1', 'x.json.unreadable-1', 'x.sqlite.bak-20261101', 'x.sqlite.fix-20261101.backup', 'cron-jobs.json.backup-1']
    for (const n of samples) { put(n); put(`tasks/${n}`) }
    await compactDataCopies({ home, ...opts })
    const untracked = execFileSync('git', ['-C', home, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
    expect(untracked.split('\n').filter((l) => l.endsWith('.gz'))).toEqual([])
  })

  it('a SQLite copy with its -wal beside it stays whole, uncompressed', async () => {
    put('tasks.sqlite.pre-repair-0805.backup')
    put('tasks.sqlite.pre-repair-0805.backup-wal')
    expect(await compactDataCopies({ home, ...opts })).toEqual([])
    expect(names()).toEqual(['tasks.sqlite.pre-repair-0805.backup', 'tasks.sqlite.pre-repair-0805.backup-wal'])
  })

  it('one pass at a time per home: a second caller joins the pass in flight, another home runs its own', async () => {
    put('a.sqlite.backup-1')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-compact-other-'))
    try {
      const a = compactDataCopies({ home, ...opts })
      const b = compactDataCopies({ home, ...opts })
      const c = compactDataCopies({ home: other, ...opts })
      expect(b).toBe(a)
      expect(c).not.toBe(a)
      expect(await a).toHaveLength(1)
      expect(await c).toEqual([])
    } finally { fs.rmSync(other, { recursive: true, force: true }) }
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

  it('a copy that compresses worse than guessed stops before it eats the margin', async () => {
    // Random bytes do not compress: the .gz would grow past the room left above the margin.
    const file = path.join(home, 'usage.sqlite.backup-1')
    fs.writeFileSync(file, Buffer.from(Array.from({ length: 1024 * 1024 }, () => Math.floor(Math.random() * 256))))
    const bytes = fs.readFileSync(file)
    const tight = async () => ({ bavail: (256 * 1024 * 1024 + 400 * 1024) / 4096, bsize: 4096 })
    await expect(compressCopy(file, { statfs: tight })).rejects.toThrow(/outgrew its room/)
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    expect(names()).toEqual(['usage.sqlite.backup-1'])
  })

  it('the volume filling up during the write stops it', async () => {
    const file = put('usage.sqlite.backup-1', 1024 * 1024)
    let calls = 0
    // Roomy when it starts; then another writer takes the space.
    const filling = async () => (++calls === 1 ? { bavail: 1e9, bsize: 4096 } : { bavail: 10, bsize: 4096 })
    const random = path.join(home, 'r')
    fs.writeFileSync(random, Buffer.from(Array.from({ length: 1024 * 1024 }, () => Math.floor(Math.random() * 256))))
    fs.renameSync(random, file); fs.utimesSync(file, OLD, OLD)
    const bytes = fs.readFileSync(file)
    await expect(compressCopy(file, { statfs: filling, recheckBytes: 64 * 1024 })).rejects.toThrow(/ran low on space/)
    expect(calls).toBeGreaterThan(1)
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
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

describe('no copy Walnut writes again or reads back by name is compressed (class guard)', () => {
  // Code that opens a copy by name uses a fixed name: an exported `*_BACKUP_PATH/FILE`
  // constant, or a literal ending in a copy kind (`.replace(/\.json$/, '.backup.json')`,
  // `${INDEX_FILE}.corrupt`). Every such name must read as not compactable; a new one that
  // does fails here. Tagged copies (`.backup-${Date.now()}`) are written once and set aside.
  const root = path.resolve(__dirname, '../..')
  const constants: Array<{ file: string; name: string }> = []
  const literals: Array<{ file: string; tail: string }> = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) {
        const text = fs.readFileSync(p, 'utf8')
        for (const m of text.matchAll(/export const (\w+_BACKUP_(?:PATH|FILE))\b/g)) constants.push({ file: p, name: m[1] })
        for (const m of text.matchAll(/[^'"`}\s/]*\.(?:backup|bak|corrupt|unreadable)(?:\.[A-Za-z0-9]+)*(?=['"`])/g)) literals.push({ file: p, tail: m[0] })
      }
    }
  }
  walk(path.join(root, 'src'))

  it('finds the known ones', () => {
    expect(constants.map((f) => f.name)).toEqual(expect.arrayContaining(['TASK_DB_PRE_V5_BACKUP_PATH', 'CONFIG_BACKUP_FILE']))
    expect(literals.map((l) => l.tail)).toEqual(expect.arrayContaining(['.backup.json', '.backup.sqlite', '.corrupt', 'library.unreadable.json']))
  })

  it.each(constants.map((f) => [f.name, f.file]))('%s is not compactable', async (name, file) => {
    const mod = await import(file) as Record<string, unknown>
    expect(isCompactableCopyName(path.basename(String(mod[name])))).toBe(false)
  })

  it.each(literals.map((l) => [l.tail, path.relative(root, l.file)]))('literal %s (%s) is not compactable', (tail) => {
    expect(isCompactableCopyName(tail.startsWith('.') ? `x${tail}` : tail)).toBe(false)
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
