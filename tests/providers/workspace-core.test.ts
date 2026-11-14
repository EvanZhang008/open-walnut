/**
 * workspace-core.ts (the daemon side of task workspaces), against real git and a
 * real provider process.
 *
 * MACHINE SAFETY: every repository, worktree, provider workspace and HOME lives
 * under ONE temp dir this file creates (`ROOT`); `inTemp` asserts it before any
 * spawn. HOME and WALNUT_WORKTREES_ROOT are set explicitly (never inherited from
 * the shell that runs the tests) to the temp HOME and its worktrees folder.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceCore, type WorkspaceCoreDeps } from '../../src/providers/workspace-core.js'

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ws-core-')))
const PROVIDER = path.resolve(__dirname, '../fixtures/workspace-providers/fake-multirepo/provider.mjs')

function inTemp(p: string): string {
  const abs = path.resolve(p)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error(`refusing to touch ${abs}: outside the test temp dir`)
  return abs
}

function sh(args: string[], cwd: string): string {
  inTemp(cwd)
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: path.join(ROOT, 'home') },
  }).trim()
}

let seq = 0
function makeRepo(name = `repo${++seq}`): string {
  const dir = inTemp(path.join(ROOT, 'repos', name))
  fs.mkdirSync(dir, { recursive: true })
  sh(['init', '-q'], dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'b\n')
  sh(['add', '.'], dir)
  sh(['commit', '-qm', 'init'], dir)
  return dir
}

function makeCore(extra: Partial<WorkspaceCoreDeps> = {}) {
  const home = inTemp(path.join(ROOT, 'home'))
  fs.mkdirSync(home, { recursive: true })
  return createWorkspaceCore({
    spawn: spawn as unknown as WorkspaceCoreDeps['spawn'],
    fs,
    path,
    homedir: () => home,
    // A poisoned redirect: if the core inherited it, git would address another repository.
    env: { ...process.env, HOME: home, WALNUT_WORKTREES_ROOT: path.join(home, '.open-walnut-worktrees'), GIT_DIR: path.join(ROOT, 'not-a-repo'), GIT_WORK_TREE: path.join(ROOT, 'nowhere') },
    stateDir: inTemp(path.join(ROOT, 'state')),
    killGroup: (pid, signal) => { process.kill(-pid, signal as NodeJS.Signals) },
    ...extra,
  })
}

type Core = ReturnType<typeof makeCore>

async function waitJob(core: Core, jobId: string, ms = 20_000): Promise<Record<string, unknown>> {
  const until = Date.now() + ms
  for (;;) {
    const r = await core.handle('workspace.job', { jobId }) as { job: Record<string, unknown> | null }
    if (r.job && r.job.state !== 'running') return r.job
    if (Date.now() > until) throw new Error('job did not finish: ' + JSON.stringify(r.job))
    await new Promise((res) => setTimeout(res, 50))
  }
}

let jobSeq = 0
const jid = () => `job-${Date.now()}-${++jobSeq}`

async function createGit(core: Core, anchor: string, name: string, extra: Record<string, unknown> = {}) {
  const jobId = jid()
  const started = await core.handle('workspace.create', { provider: 'git-worktree', jobId, anchor, name, ...extra })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  return waitJob(core, jobId)
}

afterAll(() => {
  inTemp(ROOT)
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('path safety', () => {
  const core = makeCore()
  const home = path.join(ROOT, 'home')
  it('refuses the root, home, system folders and mount roots literally', () => {
    for (const p of ['/', home, '/usr', '/usr/bin/x', '/etc', '/System/Library', '/Volumes/Disk', '/mnt/data', '/media/u/disk', '/tmp', '/private/var/folders', path.join(home, '.ssh', 'x')]) {
      expect(core.forbiddenReason(p), p).toBeTruthy()
    }
    for (const p of [path.join(home, 'work', 'repo'), '/Volumes/Disk/projects/x', '/mnt/data/src', path.join(ROOT, 'repos')]) {
      expect(core.forbiddenReason(p), p).toBeNull()
    }
  })
  it('checks the realpath too: a symlink cannot launder / or home into an allowed path', async () => {
    const links = inTemp(path.join(ROOT, 'links'))
    fs.mkdirSync(links, { recursive: true })
    fs.symlinkSync('/', path.join(links, 'to-root'))
    fs.symlinkSync(home, path.join(links, 'to-home'))
    expect(await core.checkForbidden(path.join(links, 'to-root'), 'x')).toMatch(/resolves to \/, which is the filesystem root/)
    expect(await core.checkForbidden(path.join(links, 'to-home'), 'x')).toMatch(/the home folder/)
    expect(await core.checkForbidden(path.join(links, 'to-root', 'usr'), 'x')).toMatch(/system folder/)
    expect(await core.checkForbidden(path.join(ROOT, 'repos', 'nope', 'deeper'), 'x')).toBeNull()
  })
  it('slugs names into one safe path segment', () => {
    expect(core.slugify('Fix the Login bug! (v2)')).toBe('fix-the-login-bug-v2')
    expect(core.slugify('../../etc')).toBe('etc')
    expect(core.slugify('')).toBe('task')
    expect(core.slugify('x'.repeat(200)).length).toBeLessThanOrEqual(64)
  })
})

describe('protocol framing', () => {
  const core = makeCore()
  it('reads one JSON object, pretty-printed or as the last line after log noise', () => {
    expect(core.parseReply('{"version":1,"ok":true,"result":{"root":"/x"}}')).toEqual({ ok: true, result: { root: '/x' } })
    expect(core.parseReply('{\n  "version": 1,\n  "ok": false,\n  "error": "nope"\n}\n')).toEqual({ ok: false, error: 'nope' })
    expect(core.parseReply('cloning...\ndone\n{"ok":true,"result":{}}')).toEqual({ ok: true, result: {} })
  })
  it('refuses garbage, a missing ok and another protocol version', () => {
    expect(core.parseReply('')).toBeNull()
    expect(core.parseReply('not json')).toBeNull()
    expect(core.parseReply('{"result":{}}')).toBeNull()
    expect(core.parseReply('{"version":2,"ok":true}')).toEqual({ ok: false, error: 'provider spoke protocol version 2, expected 1' })
  })
  it('parses git worktree list --porcelain', () => {
    expect(core.parseWorktreeList('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n')).toEqual([
      { path: '/a', branch: 'refs/heads/main' }, { path: '/b' },
    ])
  })
})

describe('git-worktree', () => {
  let core: Core
  beforeEach(() => { core = makeCore() })

  it('detects a repository and declines a plain folder', async () => {
    const repo = makeRepo()
    const plain = inTemp(path.join(ROOT, 'plain'))
    fs.mkdirSync(plain, { recursive: true })
    const r = await core.handle('workspace.detect', { anchor: repo }) as { candidates: Array<Record<string, unknown>> }
    expect(r.candidates[0]).toMatchObject({ provider: 'git-worktree', claimed: true, root: repo, branch: 'main' })
    const p = await core.handle('workspace.detect', { anchor: plain }) as { candidates: Array<Record<string, unknown>> }
    expect(p.candidates[0]).toMatchObject({ provider: 'git-worktree', claimed: false, reason: 'not a git repository' })
  })

  it('creates a worktree on walnut/<slug> under the Walnut folder, not in the repo, ignoring an inherited GIT_DIR', async () => {
    const repo = makeRepo()
    const job = await createGit(core, path.join(repo, 'pkg'), 'Fix login abc12345')
    expect(job.state, JSON.stringify(job)).toBe('done')
    const res = job.result as Record<string, unknown>
    const wtRoot = path.join(ROOT, 'home', '.open-walnut-worktrees')
    expect(res.root).toBe(path.join(wtRoot, path.basename(repo), 'fix-login-abc12345'))
    // The session runs in the same sub-folder the user launched from.
    expect(res.cwd).toBe(path.join(String(res.root), 'pkg'))
    expect(res.branch).toBe('walnut/fix-login-abc12345')
    expect(res.sourceRepo).toBe(repo)
    expect(sh(['rev-parse', '--abbrev-ref', 'HEAD'], String(res.root))).toBe('walnut/fix-login-abc12345')
    expect(sh(['worktree', 'list', '--porcelain'], repo)).toContain(String(res.root))
    expect(fs.existsSync(path.join(String(res.root), 'a.txt'))).toBe(true)
  })

  it('gives a second task its own worktree, and a retry of the same task adopts the existing one', async () => {
    const repo = makeRepo()
    const a = await createGit(core, repo, 'task-a')
    const b = await createGit(core, repo, 'task-b')
    expect((a.result as { root: string }).root).not.toBe((b.result as { root: string }).root)
    const again = await createGit(core, repo, 'task-a')
    expect(again.state).toBe('done')
    expect(again.result).toMatchObject({ root: (a.result as { root: string }).root, adopted: true })
  })

  it('branches from a named base ref', async () => {
    const repo = makeRepo()
    sh(['checkout', '-q', '-b', 'feature'], repo)
    fs.writeFileSync(path.join(repo, 'f.txt'), 'f\n')
    sh(['add', '.'], repo)
    sh(['commit', '-qm', 'feature'], repo)
    sh(['checkout', '-q', 'main'], repo)
    const job = await createGit(core, repo, 'from-feature', { baseRef: 'feature' })
    expect(job.state).toBe('done')
    expect(fs.existsSync(path.join((job.result as { root: string }).root, 'f.txt'))).toBe(true)
    expect(job.result).toMatchObject({ baseRef: { name: 'feature' } })
    const bad = await createGit(core, repo, 'bad-base', { baseRef: '../../etc' })
    expect(bad).toMatchObject({ state: 'failed', code: 'bad_args' })
  })

  it('refuses a workspace made from inside another one (nested)', async () => {
    const repo = makeRepo()
    const first = await createGit(core, repo, 'outer')
    const nested = await createGit(core, (first.result as { root: string }).root, 'inner')
    expect(nested).toMatchObject({ state: 'failed', code: 'nested' })
  })

  it('refuses home (or a symlink to it) as the repository', async () => {
    const home = path.join(ROOT, 'home')
    fs.mkdirSync(home, { recursive: true })
    sh(['init', '-q'], home)
    fs.writeFileSync(path.join(home, 'dot'), 'x')
    sh(['add', 'dot'], home)
    sh(['commit', '-qm', 'dotfiles'], home)
    try {
      const job = await createGit(core, home, 'dotfiles')
      expect(job).toMatchObject({ state: 'failed', code: 'forbidden_path' })
      expect(String(job.error)).toMatch(/home folder/)
      const det = await core.handle('workspace.detect', { anchor: home }) as { candidates: Array<Record<string, unknown>> }
      expect(det.candidates[0]).toMatchObject({ claimed: false })
    } finally {
      fs.rmSync(path.join(home, '.git'), { recursive: true, force: true })
      fs.rmSync(path.join(home, 'dot'), { force: true })
    }
  })

  it('a failed creation leaves no folder and no branch behind', async () => {
    const repo = makeRepo()
    // walnut/busy is checked out in another worktree, so `worktree add` of it must fail.
    const other = inTemp(path.join(ROOT, 'other-wt'))
    sh(['worktree', 'add', '-q', '-b', 'walnut/busy', other], repo)
    const job = await createGit(core, repo, 'busy')
    expect(job).toMatchObject({ state: 'failed', code: 'git_failed' })
    const target = path.join(ROOT, 'home', '.open-walnut-worktrees', path.basename(repo), 'busy')
    expect(fs.existsSync(target)).toBe(false)
    // The pre-existing branch is untouched.
    expect(sh(['rev-parse', '--verify', 'walnut/busy'], repo)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses a target folder it did not make', async () => {
    const repo = makeRepo()
    const target = path.join(ROOT, 'home', '.open-walnut-worktrees', path.basename(repo), 'squatter')
    fs.mkdirSync(inTemp(target), { recursive: true })
    fs.writeFileSync(path.join(target, 'keep.txt'), 'mine')
    const job = await createGit(core, repo, 'squatter')
    expect(job).toMatchObject({ state: 'failed', code: 'target_exists' })
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('mine')
  })

  describe('probe and removal fail closed', () => {
    async function made(name: string) {
      const repo = makeRepo()
      const job = await createGit(core, repo, name)
      const r = job.result as { root: string; branch: string; sourceRepo: string; baseRef: { name?: string; sha?: string }; repos: Array<{ path: string }> }
      return { repo, ...r }
    }
    const statusOf = async (w: Awaited<ReturnType<typeof made>>) =>
      (await core.handle('workspace.status', { provider: 'git-worktree', root: w.root, repos: w.repos, branch: w.branch, sourceRepo: w.sourceRepo, baseRef: w.baseRef }) as { probe: Record<string, unknown> }).probe
    async function remove(w: Awaited<ReturnType<typeof made>>, opts: { requireMerged: boolean }) {
      const jobId = jid()
      const started = await core.handle('workspace.remove', {
        provider: 'git-worktree', jobId, root: w.root, repos: w.repos, branch: w.branch, sourceRepo: w.sourceRepo,
        baseRef: w.baseRef, anchor: w.repo, deleteBranch: 'if-merged', requireMerged: opts.requireMerged,
      })
      expect(started.ok, JSON.stringify(started)).toBe(true)
      return waitJob(core, jobId)
    }

    it('a fresh worktree with no new commits is clean and merged: removed with its branch', async () => {
      const w = await made('fresh')
      expect(await statusOf(w)).toMatchObject({ clean: true, merged: true, branchMerged: true })
      const job = await remove(w, { requireMerged: true })
      expect(job.state, JSON.stringify(job)).toBe('done')
      expect(job.result).toMatchObject({ removed: true, rootGone: true, branchDeleted: true })
      expect(fs.existsSync(w.root)).toBe(false)
      expect(() => sh(['rev-parse', '--verify', '-q', w.branch], w.repo)).toThrow()
    })

    it('uncommitted work keeps the whole workspace, even for a manual remove', async () => {
      const w = await made('dirty')
      fs.writeFileSync(path.join(w.root, 'a.txt'), 'changed\n')
      fs.writeFileSync(path.join(w.root, 'new.txt'), 'untracked\n')
      const p = await statusOf(w)
      expect(p).toMatchObject({ clean: false })
      expect((p.problems as string[]).join(' ')).toMatch(/2 uncommitted changes/)
      const job = await remove(w, { requireMerged: false })
      expect(job).toMatchObject({ state: 'failed', code: 'not_clean' })
      expect(fs.readFileSync(path.join(w.root, 'a.txt'), 'utf8')).toBe('changed\n')
    })

    it('committed but unmerged work: completion keeps it; a manual remove drops the folder and keeps the branch', async () => {
      const w = await made('unmerged')
      fs.writeFileSync(path.join(w.root, 'c.txt'), 'c\n')
      sh(['add', '.'], w.root)
      sh(['commit', '-qm', 'work'], w.root)
      const p = await statusOf(w)
      expect(p).toMatchObject({ clean: true, merged: false, branchMerged: false })
      expect((p.problems as string[]).join(' ')).toMatch(/not merged or pushed anywhere/)
      expect(await remove(w, { requireMerged: true })).toMatchObject({ state: 'failed', code: 'not_merged' })
      expect(fs.existsSync(w.root)).toBe(true)
      const manual = await remove(w, { requireMerged: false })
      expect(manual.state).toBe('done')
      expect(manual.result).toMatchObject({ branchDeleted: false, branchKept: true })
      expect(fs.existsSync(w.root)).toBe(false)
      // The commits survive on the branch.
      expect(sh(['log', '--oneline', '-1', w.branch], w.repo)).toMatch(/work/)
    })

    it('work merged into the base branch counts as merged and the branch is deleted', async () => {
      const w = await made('merged')
      fs.writeFileSync(path.join(w.root, 'd.txt'), 'd\n')
      sh(['add', '.'], w.root)
      sh(['commit', '-qm', 'done'], w.root)
      sh(['merge', '-q', '--ff-only', w.branch], w.repo)
      expect(await statusOf(w)).toMatchObject({ clean: true, merged: true })
      const job = await remove(w, { requireMerged: true })
      expect(job.result).toMatchObject({ removed: true, branchDeleted: true })
    })

    it('an unreadable worktree (its gitdir is gone) is kept', async () => {
      const w = await made('broken')
      fs.writeFileSync(path.join(w.root, '.git'), 'gitdir: /nonexistent/gitdir\n')
      const p = await statusOf(w)
      expect(p.clean).toBe(false)
      expect((p.problems as string[]).join(' ')).toMatch(/could not be read/)
      expect(await remove(w, { requireMerged: false })).toMatchObject({ state: 'failed', code: 'not_clean' })
    })

    it('a branch named on a tampered task row is left alone: not walnut/, or checked out elsewhere', async () => {
      const w = await made('tamper')
      const job = await remove({ ...w, branch: 'main' }, { requireMerged: true })
      expect(job.state, JSON.stringify(job)).toBe('done')
      expect(job.result).toMatchObject({ branchDeleted: false })
      expect(sh(['rev-parse', '--verify', 'main'], w.repo)).toMatch(/^[0-9a-f]{40}$/)
      // walnut/<a> is checked out in worktree A: removing worktree B with A's branch keeps it.
      const a = await made('owner-a')
      const bJob = await createGit(core, a.repo, 'owner-b')
      const b = { repo: a.repo, ...(bJob.result as { root: string; branch: string; sourceRepo: string; baseRef: { name?: string; sha?: string }; repos: Array<{ path: string }> }) }
      const rm = await remove({ ...b, branch: a.branch }, { requireMerged: true })
      expect(rm.state, JSON.stringify(rm)).toBe('done')
      expect(rm.result).toMatchObject({ branchDeleted: false, branchKept: true })
      expect(sh(['rev-parse', '--verify', a.branch], a.repo)).toMatch(/^[0-9a-f]{40}$/)
      expect(fs.existsSync(a.root)).toBe(true)
    })

    it('a detached HEAD on a commit no branch holds keeps the worktree', async () => {
      const w = await made('detached')
      sh(['checkout', '-q', '--detach'], w.root)
      fs.writeFileSync(path.join(w.root, 'lost.txt'), 'only here\n')
      sh(['add', '.'], w.root)
      sh(['commit', '-qm', 'on no branch'], w.root)
      const p = await statusOf(w)
      expect(p.clean).toBe(false)
      expect((p.problems as string[]).join(' ')).toMatch(/detached commit that no branch holds/)
      expect(await remove(w, { requireMerged: false })).toMatchObject({ state: 'failed', code: 'not_clean' })
    })

    it('ignored files are listed (a removal deletes them); an ignored folder holding a repository keeps it', async () => {
      const w = await made('ignored')
      fs.mkdirSync(path.join(w.repo, '.git', 'info'), { recursive: true })
      fs.appendFileSync(path.join(w.repo, '.git', 'info', 'exclude'), 'secret.env\nvendor/\n')
      fs.writeFileSync(path.join(w.root, 'secret.env'), 'TOKEN=x\n')
      const p = await statusOf(w)
      expect(p).toMatchObject({ clean: true })
      expect((p.repos as Array<Record<string, unknown>>)[0]).toMatchObject({ ignored: ['secret.env'], ignoredCount: 1 })
      const nested = inTemp(path.join(w.root, 'vendor', 'lib'))
      fs.mkdirSync(nested, { recursive: true })
      sh(['init', '-q'], nested)
      const p2 = await statusOf(w)
      expect(p2.clean).toBe(false)
      expect(p2.unlisted).toEqual([nested])
      expect((p2.problems as string[]).join(' ')).toContain(`${nested}: a repository Walnut was not told about`)
    })

    it('never removes a root outside the worktrees folder, or one holding the task folder', async () => {
      const repo = makeRepo()
      const jobId = jid()
      await core.handle('workspace.remove', { provider: 'git-worktree', jobId, root: repo, repos: [{ path: repo }], branch: 'main', sourceRepo: repo, deleteBranch: 'if-merged', requireMerged: false })
      expect(await waitJob(core, jobId)).toMatchObject({ state: 'failed', code: 'forbidden_path' })
      expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true)
      const jobId2 = jid()
      await core.handle('workspace.remove', { provider: 'git-worktree', jobId: jobId2, root: '/', repos: [], requireMerged: false })
      expect(await waitJob(core, jobId2)).toMatchObject({ state: 'failed', code: 'forbidden_path' })
    })
  })
})

describe('plugin providers', () => {
  const home = path.join(ROOT, 'home')
  const spec = (extra: Record<string, unknown> = {}) => ({
    id: 'fake-multirepo', displayName: 'Fake multi-repo', priority: 50, markers: ['fake-workspace.json'],
    command: [process.execPath, '{script}'], script: { name: 'provider.mjs', content: fs.readFileSync(PROVIDER, 'utf8') },
    ...extra,
  })
  async function configured(extra: Record<string, unknown> = {}) {
    const core = makeCore({ env: { ...process.env, HOME: home, WALNUT_WORKTREES_ROOT: path.join(home, '.open-walnut-worktrees'), GIT_DIR: path.join(ROOT, 'not-a-repo') } })
    const hash = `h-${Date.now()}-${Math.random()}`
    const r = await core.handle('workspace.configure', { config: { version: 1, hash, providers: [spec(extra)] } })
    expect(r).toMatchObject({ ok: true, changed: true })
    return { core, hash }
  }
  async function create(core: Core, hash: string, name: string, inputs: Record<string, unknown>, anchor = path.join(ROOT, 'repos')) {
    fs.mkdirSync(anchor, { recursive: true })
    const jobId = jid()
    const started = await core.handle('workspace.create', { provider: 'fake-multirepo', providersHash: hash, jobId, anchor, name, inputs })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    return waitJob(core, jobId, 30_000)
  }

  it('a stale or missing allowlist answers providers_stale, never runs anything', async () => {
    const { core, hash } = await configured()
    expect(await core.handle('workspace.create', { provider: 'fake-multirepo', providersHash: 'old', jobId: jid(), anchor: ROOT, name: 'x' }))
      .toMatchObject({ ok: false, code: 'providers_stale' })
    expect(await core.handle('workspace.create', { provider: 'nope', providersHash: hash, jobId: jid(), anchor: ROOT, name: 'x' }))
      .toMatchObject({ ok: false, code: 'unknown_provider' })
    expect(await makeCore().handle('workspace.detect', { anchor: ROOT, providersHash: hash })).toMatchObject({ ok: false, code: 'providers_stale' })
  })

  it('keeps one allowlist and adapter dir per Walnut home; a push with no home is the legacy one', async () => {
    const state = inTemp(path.join(ROOT, 'state-scoped'))
    const core = makeCore({ stateDir: state, scopeDir: (h) => path.join(state, 'walnuts', path.basename(h)) })
    const A = path.join(ROOT, 'wa')
    const B = path.join(ROOT, 'wb')
    const cfg = (hash: string, name: string) => ({ version: 1, hash, providers: [spec({ displayName: name })] })
    expect(await core.handle('workspace.configure', { home: A, config: cfg('ha', 'A') })).toMatchObject({ ok: true, changed: true })
    expect(await core.handle('workspace.configure', { home: B, config: cfg('hb', 'B') })).toMatchObject({ ok: true, changed: true })
    expect(await core.handle('workspace.configure', { config: cfg('h0', 'unnamed') })).toMatchObject({ ok: true, changed: true })
    expect(await core.handle('workspace.configure', { home: A, config: cfg('ha', 'A') })).toMatchObject({ ok: true, changed: false })
    expect(core.providersHash(A)).toBe('ha')
    expect(core.providersHash(B)).toBe('hb')
    expect(core.providersHash()).toBe('h0')
    expect(fs.existsSync(path.join(state, 'walnuts', 'wa', 'workspace-providers', 'fake-multirepo.mjs'))).toBe(true)
    expect(fs.existsSync(path.join(state, 'walnuts', 'wb', 'workspace-providers', 'fake-multirepo.mjs'))).toBe(true)
    expect(fs.existsSync(path.join(state, 'workspace-providers', 'fake-multirepo.mjs'))).toBe(true)
    // The resolved home the twin passes wins over the command's own.
    expect(await core.handle('workspace.detect', { home: B, anchor: ROOT, providersHash: 'hb' }, A)).toMatchObject({ ok: false, code: 'providers_stale' })
    // A provider runs from its own Walnut's adapter, written again there when swept.
    fs.rmSync(path.join(state, 'walnuts', 'wb'), { recursive: true, force: true })
    const listed = await core.handle('workspace.repos', { home: B, provider: 'fake-multirepo', providersHash: 'hb', root: path.join(ROOT, 'repos') })
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    expect(fs.existsSync(path.join(state, 'walnuts', 'wb', 'workspace-providers', 'fake-multirepo.mjs'))).toBe(true)
    expect(fs.existsSync(path.join(state, 'walnuts', 'wa', 'workspace-providers', 'fake-multirepo.mjs'))).toBe(true)
    // A job belongs to the Walnut that started it.
    const repo = makeRepo()
    const jobId = jid()
    expect(await core.handle('workspace.create', { home: B, provider: 'git-worktree', jobId, anchor: repo, name: 'scoped-b' })).toMatchObject({ ok: true })
    expect((await core.handle('workspace.job', { home: A, jobId })).job).toBeNull()
    expect((await core.handle('workspace.job', { jobId })).job).toBeNull()
    expect(await waitJob({ handle: (n: string, c: Record<string, unknown>) => core.handle(n, { ...c, home: B }) } as unknown as Core, jobId)).toMatchObject({ state: 'done' })
  })

  it('configure is hash-skipped and refuses a bad argv', async () => {
    const { core, hash } = await configured()
    expect(await core.handle('workspace.configure', { config: { version: 1, hash, providers: [spec()] } })).toMatchObject({ ok: true, changed: false })
    expect(await core.handle('workspace.configure', { config: { version: 1, hash: 'h2', providers: [spec({ command: [] })] } })).toMatchObject({ ok: false })
    expect(await core.handle('workspace.configure', { config: { version: 1, hash: 'h3', providers: [spec({ id: 'git-worktree' })] } })).toMatchObject({ ok: false })
  })

  it('creates a multi-repo workspace, reports progress and repos, and detects it by marker', async () => {
    const { core, hash } = await configured()
    const job = await create(core, hash, 'multi-one', { packages: ['alpha', 'beta'] })
    expect(job.state, JSON.stringify(job)).toBe('done')
    const res = job.result as { root: string; cwd: string; repos: Array<{ path: string; name: string }> }
    expect(res.root).toBe(path.join(home, 'fake-workspaces', 'multi-one'))
    expect(res.repos.map((r) => r.name)).toEqual(['alpha', 'beta'])
    expect(res.repos[0].path).toBe(path.join(res.root, 'src', 'alpha'))
    expect(String(job.progress)).toMatch(/Cloning beta/)
    // A folder inside the new workspace is claimed by the marker.
    const det = await core.handle('workspace.detect', { anchor: path.join(res.root, 'src', 'alpha'), providersHash: hash }) as { candidates: Array<Record<string, unknown>> }
    const fake = det.candidates.find((c) => c.provider === 'fake-multirepo')!
    expect(fake).toMatchObject({ claimed: true, root: res.root })
    // Its detect step suggests the inputs a workspace of this folder uses (the marker's packages).
    expect(fake.inputs).toEqual({ packages: ['alpha', 'beta'] })
    // Priority orders the candidates: the plugin (50) before the git fallback (10).
    expect(det.candidates[0].provider).toBe('fake-multirepo')
  })

  it('fails closed on removal while any package is dirty or unpushed, and removes when all are clean', async () => {
    const { core, hash } = await configured()
    const job = await create(core, hash, 'multi-two', { packages: ['gamma', 'delta'] })
    const res = job.result as { root: string; repos: Array<{ path: string; name: string }> }
    const probe = async () => ((await core.handle('workspace.status', { provider: 'fake-multirepo', providersHash: hash, root: res.root, repos: res.repos })) as { probe: Record<string, unknown> }).probe
    expect(await probe()).toMatchObject({ clean: true, merged: true })
    fs.writeFileSync(path.join(res.repos[1].path, 'wip.txt'), 'wip')
    expect(await probe()).toMatchObject({ clean: false })
    const removeJob = async () => {
      const jobId = jid()
      await core.handle('workspace.remove', { provider: 'fake-multirepo', providersHash: hash, jobId, root: res.root, repos: res.repos, requireMerged: true })
      return waitJob(core, jobId)
    }
    expect(await removeJob()).toMatchObject({ state: 'failed', code: 'not_clean' })
    expect(fs.existsSync(res.root)).toBe(true)
    sh(['add', '.'], res.repos[1].path)
    sh(['commit', '-qm', 'local only'], res.repos[1].path)
    const p2 = await probe()
    expect(p2).toMatchObject({ clean: true, merged: false })
    expect(await removeJob()).toMatchObject({ state: 'failed', code: 'not_merged' })
    sh(['push', '-q'], res.repos[1].path)
    expect(await probe()).toMatchObject({ clean: true, merged: true })
    const done = await removeJob()
    expect(done.state, JSON.stringify(done)).toBe('done')
    expect(done.result).toMatchObject({ removed: true, rootGone: true })
  })

  it('probes what is there now: a repository added later, one nobody lists, a local branch, a stash', async () => {
    const { core, hash } = await configured()
    const job = await create(core, hash, 'multi-later', { packages: ['epsilon'] })
    const res = job.result as { root: string; repos: Array<{ path: string; name: string }> }
    const recorded = res.repos
    const probe = async () => ((await core.handle('workspace.status', { provider: 'fake-multirepo', providersHash: hash, root: res.root, repos: recorded })) as { probe: Record<string, unknown> }).probe
    const removeJob = async (requireMerged: boolean) => {
      const jobId = jid()
      await core.handle('workspace.remove', { provider: 'fake-multirepo', providersHash: hash, jobId, root: res.root, repos: recorded, requireMerged })
      return waitJob(core, jobId)
    }
    const problems = (p: Record<string, unknown>) => (p.problems as string[]).join(' | ')
    expect(await probe()).toMatchObject({ clean: true, merged: true })

    // A package checked out after creation (listRepos lists it): its local-only commit counts.
    const zeta = inTemp(path.join(res.root, 'src', 'zeta'))
    fs.mkdirSync(zeta, { recursive: true })
    sh(['init', '-q'], zeta)
    fs.writeFileSync(path.join(zeta, 'z.txt'), 'z\n')
    sh(['add', '.'], zeta)
    sh(['commit', '-qm', 'zeta'], zeta)
    const pz = await probe()
    expect(pz).toMatchObject({ clean: true, merged: false })
    expect(problems(pz)).toMatch(/zeta: 1 commit on local branches is not pushed/)
    // Even a removal by hand (requireMerged false) is refused for a plugin workspace.
    expect(await removeJob(false)).toMatchObject({ state: 'failed', code: 'not_merged' })
    expect(fs.existsSync(zeta)).toBe(true)
    fs.rmSync(zeta, { recursive: true, force: true })

    // A repository the provider never lists.
    const stray = inTemp(path.join(res.root, 'extra', 'tool'))
    fs.mkdirSync(stray, { recursive: true })
    sh(['init', '-q'], stray)
    const ps = await probe()
    expect(ps.clean).toBe(false)
    expect(ps.unlisted).toEqual([stray])
    expect(await removeJob(true)).toMatchObject({ state: 'failed', code: 'not_clean' })
    fs.rmSync(path.join(res.root, 'extra'), { recursive: true, force: true })

    // A commit on another local branch, while HEAD is pushed.
    const epsilon = recorded[0].path
    sh(['checkout', '-q', '-b', 'side'], epsilon)
    fs.writeFileSync(path.join(epsilon, 's.txt'), 's\n')
    sh(['add', '.'], epsilon)
    sh(['commit', '-qm', 'side work'], epsilon)
    sh(['checkout', '-q', 'main'], epsilon)
    const pb = await probe()
    expect(pb).toMatchObject({ clean: true, merged: false })
    expect(problems(pb)).toMatch(/epsilon: 1 commit on local branches is not pushed/)
    sh(['branch', '-q', '-D', 'side'], epsilon)

    // A stash.
    fs.writeFileSync(path.join(epsilon, 'README.md'), 'changed\n')
    sh(['stash', '-q'], epsilon)
    const pst = await probe()
    expect(pst.clean).toBe(false)
    expect(problems(pst)).toMatch(/epsilon: has stashed changes/)
    sh(['stash', 'drop', '-q'], epsilon)

    expect(await probe()).toMatchObject({ clean: true, merged: true })
    const done = await removeJob(true)
    expect(done.state, JSON.stringify(done)).toBe('done')
  })

  it('a listRepos that fails keeps the workspace', async () => {
    const { core, hash } = await configured()
    const job = await create(core, hash, 'multi-nolist', { packages: ['eta'] })
    const res = job.result as { root: string; repos: Array<{ path: string; name: string }> }
    const p = ((await core.handle('workspace.status', { provider: 'fake-multirepo', providersHash: hash, root: res.root, repos: res.repos, inputs: { fail: 'listRepos' } })) as { probe: Record<string, unknown> }).probe
    expect(p.clean).toBe(false)
    expect((p.problems as string[]).join(' ')).toMatch(/could not list its repositories \(simulated listRepos failure\)/)
  })

  it('an adapter a /tmp cleaner removed is written again before the next run', async () => {
    const { core, hash } = await configured()
    const adapter = inTemp(path.join(ROOT, 'state', 'workspace-providers', 'fake-multirepo.mjs'))
    fs.rmSync(adapter)
    const job = await create(core, hash, 'multi-rewrite', { packages: ['theta'] })
    expect(job.state, JSON.stringify(job)).toBe('done')
    expect(fs.existsSync(adapter)).toBe(true)
  })

  it('a provider whose background child keeps stdout open still ends when it exits', async () => {
    const holder = [
      "import { spawn } from 'node:child_process'",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref()",
      "process.stdout.write(JSON.stringify({ version: 1, ok: true, result: { claimed: false, reason: 'held' } }) + '\\n')",
    ].join('\n')
    const { core, hash } = await configured({ id: 'holder', markers: undefined, script: { name: 'holder.mjs', content: holder } })
    const t0 = Date.now()
    const det = await core.handle('workspace.detect', { anchor: ROOT, providersHash: hash }) as { candidates: Array<Record<string, unknown>> }
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(det.candidates.find((c) => c.provider === 'holder')).toMatchObject({ claimed: false, reason: 'held' })
  })

  it('a provider error, a timeout, a bad reply and an unsafe root all fail the job with the reason', async () => {
    const { core, hash } = await configured({ timeouts: { createSec: 1 } })
    expect(await create(core, hash, 'f1', { packages: ['x'], fail: 'create' })).toMatchObject({ state: 'failed', error: 'simulated create failure' })
    const slow = await create(core, hash, 'f2', { packages: ['x'], sleepSec: 5 })
    expect(slow).toMatchObject({ state: 'failed', code: 'timeout' })
    expect(await create(core, hash, 'f3', { packages: ['x'], badJson: true })).toMatchObject({ state: 'failed', code: 'bad_reply' })
    const unsafe = await create(core, hash, 'f4', { packages: ['x'], unsafeRoot: true })
    expect(unsafe).toMatchObject({ state: 'failed', code: 'unsafe_result' })
    expect(String(unsafe.error)).toMatch(/filesystem root/)
    expect(await create(core, hash, 'f5', {})).toMatchObject({ state: 'failed', error: expect.stringMatching(/packages is required/) })
  }, 30_000)

  it('a missing provider command is a clear error', async () => {
    const { core, hash } = await configured({ command: [path.join(ROOT, 'no-such-binary')], script: undefined })
    const job = await create(core, hash, 'm1', { packages: ['x'] })
    expect(job).toMatchObject({ state: 'failed', code: 'spawn_failed' })
    expect(String(job.error)).toMatch(/command not found/)
  })
})

describe('project scripts (workspace-scripts-v1)', () => {
  const core = makeCore({ env: { ...process.env, SHELL: '/bin/sh', HOME: path.join(ROOT, 'home'), WALNUT_WORKTREES_ROOT: path.join(ROOT, 'home', '.open-walnut-worktrees') } })
  let root = ''
  beforeAll(async () => {
    const repo = makeRepo('scripted')
    fs.writeFileSync(path.join(repo, 'walnut.json'), JSON.stringify({ scripts: [{ name: 'Install', command: 'echo hi', setup: true }] }))
    sh(['add', '.'], repo)
    sh(['commit', '-qm', 'scripts'], repo)
    const job = await createGit(core, path.join(repo, 'pkg'), 'scripted')
    expect(job.state).toBe('done')
    root = String((job.result as Record<string, unknown>).root)
  })

  async function runIt(extra: Record<string, unknown>, ms?: number) {
    const jobId = jid()
    const started = await core.handle('workspace.runScript', { provider: 'git-worktree', jobId, root, ...extra })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    return waitJob(core, jobId, ms)
  }

  it('reads walnut.json at the git top of a folder (a sub-folder, the worktree), else none', async () => {
    const r = await core.handle('workspace.scriptsFile', { dir: path.join(root, 'pkg') }) as Record<string, any>
    expect(r).toMatchObject({ ok: true, dir: root, file: { name: 'walnut.json', path: path.join(root, 'walnut.json') } })
    expect(JSON.parse(r.file.content).scripts[0].command).toBe('echo hi')
    const other = makeRepo('othername')
    fs.writeFileSync(path.join(other, 'scripts.json'), '{"scripts":[]}')
    expect(await core.handle('workspace.scriptsFile', { dir: other })).toMatchObject({ ok: true, dir: other, file: null })
    expect(await core.handle('workspace.scriptsFile', { dir: makeRepo('none') })).toMatchObject({ ok: true, file: null })
    const big = makeRepo('big')
    fs.writeFileSync(path.join(big, 'walnut.json'), ' '.repeat(70 * 1024))
    expect(await core.handle('workspace.scriptsFile', { dir: big })).toMatchObject({ ok: true, file: { name: 'walnut.json', error: 'larger than 64 KB' } })
    expect((await core.handle('workspace.scriptsFile', { dir: 'relative' })).ok).toBe(false)
    expect(await core.handle('workspace.scriptsFile', { dir: path.join(ROOT, 'missing') })).toMatchObject({ ok: false, code: 'bad_anchor' })
  })

  it('names the repository (the same for the checkout and its worktrees) and reads a committed version with ref', async () => {
    const repo = path.join(ROOT, 'repos', 'scripted')
    const inWs = await core.handle('workspace.scriptsFile', { dir: root }) as Record<string, any>
    const inRepo = await core.handle('workspace.scriptsFile', { dir: repo }) as Record<string, any>
    expect(inWs.repo).toBeTruthy()
    expect(inWs.repo).toBe(inRepo.repo)
    // An edit not committed: the working copy shows it, the committed version does not.
    fs.writeFileSync(path.join(repo, 'walnut.json'), JSON.stringify({ scripts: [{ name: 'Install', command: 'echo edited', setup: true }] }))
    try {
      expect((await core.handle('workspace.scriptsFile', { dir: repo }) as Record<string, any>).file.content).toContain('echo edited')
      const committed = await core.handle('workspace.scriptsFile', { dir: repo, ref: 'HEAD' }) as Record<string, any>
      expect(committed.file).toMatchObject({ name: 'walnut.json', ref: 'HEAD' })
      expect(committed.file.content).toContain('echo hi')
      expect((await core.handle('workspace.scriptsFile', { dir: makeRepo('nofile'), ref: 'HEAD' }) as Record<string, any>).file).toBeNull()
      expect((await core.handle('workspace.scriptsFile', { dir: repo, ref: '--output=/tmp/x' })).ok).toBe(false)
    } finally {
      sh(['checkout', '--', 'walnut.json'], repo)
    }
  })

  it('runs a line in the workspace with the WALNUT_ variables, and reports its exit, output and last line', async () => {
    const job = await runIt({
      command: 'printf "one\\n"; echo "two in $(pwd) for $WALNUT_TASK_ID"; echo oops >&2; test -z "$GIT_DIR" && echo clean-env',
      cwd: path.join(root, 'pkg'), env: { WALNUT_TASK_ID: 't1', NOT_WALNUT: 'x', WALNUT_BAD: 7 }, timeoutSec: 30,
    })
    expect(job).toMatchObject({ kind: 'script', state: 'done' })
    const r = job.result as Record<string, unknown>
    expect(r.exitCode).toBe(0)
    expect(String(r.output)).toContain(`two in ${path.join(root, 'pkg')} for t1`)
    expect(String(r.output)).toContain('oops')
    // The inherited GIT_DIR is dropped, as for git.
    expect(String(r.output)).toContain('clean-env')
    // Progress is the last line one of the two pipes delivered.
    expect(['clean-env', 'oops']).toContain(job.progress)
    const env = await runIt({ command: 'echo "[$NOT_WALNUT][$WALNUT_BAD]"', env: { NOT_WALNUT: 'x', WALNUT_BAD: 7 } })
    expect(String((env.result as Record<string, unknown>).output).trim()).toBe('[][]')
  })

  it('a failing line is a finished job with its exit code; the output tail is bounded and plain', async () => {
    const fail = await runIt({ command: 'echo nope; exit 3' })
    expect(fail.state).toBe('done')
    expect((fail.result as Record<string, unknown>).exitCode).toBe(3)
    const loud = await runIt({ command: 'i=0; while [ $i -lt 3000 ]; do printf "\\033[32mline %s\\033[0m\\n" $i; i=$((i+1)); done' })
    const out = String((loud.result as Record<string, unknown>).output)
    expect(out.length).toBeLessThanOrEqual(8192)
    expect(out).not.toContain('\u001b')
    expect(out.trim().endsWith('line 2999')).toBe(true)
  })

  it('a deadline kills the whole process group', async () => {
    const pidFile = path.join(ROOT, 'child.pid')
    const t0 = Date.now()
    const job = await runIt({ command: `sleep 30 & echo $! > ${pidFile}; wait`, timeoutSec: 1 }, 15_000)
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(job.result).toMatchObject({ timedOut: true })
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(child).toBeGreaterThan(1)
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(child, 0); await new Promise((r) => setTimeout(r, 100)) } catch { alive = false }
    }
    expect(alive).toBe(false)
  })

  async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)) } catch { return true }
    }
    return false
  }

  it('a deadline kills a child that ignores TERM too, after its shell left', async () => {
    const pidFile = path.join(ROOT, 'stubborn.pid')
    // The shell exits on TERM; its child traps TERM and lives on until the SIGKILL.
    const job = await runIt({ command: `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & wait`, timeoutSec: 1 }, 20_000)
    expect(job.result).toMatchObject({ timedOut: true })
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(child).toBeGreaterThan(1)
    expect(await gone(child)).toBe(true)
  })

  it('a run that asks for it (a teardown) ends what it left running', async () => {
    const pidFile = path.join(ROOT, 'left.pid')
    const job = await runIt({ command: `sleep 30 & echo $! > ${pidFile}; echo done`, endGroup: true }, 15_000)
    expect(job.state).toBe('done')
    expect(await gone(Number(fs.readFileSync(pidFile, 'utf8').trim()))).toBe(true)
  })

  it('a background process holding the pipes does not pin the run', async () => {
    const t0 = Date.now()
    const job = await runIt({ command: 'sleep 20 & echo started' }, 15_000)
    expect(job.state).toBe('done')
    expect(Date.now() - t0).toBeLessThan(8_000)
  })

  it('runs only inside a workspace root, never in the repository or elsewhere', async () => {
    const repo = path.join(ROOT, 'repos', 'scripted')
    // A folder that exists but is outside every place a workspace may live.
    const outside = path.join(ROOT, 'outside-ws')
    fs.mkdirSync(outside, { recursive: true })
    for (const bad of [repo, outside, path.join(ROOT, 'home'), path.join(ROOT, 'home', '.open-walnut-worktrees'), '/usr', path.join(ROOT, 'home', '.open-walnut-worktrees', 'nope')]) {
      const r = await core.handle('workspace.runScript', { provider: 'git-worktree', jobId: jid(), root: bad, command: 'touch /tmp/should-not-exist' })
      expect(r.ok, bad).toBe(false)
    }
    expect((await core.handle('workspace.runScript', { provider: 'git-worktree', jobId: jid(), root, command: '  ' })).ok).toBe(false)
    expect((await core.handle('workspace.runScript', { provider: 'git-worktree', root, command: 'x' })).ok).toBe(false)
    // A cwd outside the root falls back to the root.
    const job = await runIt({ command: 'pwd', cwd: repo })
    expect(String((job.result as Record<string, unknown>).output).trim()).toBe(root)
  })

  it('one script at a time per workspace', async () => {
    const a = jid()
    expect((await core.handle('workspace.runScript', { provider: 'git-worktree', jobId: a, root, command: 'sleep 1' })).ok).toBe(true)
    const b = await core.handle('workspace.runScript', { provider: 'git-worktree', jobId: jid(), root, command: 'true' })
    expect(b).toMatchObject({ ok: false, code: 'busy' })
    // Nor is the workspace removed while it runs.
    const rm = await core.handle('workspace.remove', { provider: 'git-worktree', jobId: jid(), root, deleteBranch: 'never' })
    expect(rm).toMatchObject({ ok: false, code: 'busy' })
    await waitJob(core, a)
  })

  it('a removal running in a workspace holds a script there', async () => {
    const repo = makeRepo('removing')
    const made = await createGit(core, repo, 'removing')
    const wsRoot = String((made.result as Record<string, unknown>).root)
    const rmJob = jid()
    expect((await core.handle('workspace.remove', { provider: 'git-worktree', jobId: rmJob, root: wsRoot, deleteBranch: 'never' })).ok).toBe(true)
    const s = await core.handle('workspace.runScript', { provider: 'git-worktree', jobId: jid(), root: wsRoot, command: 'true' })
    expect(s).toMatchObject({ ok: false, code: 'busy' })
    await waitJob(core, rmJob)
  })
})
