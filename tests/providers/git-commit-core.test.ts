/**
 * The session commit core (git-commit-core.ts) against real temp git repos:
 * a commit built from HEAD plus only the chosen hunks in a private index, the
 * repo's hooks (core.hooksPath included), the compare-and-swap branch update,
 * the real-index fix-up, the refusals, and push to a temp bare remote.
 *
 * Isolation: every repo, remote, hook and config lives under ONE temp root this
 * file creates. Git runs with a scrubbed env (no inherited GIT_DIR and friends,
 * a temp HOME and global config, no system config), and every spawn and every
 * fs write the core makes is checked to stay inside that root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createGitAttribution, type AttrOp } from '../../src/providers/git-attribution-core.js'
import { createGitCommitCore, type CommitPlanRepo, type GitCommitDeps, type PlanChanges } from '../../src/providers/git-commit-core.js'

let ROOT = ''
let ENV: Record<string, string> = {}
let seq = 0

function inRoot(p: string): boolean {
  const abs = path.resolve(p)
  return abs === ROOT || abs.startsWith(ROOT + path.sep)
}
function assertInRoot(p: string, what: string): void {
  if (!inRoot(p)) throw new Error(`${what} outside the test root: ${p}`)
}

function sh(cwd: string, args: string[], input?: string): string {
  assertInRoot(cwd, 'git cwd')
  return execFileSync('git', args, { cwd, env: ENV, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function write(file: string, text: string, mode?: number): void {
  assertInRoot(file, 'write')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  if (mode) fs.chmodSync(file, mode)
}

/** A fresh repo with one commit holding `files`, on branch main. */
function repo(files: Record<string, string>, opts: { commit?: boolean } = {}): string {
  const dir = path.join(ROOT, `repo-${++seq}`)
  fs.mkdirSync(dir)
  sh(dir, ['init', '-q', '-b', 'main'])
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text)
  if (opts.commit !== false) {
    sh(dir, ['add', '-A'])
    sh(dir, ['commit', '-q', '-m', 'initial'])
  }
  return dir
}

function hook(dir: string, name: string, body: string): void {
  write(path.join(dir, name), '#!/bin/sh\n' + body + '\n', 0o755)
}

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')
const edit = (oldString: string, newString: string): AttrOp => ({ kind: 'edit', oldString, newString, replaceAll: false })

function core(extraPath?: string) {
  const env = { ...ENV, ...(extraPath ? { PATH: `${extraPath}:${ENV.PATH}` } : {}) }
  const guardedFs = {
    promises: {
      readFile: (p: string) => fs.promises.readFile(p),
      lstat: (p: string) => fs.promises.lstat(p),
      readlink: (p: string) => fs.promises.readlink(p),
      access: (p: string, m?: number) => fs.promises.access(p, m),
      mkdtemp: (prefix: string) => { assertInRoot(prefix, 'mkdtemp'); return fs.promises.mkdtemp(prefix) },
      writeFile: (p: string, d: string) => { assertInRoot(p, 'writeFile'); return fs.promises.writeFile(p, d) },
      rm: (p: string, o: { recursive: boolean; force: boolean }) => { assertInRoot(p, 'rm'); return fs.promises.rm(p, o) },
    },
  }
  const guardedSpawn = ((cmd: string, args: string[], o: Record<string, unknown>) => {
    assertInRoot(String(o.cwd), `spawn ${cmd} cwd`)
    const e = o.env as Record<string, string | undefined>
    if (e.GIT_DIR || e.GIT_WORK_TREE) throw new Error('a redirect var leaked into a git child')
    if (e.GIT_INDEX_FILE) assertInRoot(e.GIT_INDEX_FILE, 'GIT_INDEX_FILE')
    return spawn(cmd, args, o)
  }) as unknown as GitCommitDeps['spawn']
  return createGitCommitCore({
    spawn: guardedSpawn,
    fs: guardedFs as unknown as GitCommitDeps['fs'],
    path,
    tmpdir: () => ROOT,
    env,
    attribution: createGitAttribution(),
    killGroup: () => { /* no hook in these tests outlives its timeout */ },
  })
}

