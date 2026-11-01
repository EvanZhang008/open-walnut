/**
 * Pruning a finished task's directory (src/providers/task-dir-core.ts
 * pruneTaskDirs), against real git repos. 2026-10-31: task directories held
 * 27 GB, most of it clean clones and node_modules of tasks already done, and
 * the Mac fell under 25 GB free. The prune takes what can be rebuilt or fetched
 * again and keeps everything that exists only here.
 *
 * MACHINE SAFETY: every path is inside a fresh temp dir; git runs with a clean
 * env and a temp HOME (no user config, no hooks), and only on repos made here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureTaskDir, listTaskDirs, pruneTaskDirs } from '../../src/providers/task-dir-core.js'

let tmp = ''
let root = ''
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(tmp, 'home'), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
const write = (p: string, text = 'x\n') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }

/** A bare "remote" with one commit (and the files given), cloned into the directory. */
function cloneInto(dir: string, name: string, files: Record<string, string> = {}): string {
  const bare = path.join(tmp, `remote-${name}.git`)
  fs.mkdirSync(bare, { recursive: true })
  git(bare, 'init', '--bare', '-q')
  const seed = path.join(tmp, `seed-${name}`)
  fs.mkdirSync(seed)
  git(seed, 'init', '-q')
  write(path.join(seed, 'a.txt'), 'a\n')
  for (const [rel, text] of Object.entries(files)) write(path.join(seed, rel), text)
  git(seed, 'add', '-f', '.')
  git(seed, 'commit', '-qm', 'seed')
  git(seed, 'push', '-q', bare, 'HEAD:main')
  const work = path.join(dir, name)
  git(dir, 'clone', '-q', bare, work)
  return work
}

