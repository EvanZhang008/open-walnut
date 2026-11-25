/**
 * A leader switch's stop ends this server's git in the home (quietGitWriters, git-sync.ts).
 *
 * Found by a 20 GB rehearsal between machines (2026-11-24): after the switch stop began, the
 * auto-commit's background large-file lane still ran `git hash-object -w` of 256 MB files and a
 * tick still committed, so the final batch found `.git` changing until the commit window ended,
 * and the switch rolled back after six minutes without a leader. Here: real git children of this
 * process in an isolated home. A child that holds no lock ends at once; one that may hold a lock
 * finishes within the budget, or is ended after it; no git starts in the home (or below it) once
 * it is quiet, sync or async; the auto-commit's large-file lane stops; a later server runs again.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-switch-quiet-git'))

import { GitQuiet, commitIfDirty, endGitQuiet, execGitArgsRaw, execGitGroup, git, gitQuietAt, initSync, oldestOwnGitStart, quietGitWriters } from '../../src/integrations/git-sync.js'
import { prehashInFlight, setLargeFileLaneForTest } from '../../src/integrations/git-sync-large-files.js'
import { WALNUT_HOME } from '../../src/constants.js'

/** Marks the slow gits write once their shell runs (outside the home, so the repo stays clean). */
const MARKS = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-slow-git-'))
let marks = 0
afterAll(() => fs.rmSync(MARKS, { recursive: true, force: true }))

/** A git child that runs `seconds` (a shell alias: git starts the sleep in its own process group); its mark says it runs. */
const slowGit = (seconds: number, o: { holdsNoLock?: boolean; cwd?: string } = {}) => {
  const mark = path.join(MARKS, String(++marks))
  const run = execGitArgsRaw(['-c', `alias.slow=!touch '${mark}' && sleep ${seconds}`, 'slow'], { cwd: o.cwd ?? WALNUT_HOME, timeout: 60_000, ...(o.holdsNoLock ? { holdsNoLock: true } : {}) })
  return Object.assign(run, { mark })
}

/** Until each slow git's shell runs (its mark is there). */
const untilRunning = (...runs: Array<{ mark: string }>) =>
  vi.waitFor(() => { for (const r of runs) if (!fs.existsSync(r.mark)) throw new Error(`not running yet: ${r.mark}`) }, { timeout: 10_000, interval: 20 })

beforeEach(async () => {
  endGitQuiet(WALNUT_HOME)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  initSync()
  fs.writeFileSync(path.join(WALNUT_HOME, 'seed.txt'), 'seed\n')
  git('add -A')
  git('commit -q -m seed')
})

afterEach(async () => {
  endGitQuiet(WALNUT_HOME)
  setLargeFileLaneForTest(null)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the switch stop ends this server\'s git in the home', () => {
  it('a git that holds no lock (the large-file lane\'s hash-object) ends at once', async () => {
    const run = slowGit(30, { holdsNoLock: true })
    await untilRunning(run)
    const t0 = Date.now()
    const r = await quietGitWriters(WALNUT_HOME, { budgetMs: 20_000, graceMs: 1_000 })
    expect(r).toEqual({ ended: 1, finished: 0, killed: 0 })
    expect(Date.now() - t0).toBeLessThan(5_000)
    const out = await run.catch((e: Error) => e)
    expect(out instanceof Error ? 0 : out.code).not.toBe(0)
  })

  it('a git that may hold a lock finishes within the budget; one past it is ended', async () => {
    const short = slowGit(1)
    const long = slowGit(30)
    await untilRunning(short, long)
    expect(oldestOwnGitStart(WALNUT_HOME)).not.toBeNull()
    const t0 = Date.now()
    const r = await quietGitWriters(WALNUT_HOME, { budgetMs: 2_500, graceMs: 1_000 })
    expect(r).toEqual({ ended: 0, finished: 1, killed: 1 })
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect((await short).code).toBe(0)
    expect((await long).code).not.toBe(0)
    expect(oldestOwnGitStart(WALNUT_HOME)).toBeNull()
  })

  it('no git starts in the home or below it once quiet (async and sync); elsewhere it does; a later server runs it again', async () => {
    await quietGitWriters(WALNUT_HOME, { budgetMs: 0 })
    expect(gitQuietAt(WALNUT_HOME)).toBe(true)
    expect(gitQuietAt(path.join(WALNUT_HOME, 'plugins', 'x'))).toBe(true)
    await expect(execGitArgsRaw(['status'], { cwd: WALNUT_HOME, timeout: 10_000 })).rejects.toBeInstanceOf(GitQuiet)
    await expect(execGitGroup('git status', { cwd: WALNUT_HOME, timeout: 10_000 })).rejects.toBeInstanceOf(GitQuiet)
    expect(() => git('status')).toThrow(GitQuiet)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-other-'))
    try {
      expect(gitQuietAt(other)).toBe(false)
      expect((await execGitArgsRaw(['--version'], { cwd: other, timeout: 10_000 })).code).toBe(0)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
    endGitQuiet(WALNUT_HOME)
    expect(git('status --porcelain')).toBe('')
  })

  it('the auto-commit writes nothing in a quiet home, and its large-file lane starts no background write', async () => {
    setLargeFileLaneForTest({ routineBudget: 1024 })
    fs.writeFileSync(path.join(WALNUT_HOME, 'small.txt'), 'x\n')
    fs.mkdirSync(path.join(WALNUT_HOME, 'artifacts'), { recursive: true })
    fs.writeFileSync(path.join(WALNUT_HOME, 'artifacts', 'big.bin'), Buffer.alloc(64 * 1024, 7))
    const headBefore = git('rev-parse HEAD')
    const objects = () => fs.readdirSync(path.join(WALNUT_HOME, '.git', 'objects')).length
    const before = objects()
    await quietGitWriters(WALNUT_HOME, { budgetMs: 0 })
    // Refused or skipped, it commits nothing.
    expect(await commitIfDirty().catch(() => false)).toBe(false)
    expect(prehashInFlight()).toBeNull()
    endGitQuiet(WALNUT_HOME)
    expect(git('rev-parse HEAD')).toBe(headBefore)
    expect(objects()).toBe(before)
  })
})
