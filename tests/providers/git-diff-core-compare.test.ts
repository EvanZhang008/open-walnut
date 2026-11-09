/**
 * The whole-repo comparisons of the git-diff core ('branch', 'commit', the
 * names-only list and git refs) against REAL git repositories: merge-base
 * resolution and the default-branch fallbacks, a root commit, a merge commit
 * (first parent), untracked files, renames, a ref or commit this repo does not
 * have, and the guard that keeps a caller's ref from reading as a git option.
 *
 * MACHINE SAFETY: every repository lives under one temp dir (asserted before
 * any git run), HOME points into it, and GIT_* redirects are stripped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeGitDiff, listGitRefs, GitDiffError, isValidGitRef, isValidGitCommit, type ExecFn, type ReadTextFn } from '../../src/providers/git-diff-core.js'

let root = ''

function inRoot(p: string): string {
  const abs = path.resolve(p)
  if (!root || !abs.startsWith(root + path.sep)) throw new Error(`refusing ${abs}: outside the test temp dir`)
  return abs
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete env[k]
  return env
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture User', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd: inRoot(cwd), encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const exec: ExecFn = async (argv, cwd) => {
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), { cwd: inRoot(cwd), encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    return { stdout, stderr: '', code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 }
  }
}
const readText: ReadTextFn = async (abs) => { try { return fs.readFileSync(inRoot(abs), 'utf8') } catch { return '' } }

function write(repo: string, rel: string, body: string): void {
  const p = inRoot(path.join(repo, rel))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

/**
 * main: init (a.txt, gone.txt) → "main moves on" (main.txt), pushed to origin.
 * feature (from init): f1 (a.txt edited, new.txt), f2 (gone.txt deleted,
 * old.txt renamed to moved.txt); then uncommitted: a.txt again, scratch.txt untracked.
 */
function makeRepo(): { repo: string; remote: string; init: string; f1: string; f2: string } {
  const repo = path.join(root, 'app')
  const remote = path.join(root, 'origin.git')
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(remote, { recursive: true })
  git(remote, ['init', '-q', '--bare'])
  git(repo, ['init', '-q'])
  write(repo, 'a.txt', 'one\ntwo\nthree\n')
  write(repo, 'gone.txt', 'bye\n')
  write(repo, 'old.txt', Array.from({ length: 20 }, (_, i) => `same line ${i}\n`).join(''))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  const init = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['checkout', '-qb', 'feature'])
  write(repo, 'a.txt', 'one\nTWO\nthree\n')
  write(repo, 'new.txt', 'brand new\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'f1: edit a and add new'])
  const f1 = git(repo, ['rev-parse', 'HEAD'])
  fs.rmSync(path.join(repo, 'gone.txt'))
  git(repo, ['mv', 'old.txt', 'moved.txt'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'f2: delete gone, move old'])
  const f2 = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '-q', 'main'])
  write(repo, 'main.txt', 'main only\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'main moves on'])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  git(repo, ['remote', 'set-head', 'origin', 'main'])
  git(repo, ['checkout', '-q', 'feature'])
  write(repo, 'a.txt', 'one\nTWO\nthree\nfour\n')
  write(repo, 'scratch.txt', 'untracked\n')
  return { repo, remote, init, f1, f2 }
}

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-git-compare-'))) })
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = '' })