function changes(dir: string, files: Array<{ rel: string; ops: AttrOp[]; status?: string }>): PlanChanges {
  return {
    groups: [{ repoRoot: dir, label: path.basename(dir), files: files.map((f) => ({ filePath: path.join(dir, f.rel), relPath: f.rel, status: f.status ?? 'modified' })) }],
    fileMap: new Map(files.map((f) => [path.join(dir, f.rel), { ops: f.ops }])),
  }
}

async function planOne(c: ReturnType<typeof core>, dir: string, files: Array<{ rel: string; ops: AttrOp[]; status?: string }>): Promise<CommitPlanRepo> {
  const p = await c.plan({}, changes(dir, files))
  expect(p.repos).toHaveLength(1)
  return p.repos[0]
}

async function run(c: ReturnType<typeof core>, cmd: Record<string, unknown>) {
  const started = c.start(cmd)
  await started.done
  return c.job(started.job.id)!
}

/** The `selections` for every hunk the plan claims for this session. */
function mineSelections(repo: CommitPlanRepo) {
  return repo.files.filter((f) => f.session && f.hunks?.some((h) => h.owner === 'mine'))
    .map((f) => ({ path: f.path, mode: 'hunks', hunks: f.hunks!.filter((h) => h.owner === 'mine') }))
}

beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-git-commit-test-')))
  const home = path.join(ROOT, 'home')
  fs.mkdirSync(home)
  const gitconfig = path.join(ROOT, 'gitconfig')
  fs.writeFileSync(gitconfig, '[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n')
  // The system dirs' tools, and never a real gh (the PR cases bring their own).
  // The dirs themselves are not enough: CI's Ubuntu image ships gh in /usr/bin,
  // so the "no gh" case saw one there. Every system tool but gh is linked into
  // one directory of this root, the first dir in PATH order winning a name.
  const sysbin = path.join(ROOT, 'sysbin')
  fs.mkdirSync(sysbin)
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (name === 'gh' || fs.existsSync(path.join(sysbin, name))) continue
      try { fs.symlinkSync(path.join(dir, name), path.join(sysbin, name)) } catch { /* a racing duplicate */ }
    }
  }
  ENV = {
    PATH: sysbin,
    HOME: home,
    TMPDIR: ROOT,
    LANG: 'C',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
})

