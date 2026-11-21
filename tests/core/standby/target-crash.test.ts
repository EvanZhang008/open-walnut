/**
 * The target keeps complete batches only: a process killed (SIGKILL, as a power loss stops
 * it) at each point of a commit, and a disk that fills while chunks arrive or while files are
 * built, each leave one whole batch current, which verifies file by file.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { snapshotTo, standbyStatus, takeBatch, verifyStandby, StandbyTarget, type BatchManifest } from '../../../src/core/standby/index.js'
import { sandbox, seedHome, sha, write, type Sandbox } from './helpers.js'

let sb: Sandbox
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})
const settle = () => new Promise((r) => setTimeout(r, 30))
const read = (rel: string) => fs.readFileSync(path.join(sb.target, 'copy', rel), 'utf8')
/** The big file's sha256 in each batch (batch 2 changes its middle chunk in place). */
const blob: Record<1 | 2, string> = { 1: '', 2: '' }

/** Batch 1 committed; the home then changed (an edit, a delete, a new file, a database row). */
async function twoVersions(): Promise<void> {
  const seeded = seedHome(sb.home)
  dbs.push(...seeded.dbs)
  await settle()
  const first = await snapshotTo(sb.home, sb.target)
  expect(first.ok, first.ok ? '' : first.reason).toBe(true)
  blob[1] = sha(path.join(sb.home, 'big/blob.bin'))
  // One chunk of a 3-chunk file changes: the commit makes it from batch 1's copy (buildPatched).
  const fd = fs.openSync(path.join(sb.home, 'big/blob.bin'), 'r+')
  fs.writeSync(fd, Buffer.alloc(4096, 9), 0, 4096, 1024 * 1024 + 100)
  fs.closeSync(fd)
  blob[2] = sha(path.join(sb.home, 'big/blob.bin'))
  write(sb.home, 'memory/MEMORY.md', '# second version\n')
  fs.rmSync(path.join(sb.home, 'user-own-folder/plan.md'))
  write(sb.home, 'artifacts/notes/new.md', 'new in batch 2\n')
  seeded.dbs[0].prepare('INSERT INTO t (body) VALUES (?)').run('batch 2')
  await settle()
}

/** Stage and send batch 2 but stop before its commit: returns its manifest. */
async function sendWithoutCommit(): Promise<BatchManifest> {
  const target = new StandbyTarget(sb.target)
  await target.init()
  let held: BatchManifest | null = null
  const transport = {
    current: () => target.current(),
    missing: (ids: string[]) => target.missing(ids),
    putChunk: (id: string, data: Buffer) => target.putChunk(id, data),
    commit: async (m: BatchManifest) => { held = m; return { batch: m.batch, written: 0, deleted: 0, unchanged: false } },
  }
  const out = await takeBatch({ home: sb.home, transport, stagingDir: path.join(sb.root, 'staging') })
  expect(out.ok, out.ok ? '' : out.reason).toBe(true)
  return held!
}

function expectBatch(n: 1 | 2): void {
  expect(read('memory/MEMORY.md')).toBe(n === 1 ? '# Memory\n' : '# second version\n')
  expect(fs.existsSync(path.join(sb.target, 'copy', 'user-own-folder/plan.md'))).toBe(n === 1)
  expect(fs.existsSync(path.join(sb.target, 'copy', 'artifacts/notes/new.md'))).toBe(n === 2)
  expect(sha(path.join(sb.target, 'copy', 'big/blob.bin'))).toBe(blob[n])
}

describe('a commit killed at each point', () => {
  for (const [point, current] of [
    ['cloned', 1],
    ['files-built', 1],
    ['journal-written', 1],
    ['half-step', 1],
    ['mid-swap', 1],
    ['swapped', 1],
    ['state-written', 2],
  ] as const) {
    it(`killed at ${point}: batch ${current} is current and whole`, async () => {
      sb = await sandbox(`kill-${point}`)
      await twoVersions()
      const manifest = await sendWithoutCommit()
      const file = path.join(sb.root, 'manifest.json')
      fs.writeFileSync(file, JSON.stringify(manifest))
      const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/commit-and-die.ts'), sb.target, file, point], { encoding: 'utf8', timeout: 60_000 })
      expect(child.signal, child.stderr).toBe('SIGKILL')
      // Whatever opens the target next recovers it first.
      const verify = await verifyStandby(sb.target, { deep: true })
      expect(verify.drift).toEqual([])
      expect((await standbyStatus(sb.target)).batch).toBe(current)
      expectBatch(current)
      expect(fs.existsSync(path.join(sb.target, '.apply'))).toBe(false)
      // And the next batch goes on from there.
      const next = await snapshotTo(sb.home, sb.target)
      expect(next.ok, next.ok ? '' : next.reason).toBe(true)
      expectBatch(2)
      expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
    }, 60_000)
  }
})

describe('a full disk on the target', () => {
  it('while chunks arrive: the batch is void and batch 1 stays whole', async () => {
    sb = await sandbox('enospc-chunks')
    await twoVersions()
    const target = new StandbyTarget(sb.target)
    await target.init()
    let n = 0
    const transport = {
      current: () => target.current(),
      missing: (ids: string[]) => target.missing(ids),
      putChunk: async (id: string, data: Buffer) => {
        if (++n > 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        return target.putChunk(id, data)
      },
      commit: (m: BatchManifest) => target.commit(m),
    }
    const out = await takeBatch({ home: sb.home, transport, stagingDir: path.join(sb.root, 'staging') })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/ENOSPC/)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    expectBatch(1)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })

  it('while files are built: the commit fails and batch 1 stays whole', async () => {
    sb = await sandbox('enospc-build')
    await twoVersions()
    const manifest = await sendWithoutCommit()
    class FullDisk extends StandbyTarget {
      calls = 0
      override async build(...args: Parameters<StandbyTarget['build']>): Promise<void> {
        if (++this.calls > 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        return super.build(...args)
      }
    }
    await expect(new FullDisk(sb.target).commit(manifest)).rejects.toThrow(/ENOSPC/)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    expectBatch(1)
    expect(fs.existsSync(path.join(sb.target, '.apply'))).toBe(false)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })
})

describe('a changed large file is made from the last batch\'s copy', () => {
  it('only its changed chunk is written, and the result is the batch\'s', async () => {
    sb = await sandbox('patch')
    await twoVersions()
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(out.ok && out.commit.patched).toBe(1)
    expect(out.ok && out.commit.patchFailed).toBe(0)
    // The changed 1 MiB chunk of the big file, plus the small files written whole.
    expect(out.ok && out.commit.bytesWritten).toBeLessThan(1024 * 1024 + 64 * 1024)
    expectBatch(2)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })

  it('a copy edited directly is not cloned: the file is built from its chunks and the edit saved', async () => {
    sb = await sandbox('patch-drift')
    await twoVersions()
    const copied = path.join(sb.target, 'copy', 'big/blob.bin')
    fs.chmodSync(path.dirname(copied), 0o700)
    fs.chmodSync(copied, 0o600)
    const fd = fs.openSync(copied, 'r+')
    fs.writeSync(fd, Buffer.alloc(16, 1), 0, 16, 0)
    fs.closeSync(fd)
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(out.ok && out.commit.patched).toBe(0)
    // Not even tried: an edited copy is never a clone source (patchFailed counts a tried one).
    expect(out.ok && out.commit.patchFailed).toBe(0)
    expectBatch(2)
    const saved = fs.readdirSync(path.join(sb.target, 'drift')).filter((d) => d.endsWith('-commit'))
    expect(saved).toHaveLength(1)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })
})