describe('git-diff core: branch base', () => {
  it('default branch: origin/HEAD resolves, before is the MERGE-BASE (main moving on is not shown), after is the working tree', async () => {
    const { repo, init } = makeRepo()
    const res = await computeGitDiff('branch', repo, exec, readText)
    expect(res!.compare).toMatchObject({ base: 'branch', ref: 'origin/main', isDefault: true, baseSha: init })
    const by = Object.fromEntries(res!.files.map((f) => [f.relPath, f]))
    expect(Object.keys(by).sort()).toEqual(['a.txt', 'gone.txt', 'moved.txt', 'new.txt', 'scratch.txt'])
    expect(by['main.txt']).toBeUndefined()
    expect(by['a.txt']).toMatchObject({ status: 'modified', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\nfour\n' })
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', before: 'bye\n', after: '' })
    expect(by['moved.txt']).toMatchObject({ status: 'renamed', oldRelPath: 'old.txt' })
    expect(by['scratch.txt']).toMatchObject({ status: 'added', before: '', after: 'untracked\n' })
  })

  it('without origin/HEAD falls back to origin/main, then to local main when there is no remote', async () => {
    const { repo } = makeRepo()
    git(repo, ['remote', 'set-head', 'origin', '--delete'])
    expect((await computeGitDiff('branch', repo, exec, readText))!.compare!.ref).toBe('origin/main')
    git(repo, ['remote', 'remove', 'origin'])
    expect((await computeGitDiff('branch', repo, exec, readText))!.compare!.ref).toBe('main')
  })

  // A clone of another checkout on this machine: its origin/HEAD is whatever branch that
  // checkout had out (a task's work branch), and "Branch vs" it listed every file of the repo.
  it('an origin on this machine: its HEAD on a work branch never becomes the default; a network origin\'s HEAD does', async () => {
    const { repo } = makeRepo()
    git(repo, ['push', '-q', 'origin', 'feature'])
    git(repo, ['remote', 'set-head', 'origin', 'feature'])
    expect((await computeGitDiff('branch', repo, exec, readText))!.compare!.ref).toBe('origin/main')
    expect((await listGitRefs(repo, exec))!.defaultRef).toBe('origin/main')
    git(repo, ['remote', 'set-url', 'origin', 'https://example.invalid/app.git'])
    expect((await computeGitDiff('branch', repo, exec, readText))!.compare!.ref).toBe('origin/feature')
  })

  // 2026-11-09, a task's clone: origin/HEAD named another task's old work branch, origin/main
  // was days behind (the clone fetches a second remote), and "Branch vs" listed 9,975 files.
  it('the default is the candidate HEAD left most recently: an old work branch as origin/HEAD and a stale origin/main lose to the main this clone tracks', async () => {
    const { repo, init } = makeRepo()
    git(repo, ['push', '-q', 'origin', init + ':refs/heads/old-work'])
    git(repo, ['fetch', '-q', 'origin'])
    git(repo, ['remote', 'set-head', 'origin', 'old-work'])
    const mac = path.join(root, 'mac.git')
    fs.mkdirSync(mac, { recursive: true })
    git(mac, ['init', '-q', '--bare'])
    git(repo, ['remote', 'add', 'mac', mac])
    git(repo, ['stash', '-qu'])
    git(repo, ['checkout', '-q', 'main'])
    write(repo, 'later.txt', 'main moved on again\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'main moves on again'])
    git(repo, ['push', '-q', 'mac', 'main'])
    const macMain = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '-qb', 'work'])
    write(repo, 'w.txt', 'work\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'w1'])
    git(repo, ['remote', 'set-url', 'origin', 'https://example.invalid/app.git'])
    const res = await computeGitDiff('branch', repo, exec, readText)
    expect(res!.compare).toMatchObject({ ref: 'mac/main', isDefault: true, baseSha: macMain })
    expect(res!.files.map((f) => f.relPath)).toEqual(['w.txt'])
    expect((await listGitRefs(repo, exec))!.defaultRef).toBe('mac/main')
    // On main itself, ahead of what it tracks: the default stays the branch it pushes to.
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['remote', 'set-head', 'origin', 'main'])
    write(repo, 'ahead.txt', 'not pushed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'ahead'])
    expect((await computeGitDiff('branch', repo, exec, readText))!.compare!.ref).toBe('origin/main')
  })

  it('an explicit ref compares against its merge-base; a ref this repo lacks answers missing, never an error', async () => {
    const { repo, f1 } = makeRepo()
    git(repo, ['branch', 'checkpoint', f1])
    const res = await computeGitDiff('branch', repo, exec, readText, { ref: 'checkpoint' })
    expect(res!.compare).toMatchObject({ ref: 'checkpoint', isDefault: false, baseSha: f1 })
    expect(res!.files.map((f) => f.relPath).sort()).toEqual(['a.txt', 'gone.txt', 'moved.txt', 'scratch.txt'])
    expect(await computeGitDiff('branch', repo, exec, readText, { ref: 'no-such-branch' })).toEqual({ repoRoot: repo, files: [], missing: 'ref' })
  })

  it('refuses a ref that would reach git as an option or a revision expression', async () => {
    const { repo } = makeRepo()
    for (const bad of ['--output=out.txt', '-p', 'main..feature', 'main@{1}', 'main^', 'main~2', 'main:a.txt', 'a b', 'x\ny']) {
      expect(isValidGitRef(bad), bad).toBe(false)
      await expect(computeGitDiff('branch', repo, exec, readText, { ref: bad }), bad).rejects.toBeInstanceOf(GitDiffError)
    }
    expect(fs.existsSync(path.join(repo, 'out.txt'))).toBe(false)
    for (const good of ['main', 'origin/main', 'feature/x-1', 'release_2.0']) expect(isValidGitRef(good), good).toBe(true)
  })

  it('names only: no blob read, and each file carries the working-tree blob id that changes when the file does', async () => {
    const { repo } = makeRepo()
    const reads: string[] = []
    const counting: ExecFn = async (argv, cwd) => { if (argv[1] === 'show') reads.push(argv.join(' ')); return exec(argv, cwd) }
    const first = await computeGitDiff('branch', repo, counting, async () => { throw new Error('no working-tree read in names-only mode') }, { namesOnly: true })
    expect(reads).toEqual([])
    const by = Object.fromEntries(first!.files.map((f) => [f.relPath, f]))
    expect(by['a.txt']).toMatchObject({ before: '', after: '', status: 'modified' })
    expect(by['a.txt']!.sig).toBe(git(repo, ['hash-object', 'a.txt']))
    expect(by['gone.txt']!.sig).toBe('')
    write(repo, 'a.txt', 'edited again\n')
    const second = await computeGitDiff('branch', repo, exec, readText, { namesOnly: true })
    const a2 = second!.files.find((f) => f.relPath === 'a.txt')!
    expect(a2.sig).not.toBe(by['a.txt']!.sig)
    expect(second!.files.find((f) => f.relPath === 'new.txt')!.sig).toBe(by['new.txt']!.sig)
    // No whitespace-only flag on a real change.
    expect(by['a.txt']!.wsOnly).toBeUndefined()
  })

  it('names only: a modified file whose every change is whitespace is flagged, a real edit next to it is not', async () => {
    const { repo } = makeRepo()
    write(repo, 'moved.txt', Array.from({ length: 20 }, (_, i) => `same  line ${i}   \n`).join(''))
    const res = await computeGitDiff('branch', repo, exec, readText, { namesOnly: true })
    const by = Object.fromEntries(res!.files.map((f) => [f.relPath, f]))
    // moved.txt is a rename (old.txt), not "modified": never flagged.
    expect(by['moved.txt']!.wsOnly).toBeUndefined()
    write(repo, 'a.txt', 'one\nTWO\nthree\n')
    git(repo, ['commit', '-qam', 'a back to f1'])
    write(repo, 'a.txt', 'one  \nTWO\n  three\n')
    const again = await computeGitDiff('commit', repo, exec, readText, { namesOnly: true, commit: git(repo, ['rev-parse', 'HEAD']) })
    expect(again!.files.find((f) => f.relPath === 'a.txt')?.wsOnly).toBeUndefined()
    const ws = await computeGitDiff('uncommitted', repo, exec, readText, { namesOnly: true })
    expect(ws!.files.find((f) => f.relPath === 'a.txt')).toMatchObject({ status: 'modified', wsOnly: true })
  })

  it('with no default branch at all it says so', async () => {
    const repo = path.join(root, 'solo')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'trunk'])
    write(repo, 'x.txt', 'x\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'x'])
    await expect(computeGitDiff('branch', repo, exec, readText)).rejects.toThrow(/No default branch/)
  })
})

describe('git-diff core: commit base', () => {
  it('one commit vs its parent: after is the COMMIT content, not the working tree, and untracked files stay out', async () => {
    const { repo, f1, init } = makeRepo()
    const res = await computeGitDiff('commit', repo, exec, readText, { commit: f1.slice(0, 9) })
    expect(res!.compare).toMatchObject({ base: 'commit', baseSha: init, commit: { sha: f1, parent: init, parents: 1, author: 'Fixture User', subject: 'f1: edit a and add new' } })
    const by = Object.fromEntries(res!.files.map((f) => [f.relPath, f]))
    expect(Object.keys(by).sort()).toEqual(['a.txt', 'new.txt'])
    expect(by['a.txt']).toMatchObject({ before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' })
    expect(by['new.txt']).toMatchObject({ status: 'added', before: '', after: 'brand new\n' })
  })

  it('a deletion and a rename inside a commit read both sides from git', async () => {
    const { repo, f2 } = makeRepo()
    const res = await computeGitDiff('commit', repo, exec, readText, { commit: f2 })
    const by = Object.fromEntries(res!.files.map((f) => [f.relPath, f]))
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', before: 'bye\n', after: '' })
    expect(by['moved.txt']).toMatchObject({ status: 'renamed', oldRelPath: 'old.txt' })
    expect(by['moved.txt']!.after).toBe(by['moved.txt']!.before)
  })

  it('the root commit compares against the empty tree', async () => {
    const { repo, init } = makeRepo()
    const res = await computeGitDiff('commit', repo, exec, readText, { commit: init })
    expect(res!.compare).toMatchObject({ baseSha: '', commit: { parent: '', parents: 0 } })
    expect(res!.files.map((f) => [f.relPath, f.status])).toEqual([['a.txt', 'added'], ['gone.txt', 'added'], ['old.txt', 'added']])
  })

  it('a merge commit shows its changes against the FIRST parent', async () => {
    const { repo } = makeRepo()
    git(repo, ['checkout', '-q', '.'])
    fs.rmSync(path.join(repo, 'scratch.txt'))
    git(repo, ['merge', '-q', '--no-edit', 'main'])
    const merge = git(repo, ['rev-parse', 'HEAD'])
    const res = await computeGitDiff('commit', repo, exec, readText, { commit: merge })
    expect(res!.compare!.commit!.parents).toBe(2)
    expect(res!.files.map((f) => f.relPath)).toEqual(['main.txt'])
  })

  it('an unknown commit answers missing; a non-hex id is refused before git runs', async () => {
    const { repo } = makeRepo()
    expect(await computeGitDiff('commit', repo, exec, readText, { commit: 'deadbeefdeadbeef' })).toEqual({ repoRoot: repo, files: [], missing: 'commit' })
    for (const bad of ['HEAD', '--all', 'abc', 'xyz1234567']) {
      expect(isValidGitCommit(bad), bad).toBe(false)
      await expect(computeGitDiff('commit', repo, exec, readText, { commit: bad }), bad).rejects.toBeInstanceOf(GitDiffError)
    }
  })

  it('paths narrows a commit to one file (the lazy per-file read)', async () => {
    const { repo, f1 } = makeRepo()
    const res = await computeGitDiff('commit', repo, exec, readText, { commit: f1, paths: ['new.txt'] })
    expect(res!.files).toHaveLength(1)
    expect(res!.files[0]).toMatchObject({ relPath: 'new.txt', after: 'brand new\n' })
  })
})

describe('git refs', () => {
  it('lists local and remote branches (no origin/HEAD alias), the current branch, the default, and the newest commits marked when they are on this branch', async () => {
    const { repo, f1, f2, init } = makeRepo()
    const refs = await listGitRefs(repo, exec)
    expect(refs).toMatchObject({ repoRoot: repo, current: 'feature', defaultRef: 'origin/main', head: f2 })
    const names = refs!.refs.map((r) => `${r.kind}:${r.name}`).sort()
    expect(names).toEqual(['local:feature', 'local:main', 'remote:origin/main'])
    expect(refs!.commits.map((c) => [c.sha, c.onBranch])).toEqual([[f2, true], [f1, true], [init, false]])
    expect(refs!.commits[0]).toMatchObject({ subject: 'f2: delete gone, move old', author: 'Fixture User', parent: f1 })
    expect(refs!.commits[0]!.time).toBeGreaterThan(1_600_000_000)
  })

  it('a detached HEAD has no current branch; a folder outside git answers null', async () => {
    const { repo, f1 } = makeRepo()
    git(repo, ['checkout', '-q', '.'])
    git(repo, ['checkout', '-q', f1])
    expect((await listGitRefs(repo, exec))!.current).toBe('')
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    expect(await listGitRefs(plain, exec)).toBeNull()
  })

  it('caps the commit list at 100', async () => {
    const repo = path.join(root, 'long')
    fs.mkdirSync(repo)
    git(repo, ['init', '-q'])
    // One fast-import run, not 105 commits (each `git commit` is a process).
    const stream = Array.from({ length: 105 }, (_, i) => `commit refs/heads/main\ncommitter Fixture User <fixture@example.invalid> ${1_700_000_000 + i} +0000\ndata ${`c${i}`.length}\nc${i}\n`).join('')
    execFileSync('git', ['fast-import', '--quiet'], { cwd: inRoot(repo), input: stream, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    const refs = await listGitRefs(repo, exec)
    expect(refs!.commits).toHaveLength(100)
    expect(refs!.commits[0]!.subject).toBe('c104')
  })
})