afterAll(() => {
  if (ROOT && ROOT.includes('walnut-git-commit-test-')) fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('commit: only the chosen hunks, without touching the working tree', () => {
  it('commits session A\'s hunk of a file B also edited, and leaves B\'s hunk uncommitted', async () => {
    const head = lines(30)
    const dir = repo({ 'src/shared.txt': head })
    const work = head.replace('line 5\n', 'line five (A)\n').replace('line 25\n', 'line twenty-five (B)\n')
    write(path.join(dir, 'src/shared.txt'), work)
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'src/shared.txt', ops: [edit('line 5\n', 'line five (A)\n')] }])
    const f = r.files[0]
    expect(f).toMatchObject({ path: 'src/shared.txt', kind: 'text', owner: 'mixed', session: true })
    expect(f.hunks!.map((h) => h.owner)).toEqual(['mine', 'other'])
    expect(r.branch).toBe('main')

    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'Rename line five\n', selections: mineSelections(r) })
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded')
    const sha = String(job.result!.sha)
    expect(sh(dir, ['rev-parse', 'HEAD']).trim()).toBe(sha)
    expect(sh(dir, ['rev-parse', 'HEAD~1']).trim()).toBe(r.headSha)
    expect(sh(dir, ['show', 'HEAD:src/shared.txt'])).toBe(head.replace('line 5\n', 'line five (A)\n'))
    expect(sh(dir, ['log', '-1', '--format=%B']).trim()).toBe('Rename line five')
    // The working tree is exactly as it was; B's hunk is still uncommitted.
    expect(fs.readFileSync(path.join(dir, 'src/shared.txt'), 'utf8')).toBe(work)
    const diff = sh(dir, ['diff', 'HEAD'])
    expect(diff).toContain('+line twenty-five (B)')
    expect(diff).not.toContain('line five (A)')
    // The real index moved with the commit (nothing shows as staged-reversed).
    expect(sh(dir, ['diff', '--cached', '--name-only']).trim()).toBe('')
    expect(job.result!.indexUpdated).toEqual(['src/shared.txt'])
  }, 60_000)

  it('keeps an index entry the user staged differently, and moves one that still matched HEAD', async () => {
    const dir = repo({ 'a.txt': lines(5), 'b.txt': lines(5, 'bee') })
    write(path.join(dir, 'a.txt'), lines(5).replace('line 2\n', 'line two\n'))
    write(path.join(dir, 'b.txt'), lines(5, 'bee').replace('bee 3\n', 'bee three\n'))
    // The user staged their own version of a.txt (with an extra line) before the commit.
    write(path.join(dir, 'a.txt'), lines(5).replace('line 2\n', 'line two\n') + 'staged by the user\n')
    sh(dir, ['add', 'a.txt'])
    const stagedSha = sh(dir, ['ls-files', '-s', 'a.txt']).split(' ')[1]
    write(path.join(dir, 'a.txt'), lines(5).replace('line 2\n', 'line two\n'))
    const c = core()
    const r = await planOne(c, dir, [
      { rel: 'a.txt', ops: [edit('line 2\n', 'line two\n')] },
      { rel: 'b.txt', ops: [edit('bee 3\n', 'bee three\n')] },
    ])
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'two edits', selections: mineSelections(r) })
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded')
    expect(job.result!.indexKept).toEqual(['a.txt'])
    expect(job.result!.indexUpdated).toEqual(['b.txt'])
    expect(sh(dir, ['ls-files', '-s', 'a.txt']).split(' ')[1]).toBe(stagedSha)
    expect(sh(dir, ['show', 'HEAD:a.txt'])).toBe(lines(5).replace('line 2\n', 'line two\n'))
  }, 60_000)

  it('commits on an unborn branch (no parent) and creates the branch', async () => {
    const dir = repo({}, { commit: false })
    write(path.join(dir, 'new.txt'), 'hello\n')
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'new.txt', ops: [{ kind: 'write', content: 'hello\n' }], status: 'added' }])
    expect(r.headSha).toBeNull()
    expect(r.files[0]).toMatchObject({ status: 'added', owner: 'mine' })
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: null, message: 'first', selections: mineSelections(r) })
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded')
    expect(sh(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1')
    expect(sh(dir, ['show', 'HEAD:new.txt'])).toBe('hello\n')
  }, 60_000)

  it('commits whole files: a new untracked file and a deletion', async () => {
    const dir = repo({ 'keep.txt': 'k\n', 'gone.txt': 'g\n' })
    fs.rmSync(path.join(dir, 'gone.txt'))
    write(path.join(dir, 'bin.dat'), 'a\u0000b')
    const c = core()
    const r = await planOne(c, dir, [
      { rel: 'gone.txt', ops: [{ kind: 'delete' }], status: 'deleted' },
      { rel: 'bin.dat', ops: [{ kind: 'create' }], status: 'added' },
    ])
    expect(r.files.find((f) => f.path === 'gone.txt')).toMatchObject({ kind: 'deleted', owner: 'mine' })
    expect(r.files.find((f) => f.path === 'bin.dat')).toMatchObject({ kind: 'binary' })
    const job = await run(c, {
      action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'whole files',
      selections: [{ path: 'gone.txt', mode: 'whole' }, { path: 'bin.dat', mode: 'whole' }],
    })
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded')
    expect(sh(dir, ['ls-tree', '--name-only', 'HEAD']).trim().split('\n').sort()).toEqual(['bin.dat', 'keep.txt'])
  }, 60_000)

  it('refuses a hunk whose lines changed after the view loaded', async () => {
    const dir = repo({ 'x.txt': lines(8) })
    write(path.join(dir, 'x.txt'), lines(8).replace('line 4\n', 'line four\n'))
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'x.txt', ops: [edit('line 4\n', 'line four\n')] }])
    write(path.join(dir, 'x.txt'), lines(8).replace('line 4\n', 'line FOUR, rewritten\n'))
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'm', selections: mineSelections(r) })
    expect(job.error?.code).toBe('stale')
    expect(sh(dir, ['rev-parse', 'HEAD']).trim()).toBe(r.headSha)
  }, 60_000)
})

