/**
 * Direct edits on the standby copy (A3): an edit in place, a replace, an added file and a
 * deleted file are each found by verify, saved under drift/<time>/, repaired from the batch,
 * and reported once. The copy is read-only on disk, so each edit first opens it as an
 * editor or a person with the rights would.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { reportPendingDrift, snapshotTo, standbyStatus, verifyStandby, type DriftReport } from '../../../src/core/standby/index.js'
import { sandbox, seedHome, sha, type Sandbox } from './helpers.js'

let sb: Sandbox
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})
const copy = (rel: string) => path.join(sb.target, 'copy', rel)
const open = (rel: string) => { fs.chmodSync(path.dirname(copy(rel)), 0o755); if (fs.existsSync(copy(rel))) fs.chmodSync(copy(rel), 0o644) }

async function oneBatch(): Promise<void> {
  dbs.push(...seedHome(sb.home).dbs)
  await new Promise((r) => setTimeout(r, 30))
  const out = await snapshotTo(sb.home, sb.target)
  expect(out.ok, out.ok ? '' : out.reason).toBe(true)
}

describe('the copy is read-only', () => {
  it('its files and dirs carry no write bit', async () => {
    sb = await sandbox('ro')
    await oneBatch()
    expect(fs.statSync(copy('memory/MEMORY.md')).mode & 0o222).toBe(0)
    expect(fs.statSync(copy('memory')).mode & 0o222).toBe(0)
    expect(() => fs.writeFileSync(copy('memory/MEMORY.md'), 'x')).toThrow(/EACCES|EPERM/)
  })
})

describe('verify finds, saves, repairs and reports once', () => {
  it('an edit in place (same size, mtime put back), a replace, an added file and a deleted file', async () => {
    sb = await sandbox('drift')
    await oneBatch()
    const original = sha(copy('memory/MEMORY.md'))

    // In place: same length, mtime set back, so only the ctime tells.
    const mem = copy('memory/MEMORY.md')
    const st = fs.statSync(mem)
    open('memory/MEMORY.md')
    fs.writeFileSync(mem, '# Memorx\n')
    fs.utimesSync(mem, st.atime, st.mtime)
    // Replaced by a new file (an editor's save).
    open('config.yaml')
    fs.writeFileSync(copy('config.yaml.new'), 'theme: hacked\n')
    fs.renameSync(copy('config.yaml.new'), copy('config.yaml'))
    // Added, and deleted.
    open('artifacts/notes/stray.md')
    fs.writeFileSync(copy('artifacts/notes/stray.md'), 'not from the leader\n')
    open('user-own-folder/plan.md')
    fs.rmSync(copy('user-own-folder/plan.md'))

    const reports: DriftReport[] = []
    const report = async (r: DriftReport) => { reports.push(r); return true }
    const v = await verifyStandby(sb.target, { report })
    const kinds = Object.fromEntries(v.drift.map((d) => [d.p, d.kind]))
    expect(kinds).toEqual({
      'memory/MEMORY.md': 'modified',
      'config.yaml': 'modified',
      'artifacts/notes/stray.md': 'added',
      'user-own-folder/plan.md': 'deleted',
    })
    // Saved before repair.
    const saved = (rel: string) => fs.readFileSync(path.join(sb.target, v.drift.find((d) => d.p === rel)!.saved!), 'utf8')
    expect(saved('memory/MEMORY.md')).toBe('# Memorx\n')
    expect(saved('config.yaml')).toBe('theme: hacked\n')
    expect(saved('artifacts/notes/stray.md')).toBe('not from the leader\n')
    // Repaired from the batch, read-only again.
    expect(sha(copy('memory/MEMORY.md'))).toBe(original)
    expect(fs.readFileSync(copy('config.yaml'), 'utf8')).toBe('theme: dark\n')
    expect(fs.existsSync(copy('artifacts/notes/stray.md'))).toBe(false)
    expect(fs.readFileSync(copy('user-own-folder/plan.md'), 'utf8')).toBe('unknown names are leader-data\n')
    expect(fs.statSync(copy('memory')).mode & 0o222).toBe(0)
    expect(fs.statSync(copy('config.yaml')).mode & 0o222).toBe(0)

    // Reported once: this pass, and never again.
    expect(reports).toHaveLength(1)
    expect(reports[0].items).toHaveLength(4)
    expect((await verifyStandby(sb.target, { deep: true, report })).drift).toEqual([])
    expect(await reportPendingDrift(sb.target, report)).toBe(0)
    expect(reports).toHaveLength(1)
    expect((await standbyStatus(sb.target)).unreportedDrift).toBe(0)
  })

  it('a pass with no reporter (the CLI) leaves its report for the server, which sends it once', async () => {
    sb = await sandbox('pending')
    await oneBatch()
    open('memory/MEMORY.md')
    fs.writeFileSync(copy('memory/MEMORY.md'), 'changed\n')
    expect((await verifyStandby(sb.target)).drift).toHaveLength(1)
    expect((await standbyStatus(sb.target)).unreportedDrift).toBe(1)
    const seen: DriftReport[] = []
    expect(await reportPendingDrift(sb.target, async (r) => { seen.push(r); return true })).toBe(1)
    expect(await reportPendingDrift(sb.target, async (r) => { seen.push(r); return true })).toBe(0)
    expect(seen).toHaveLength(1)
  })

  it('an edit never reaches the next batch: the next batch builds on the repaired copy', async () => {
    sb = await sandbox('next')
    await oneBatch()
    open('memory/MEMORY.md')
    fs.writeFileSync(copy('memory/MEMORY.md'), 'changed on the standby\n')
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok).toBe(true)
    // The commit did not touch it (unchanged on the leader); verify still finds and repairs it.
    const v = await verifyStandby(sb.target)
    expect(v.drift.map((d) => d.p)).toEqual(['memory/MEMORY.md'])
    expect(fs.readFileSync(copy('memory/MEMORY.md'), 'utf8')).toBe('# Memory\n')
  })
})
