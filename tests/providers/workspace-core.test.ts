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