describe('commit: hooks run against the private index', () => {
  it('a failing pre-commit hook aborts with its output and commits nothing', async () => {
    const dir = repo({ 'f.txt': lines(4) })
    hook(path.join(dir, '.git/hooks'), 'pre-commit', 'echo "lint failed: f.txt line 2" >&2\nexit 1')
    write(path.join(dir, 'f.txt'), lines(4).replace('line 2\n', 'line two\n'))
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'f.txt', ops: [edit('line 2\n', 'line two\n')] }])
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'm', selections: mineSelections(r) })
    expect(job.state).toBe('failed')
    expect(job.error?.code).toBe('hook-failed')
    expect(job.output).toContain('lint failed: f.txt line 2')
    expect(sh(dir, ['rev-parse', 'HEAD']).trim()).toBe(r.headSha)
    expect(sh(dir, ['diff', '--cached', '--name-only']).trim()).toBe('')
  }, 60_000)

  it('honours core.hooksPath, and the hook sees only the selected change staged', async () => {
    const dir = repo({ 'sel.txt': lines(4), 'other.txt': lines(4, 'o') })
    const hooksDir = path.join(ROOT, `hooks-${seq}`)
    const marker = path.join(ROOT, `marker-${seq}.txt`)
    hook(hooksDir, 'pre-commit', `git diff --cached --name-only > "${marker}"`)
    hook(hooksDir, 'commit-msg', 'printf "\\nReviewed-by: Hook\\n" >> "$1"')
    sh(dir, ['config', 'core.hooksPath', hooksDir])
    write(path.join(dir, 'sel.txt'), lines(4).replace('line 1\n', 'line one\n'))
    write(path.join(dir, 'other.txt'), lines(4, 'o').replace('o 1\n', 'o one\n'))
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'sel.txt', ops: [edit('line 1\n', 'line one\n')] }])
    expect(r.files.map((f) => [f.path, f.session])).toEqual([['sel.txt', true], ['other.txt', false]])
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'Select one file', selections: mineSelections(r) })
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded')
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('sel.txt')
    expect(sh(dir, ['log', '-1', '--format=%B']).trim()).toBe('Select one file\n\nReviewed-by: Hook')
    expect(sh(dir, ['diff', 'HEAD', '--name-only']).trim()).toBe('other.txt')
  }, 60_000)

  it('a failing commit-msg hook commits nothing', async () => {
    const dir = repo({ 'f.txt': 'a\n' })
    hook(path.join(dir, '.git/hooks'), 'commit-msg', 'echo "message must reference an issue"\nexit 1')
    write(path.join(dir, 'f.txt'), 'b\n')
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'f.txt', ops: [edit('a\n', 'b\n')] }])
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'm', selections: mineSelections(r) })
    expect(job.error?.code).toBe('hook-failed')
    expect(job.output).toContain('message must reference an issue')
    expect(sh(dir, ['rev-parse', 'HEAD']).trim()).toBe(r.headSha)
  }, 60_000)

  it('refuses to move the branch when HEAD moved while the hook ran (CAS)', async () => {
    const dir = repo({ 'f.txt': 'a\n' })
    // The hook commits on the branch itself, as a concurrent writer would.
    hook(path.join(dir, '.git/hooks'), 'pre-commit',
      'unset GIT_INDEX_FILE\nc=$(git commit-tree "HEAD^{tree}" -p HEAD -m concurrent)\ngit update-ref refs/heads/main "$c"')
    write(path.join(dir, 'f.txt'), 'b\n')
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'f.txt', ops: [edit('a\n', 'b\n')] }])
    const job = await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'mine', selections: mineSelections(r) })
    expect(job.error?.code).toBe('head-moved')
    expect(sh(dir, ['log', '-1', '--format=%s']).trim()).toBe('concurrent')
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('b\n')
  }, 60_000)
})

