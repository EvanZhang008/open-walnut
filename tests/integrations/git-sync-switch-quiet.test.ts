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

import { GitQuiet, commitIfDirty, endGitQuiet, execGitArgsRaw, execGitGroup, git, gitAsync, gitQuietAt, initSync, oldestOwnGitStart, quietGitWriters } from '../../src/integrations/git-sync.js'
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

describe('a handed-over home takes no git write from git sync (lib/leader-home-gate.ts), whichever process asks', () => {
  const markHome = (state: string) => {
    fs.mkdirSync(path.join(WALNUT_HOME, 'local', 'leader-switch'), { recursive: true })
    fs.writeFileSync(path.join(WALNUT_HOME, 'local', 'leader-switch', 'handed-over.json'), JSON.stringify({ switchId: 's', to: 'machine-b', state, at: new Date().toISOString() }))
  }
  const store = () => {
    const out: string[] = []
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p) } }
    walk(path.join(WALNUT_HOME, '.git', 'objects'))
    walk(path.join(WALNUT_HOME, '.git', 'refs'))
    return out.sort()
  }

  it('handed over: every spawner refuses a writing git (a commit of nothing writes the empty tree too) and lets a read run', async () => {
    markHome('handed-over')
    fs.writeFileSync(path.join(WALNUT_HOME, 'new.txt'), 'after the handover\n')
    const before = store()
    expect(() => git('add -A')).toThrow(GitQuiet)
    expect(() => git('commit -q --allow-empty -m x')).toThrow(/handed over/)
    await expect(execGitGroup('git -c core.x=1 commit -q -m x', { cwd: WALNUT_HOME, timeout: 10_000 })).rejects.toThrow(GitQuiet)
    await expect(execGitArgsRaw(['mktree'], { cwd: WALNUT_HOME, timeout: 10_000, input: '' })).rejects.toThrow(GitQuiet)
    await expect(execGitArgsRaw(['hash-object', '-w', 'new.txt'], { cwd: WALNUT_HOME, timeout: 10_000 })).rejects.toThrow(GitQuiet)
    // Fail-closed (review round 1): the compaction's backup branch and reflog expire, the data remote's set-url, a
    // config set and a push all write .git.
    for (const cmd of ['branch backup-x HEAD', 'reflog expire --expire=now --all', 'remote set-url cloud http://x', 'remote add cloud http://x', 'config user.name x', 'push cloud HEAD', 'pack-refs --all', 'commit-graph write']) {
      expect(() => git(cmd), cmd).toThrow(GitQuiet)
    }
        // Reads run (a standby answers what its home holds).
    expect(git('rev-parse --abbrev-ref HEAD')).toBeTruthy()
    expect(() => git('config --get user.name')).not.toThrow(GitQuiet)
    expect(() => git('branch --list')).not.toThrow()
    expect(() => git('remote -v')).not.toThrow()
    expect((await execGitArgsRaw(['hash-object', 'new.txt'], { cwd: WALNUT_HOME, timeout: 10_000 })).code).toBe(0)
    // The auto-commit's own pass is refused at its first writing git (as in a switch stop's quiet).
    await expect(commitIfDirty()).rejects.toThrow(GitQuiet)
    expect(store()).toEqual(before)
  })

  it('switching: the leader\'s git sync still commits until its stop (the stop\'s quiet refuses from then on)', async () => {
    markHome('switching')
    fs.writeFileSync(path.join(WALNUT_HOME, 'new.txt'), 'during the switch\n')
    git('add -A')
    git('commit -q -m during')
    expect(git('log -1 --format=%s')).toBe('during')
  })
})

describe('git sync\'s reads: index refresh as git always does it, none in a marked home (lib/git-env.ts gitChildEnv, lib/leader-home-gate.ts readOnlyGitEnv)', () => {
  // Same content, an mtime hours back (never racy): a status with optional locks, or a diff of the work tree,
  // refreshes the stat data and writes .git/index back.
  let touches = 0
  // A new whole second each time: git compares the mtime's seconds (nanoseconds only when built with USE_NSEC).
  const touchSeed = () => {
    const earlier = new Date(Date.now() - 3_600_000 * ++touches)
    fs.utimesSync(path.join(WALNUT_HOME, 'seed.txt'), earlier, earlier)
    const index = path.join(WALNUT_HOME, '.git', 'index')
    return { index, before: fs.readFileSync(index), mtime: fs.statSync(index).mtimeMs }
  }
  const mark = (state: 'switching' | 'handed-over') => {
    fs.mkdirSync(path.join(WALNUT_HOME, 'local', 'leader-switch'), { recursive: true })
    fs.writeFileSync(path.join(WALNUT_HOME, 'local', 'leader-switch', 'handed-over.json'), JSON.stringify({ switchId: 's', to: 'machine-b', state, at: new Date().toISOString() }))
  }

  // 2026-11-26: optional locks off for every git child left a touched file stale in the index for good (git sync runs
  // no add on a clean tree), so each status of a touched 20 GB home hashed it all again: 98 to 131 s a run, 0.04 s
  // once refreshed.
  it('an unmarked home: a status of a touched file refreshes .git/index once, so the next status has nothing to hash', async () => {
    expect(process.env.GIT_OPTIONAL_LOCKS).toBeUndefined()
    for (const status of [
      () => git('status --porcelain'),
      () => gitAsync('status --porcelain'),
      () => execGitGroup('git status --porcelain', { cwd: WALNUT_HOME, timeout: 10_000 }),
      () => execGitArgsRaw(['-c', 'core.bigFileThreshold=1024g', 'status', '--porcelain', '-uall'], { cwd: WALNUT_HOME, timeout: 10_000 }),
    ]) {
      const { index, before } = touchSeed()
      await status()
      const after = fs.readFileSync(index)
      expect(after.equals(before), String(status)).toBe(false)
      await status()
      expect(fs.readFileSync(index).equals(after), String(status)).toBe(true)
    }
  })

  for (const state of ['switching', 'handed-over'] as const) {
    it(`a ${state} home: neither a status nor a diff of the work tree rewrites .git/index`, async () => {
      mark(state)
      const { index, before, mtime } = touchSeed()
      expect(git('status --porcelain')).toBe('')
      await gitAsync('status --porcelain')
      await execGitGroup('git status --porcelain', { cwd: WALNUT_HOME, timeout: 10_000 })
      expect((await execGitArgsRaw(['-c', 'core.bigFileThreshold=1024g', 'status', '--porcelain', '-uall'], { cwd: WALNUT_HOME, timeout: 10_000 })).code).toBe(0)
      expect((await execGitArgsRaw(['diff', '--stat'], { cwd: WALNUT_HOME, timeout: 10_000 })).code).toBe(0)
      await execGitGroup('git diff --name-only', { cwd: WALNUT_HOME, timeout: 10_000 })
      git('diff --quiet || true')
      expect(fs.readFileSync(index).equals(before)).toBe(true)
      expect(fs.statSync(index).mtimeMs).toBe(mtime)
    })
  }
})
