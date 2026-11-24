/**
 * Pruning keeps the trees a running Walnut uses (src/binary/runtime-tree.ts). The prune keeps
 * the two newest other builds by marker mtime, so a tree is "in use" only as far as its mtime
 * says (2026-11-24 review): a complete tree found again was never touched, a failed trial's tree
 * ranked newest, and the build the service runs could be pruned under it. Now a start that finds
 * its tree touches the marker, a trial's tree ranks last, and the build the place's service
 * runs is never pruned.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packArchive } from '../../src/binary/asset-archive.js'
import { RUNTIME_MARKER, RUNTIME_TRIAL_ENV, ensureRuntime, isServiceArgv } from '../../src/binary/runtime-tree.js'

const A = '1.0.0-aaaaaaaaaaaa'
const OTHERS = ['1.0.0-bbbbbbbbbbbb', '1.0.0-cccccccccccc', '1.0.0-dddddddddddd', '1.0.0-eeeeeeeeeeee']

let dir: string
let parent: string
let archiveFile: string
const saved = { ...process.env }
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-in-use-'))
  // The data home's place: the one a start prunes.
  process.env.OPEN_WALNUT_HOME = path.join(dir, 'home')
  delete process.env.WALNUT_RUNTIME_DIR
  delete process.env[RUNTIME_TRIAL_ENV]
  parent = path.join(dir, 'home', 'local', 'runtime')
  archiveFile = path.join(dir, 'assets.wna')
  fs.writeFileSync(archiveFile, packArchive([{ path: 'package.json', mode: 0o644, data: Buffer.from('{}') }], 1))
})
afterEach(() => {
  for (const key of ['OPEN_WALNUT_HOME', 'WALNUT_RUNTIME_DIR', RUNTIME_TRIAL_ENV]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Set a tree's marker mtime `minutes` ago (an older start). */
const age = (id: string, minutes: number) => {
  const t = new Date(Date.now() - minutes * 60_000)
  fs.utimesSync(path.join(parent, id, RUNTIME_MARKER), t, t)
}
const trees = () => fs.readdirSync(parent).filter((n) => !n.startsWith('.')).sort()

describe('a start keeps the trees in use', () => {
  it('a start that finds its tree complete touches it, so a later prune keeps it', () => {
    ensureRuntime(archiveFile, A)
    age(A, 30)
    ensureRuntime(archiveFile, OTHERS[0]!); age(OTHERS[0]!, 20)
    ensureRuntime(archiveFile, OTHERS[1]!); age(OTHERS[1]!, 10)
    ensureRuntime(archiveFile, A) // A runs again: its tree is in use now
    ensureRuntime(archiveFile, OTHERS[2]!)
    expect(trees()).toEqual([A, OTHERS[1]!, OTHERS[2]!].sort())
  })

  it('a trial\'s tree ranks last and the trial prunes nothing, so failed trials never push the running build out', () => {
    ensureRuntime(archiveFile, A)
    age(A, 30)
    process.env[RUNTIME_TRIAL_ENV] = '1'
    for (const id of OTHERS.slice(0, 3)) ensureRuntime(archiveFile, id)
    expect(trees()).toEqual([A, ...OTHERS.slice(0, 3)].sort())
    delete process.env[RUNTIME_TRIAL_ENV]
    ensureRuntime(archiveFile, OTHERS[3]!)
    // Kept: the new build, the running A and the newest trial (all trials rank last, one survives).
    expect(trees()).toContain(A)
    expect(trees()).toHaveLength(3)
  })

  it('a trial that passed, then the real start of its build, ranks that tree newest', () => {
    process.env[RUNTIME_TRIAL_ENV] = '1'
    ensureRuntime(archiveFile, OTHERS[0]!)
    expect(fs.statSync(path.join(parent, OTHERS[0]!, RUNTIME_MARKER)).mtimeMs).toBeLessThan(Date.now() - 365 * 24 * 3_600_000)
    delete process.env[RUNTIME_TRIAL_ENV]
    ensureRuntime(archiveFile, OTHERS[0]!)
    expect(fs.statSync(path.join(parent, OTHERS[0]!, RUNTIME_MARKER)).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('never prunes the build the place\'s service runs, however many builds start after it', () => {
    ensureRuntime(archiveFile, A, { service: true })
    age(A, 60)
    OTHERS.forEach((id, i) => { ensureRuntime(archiveFile, id); age(id, 50 - i * 10) })
    expect(trees()).toContain(A)
    // A trial's --service start names no service build.
    process.env[RUNTIME_TRIAL_ENV] = '1'
    ensureRuntime(archiveFile, '1.0.0-ffffffffffff', { service: true })
    delete process.env[RUNTIME_TRIAL_ENV]
    ensureRuntime(archiveFile, '1.0.0-999999999999')
    expect(trees()).toContain(A)
  })

  it.each([
    [['bun', '/f', '--service'], true],
    [['/f', '/f', '--service'], true],
    [['/f', '/f', '__daemon', '--service'], true],
    [['/f', '/f', 'walnut', 'daemon', 'status'], false],
    [['/f', '/f', '--start'], false],
  ])('isServiceArgv(%j) is %s', (argv, want) => {
    expect(isServiceArgv(argv, '/f')).toBe(want)
  })
})
