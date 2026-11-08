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
import { ensureTaskDir, listTaskDirs, pruneTaskBuilds, pruneTaskDirs, readOpenPaths, removeTaskDirs, taskDirInUse } from '../../src/providers/task-dir-core.js'
import { spawn } from 'node:child_process'

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

  it('keeps build output a repo deeper than the repo walk reaches tracks, and prunes an untracked one there', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const deep = path.join(dir, 'a', 'b', 'c', 'd', 'e', 'f', 'g')
    fs.mkdirSync(deep, { recursive: true })
    git(deep, 'init', '-q')
    write(path.join(deep, 'node_modules', 'x', 'i.js'), 'tracked\n')
    git(deep, 'add', '-f', '.')
    git(deep, 'commit', '-qm', 'vendored deps')
    write(path.join(deep, 'node_modules', 'x', 'i.js'), 'edited\n')
    write(path.join(deep, 'web', 'node_modules', 'y', 'i.js'))
    const res = await pruneTaskDirs(root, ['done'])
    expect(res.pruned[0].builds).toEqual(['a/b/c/d/e/f/g/web/node_modules'])
    expect(fs.readFileSync(path.join(deep, 'node_modules', 'x', 'i.js'), 'utf8')).toBe('edited\n')
  })

  // 2026-11-08: a copied source tree (no .git) deeper than the repo walk made every large
  // directory on the Mac read as "could not see everything", so none lost any build output.
  it('a deep tree with no repo beside the build output does not stop the pruning', async () => {
    const dir = ensureTaskDir(root, 'done')!
    fs.mkdirSync(path.join(dir, 'verify-v18', 'web', 'src', 'components', 'settings', 'sections', 'deeper', 'still'), { recursive: true })
    write(path.join(dir, 'verify-v18', 'node_modules', 'pkg', 'i.js'))
    write(path.join(dir, 'verify-v18', 'web', 'src', 'App.tsx'), 'source\n')
    write(path.join(dir, 'verify-v18', 'package.json'), '{}\n')
    write(path.join(dir, 'verify-v18', 'dist', 'cli.js')) // maybe the copy's only code (a package unpacked from npm): stays
    write(path.join(dir, 'download', 'dist', 'release.tgz')) // no package.json: maybe evidence
    const nested = path.join(dir, 'node-modules-repo', 'node_modules')
    fs.mkdirSync(nested, { recursive: true })
    git(nested, 'init', '-q') // a repo that happens to be named node_modules is never build output
    write(path.join(nested, 'own.txt'))
    const res = await pruneTaskBuilds(root, ['done'])
    expect(res.pruned[0].builds.sort()).toEqual(['verify-v18/node_modules'])
    expect(fs.existsSync(path.join(dir, 'verify-v18', 'dist', 'cli.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'download', 'dist', 'release.tgz'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'verify-v18', 'web', 'src', 'App.tsx'), 'utf8')).toBe('source\n')
    expect(fs.existsSync(path.join(nested, 'own.txt'))).toBe(true)
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

/** An Xcode derived data folder as `xcodebuild -derivedDataPath <dir>` leaves it. */
function derivedData(dir: string) {
  write(path.join(dir, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app', 'App'))
  write(path.join(dir, 'ModuleCache.noindex', 'Session.modulevalidation'))
  write(path.join(dir, 'Logs', 'Build', 'LogStoreManifest.plist'))
  write(path.join(dir, 'info.plist'))
}

/** The folder and everything in it, last changed long ago. */
const old = (p: string, t = new Date('2026-10-01T00:00:00Z')) => {
  if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) old(path.join(p, n), t)
  fs.utimesSync(p, t, t)
}

describe('pruneTaskBuilds (an idle task, open or not)', { timeout: 180_000 }, () => {
  it('takes only build output: clones, work, evidence and the marker\'s prunedAt stay', async () => {
    const dir = ensureTaskDir(root, 'open', '/data/home', new Date('2026-10-20T00:00:00Z'))!
    const clean = cloneInto(dir, 'clean', { '.gitignore': 'dist/\n' })
    write(path.join(clean, 'node_modules', 'pkg', 'index.js'))
    write(path.join(clean, 'dist', 'cli.js'))
    const wip = cloneInto(dir, 'wip')
    write(path.join(wip, 'a.txt'), 'changed\n')
    write(path.join(wip, 'web', 'node_modules', 'x', 'y.js'))
    derivedData(path.join(dir, 'ios-final-derived-data'))
    derivedData(path.join(wip, 'dd-queue')) // untracked inside a repo
    write(path.join(dir, 'evidence', 'shot.png'))
    write(path.join(dir, 'home', 'notes', 'n.md'))
    for (const b of [path.join(clean, 'node_modules'), path.join(clean, 'dist'), path.join(wip, 'web', 'node_modules'), ...['Build', 'ModuleCache.noindex'].flatMap((n) => [path.join(dir, 'ios-final-derived-data', n), path.join(wip, 'dd-queue', n)])]) old(b)
    for (const p of [clean, path.join(wip, 'web'), path.join(dir, 'ios-final-derived-data'), path.join(wip, 'dd-queue')]) old(p)

    const res = await pruneTaskBuilds(root, ['open'], { now: new Date('2026-10-23T00:00:00Z'), idleBefore: Date.parse('2026-10-21T00:00:00Z') })
    expect(res.kept).toEqual([])
    expect(res.pruned[0].repos).toEqual([])
    expect(res.pruned[0].builds.sort()).toEqual(['clean/dist', 'clean/node_modules', 'ios-final-derived-data/Build', 'ios-final-derived-data/ModuleCache.noindex', 'wip/dd-queue/Build', 'wip/dd-queue/ModuleCache.noindex', 'wip/web/node_modules'])
    // Xcode's own logs and anything kept beside the build stay: only what Xcode rebuilds goes.
    expect(fs.existsSync(path.join(dir, 'ios-final-derived-data', 'Logs', 'Build', 'LogStoreManifest.plist'))).toBe(true)
    expect(git(clean, 'log', '-1', '--format=%s').trim()).toBe('seed')
    expect(fs.readFileSync(path.join(wip, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(fs.existsSync(path.join(dir, 'evidence', 'shot.png'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'home', 'notes', 'n.md'))).toBe(true)
    const [entry] = await listTaskDirs(root)
    expect(entry.buildsPrunedAt).toBe('2026-10-23T00:00:00.000Z')
    expect(entry.prunedAt).toBeUndefined()
  })

  it('keeps a build folder written after idleBefore, a tracked derived-data-shaped folder, and anything a live session works in', async () => {
    const dir = ensureTaskDir(root, 'open')!
    const repo = cloneInto(dir, 'repo', { 'fixtures/dd/Build/x.txt': 'tracked\n', 'fixtures/dd/ModuleCache.noindex/y.txt': 'tracked\n' })
    write(path.join(repo, 'node_modules', 'fresh', 'index.js')) // mtime now
    old(path.join(repo, 'fixtures', 'dd'))
    const res = await pruneTaskBuilds(root, ['open'], { idleBefore: Date.now() - 3_600_000 })
    expect(res.pruned[0].builds).toEqual([])
    expect(fs.existsSync(path.join(repo, 'node_modules', 'fresh', 'index.js'))).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'fixtures', 'dd', 'Build', 'x.txt'), 'utf8')).toBe('tracked\n')

    old(path.join(repo, 'node_modules'))
    const busy = await pruneTaskBuilds(root, ['open'], { busy: () => true, idleBefore: Date.now() })
    expect(busy.kept).toEqual([{ taskId: 'open', reasons: ['a live session works in it'] }])
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(true)
  })

  it('a derived data folder with tens of thousands of folders does not make the walk give up', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const dd = path.join(dir, 'local-runs', 'DerivedData-queue')
    derivedData(dd)
    for (let i = 0; i < 260; i++) for (let j = 0; j < 100; j++) fs.mkdirSync(path.join(dd, 'Build', 'Intermediates.noindex', `t${i}`, `o${j}`), { recursive: true })
    write(path.join(dir, 'node_modules', 'x.js'))
    const res = await pruneTaskDirs(root, ['done'])
    expect(res.pruned[0].builds.sort()).toEqual(['local-runs/DerivedData-queue/Build', 'local-runs/DerivedData-queue/ModuleCache.noindex', 'node_modules'])
    expect(fs.existsSync(path.join(dd, 'Build'))).toBe(false)
  })

  // The review of 2026-11-08 (each case deleted unique work in the first draft of this change).
  it('never removes a build folder that holds a repo, or is a bare one', async () => {
    const dir = ensureTaskDir(root, 'open')!
    const capture = path.join(dir, 'capture')
    derivedData(capture)
    const custom = path.join(capture, 'Build', 'custom')
    fs.mkdirSync(custom, { recursive: true })
    git(custom, 'init', '-q')
    write(path.join(custom, 'only-here.swift'), 'unique\n')
    git(custom, 'add', '.')
    git(custom, 'commit', '-qm', 'only here')
    write(path.join(capture, 'review.md'), '# notes\n')
    const bare = path.join(dir, 'DerivedData')
    fs.mkdirSync(bare)
    git(bare, 'init', '--bare', '-q')
    write(path.join(dir, 'node_modules', 'dep', '.git', 'HEAD'), 'ref: refs/heads/main\n') // a git checkout of a dependency
    const res = await pruneTaskBuilds(root, ['open'])
    expect(res.pruned[0].builds).toEqual(['capture/ModuleCache.noindex'])
    expect(git(custom, 'log', '-1', '--format=%s').trim()).toBe('only here')
    expect(fs.readFileSync(path.join(capture, 'review.md'), 'utf8')).toBe('# notes\n')
    expect(fs.existsSync(path.join(bare, 'HEAD'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'node_modules', 'dep', '.git', 'HEAD'))).toBe(true)
  })

  it('a session that starts while the checks run keeps the folder', async () => {
    const dir = ensureTaskDir(root, 'open')!
    const repo = cloneInto(dir, 'repo')
    write(path.join(repo, 'node_modules', 'x.js'))
    let started = false
    const slowGit = async (cwd: string, args: string[]) => {
      if (args[0] === 'ls-files') started = true // the session starts during this await
      return git(cwd, ...args)
    }
    const res = await pruneTaskBuilds(root, ['open'], { git: slowGit, busy: () => started })
    expect(res.pruned[0].builds).toEqual([])
    expect(fs.existsSync(path.join(repo, 'node_modules', 'x.js'))).toBe(true)
    const [entry] = await listTaskDirs(root)
    expect(entry.buildsPrunedAt).toBeUndefined()
  })

  it('output left for being too new is not stamped done, so a later round takes it', async () => {
    const dir = ensureTaskDir(root, 'open')!
    write(path.join(dir, 'node_modules', 'x.js')) // written now
    const first = await pruneTaskBuilds(root, ['open'], { idleBefore: Date.now() - 3_600_000 })
    expect(first.pruned[0].builds).toEqual([])
    expect((await listTaskDirs(root))[0].buildsPrunedAt).toBeUndefined()
    const later = await pruneTaskBuilds(root, ['open'], { idleBefore: Date.now() + 60_000 })
    expect(later.pruned[0].builds).toEqual(['node_modules'])
    expect((await listTaskDirs(root))[0].buildsPrunedAt).toEqual(expect.any(String))
  })

  it('the whole-directory removal still sees a repo inside build-named folders', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const editable = path.join(dir, '.build', 'editable')
    fs.mkdirSync(editable, { recursive: true })
    git(editable, 'init', '-q')
    write(path.join(editable, 'a.txt'))
    git(editable, 'add', '.')
    git(editable, 'commit', '-qm', 'unique')
    const dd = path.join(dir, 'dd')
    derivedData(dd)
    const inDd = path.join(dd, 'SourcePackages', 'mine')
    fs.mkdirSync(inDd, { recursive: true })
    git(inDd, 'init', '-q')
    write(path.join(inDd, 'b.txt'))
    const res = await removeTaskDirs(root, ['done'])
    expect(res.removed).toEqual([])
    expect(res.kept[0].reasons.join(' ')).toMatch(/\.build\/editable: commits not on any remote/)
    expect(res.kept[0].reasons.join(' ')).toMatch(/dd\/SourcePackages\/mine: uncommitted or untracked files/)
  })

  // Round 2 of the 2026-11-08 review: Xcode's default name holds its logs and other
  // projects' folders, so only Xcode's own rebuildable parts go.
  it('a folder named DerivedData keeps its logs: only each project\'s Build and caches go', async () => {
    const dir = ensureTaskDir(root, 'done')!
    const proj = path.join(dir, 'DerivedData', 'Walnut-abcdef')
    derivedData(proj)
    write(path.join(dir, 'DerivedData', 'notes.md'), 'kept\n')
    const res = await pruneTaskBuilds(root, ['done'])
    expect(res.pruned[0].builds.sort()).toEqual(['DerivedData/Walnut-abcdef/Build', 'DerivedData/Walnut-abcdef/ModuleCache.noindex'])
    expect(fs.existsSync(path.join(proj, 'Logs', 'Build', 'LogStoreManifest.plist'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'DerivedData', 'notes.md'), 'utf8')).toBe('kept\n')
  })

  it('a deep write inside a build folder keeps it', async () => {
    const dir = ensureTaskDir(root, 'open')!
    write(path.join(dir, 'node_modules', 'a', 'b', 'c', 'x.js'))
    old(path.join(dir, 'node_modules'))
    write(path.join(dir, 'node_modules', 'a', 'b', 'c', 'new.js')) // c's time is now, the rest is old
    const res = await pruneTaskBuilds(root, ['open'], { idleBefore: Date.now() - 3_600_000 })
    expect(res.pruned[0].builds).toEqual([])
    expect((await listTaskDirs(root))[0].buildsPrunedAt).toBeUndefined()
  })

  it('a file rewritten in place inside a build folder keeps it', async () => {
    const dir = ensureTaskDir(root, 'open')!
    const f = path.join(dir, 'copy', 'node_modules', 'a', 'b', 'c', 'existing.js')
    write(f)
    old(path.join(dir, 'copy'))
    fs.writeFileSync(f, 'rewritten\n') // the file's time moves, no folder's does
    const res = await pruneTaskBuilds(root, ['open'], { idleBefore: Date.now() - 3_600_000 })
    expect(res.pruned[0].builds).toEqual([])
    expect(fs.existsSync(f)).toBe(true)
  })

  it('build output deeper than the walk goes leaves the round unstamped', async () => {
    const dir = ensureTaskDir(root, 'open')!
    const deep = path.join(dir, ...Array.from({ length: 10 }, (_, i) => `level${i}`), 'node_modules')
    write(path.join(deep, 'x.js'))
    const res = await pruneTaskBuilds(root, ['open'])
    expect(res.pruned[0].builds).toEqual([])
    expect((await listTaskDirs(root))[0].buildsPrunedAt).toBeUndefined()
  })

  it('a check that could not finish leaves the round unstamped, so it is asked again', async () => {
    const dir = ensureTaskDir(root, 'open')!
    const repo = cloneInto(dir, 'repo')
    write(path.join(repo, 'node_modules', 'x.js'))
    const failingGit = async (_cwd: string, args: string[]) => { if (args[0] === 'ls-files') throw Object.assign(new Error('timed out'), { code: null }); return '' }
    const res = await pruneTaskBuilds(root, ['open'], { git: failingGit })
    expect(res.pruned[0].builds).toEqual([])
    expect((await listTaskDirs(root))[0].buildsPrunedAt).toBeUndefined()
    // A folder it cannot read: the same.
    const locked = path.join(dir, 'locked')
    write(path.join(locked, 'node_modules', 'y.js'))
    fs.chmodSync(locked, 0o000)
    try {
      if (process.getuid?.() !== 0) {
        const again = await pruneTaskBuilds(root, ['open'])
        expect(again.pruned[0].builds).toEqual(['repo/node_modules'])
        expect((await listTaskDirs(root))[0].buildsPrunedAt).toBeUndefined()
      }
    } finally { fs.chmodSync(locked, 0o755) }
  })

  // 2026-11-08: a cleanup pass took a running simulator check's Walnut.app. The task's
  // commands ran through host_exec, and the daemon counted only its sessions, by string.
  it('a task directory is in use for work of the task, or work in it reached through another path', () => {
    const dir = ensureTaskDir(root, 'live')!
    const alias = path.join(tmp, 'alias')
    fs.symlinkSync(root, alias)
    fs.mkdirSync(path.join(dir, 'verify'), { recursive: true })
    expect(taskDirInUse(dir, 'live', [{ task: 'live', cwd: '/elsewhere' }])).toBe(true) // a session or a host command of the task
    expect(taskDirInUse(dir, 'live', [{ cwd: path.join(alias, 'live', 'verify') }])).toBe(true) // another task's host command, via a link
    expect(taskDirInUse(dir, 'live', [{ cwd: dir + '-other' }, { task: 'other', cwd: '/elsewhere' }, { cwd: undefined }])).toBe(false)
  })

  // 2026-11-08: the Mac refilled from 30 to 12 GiB within hours, all of it in directories of
  // tasks still running, which the idle sweep never touches. A low disk takes their old build
  // output too, but never one a process has open, and never one touched in the last 6 hours.
  it('a low disk prunes a task in use: old build output nobody has open goes, the rest stays', async () => {
    const dir = ensureTaskDir(root, 'live')!
    for (const v of ['verify-v19', 'verify-v20', 'verify-v21']) {
      write(path.join(dir, v, 'package.json'), '{}\n')
      write(path.join(dir, v, 'src', 'index.ts'), 'source\n')
      write(path.join(dir, v, 'node_modules', 'x.js'))
      write(path.join(dir, v, 'dist', 'cli.js'))
    }
    derivedData(path.join(dir, 'ios-dd'))
    for (const v of ['verify-v19', 'verify-v20', 'verify-v21', 'ios-dd']) old(path.join(dir, v))
    write(path.join(dir, 'verify-v21', 'node_modules', 'new.js')) // touched now
    const busy = () => true
    // Without the live mode a directory in use is kept whole.
    expect((await pruneTaskBuilds(root, ['live'], { busy, idleBefore: Date.now() })).kept).toEqual([{ taskId: 'live', reasons: ['a live session works in it'] }])
    // v20's copy is some process's working directory; the app inside ios-dd is open (a running simulator).
    const openPaths = async () => [path.join(dir, 'verify-v20'), path.join(dir, 'ios-dd', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app', 'App')]
    const res = await pruneTaskBuilds(root, ['live'], { busy, idleBefore: Date.now(), openPaths })
    expect(res.kept).toEqual([])
    // v21 was written into just now, so its copy is someone's: its dist stays too.
    expect(res.pruned[0].builds.sort()).toEqual(['verify-v19/dist', 'verify-v19/node_modules'])
    expect(fs.existsSync(path.join(dir, 'verify-v21', 'dist', 'cli.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'verify-v19', 'src', 'index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'verify-v20', 'node_modules', 'x.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'ios-dd', 'Build'))).toBe(true)
    // A directory in use is never stamped done.
    expect((await listTaskDirs(root))[0].buildsPrunedAt).toBeUndefined()
  })

  it('a low disk keeps everything of a task in use when the open files cannot be read, or the output is under 6 hours old', async () => {
    const dir = ensureTaskDir(root, 'live')!
    write(path.join(dir, 'copy', 'node_modules', 'x.js'))
    old(path.join(dir, 'copy'), new Date(Date.now() - 3 * 3_600_000)) // 3 hours untouched
    const busy = () => true
    expect((await pruneTaskBuilds(root, ['live'], { busy, idleBefore: Date.now(), openPaths: async () => [] })).pruned[0].builds).toEqual([])
    old(path.join(dir, 'copy'))
    expect((await pruneTaskBuilds(root, ['live'], { busy, idleBefore: Date.now(), openPaths: async () => null })).pruned[0].builds).toEqual([])
    expect((await pruneTaskBuilds(root, ['live'], { busy, idleBefore: Date.now(), openPaths: async () => { throw new Error('lsof failed') } })).pruned[0].builds).toEqual([])
    expect(fs.existsSync(path.join(dir, 'copy', 'node_modules', 'x.js'))).toBe(true)
  })

  it('a dist with no src beside it, outside a repo, stays even on a low disk', async () => {
    const dir = ensureTaskDir(root, 'live')!
    write(path.join(dir, 'unpacked', 'package.json'), '{}\n')
    write(path.join(dir, 'unpacked', 'dist', 'index.js')) // an npm package's only code
    old(path.join(dir, 'unpacked'))
    const res = await pruneTaskBuilds(root, ['live'], { busy: () => true, idleBefore: Date.now(), openPaths: async () => [] })
    expect(res.pruned[0].builds).toEqual([])
  })

  it('readOpenPaths sees a working directory and an open file under the root', async () => {
    const dir = ensureTaskDir(root, 'live')!
    const work = path.join(dir, 'work')
    write(path.join(work, 'held.txt'))
    const child = spawn('/bin/sh', ['-c', 'exec 3<held.txt; sleep 30'], { cwd: work, stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 500))
      const open = await readOpenPaths(root)
      if (open === null) return // neither lsof nor /proc on this machine: the caller then prunes nothing in use
      const realWork = fs.realpathSync(work)
      expect(open.map((p) => { try { return fs.realpathSync(p) } catch { return p } })).toEqual(expect.arrayContaining([realWork, path.join(realWork, 'held.txt')]))
    } finally { child.kill('SIGKILL') }
  })

  // Review round 4 of 2026-11-08: each of these deleted a build in use in the first draft.
  it('a low disk re-reads the open files before every removal, and a folder above the build inside the task protects it', async () => {
    const dir = ensureTaskDir(root, 'live')!
    for (const copy of ['a', 'b']) { cloneInto(dir, copy); write(path.join(dir, copy, 'node_modules', 'x.js')); old(path.join(dir, copy)) }
    // A process starts in the other copy while the checks of the first build run: that build stays.
    let openNow: string[] = []
    let reads = 0
    let first = ''
    const slowGit = async (cwd: string, args: string[]) => {
      if (args[0] === 'ls-files' && !first) { first = path.basename(cwd); openNow = [path.join(dir, first === 'a' ? 'b' : 'a')] }
      return git(cwd, ...args)
    }
    const res = await pruneTaskBuilds(root, ['live'], { busy: () => true, idleBefore: Date.now(), git: slowGit, openPaths: async () => { reads++; return [...openNow] } })
    const other = first === 'a' ? 'b' : 'a'
    expect(res.pruned[0].builds).toEqual([`${first}/node_modules`])
    expect(fs.existsSync(path.join(dir, other, 'node_modules', 'x.js'))).toBe(true)
    expect(reads).toBeGreaterThanOrEqual(2)
    // A server whose working directory is the task directory reads builds below it lazily: kept.
    const above = await pruneTaskBuilds(root, ['live'], { busy: () => true, idleBefore: Date.now(), openPaths: async () => [dir] })
    expect(above.pruned[0].builds).toEqual([])
    // A working directory above the task directory (a home, a shared checkout) says nothing about it.
    const outside = await pruneTaskBuilds(root, ['live'], { busy: () => true, idleBefore: Date.now(), openPaths: async () => [root, tmp] })
    expect(outside.pruned[0].builds).toEqual([`${other}/node_modules`])
  })

  it('readOpenPaths takes only a whole lsof answer: a failed or partial run is no answer', async () => {
    const bin = path.join(tmp, 'fake-lsof-bin')
    fs.mkdirSync(bin, { recursive: true })
    const fake = (code: number) => fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh\necho p1\necho n${root}/elsewhere\nexit ${code}\n`, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath}`
    try {
      fake(2)
      expect(await readOpenPaths(root)).toBeNull()
      fake(1) // lsof's "some file could not be listed": the rest of its answer stands
      expect(await readOpenPaths(root)).toEqual([`${root}/elsewhere`])
    } finally { process.env.PATH = savedPath }
  })
})
