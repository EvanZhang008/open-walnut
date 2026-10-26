/**
 * Task directories on a host (src/providers/task-dir-core.ts, src/lib/task-dir.ts):
 * where they live, how they are made, and the removal rule, against real git
 * repos. The rule is fail-safe: anything that exists only in the directory
 * keeps it.
 *
 * MACHINE SAFETY: every path is inside a fresh temp dir; git runs with a clean
 * env and a temp HOME (no user config, no hooks), and only on repos made here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ensureTaskDir, listTaskDirs, removeTaskDirs, unmergedWork, taskDirRoot, taskDirPath, isTaskDirId, TASK_DIR_MARKER,
} from '../../src/providers/task-dir-core.js'

let tmp = ''
let root = ''
const gitEnv = () => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(tmp, 'home'), GIT_CONFIG_NOSYSTEM: '1' }
  return env
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv(), encoding: 'utf8' })

/** A bare "remote" and a clone of it, inside the task dir, with one pushed commit. */
function cloneInto(taskDir: string, name = 'app'): string {
  const bare = path.join(tmp, `remote-${name}.git`)
  fs.mkdirSync(bare, { recursive: true })
  git(bare, 'init', '--bare', '-q')
  const seed = path.join(tmp, `seed-${name}`)
  fs.mkdirSync(seed)
  git(seed, 'init', '-q')
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'seed')
  git(seed, 'push', '-q', bare, 'HEAD:main')
  const work = path.join(taskDir, name)
  git(taskDir, 'clone', '-q', bare, work)
  return work
}

// The fixture remotes live in the OS temp dir, which the real rule distrusts;
// these tests trust it unless one says otherwise (that rule has its own tests).
const prevVolatile = process.env.WALNUT_TASK_DIR_VOLATILE
beforeAll(() => { process.env.WALNUT_TASK_DIR_VOLATILE = '' })
afterAll(() => { if (prevVolatile === undefined) delete process.env.WALNUT_TASK_DIR_VOLATILE; else process.env.WALNUT_TASK_DIR_VOLATILE = prevVolatile })

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-dir-')))
  fs.mkdirSync(path.join(tmp, 'home'))
  root = path.join(tmp, 'state', 'open-walnut', 'tasks')
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('where task directories live', () => {
  it('defaults under ~/.local/state, honours XDG_STATE_HOME and WALNUT_TASK_DIR_ROOT, never a relative path', () => {
    expect(taskDirRoot({}, '/home/u')).toBe('/home/u/.local/state/open-walnut/tasks')
    expect(taskDirRoot({ XDG_STATE_HOME: '/xdg' }, '/home/u')).toBe('/xdg/open-walnut/tasks')
    expect(taskDirRoot({ XDG_STATE_HOME: 'rel' }, '/home/u')).toBe('/home/u/.local/state/open-walnut/tasks')
    expect(taskDirRoot({ WALNUT_TASK_DIR_ROOT: '/r/', XDG_STATE_HOME: '/xdg' }, '/home/u')).toBe('/r')
    expect(taskDirRoot({ WALNUT_TASK_DIR_ROOT: 'r' }, '/home/u')).toBe('/home/u/.local/state/open-walnut/tasks')
  })

  it('only a task id becomes a path', () => {
    for (const ok of ['7f35f6b1-2a97-5e2f-a421-6070a1541765', 'mvm0n3bu-6910', 'a.b_c']) expect(isTaskDirId(ok)).toBe(true)
    for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(200), 7, null]) expect(isTaskDirId(bad)).toBe(false)
    expect(taskDirPath('/r', '../etc')).toBeNull()
  })
})