describe('commit: refusals', () => {
  it('refuses a stale expected HEAD, an empty message and an empty selection', async () => {
    const dir = repo({ 'f.txt': 'a\n' })
    write(path.join(dir, 'f.txt'), 'b\n')
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'f.txt', ops: [edit('a\n', 'b\n')] }])
    const sel = mineSelections(r)
    sh(dir, ['commit', '-q', '--allow-empty', '-m', 'someone else'])
    expect((await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'm', selections: sel })).error?.code).toBe('head-moved')
    const head = sh(dir, ['rev-parse', 'HEAD']).trim()
    expect((await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: head, message: '  \n\n', selections: sel })).error?.code).toBe('empty-message')
    expect((await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: head, message: 'm', selections: [] })).error?.code).toBe('nothing-selected')
    expect((await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: head, message: 'm', selections: [{ path: '../escape', mode: 'whole' }] })).error?.code).toBe('bad-request')
  }, 60_000)

  it('blocks a detached HEAD, a merge in progress and a held index.lock', async () => {
    const dir = repo({ 'f.txt': 'a\n' })
    write(path.join(dir, 'f.txt'), 'b\n')
    const c = core()
    const files = [{ rel: 'f.txt', ops: [edit('a\n', 'b\n')] }]
    const head = sh(dir, ['rev-parse', 'HEAD']).trim()

    sh(dir, ['checkout', '-q', '--detach'])
    const detached = await planOne(c, dir, files)
    expect(detached.blocked?.code).toBe('detached')
    expect((await run(c, { action: 'commit', repoRoot: dir, expectedHead: head, message: 'm', selections: mineSelections(detached) })).error?.code).toBe('detached')
    sh(dir, ['checkout', '-q', 'main'])

    write(path.join(dir, '.git/MERGE_HEAD'), head + '\n')
    expect((await planOne(c, dir, files)).blocked?.code).toBe('merge')
    fs.rmSync(path.join(dir, '.git/MERGE_HEAD'))

    write(path.join(dir, '.git/index.lock'), '')
    const locked = await planOne(c, dir, files)
    expect(locked.blocked?.code).toBe('index-lock')
    expect((await run(c, { action: 'commit', repoRoot: dir, branch: 'main', expectedHead: head, message: 'm', selections: mineSelections(locked) })).error?.code).toBe('index-lock')
    fs.rmSync(path.join(dir, '.git/index.lock'))
    expect((await planOne(c, dir, files)).blocked).toBeUndefined()
  }, 60_000)

  it('runs one job per repository at a time', async () => {
    const dir = repo({ 'f.txt': 'a\n' })
    hook(path.join(dir, '.git/hooks'), 'pre-commit', 'sleep 1')
    write(path.join(dir, 'f.txt'), 'b\n')
    const c = core()
    const r = await planOne(c, dir, [{ rel: 'f.txt', ops: [edit('a\n', 'b\n')] }])
    const first = c.start({ action: 'commit', repoRoot: dir, branch: 'main', expectedHead: r.headSha, message: 'm', selections: mineSelections(r) })
    expect(() => c.start({ action: 'push', repoRoot: dir })).toThrow(/Another commit or push/)
    await first.done
    expect(c.job(first.job.id)!.state).toBe('succeeded')
  }, 60_000)
})