const prevVolatile = process.env.WALNUT_TASK_DIR_VOLATILE
beforeAll(() => { process.env.WALNUT_TASK_DIR_VOLATILE = '' })
afterAll(() => { if (prevVolatile === undefined) delete process.env.WALNUT_TASK_DIR_VOLATILE; else process.env.WALNUT_TASK_DIR_VOLATILE = prevVolatile })
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-dir-prune-')))
  fs.mkdirSync(path.join(tmp, 'home'))
  root = path.join(tmp, 'state', 'open-walnut', 'tasks')
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// Each case runs a dozen real git commands; a busy machine stretches them (load 150: 13 s for one fixture).
describe('pruneTaskDirs', { timeout: 180_000 }, () => {
  it('removes clean pushed clones and untracked build output; keeps work, evidence and tracked files', async () => {
    const dir = ensureTaskDir(root, 'done', '/data/home', new Date('2026-10-20T00:00:00Z'))!
    cloneInto(dir, 'clean')
    // A clone with an uncommitted change, its own node_modules, an ignored dist and a tracked build/.
    const wip = cloneInto(dir, 'wip', { '.gitignore': 'dist/\nplaywright-report/\n', 'test-results/keep.txt': 'tracked\n' })
    write(path.join(wip, 'a.txt'), 'changed\n')
    write(path.join(wip, 'node_modules', 'pkg', 'index.js'))
    write(path.join(wip, 'dist', 'bundle.js'))
    write(path.join(wip, 'web', 'node_modules', 'x', 'y.js'))
    // A clone with a commit nobody else has.
    const ahead = cloneInto(dir, 'ahead')
    write(path.join(ahead, 'b.txt'))
    git(ahead, 'add', '.')
    git(ahead, 'commit', '-qm', 'only here')
    // A clone whose dist is tracked: not build output.
    cloneInto(dir, 'shipped', { 'dist/app.js': 'shipped\n' })
    fs.rmSync(path.join(dir, 'shipped', '.git'), { recursive: true }) // left as plain files, outside any repo
    // Outside any repo: node_modules goes, a dist (maybe a download kept as evidence) stays.
    write(path.join(dir, 'node_modules', 'tool', 'bin.js'))
    write(path.join(dir, 'evidence', 'dist', 'release.tgz'))
    // Test reports: regenerable when the repo ignores them, evidence otherwise.
    write(path.join(wip, 'playwright-report', 'index.html'))
    write(path.join(ahead, 'test-results', 'run.json'))
    write(path.join(dir, 'evidence', 'webkit', 'test-results', 'trace.zip'))
    write(path.join(dir, 'report.md'), '# all green\n')
    const mtimeBefore = fs.statSync(dir).mtimeMs

    const res = await pruneTaskDirs(root, ['done'], { now: new Date('2026-10-22T00:00:00Z') })
    expect(res.kept).toEqual([])
    expect(res.pruned).toHaveLength(1)
    expect(res.pruned[0].repos).toEqual(['clean'])
    expect(res.pruned[0].builds.sort()).toEqual(['node_modules', 'wip/dist', 'wip/node_modules', 'wip/playwright-report', 'wip/web/node_modules'])

    expect(fs.existsSync(path.join(dir, 'clean'))).toBe(false)
    expect(fs.readFileSync(path.join(wip, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(fs.readFileSync(path.join(wip, 'test-results', 'keep.txt'), 'utf8')).toBe('tracked\n')
    expect(git(ahead, 'log', '-1', '--format=%s').trim()).toBe('only here')
    expect(fs.existsSync(path.join(dir, 'shipped', 'dist', 'app.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'evidence', 'dist', 'release.tgz'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'evidence', 'webkit', 'test-results', 'trace.zip'))).toBe(true)
    expect(fs.existsSync(path.join(ahead, 'test-results', 'run.json'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf8')).toBe('# all green\n')
    // A prune is not a use: the mtime is put back, and the marker says when it ran.
    expect(Math.floor(fs.statSync(dir).mtimeMs)).toBe(Math.floor(mtimeBefore))
    const [entry] = await listTaskDirs(root)
    expect(entry).toMatchObject({ taskId: 'done', lastUsedAt: '2026-10-20T00:00:00.000Z', prunedAt: '2026-10-22T00:00:00.000Z' })
  })

  it('keeps a clone that another clone under the root borrows objects from', async () => {
    const a = ensureTaskDir(root, 'done-a')!
    const b = ensureTaskDir(root, 'busy-b')!
    const source = cloneInto(a, 'source')
    git(b, 'clone', '-q', '--shared', source, 'borrower')
    const res = await pruneTaskDirs(root, ['done-a'])
    expect(res.pruned[0].repos).toEqual([])
    expect(fs.existsSync(source)).toBe(true)
    expect(git(path.join(b, 'borrower'), 'log', '-1', '--format=%s').trim()).toBe('seed')
  })

  it('keeps a clean clone holding an ignored file that is not build output; one with only ignored build output goes', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const secret = cloneInto(dir, 'with-env', { '.gitignore': '.env\ndist/\n' })
    write(path.join(secret, '.env'), 'TOKEN=local\n')
    const built = cloneInto(dir, 'with-dist', { '.gitignore': '.env\ndist/\n.DS_Store\n' })
    write(path.join(built, 'dist', 'app.js'))
    write(path.join(built, '.DS_Store'))
    const res = await pruneTaskDirs(root, ['done'])
    expect(res.pruned[0].repos).toEqual(['with-dist'])
    expect(fs.readFileSync(path.join(secret, '.env'), 'utf8')).toBe('TOKEN=local\n')
  })

  it('finds a borrower nested deep, or under a working folder named objects', async () => {
    const a = ensureTaskDir(root, 'done-a')!
    const b = ensureTaskDir(root, 'busy-b')!
    const deepSource = cloneInto(a, 'deep-src')
    const objSource = cloneInto(a, 'obj-src')
    const deep = path.join(b, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i')
    fs.mkdirSync(deep, { recursive: true })
    git(deep, 'clone', '-q', '--shared', deepSource, 'borrower')
    fs.mkdirSync(path.join(b, 'objects'))
    git(path.join(b, 'objects'), 'clone', '-q', '--shared', objSource, 'borrower')
    const res = await pruneTaskDirs(root, ['done-a'])
    expect(res.pruned[0].repos).toEqual([])
    expect(git(path.join(deep, 'borrower'), 'log', '-1', '--format=%s').trim()).toBe('seed')
    expect(git(path.join(b, 'objects', 'borrower'), 'log', '-1', '--format=%s').trim()).toBe('seed')
  })

  it('prunes no build output when the repo walk could not see every repo', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const deep = path.join(dir, 'a', 'b', 'c', 'd', 'e', 'f', 'g')
    fs.mkdirSync(deep, { recursive: true })
    git(deep, 'init', '-q')
    write(path.join(deep, 'node_modules', 'x', 'i.js'), 'tracked\n')
    git(deep, 'add', '-f', '.')
    git(deep, 'commit', '-qm', 'vendored deps')
    write(path.join(deep, 'node_modules', 'x', 'i.js'), 'edited\n')
    const res = await pruneTaskDirs(root, ['done'])
    expect(res.pruned[0].builds).toEqual([])
    expect(fs.readFileSync(path.join(deep, 'node_modules', 'x', 'i.js'), 'utf8')).toBe('edited\n')
  })

  it('touches nothing in a directory a live session works in, or one used since the server looked', async () => {
    const dir = ensureTaskDir(root, 'live', undefined, new Date('2026-10-25T00:00:00Z'))!
    cloneInto(dir, 'clean')
    write(path.join(dir, 'node_modules', 'x.js'))
    const busy = await pruneTaskDirs(root, ['live'], { busy: (_d, id) => id === 'live' })
    expect(busy.kept).toEqual([{ taskId: 'live', reasons: ['a live session works in it'] }])
    const usedSince = await pruneTaskDirs(root, [{ taskId: 'live', usedBefore: Date.parse('2026-10-24T00:00:00Z') }])
    expect(usedSince.pruned).toEqual([])
    expect(fs.existsSync(path.join(dir, 'clean'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'node_modules', 'x.js'))).toBe(true)
  })

  it('removes a symlinked node_modules never, and never follows it', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const shared = path.join(tmp, 'shared-node_modules')
    write(path.join(shared, 'dep', 'index.js'))
    const wip = cloneInto(dir, 'wip')
    write(path.join(wip, 'a.txt'), 'changed\n')
    fs.symlinkSync(shared, path.join(wip, 'node_modules'))
    const res = await pruneTaskDirs(root, ['done'])
    expect(res.pruned[0].builds).toEqual([])
    expect(fs.existsSync(path.join(shared, 'dep', 'index.js'))).toBe(true)
  })

  it('never touches the directory itself when it is a repo, an unmarked directory, a bad id, or a root too close to /', async () => {
    const dir = ensureTaskDir(root, 'self')!
    git(dir, 'init', '-q')
    write(path.join(dir, 'node_modules', 'x.js'))
    const res = await pruneTaskDirs(root, ['self', 'nomarker', '../etc'])
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
    expect(res.pruned.map((p) => p.repos)).toEqual([[]])
    expect(res.missing).toEqual(['nomarker'])
    expect(await pruneTaskDirs('/tmp', ['self'])).toEqual({ pruned: [], kept: [], missing: [] })
  })
})