describe('ensureTaskDir', () => {
  it('makes a private directory with a marker, and keeps createdAt on reuse', () => {
    const dir = ensureTaskDir(root, 'task-1', '/data/home', new Date('2026-10-01T00:00:00Z'))!
    expect(dir).toBe(path.join(root, 'task-1'))
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const m1 = JSON.parse(fs.readFileSync(path.join(dir, TASK_DIR_MARKER), 'utf8'))
    expect(m1).toMatchObject({ taskId: 'task-1', home: '/data/home', createdAt: '2026-10-01T00:00:00.000Z' })
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
    ensureTaskDir(root, 'task-1', undefined, new Date('2026-10-02T00:00:00Z'))
    const m2 = JSON.parse(fs.readFileSync(path.join(dir, TASK_DIR_MARKER), 'utf8'))
    expect(m2).toMatchObject({ home: '/data/home', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: '2026-10-02T00:00:00.000Z' })
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('refuses a bad id and survives an unwritable root', () => {
    expect(ensureTaskDir(root, '../x')).toBeNull()
    fs.mkdirSync(path.dirname(root), { recursive: true })
    fs.writeFileSync(root, 'a file where the root should be')
    expect(ensureTaskDir(root, 'task-1')).toBeNull()
  })
})

describe('listTaskDirs', () => {
  it('lists only directories carrying their own marker', async () => {
    ensureTaskDir(root, 'a')
    ensureTaskDir(root, 'b', '/h')
    fs.mkdirSync(path.join(root, 'foreign'))
    fs.mkdirSync(path.join(root, 'wrong'))
    fs.writeFileSync(path.join(root, 'wrong', TASK_DIR_MARKER), JSON.stringify({ taskId: 'other' }))
    const ids = (await listTaskDirs(root)).map((d) => d.taskId).sort()
    expect(ids).toEqual(['a', 'b'])
    expect((await listTaskDirs(path.join(tmp, 'missing')))).toEqual([])
  })
})

describe('removeTaskDirs: nothing that exists only here is ever deleted', () => {
  it('removes a directory whose clone is fully pushed, plus plain evidence files', async () => {
    const dir = ensureTaskDir(root, 'done')!
    cloneInto(dir)
    fs.mkdirSync(path.join(dir, 'evidence'))
    fs.writeFileSync(path.join(dir, 'evidence', 'report.md'), 'ok')
    const res = await removeTaskDirs(root, ['done'])
    expect(res.removed).toEqual(['done'])
    expect(fs.existsSync(dir)).toBe(false)
  })

  it.each([
    ['an unpushed commit', (w: string) => { fs.writeFileSync(path.join(w, 'b.txt'), 'b'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'local') }, /commits not on any remote/],
    ['an uncommitted change', (w: string) => { fs.writeFileSync(path.join(w, 'a.txt'), 'changed') }, /uncommitted or untracked/],
    ['an untracked file', (w: string) => { fs.writeFileSync(path.join(w, 'new.txt'), 'n') }, /uncommitted or untracked/],
    ['a stash', (w: string) => { fs.writeFileSync(path.join(w, 'a.txt'), 'z'); git(w, 'stash', '-q') }, /a stash/],
    ['a commit on a detached HEAD', (w: string) => { git(w, 'checkout', '-q', '--detach'); fs.writeFileSync(path.join(w, 'd.txt'), 'd'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'detached') }, /commits not on any remote/],
    ['a local branch with work', (w: string) => { git(w, 'checkout', '-qb', 'feature'); fs.writeFileSync(path.join(w, 'f.txt'), 'f'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'f'); git(w, 'checkout', '-q', 'main') }, /commits not on any remote/],
  ])('keeps a directory with %s', async (_label, mutate, reason) => {
    const dir = ensureTaskDir(root, 'work')!
    const w = cloneInto(dir)
    mutate(w)
    const res = await removeTaskDirs(root, ['work'])
    expect(res.removed).toEqual([])
    expect(res.kept[0].reasons.join('; ')).toMatch(reason)
    expect(fs.existsSync(w)).toBe(true)
  })

  it('keeps a repo with no remote that has commits, and finds repos nested a few levels down', async () => {
    const dir = ensureTaskDir(root, 'nested')!
    const deep = path.join(dir, 'build', 'x', 'scratch')
    fs.mkdirSync(deep, { recursive: true })
    git(deep, 'init', '-q')
    fs.writeFileSync(path.join(deep, 'f'), 'f')
    git(deep, 'add', '.')
    git(deep, 'commit', '-qm', 'only here')
    expect(await unmergedWork(dir)).toEqual(['build/x/scratch: commits not on any remote'])
    expect((await removeTaskDirs(root, ['nested'])).kept).toHaveLength(1)
  })

  it('a worktree of a repo kept elsewhere goes (its branch lives on there) and that repo forgets it', async () => {
    const dir = ensureTaskDir(root, 'wt')!
    const main = cloneInto(path.join(tmp), 'durable')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', path.join(dir, 'wt'))
    fs.writeFileSync(path.join(dir, 'wt', 'f.txt'), 'f')
    git(path.join(dir, 'wt'), 'add', '.')
    git(path.join(dir, 'wt'), 'commit', '-qm', 'feature work')
    expect((await removeTaskDirs(root, ['wt'])).removed).toEqual(['wt'])
    expect(git(main, 'log', '-1', '--format=%s', 'feature').trim()).toBe('feature work')
    expect(git(main, 'worktree', 'list')).not.toContain(path.join(dir, 'wt'))
  })

  it('a worktree whose detached HEAD has its own commits stays', async () => {
    const dir = ensureTaskDir(root, 'wtd')!
    const main = cloneInto(path.join(tmp), 'durable2')
    git(main, 'worktree', 'add', '-q', '--detach', path.join(dir, 'wt'))
    fs.writeFileSync(path.join(dir, 'wt', 'd.txt'), 'd')
    git(path.join(dir, 'wt'), 'add', '.')
    git(path.join(dir, 'wt'), 'commit', '-qm', 'detached only')
    expect((await removeTaskDirs(root, ['wtd'])).kept[0].reasons).toEqual(['wt: commits only on its detached HEAD'])
  })

  it('a bare repo with commits stays; a clone kept inside a clone is checked on its own', async () => {
    const dir = ensureTaskDir(root, 'bare')!
    const w = cloneInto(dir)
    git(dir, 'clone', '-q', '--bare', w, 'mirror.git')
    expect(await unmergedWork(dir)).toEqual(['mirror.git: a bare repo with commits'])
    const dir2 = ensureTaskDir(root, 'inner')!
    const outer = cloneInto(dir2, 'outer')
    fs.writeFileSync(path.join(outer, '.gitignore'), 'inner/\n')
    git(outer, 'add', '.gitignore'); git(outer, 'commit', '-qm', 'ignore'); git(outer, 'push', '-q', 'origin', 'HEAD:main'); git(outer, 'fetch', '-q')
    const inner = path.join(outer, 'inner')
    fs.mkdirSync(inner); git(inner, 'init', '-q'); fs.writeFileSync(path.join(inner, 'x'), 'x'); git(inner, 'add', '.'); git(inner, 'commit', '-qm', 'inner only')
    expect(await unmergedWork(dir2)).toEqual(['outer/inner: commits not on any remote'])
  })

  it('keeps a directory a live session works in, and one whose git check fails', async () => {
    const dir = ensureTaskDir(root, 'busy')!
    expect((await removeTaskDirs(root, ['busy'], { busy: (d) => d === dir })).kept[0].reasons).toEqual(['a live session works in it'])
    cloneInto(dir)
    const failing = async () => { throw new Error('timed out') }
    const res = await removeTaskDirs(root, ['busy'], { git: failing })
    expect(res.removed).toEqual([])
    expect(res.kept[0].reasons[0]).toMatch(/could not check \(timed out\)/)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('never touches a directory without its marker, a bad id, or anything outside the root', async () => {
    fs.mkdirSync(path.join(root, 'nomarker'), { recursive: true })
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    const res = await removeTaskDirs(root, ['nomarker', '../outside', '..', 'absent'])
    expect(res.removed).toEqual([])
    expect(res.missing.sort()).toEqual(['absent', 'nomarker'])
    expect(fs.existsSync(path.join(root, 'nomarker'))).toBe(true)
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('removes a symlink inside the directory, never what it points at', async () => {
    const dir = ensureTaskDir(root, 'links')!
    const target = path.join(tmp, 'shared-node-modules')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'pkg.json'), '{}')
    fs.symlinkSync(target, path.join(dir, 'node_modules'))
    expect((await removeTaskDirs(root, ['links'])).removed).toEqual(['links'])
    expect(fs.readFileSync(path.join(target, 'pkg.json'), 'utf8')).toBe('{}')
  })

  it('a remote that is a local path counts only when it will outlive the directory', async () => {
    // A leader fetched a worker's task-dir clone: both look "pushed" to each other.
    const worker = ensureTaskDir(root, 'worker')!
    const leader = ensureTaskDir(root, 'leader')!
    const w = path.join(worker, 'app')
    fs.mkdirSync(w); git(w, 'init', '-q'); fs.writeFileSync(path.join(w, 'f'), 'f'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'worker only')
    git(leader, 'clone', '-q', w, 'app')
    expect(await unmergedWork(path.join(root, 'leader'), undefined, { root, volatile: [] })).toEqual(['app: commits not on any remote'])
    // A remote in a temp dir is gone after a reboot.
    const dir = ensureTaskDir(root, 'tmpremote')!
    cloneInto(dir)
    expect(await unmergedWork(dir, undefined, { root, volatile: [tmp] })).toEqual(['app: commits not on any remote'])
    expect(await unmergedWork(dir, undefined, { root, volatile: [] })).toEqual([])
    // A local remote that no longer exists proves nothing.
    fs.rmSync(path.join(tmp, 'remote-app.git'), { recursive: true, force: true })
    expect(await unmergedWork(dir, undefined, { root, volatile: [] })).toEqual(['app: commits not on any remote'])
  })

  it('an orphan branch with no commit yet does not hide unpushed work on another branch', async () => {
    const dir = ensureTaskDir(root, 'orphan')!
    const w = cloneInto(dir)
    git(w, 'checkout', '-qb', 'side'); fs.writeFileSync(path.join(w, 's'), 's'); git(w, 'add', '.'); git(w, 'commit', '-qm', 'side')
    git(w, 'checkout', '-q', '--orphan', 'fresh'); git(w, 'rm', '-rfq', '.')
    expect(await unmergedWork(dir)).toEqual(['app: commits not on any remote'])
  })

  it('a worktree of a repo in the directory that lives outside it keeps the directory', async () => {
    const dir = ensureTaskDir(root, 'wto')!
    const w = cloneInto(dir)
    git(w, 'worktree', 'add', '-q', '-b', 'out', path.join(tmp, 'outside-wt'))
    expect((await unmergedWork(dir))[0]).toMatch(/^app: a worktree of it lives outside/)
  })

  it('an untracked symlink (a shared node_modules) is not work', async () => {
    const dir = ensureTaskDir(root, 'nm')!
    const w = cloneInto(dir)
    fs.mkdirSync(path.join(tmp, 'shared-nm'))
    fs.symlinkSync(path.join(tmp, 'shared-nm'), path.join(w, 'node_modules'))
    expect(await unmergedWork(dir)).toEqual([])
    fs.writeFileSync(path.join(w, 'real-untracked.txt'), 'x')
    expect(await unmergedWork(dir)).toEqual(['app: uncommitted or untracked files'])
  })

  it('keeps a directory used again after the server looked, and one whose task has a live session', async () => {
    const dir = ensureTaskDir(root, 'again', undefined, new Date('2026-10-01T00:00:00Z'))!
    const seen = Date.parse('2026-10-01T00:00:00Z')
    ensureTaskDir(root, 'again', undefined, new Date('2026-10-02T00:00:00Z'))
    expect((await removeTaskDirs(root, [{ taskId: 'again', usedBefore: seen }])).kept[0].reasons).toEqual(['used again since the sweep looked'])
    expect((await removeTaskDirs(root, [{ taskId: 'again', usedBefore: Date.parse('2026-10-02T00:00:00Z') }], { busy: (_d, id) => id === 'again' })).kept[0].reasons).toEqual(['a live session works in it'])
    expect((await removeTaskDirs(root, [{ taskId: 'again', usedBefore: Date.parse('2026-10-02T00:00:00Z') }])).removed).toEqual(['again'])
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('the first owner stays the owner', () => {
    ensureTaskDir(root, 'own', '/first/home')
    const dir = ensureTaskDir(root, 'own', '/later/home')!
    expect(JSON.parse(fs.readFileSync(path.join(dir, TASK_DIR_MARKER), 'utf8')).home).toBe('/first/home')
  })

  it('refuses a root too close to /', async () => {
    expect(await removeTaskDirs('/', ['x'])).toEqual({ removed: [], kept: [], missing: [] })
  })
})