describe('push and PR', () => {
  function remoteSetup() {
    const bare = path.join(ROOT, `remote-${++seq}.git`)
    fs.mkdirSync(bare)
    sh(bare, ['init', '-q', '--bare', '-b', 'main'])
    const dir = repo({ 'f.txt': 'a\n' })
    sh(dir, ['remote', 'add', 'origin', bare])
    return { bare, dir }
  }

  it('sets the upstream on request, then pushes to it; never without asking', async () => {
    const { bare, dir } = remoteSetup()
    const c = core()
    const before = await planOne(c, dir, [])
    expect(before.upstream).toBeNull()
    expect(before.pushTarget).toMatchObject({ remote: 'origin', ref: 'refs/heads/main' })
    expect((await run(c, { action: 'push', repoRoot: dir, branch: 'main' })).error?.code).toBe('no-upstream')
    const first = await run(c, { action: 'push', repoRoot: dir, branch: 'main', setUpstream: true })
    expect(first.state, JSON.stringify(first.error)).toBe('succeeded')
    expect(sh(bare, ['rev-parse', 'refs/heads/main']).trim()).toBe(sh(dir, ['rev-parse', 'HEAD']).trim())
    expect(sh(dir, ['config', 'branch.main.remote']).trim()).toBe('origin')

    sh(dir, ['commit', '-q', '--allow-empty', '-m', 'second'])
    const after = await planOne(c, dir, [])
    expect(after.upstream).toMatchObject({ remote: 'origin', ref: 'refs/heads/main' })
    expect(after.ahead).toBe(1)
    const second = await run(c, { action: 'push', repoRoot: dir, branch: 'main' })
    expect(second.state, JSON.stringify(second.error)).toBe('succeeded')
    expect(sh(bare, ['log', '-1', '--format=%s', 'main']).trim()).toBe('second')
  }, 60_000)

  it('refuses a non-fast-forward push and leaves the remote alone', async () => {
    const { bare, dir } = remoteSetup()
    sh(dir, ['push', '-q', '-u', 'origin', 'main'])
    const other = path.join(ROOT, `clone-${++seq}`)
    execFileSync('git', ['clone', '-q', bare, other], { cwd: ROOT, env: ENV })
    sh(other, ['commit', '-q', '--allow-empty', '-m', 'from the other clone'])
    sh(other, ['push', '-q', 'origin', 'main'])
    const remoteHead = sh(bare, ['rev-parse', 'main']).trim()
    sh(dir, ['commit', '-q', '--allow-empty', '-m', 'local'])
    const c = core()
    const job = await run(c, { action: 'push', repoRoot: dir, branch: 'main' })
    expect(job.error?.code).toBe('push-rejected')
    expect(sh(bare, ['rev-parse', 'main']).trim()).toBe(remoteHead)
  }, 60_000)

  it('offers a PR only for a GitHub remote with gh on PATH', async () => {
    const { dir } = remoteSetup()
    sh(dir, ['remote', 'set-url', 'origin', 'https://user:secret-token@github.com/acme/widget.git'])
    expect(ENV.PATH.split(':').filter((d) => fs.existsSync(path.join(d, 'gh'))), 'a gh on the test PATH').toEqual([])
    const noGh = await planOne(core(), dir, [])
    expect(noGh.pr).toEqual({ available: false, reason: 'no-gh' })
    expect(noGh.pushTarget?.url).toBe('https://github.com/acme/widget.git')

    const bin = path.join(ROOT, `bin-${seq}`)
    hook(bin, 'gh', 'echo "https://github.com/acme/widget/pull/7"')
    const c = core(bin)
    sh(dir, ['config', 'branch.main.remote', 'origin'])
    sh(dir, ['config', 'branch.main.merge', 'refs/heads/main'])
    const withGh = await planOne(c, dir, [])
    expect(withGh.pr).toEqual({ available: true })
    const pr = await run(c, { action: 'pr', repoRoot: dir, branch: 'main', title: 'Add widget', body: '' })
    expect(pr.state, JSON.stringify(pr.error)).toBe('succeeded')
    expect(pr.result).toMatchObject({ url: 'https://github.com/acme/widget/pull/7', existed: false })

    sh(dir, ['remote', 'set-url', 'origin', path.join(ROOT, 'elsewhere.git')])
    expect((await planOne(c, dir, [])).pr).toEqual({ available: false, reason: 'not-github' })
  }, 60_000)
})
