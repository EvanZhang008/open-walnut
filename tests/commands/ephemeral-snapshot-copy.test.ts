/**
 * How big a `web --ephemeral` snapshot gets (src/commands/ephemeral-snapshot-copy.ts).
 * 2026-11-04: one snapshot was a full 6.15 GB copy of the data dir (notes 3.7 GB,
 * plugin-data 0.8 GB) and the Mac's disk ran full. Where the volume clones, the
 * snapshot is copy-on-write and keeps everything; where it cannot, the largest
 * top-level folders a test does not need are left out (empty) until it fits the cap.
 * This runs the launcher's own copy step on real temp trees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyDataSnapshot, snapshotFilter } from '../../src/commands/ephemeral-snapshot.js'
import { canClone, copyCapBytes, DEFAULT_COPY_CAP_MB, measureTopLevel, SNAPSHOT_KEEP_TOP_LEVEL } from '../../src/commands/ephemeral-snapshot-copy.js'

const MB = 1024 * 1024
let root: string
let home: string
let dest: string
let warnings: string[]
const warn = (l: string) => { warnings.push(l) }

function write(rel: string, bytes: number | string): void {
  const file = path.join(home, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 7))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-snapshot-copy-'))
  home = path.join(root, 'home')
  dest = path.join(root, 'snapshot')
  fs.mkdirSync(home)
  fs.mkdirSync(dest)
  warnings = []
  // The shape of the real data dir, small: notes and plugin-data are the big ones.
  write('config.yaml', 'a: 1\n')
  write(path.join('tasks', 'tasks.json'), '{"tasks":[]}')
  write(path.join('tasks', 'big-archive.json'), 3 * MB)
  write(path.join('memory', 'USER.md'), '# user\n')
  write(path.join('notes', 'a.md'), 6 * MB)
  write(path.join('notes', 'deep', '日记.md'), 2 * MB)
  write(path.join('plugin-data', 'x', 'blob.bin'), 3 * MB)
  write(path.join('human-inbox', 'l.json'), 1 * MB)
  write(path.join('cache', 'derived.bin'), 4 * MB) // never copied (regenerable)
})

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('a real copy (no copy-on-write) stays under the cap', () => {
  it('leaves out the largest folders a test does not need, largest first, and says which', () => {
    const report = copyDataSnapshot(home, dest, { clone: false, capBytes: 8 * MB, warn })
    expect(report.mode).toBe('copy')
    expect(report.skipped.map((s) => s.entry)).toEqual(['notes'])
    expect(report.copiedBytes).toBeLessThanOrEqual(8 * MB)
    // Left out means empty, not missing: the server finds its folder.
    expect(fs.readdirSync(path.join(dest, 'notes'))).toEqual([])
    expect(fs.existsSync(path.join(dest, 'plugin-data', 'x', 'blob.bin'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'cache'))).toBe(false)
    expect(warnings.join('\n')).toMatch(/left out notes \(8 MB\).*8 MB cap.*WALNUT_EPHEMERAL_COPY_CAP_MB/)
  })

  it('a tighter cap drops more, but never what a test server needs (tasks, memory, plugin data) or a top-level file', () => {
    const report = copyDataSnapshot(home, dest, { clone: false, capBytes: 1 * MB, warn })
    expect(report.skipped.map((s) => s.entry)).toEqual(['notes', 'human-inbox'])
    for (const kept of ['config.yaml', path.join('tasks', 'big-archive.json'), path.join('memory', 'USER.md'), path.join('plugin-data', 'x', 'blob.bin')]) {
      expect(fs.existsSync(path.join(dest, kept)), kept).toBe(true)
    }
    // A plugin that finds its state gone may backfill against the real account.
    for (const keep of ['tasks', 'plugin-data', 'plugin-stores']) expect(SNAPSHOT_KEEP_TOP_LEVEL.has(keep)).toBe(true)
  })

  it('under the cap, or with no cap, everything the filter keeps is copied and nothing is said', () => {
    const report = copyDataSnapshot(home, dest, { clone: false, capBytes: Number.POSITIVE_INFINITY, warn })
    expect(report.skipped).toEqual([])
    expect(fs.statSync(path.join(dest, 'notes', 'deep', '日记.md')).size).toBe(2 * MB)
    expect(warnings).toEqual([])
  })

  it('measures what the filter would copy, per top-level entry', () => {
    const sizes = measureTopLevel(home, snapshotFilter(home))
    expect(sizes.get('notes')).toBe(8 * MB)
    expect(sizes.has('cache')).toBe(false)
  })

  it('the cap comes from WALNUT_EPHEMERAL_COPY_CAP_MB, 0 is no cap', () => {
    expect(copyCapBytes({})).toBe(DEFAULT_COPY_CAP_MB * MB)
    expect(copyCapBytes({ WALNUT_EPHEMERAL_COPY_CAP_MB: '512' })).toBe(512 * MB)
    expect(copyCapBytes({ WALNUT_EPHEMERAL_COPY_CAP_MB: '0' })).toBe(Number.POSITIVE_INFINITY)
    expect(copyCapBytes({ WALNUT_EPHEMERAL_COPY_CAP_MB: 'lots' })).toBe(DEFAULT_COPY_CAP_MB * MB)
  })
})

describe('copy-on-write where the volume clones', () => {
  it('the probe decides: a cloning volume copies everything as clones, any other copies under the cap', () => {
    const clones = canClone(home, dest, snapshotFilter(home))
    const report = copyDataSnapshot(home, dest, { capBytes: 6 * MB, warn })
    expect(report.mode).toBe(clones ? 'clone' : 'copy')
    if (clones) {
      expect(report.copiedBytes).toBe(0)
      expect(fs.statSync(path.join(dest, 'notes', 'a.md')).size).toBe(6 * MB)
      expect(warnings).toEqual([])
    } else {
      expect(report.skipped.length).toBeGreaterThan(0)
    }
    expect(fs.readdirSync(dest).some((n) => n.startsWith('.clone-probe'))).toBe(false)
  })

  it('cloning that fails part way copies the rest, and every kept file is there', () => {
    // Forced on: where the volume cannot clone, the first file fails and the copy path takes over.
    const report = copyDataSnapshot(home, dest, { clone: true, capBytes: Number.POSITIVE_INFINITY, warn })
    if (report.mode === 'copy') expect(report.cloneError).toBeTruthy()
    for (const rel of ['config.yaml', path.join('notes', 'a.md'), path.join('plugin-data', 'x', 'blob.bin')]) {
      expect(fs.existsSync(path.join(dest, rel)), rel).toBe(true)
    }
  })

  it('on macOS (APFS) under bun the temp volume clones', () => {
    // Node answers ENOSYS to COPYFILE_FICLONE_FORCE on macOS: a node launcher takes the capped copy.
    if (process.platform !== 'darwin' || typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return
    expect(canClone(home, dest, snapshotFilter(home))).toBe(true)
  })
})
