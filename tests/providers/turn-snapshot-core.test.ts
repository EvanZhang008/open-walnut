/**
 * Per-turn working-tree snapshots (src/providers/turn-snapshot-core.ts) against
 * REAL git in temp repositories: every repo lives under one mkdtemp root and
 * the core is pinned to it (`allowRepo`), so nothing here can reach this
 * checkout or the user's home.
 *
 * Would these pass with the feature reverted? No: they read the hidden refs,
 * the restored files and the user's index back from disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTurnSnapshots, parseTurnRefRecords, parseNameStatusZ, parseNumstatZ, isValidSnapshotRelPath,
  TURN_SNAPSHOT_REDIRECT_VARS, type TurnSnapshotDeps, type TurnSnapshotExecFile, type TurnSnapshotFs,
} from '../../src/providers/turn-snapshot-core.js'
import { GIT_REPO_REDIRECT_VARS } from '../../src/lib/git-env.js'

let ROOT = ''

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of GIT_REPO_REDIRECT_VARS) delete env[v]
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig')
  // Repository discovery never climbs out of the temp root.
  env.GIT_CEILING_DIRECTORIES = path.dirname(ROOT)
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

function git(cwd: string, ...args: string[]): string {
  if (!cwd.startsWith(ROOT)) throw new Error('refusing to run git outside the temp root: ' + cwd)
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' })
}

function write(repo: string, rel: string, text: string): void {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function read(repo: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(repo, rel), 'utf-8') } catch { return null }
}

let seq = 0
/** A fresh repo with one commit (a.txt, b.txt), or an unborn one. */
function makeRepo(opts: { unborn?: boolean } = {}): string {
  const repo = path.join(ROOT, 'repo-' + (++seq))
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  if (!opts.unborn) {
    write(repo, 'a.txt', 'one\ntwo\nthree\n')
    write(repo, 'b.txt', 'bee\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
  }
  return repo
}

function makeCore(extra: Partial<TurnSnapshotDeps> = {}) {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'daemon-'))
  return createTurnSnapshots({
    execFile: execFile as unknown as TurnSnapshotExecFile,
    fs: fs.promises as unknown as TurnSnapshotFs,
    path,
    env: cleanEnv(),
    // A temp-index dir that does not exist yet, as in the daemon: the core makes it.
    tmpDir: path.join(tmp, 'turn-snapshots'),
    settingsPath: path.join(tmp, 'settings.json'),
    allowRepo: (root) => root.startsWith(ROOT),
    ...extra,
  })
}

function refs(repo: string, sid: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname)', `refs/walnut/turns/${sid}/`).split('\n').filter(Boolean)
}

/** Everything the user owns: HEAD, branches, the index file's bytes, the status. */
function userState(repo: string) {
  const index = fs.existsSync(path.join(repo, '.git/index')) ? fs.readFileSync(path.join(repo, '.git/index')).toString('base64') : null
  return {
    index,
    head: git(repo, 'rev-parse', '-q', '--verify', 'HEAD').trim(),
    branches: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'),
    status: git(repo, 'status', '--porcelain', '--untracked-files=all'),
  }
}

beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-snapshot-core-')))
  fs.writeFileSync(path.join(ROOT, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n')
})

afterAll(() => {
  if (ROOT && ROOT.startsWith(fs.realpathSync(os.tmpdir()))) fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('turn snapshots: capture', () => {
  it('records the whole working tree under a hidden ref without touching the index, HEAD, branches or files', async () => {
    const repo = makeRepo()
    const core = makeCore()
    expect((await core.snapshot('s1', repo, 'start')).status).toBe('created')
    write(repo, 'a.txt', 'one\nTWO\nthree\nfour\n')
    write(repo, 'new/c.txt', 'sea\n')
    fs.rmSync(path.join(repo, 'b.txt'))
    git(repo, 'add', 'a.txt') // a staged change the snapshot must leave staged
    const before = userState(repo)
    const out = await core.snapshot('s1', repo, 'turn')
    expect(out.status).toBe('created')
    expect(userState(repo)).toEqual(before)

    expect(refs(repo, 's1')).toEqual(['refs/walnut/turns/s1/0', 'refs/walnut/turns/s1/1'])
    const listed = await core.list('s1', repo)
    expect(listed.enabled).toBe(true)
    expect(listed.repoRoot).toBe(repo)
    const [start, turn] = listed.snapshots
    expect(start).toMatchObject({ n: 0, kind: 'start', base: 'head', files: [], capture: 'full' })
    expect(turn).toMatchObject({ n: 1, kind: 'turn', base: 'previous', filesTotal: 3, prevSha: start.sha })
    expect(turn.files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 1 },
      { path: 'b.txt', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'new/c.txt', status: 'added', additions: 1, deletions: 0 },
    ])
    // The snapshot is a commit whose parent is HEAD; its tree holds the files as they were.
    expect(git(repo, 'rev-parse', turn.sha + '^1').trim()).toBe(before.head)
    expect(git(repo, 'show', turn.sha + ':new/c.txt')).toBe('sea\n')
  })

  it('a tree equal to the previous snapshot makes no new ref', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'a.txt', 'changed\n')
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('created')
    const again = await core.snapshot('s1', repo, 'turn')
    expect(again).toMatchObject({ status: 'unchanged', n: 1 })
    expect(refs(repo, 's1')).toHaveLength(1)
  })

  it('honours .gitignore and records ignored files never', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, '.gitignore', 'build/\n*.log\n')
    write(repo, 'build/out.js', 'x')
    write(repo, 'debug.log', 'x')
    write(repo, 'kept.ts', 'k')
    const out = await core.snapshot('s1', repo, 'turn')
    expect(out.status).toBe('created')
    const tree = git(repo, 'ls-tree', '-r', '--name-only', 'refs/walnut/turns/s1/1').split('\n').filter(Boolean)
    expect(tree).toContain('kept.ts')
    expect(tree).toContain('.gitignore')
    expect(tree).not.toContain('build/out.js')
    expect(tree).not.toContain('debug.log')
  })

  it('an untracked pile over the cap is left out: tracked files only, and the record says so', async () => {
    const repo = makeRepo()
    const core = makeCore({ maxUntrackedFiles: 3 })
    for (let i = 0; i < 5; i++) write(repo, `node_modules/p${i}/index.js`, 'x' + i)
    write(repo, 'a.txt', 'tracked change\n')
    const out = await core.snapshot('s1', repo, 'turn')
    expect(out.status).toBe('created')
    const [snap] = (await core.list('s1', repo)).snapshots
    expect(snap).toMatchObject({ capture: 'tracked-only', untrackedSkipped: 5 })
    expect(snap.files.map((f) => f.path)).toEqual(['a.txt'])
  })

  it('one oversized untracked file is left out, the rest are kept', async () => {
    const repo = makeRepo()
    const core = makeCore({ maxUntrackedFileBytes: 100 })
    write(repo, 'big.bin', 'x'.repeat(500))
    write(repo, 'small.txt', 'ok\n')
    await core.snapshot('s1', repo, 'turn')
    const [snap] = (await core.list('s1', repo)).snapshots
    expect(snap.capture).toBe('tracked-only')
    expect(snap.untrackedSkipped).toBe(1)
    expect(snap.files.map((f) => f.path)).toEqual(['small.txt'])
  })

  it('works on an unborn branch (no commit yet): measured against the empty tree, no parent', async () => {
    const repo = makeRepo({ unborn: true })
    const core = makeCore()
    write(repo, 'first.txt', 'hello\n')
    const out = await core.snapshot('s1', repo, 'turn')
    expect(out.status).toBe('created')
    const [snap] = (await core.list('s1', repo)).snapshots
    expect(snap).toMatchObject({ n: 1, base: 'empty' })
    expect(snap.files).toEqual([{ path: 'first.txt', status: 'added', additions: 1, deletions: 0 }])
    expect(git(repo, 'rev-list', '--parents', '-n', '1', snap.sha).trim()).toBe(snap.sha)
    expect(fs.existsSync(path.join(repo, '.git/index'))).toBe(false)
  })

  it('ignores inherited repo redirects (GIT_DIR, GIT_INDEX_FILE) in its base env', async () => {
    const repo = makeRepo()
    const decoy = path.join(ROOT, 'decoy-index')
    const core = makeCore({ env: { ...cleanEnv(), GIT_DIR: path.join(ROOT, 'nowhere.git'), GIT_INDEX_FILE: decoy, GIT_WORK_TREE: ROOT } })
    write(repo, 'a.txt', 'x\n')
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('created')
    expect(fs.existsSync(decoy)).toBe(false)
    expect(refs(repo, 's1')).toHaveLength(1)
  })
})

describe('turn snapshots: skip rules', () => {
  it('not a git repo', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'plain-'))
    const core = makeCore()
    expect(await core.snapshot('s1', dir, 'turn')).toMatchObject({ status: 'skipped', reason: 'not-a-repo' })
    expect((await core.list('s1', dir)).skipped.map((s) => s.reason)).toEqual(['not-a-repo'])
  })

  it('index.lock present: skipped, and nothing is written', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'a.txt', 'x\n')
    fs.writeFileSync(path.join(repo, '.git/index.lock'), '')
    try {
      expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'index-locked' })
      expect(refs(repo, 's1')).toEqual([])
    } finally {
      fs.rmSync(path.join(repo, '.git/index.lock'))
    }
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('created')
  })

  it('a merge or a rebase in progress', async () => {
    const repo = makeRepo()
    const core = makeCore()
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(path.join(repo, '.git/MERGE_HEAD'), head + '\n')
    expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'merge-in-progress' })
    fs.rmSync(path.join(repo, '.git/MERGE_HEAD'))
    fs.mkdirSync(path.join(repo, '.git/rebase-merge'))
    expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'rebase-in-progress' })
    fs.rmSync(path.join(repo, '.git/rebase-merge'), { recursive: true })
  })

  it('off (configure or the kill switch), a bad session id, a repo outside the allowed root', async () => {
    const repo = makeRepo()
    const core = makeCore()
    await core.configure({ enabled: false })
    expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'disabled' })
    await core.configure({ enabled: true })
    expect(await core.snapshot('../x', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'bad-session-id' })
    const killed = makeCore({ forceDisabled: true })
    expect((await killed.configure({ enabled: true })).enabled).toBe(false)
    const pinned = makeCore({ allowRepo: () => false })
    expect(await pinned.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'not-allowed' })
  })

  it('the settings persist across a daemon restart', async () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, 'settings-'))
    const settingsPath = path.join(tmp, 's.json')
    const a = makeCore({ settingsPath })
    await a.configure({ enabled: false, keep: 7 })
    const b = makeCore({ settingsPath })
    await b.ready()
    expect(b.settings()).toEqual({ enabled: false, keep: 7 })
  })

  it('a snapshot that runs out of time is skipped and the repo rests', async () => {
    const repo = makeRepo()
    let t = 1_000_000
    const core = makeCore({ timeBudgetMs: 0, now: () => t })
    write(repo, 'a.txt', 'x\n')
    expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'timeout' })
    expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'resting' })
    t += 16 * 60_000
    expect(await core.snapshot('s1', repo, 'turn')).toMatchObject({ status: 'skipped', reason: 'timeout' })
  })
})

describe('turn snapshots: retention and the turn hooks', () => {
  it('keeps the newest N per session and deletes older refs (never gc)', async () => {
    const repo = makeRepo()
    const core = makeCore()
    await core.configure({ keep: 3 })
    for (let i = 0; i < 5; i++) {
      write(repo, 'a.txt', 'v' + i + '\n')
      expect((await core.snapshot('s1', repo, 'turn')).status).toBe('created')
    }
    expect(refs(repo, 's1')).toEqual(['refs/walnut/turns/s1/3', 'refs/walnut/turns/s1/4', 'refs/walnut/turns/s1/5'])
    // Another session's refs are its own.
    write(repo, 'a.txt', 'other\n')
    await core.snapshot('s2', repo, 'turn')
    expect(refs(repo, 's2')).toEqual(['refs/walnut/turns/s2/1'])
    expect(refs(repo, 's1')).toHaveLength(3)
  })

  it('onTurnEnd returns at once, a replayed result line is ignored, and a second turn end rides the queued one', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'a.txt', 'x\n')
    core.onTurnEnd('s1', repo, 100)
    core.onTurnEnd('s1', repo, 100)
    core.onTurnEnd('s1', repo, 50)
    expect(refs(repo, 's1')).toEqual([])
    await expect.poll(() => refs(repo, 's1').length, { timeout: 10_000 }).toBe(1)
    await new Promise((r) => setTimeout(r, 300))
    expect(refs(repo, 's1')).toHaveLength(1)
  })

  it('onTurnStart records the tree before the first turn, once, only when the session has none', async () => {
    const repo = makeRepo()
    const core = makeCore()
    core.onTurnStart('s1', repo)
    await expect.poll(() => refs(repo, 's1'), { timeout: 10_000 }).toEqual(['refs/walnut/turns/s1/0'])
    write(repo, 'a.txt', 'x\n')
    core.onTurnStart('s1', repo)
    const other = makeCore()
    other.onTurnStart('s1', repo) // a restarted daemon: the session already has refs
    await new Promise((r) => setTimeout(r, 500))
    expect(refs(repo, 's1')).toEqual(['refs/walnut/turns/s1/0'])
  })
})

describe('turn snapshots: the age sweep', () => {
  /** A snapshot ref of `sid` whose commit is `ageDays` old (any session, as git would hold it). */
  function plantRef(repo: string, sid: string, n: number, ageDays: number): string {
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim()
    const when = `@${Math.floor(Date.now() / 1000 - ageDays * 86400)} +0000`
    const sha = execFileSync('git', ['commit-tree', tree, '-m', 'planted'], {
      cwd: repo, env: { ...cleanEnv(), GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }, encoding: 'utf-8',
    }).trim()
    git(repo, 'update-ref', `refs/walnut/turns/${sid}/${n}`, sha)
    return sha
  }

  it("deletes any session's refs older than 30 days, keeps recent ones and a busy session's, at most once a day per repo", async () => {
    const repo = makeRepo()
    let offset = 0
    const active = new Set(['busy'])
    const core = makeCore({ now: () => Date.now() + offset, turnActive: (sid) => active.has(sid) })
    const gone = plantRef(repo, 'ended', 1, 45)
    plantRef(repo, 'ended', 2, 31)
    plantRef(repo, 'ended', 3, 2)
    plantRef(repo, 'busy', 1, 60)
    plantRef(repo, 'other', 7, 40)

    write(repo, 'a.txt', 'x\n')
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('created')
    expect(refs(repo, 'ended')).toEqual(['refs/walnut/turns/ended/3'])
    expect(refs(repo, 'other')).toEqual([])
    expect(refs(repo, 'busy')).toEqual(['refs/walnut/turns/busy/1'])
    expect(refs(repo, 's1')).toEqual(['refs/walnut/turns/s1/1'])
    // Never gc: the swept commit is still in the object store.
    expect(git(repo, 'cat-file', '-t', gone).trim()).toBe('commit')

    // A second capture within 24h does not sweep again.
    plantRef(repo, 'late', 1, 50)
    write(repo, 'a.txt', 'y\n')
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('created')
    expect(refs(repo, 'late')).toHaveLength(1)

    // A day later the next capture sweeps (an unchanged tree is a capture too);
    // the busy session's ref stays while it is busy and goes once it is not.
    offset = 25 * 3600_000
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('unchanged')
    expect(refs(repo, 'late')).toEqual([])
    expect(refs(repo, 'busy')).toHaveLength(1)
    active.delete('busy')
    offset = 50 * 3600_000
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('unchanged')
    expect(refs(repo, 'busy')).toEqual([])
    expect(refs(repo, 's1')).toHaveLength(2)
  })

  it('a session with a capture in flight keeps its old refs; a skipped capture does not sweep', async () => {
    const repo = makeRepo()
    const core = makeCore()
    plantRef(repo, 'queued', 1, 90)
    plantRef(repo, 'ended', 1, 90)
    // A capture that is skipped (git busy) leaves everything, and does not use up the day.
    fs.writeFileSync(path.join(repo, '.git/index.lock'), '')
    expect((await core.snapshot('s1', repo, 'turn')).status).toBe('skipped')
    expect(refs(repo, 'ended')).toHaveLength(1)
    fs.unlinkSync(path.join(repo, '.git/index.lock'))

    write(repo, 'a.txt', 'x\n')
    const [a, b] = await Promise.all([core.snapshot('s1', repo, 'turn'), core.snapshot('queued', repo, 'turn')])
    expect(a.status).not.toBe('skipped')
    expect(b.status).not.toBe('skipped')
    expect(refs(repo, 'ended')).toEqual([])
    expect(refs(repo, 'queued')).toContain('refs/walnut/turns/queued/1')
  })

  it('the age is a deps override', async () => {
    const repo = makeRepo()
    const core = makeCore({ refMaxAgeMs: 3 * 86400_000 })
    plantRef(repo, 'ended', 1, 5)
    plantRef(repo, 'ended', 2, 1)
    write(repo, 'a.txt', 'x\n')
    await core.snapshot('s1', repo, 'turn')
    expect(refs(repo, 'ended')).toEqual(['refs/walnut/turns/ended/2'])
  })
})

describe('turn snapshots: diff', () => {
  it("one file between a snapshot and the one before it, and against the working tree", async () => {
    const repo = makeRepo()
    const core = makeCore()
    await core.snapshot('s1', repo, 'start')
    write(repo, 'a.txt', 'one\nTWO\nthree\n')
    await core.snapshot('s1', repo, 'turn')
    const d = await core.fileDiff('s1', repo, 1, 'a.txt', 'previous')
    expect(d).toMatchObject({ path: 'a.txt', filePath: path.join(repo, 'a.txt'), before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n', status: 'modified', fromN: 0, toN: 1 })
    write(repo, 'a.txt', 'later\n')
    const w = await core.fileDiff('s1', repo, 1, 'a.txt', 'worktree')
    expect(w).toMatchObject({ before: 'one\nTWO\nthree\n', after: 'later\n', fromN: 1, toN: null })
    // A first turn snapshot with no baseline is measured against HEAD.
    const repo2 = makeRepo()
    write(repo2, 'b.txt', 'changed\n')
    await core.snapshot('s9', repo2, 'turn')
    expect(await core.fileDiff('s9', repo2, 1, 'b.txt', 'previous')).toMatchObject({ before: 'bee\n', after: 'changed\n', fromN: null })
    // Added and binary files.
    fs.writeFileSync(path.join(repo2, 'bin.dat'), Buffer.from([0, 1, 2, 0]))
    await core.snapshot('s9', repo2, 'turn')
    expect(await core.fileDiff('s9', repo2, 2, 'bin.dat', 'previous')).toMatchObject({ status: 'added', binary: true })
  })

  it('refuses a path outside the repository and an unknown snapshot', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'a.txt', 'x\n')
    await core.snapshot('s1', repo, 'turn')
    await expect(core.fileDiff('s1', repo, 1, '../escape', 'previous')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(core.fileDiff('s1', repo, 1, '.git/config', 'previous')).rejects.toMatchObject({ code: 'bad-request' })
    await expect(core.fileDiff('s1', repo, 9, 'a.txt', 'previous')).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('turn snapshots: restore', () => {
  it('puts a turn back, snapshots the state first so the restore is undoable, and leaves the index alone', async () => {
    const repo = makeRepo()
    const core = makeCore()
    await core.snapshot('s1', repo, 'start') // 0: a, b as committed
    write(repo, 'a.txt', 'turn one\n')
    await core.snapshot('s1', repo, 'turn') // 1
    write(repo, 'a.txt', 'turn two\n')
    fs.rmSync(path.join(repo, 'b.txt'))
    write(repo, 'c.txt', 'new in two\n')
    await core.snapshot('s1', repo, 'turn') // 2
    write(repo, 'a.txt', 'edited after the turn\n') // not snapshotted yet
    const indexBefore = fs.readFileSync(path.join(repo, '.git/index'))

    const dry = await core.restore({ sid: 's1', cwd: repo, n: 1, dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, write: ['a.txt', 'b.txt'], delete: ['c.txt'], keep: [], backupN: null })
    expect(read(repo, 'a.txt')).toBe('edited after the turn\n')
    expect(refs(repo, 's1')).toHaveLength(3)

    const done = await core.restore({ sid: 's1', cwd: repo, n: 1 })
    expect(done).toMatchObject({ dryRun: false, write: ['a.txt', 'b.txt'], delete: ['c.txt'], backupN: 3, afterN: 4 })
    expect(read(repo, 'a.txt')).toBe('turn one\n')
    expect(read(repo, 'b.txt')).toBe('bee\n')
    expect(read(repo, 'c.txt')).toBeNull()
    expect(fs.readFileSync(path.join(repo, '.git/index')).equals(indexBefore)).toBe(true)
    const list = (await core.list('s1', repo)).snapshots
    expect(list.map((s) => [s.n, s.kind])).toEqual([[0, 'start'], [1, 'turn'], [2, 'turn'], [3, 'pre-restore'], [4, 'restored']])
    expect(list[4].restoredFrom).toBe(1)

    // Undo: restore the backup, the unsnapshotted edit included.
    await core.restore({ sid: 's1', cwd: repo, n: 3 })
    expect(read(repo, 'a.txt')).toBe('edited after the turn\n')
    expect(read(repo, 'b.txt')).toBeNull()
    expect(read(repo, 'c.txt')).toBe('new in two\n')
  })

  it('restores only the selected files', async () => {
    const repo = makeRepo()
    const core = makeCore()
    await core.snapshot('s1', repo, 'start')
    write(repo, 'a.txt', 'A\n')
    write(repo, 'b.txt', 'B\n')
    const out = await core.restore({ sid: 's1', cwd: repo, n: 0, paths: ['b.txt'] })
    expect(out.write).toEqual(['b.txt'])
    expect(read(repo, 'b.txt')).toBe('bee\n')
    expect(read(repo, 'a.txt')).toBe('A\n')
  })

  it('a file a tracked-only snapshot never recorded is kept, not deleted', async () => {
    const repo = makeRepo()
    const core = makeCore({ maxUntrackedFiles: 1 })
    write(repo, 'u1.txt', '1')
    write(repo, 'u2.txt', '2')
    await core.snapshot('s1', repo, 'turn') // tracked-only: u1/u2 not recorded
    fs.rmSync(path.join(repo, 'u1.txt'))
    fs.rmSync(path.join(repo, 'u2.txt'))
    write(repo, 'u3.txt', '3') // may have existed untracked back then: never deleted
    write(repo, 'a.txt', 'later\n')
    const out = await core.restore({ sid: 's1', cwd: repo, n: 1 })
    expect(out.write).toEqual(['a.txt'])
    expect(out.delete).toEqual([])
    expect(out.keep).toEqual(['u3.txt'])
    expect(read(repo, 'u3.txt')).toBe('3')
    expect(read(repo, 'a.txt')).toBe('one\ntwo\nthree\n')
  })

  it('a file that became ignored since the snapshot: its current text is in the backup, so the undo brings it back', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'conf.local', 'original\n')
    await core.snapshot('s1', repo, 'turn') // 1 holds conf.local
    write(repo, '.gitignore', 'conf.local\n')
    write(repo, 'conf.local', 'edited while ignored\n')
    const out = await core.restore({ sid: 's1', cwd: repo, n: 1 })
    expect(out.write).toEqual(['conf.local'])
    expect(out.delete).toEqual(['.gitignore'])
    expect(read(repo, 'conf.local')).toBe('original\n')
    expect(git(repo, 'show', `refs/walnut/turns/s1/${out.backupN}:conf.local`)).toBe('edited while ignored\n')
    await core.restore({ sid: 's1', cwd: repo, n: out.backupN! })
    expect(read(repo, 'conf.local')).toBe('edited while ignored\n')
    expect(read(repo, '.gitignore')).toBe('conf.local\n')
  })

  it('refuses while a turn of that session runs; a dry run still answers', async () => {
    const repo = makeRepo()
    let running = true
    const core = makeCore({ turnActive: () => running })
    write(repo, 'a.txt', 'x\n')
    await core.snapshot('s1', repo, 'turn')
    write(repo, 'a.txt', 'y\n')
    await expect(core.restore({ sid: 's1', cwd: repo, n: 1 })).rejects.toMatchObject({ code: 'turn-running' })
    expect((await core.restore({ sid: 's1', cwd: repo, n: 1, dryRun: true })).write).toEqual(['a.txt'])
    expect(read(repo, 'a.txt')).toBe('y\n')
    running = false
    await core.restore({ sid: 's1', cwd: repo, n: 1 })
    expect(read(repo, 'a.txt')).toBe('x\n')
  })

  it('on an unborn branch', async () => {
    const repo = makeRepo({ unborn: true })
    const core = makeCore()
    write(repo, 'f.txt', 'first\n')
    await core.snapshot('s1', repo, 'turn')
    write(repo, 'f.txt', 'second\n')
    write(repo, 'g.txt', 'extra\n')
    const out = await core.restore({ sid: 's1', cwd: repo, n: 1 })
    expect(out).toMatchObject({ write: ['f.txt'], delete: ['g.txt'] })
    expect(read(repo, 'f.txt')).toBe('first\n')
    expect(read(repo, 'g.txt')).toBeNull()
    expect(fs.existsSync(path.join(repo, '.git/index'))).toBe(false)
  })

  it('refuses a bad path and git busy in the repo', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'a.txt', 'x\n')
    await core.snapshot('s1', repo, 'turn')
    await expect(core.restore({ sid: 's1', cwd: repo, n: 1, paths: ['../../etc/hosts'] })).rejects.toMatchObject({ code: 'bad-request' })
    fs.writeFileSync(path.join(repo, '.git/index.lock'), '')
    try {
      await expect(core.restore({ sid: 's1', cwd: repo, n: 1 })).rejects.toMatchObject({ code: 'index-locked' })
    } finally {
      fs.rmSync(path.join(repo, '.git/index.lock'))
    }
  })
})

describe('turn snapshots: compare with the newest snapshot (the guard\'s first fact)', () => {
  it('same, differs, deleted, outside the repo, and stale after a skipped turn', async () => {
    const repo = makeRepo()
    const core = makeCore()
    write(repo, 'a.txt', 'mine\n')
    await core.snapshot('s1', repo, 'turn')
    write(repo, 'b.txt', 'someone else\n')
    const outside = path.join(ROOT, 'outside.txt')
    fs.writeFileSync(outside, 'o')
    const cmp = await core.compareToLatest('s1', repo, [path.join(repo, 'a.txt'), path.join(repo, 'b.txt'), outside])
    expect(cmp).toMatchObject({ repoRoot: repo, snapshotN: 1, snapshotStale: false })
    expect(cmp.files.map((f) => [f.rel, f.snapshot, f.text])).toEqual([
      ['a.txt', 'same', 'mine\n'], ['b.txt', 'differs', 'someone else\n'], [null, 'unknown', 'o'],
    ])
    // The same file named through a symlinked directory still maps into the repo.
    const link = path.join(ROOT, 'link-' + seq)
    fs.symlinkSync(repo, link)
    expect((await core.compareToLatest('s1', repo, [path.join(link, 'a.txt')])).files[0]).toMatchObject({ rel: 'a.txt', snapshot: 'same' })
    fs.rmSync(path.join(repo, 'a.txt'))
    expect((await core.compareToLatest('s1', repo, [path.join(repo, 'a.txt')])).files[0]).toMatchObject({ exists: false, snapshot: 'differs' })
    expect((await core.compareToLatest('s1', repo, [path.join(link, 'a.txt')])).files[0]).toMatchObject({ rel: 'a.txt', exists: false, snapshot: 'differs' })
    // A turn ends (over a second later) with snapshots off: the newest one is older than that turn.
    await core.configure({ enabled: false })
    await new Promise((r) => setTimeout(r, 1100))
    core.onTurnEnd('s1', repo, 10)
    expect((await core.compareToLatest('s1', repo, [path.join(repo, 'b.txt')])).snapshotStale).toBe(true)
  })
})

describe('turn snapshots: pure parts', () => {
  it('the redirect list mirrors src/lib/git-env.ts', () => {
    expect([...TURN_SNAPSHOT_REDIRECT_VARS].sort()).toEqual([...GIT_REPO_REDIRECT_VARS].sort())
  })

  it('parses ref records, name-status and numstat lists', () => {
    const NUL = String.fromCharCode(0)
    const record = (fields: string[]) => fields.join(NUL) + NUL + '\n'
    const rec = record(['refs/walnut/turns/s/2', 'a'.repeat(40), 'b'.repeat(40), '1700000000',
      '{"kind":"restored","at":5,"restoredFrom":1,"untrackedSkipped":-1,"capture":"tracked-only","files":[["A","x y.ts",3,0]]}\n'])
      + record(['refs/walnut/turns/s/1', 'c'.repeat(40), 'd'.repeat(40), '1700000000', 'not json'])
    const out = parseTurnRefRecords(rec)
    expect(out.map((r) => r.n)).toEqual([1, 2])
    expect(out[0]).toMatchObject({ kind: 'turn', at: 1700000000000, files: [] })
    expect(out[1]).toMatchObject({ kind: 'restored', at: 5, restoredFrom: 1, untrackedSkipped: -1, capture: 'tracked-only', files: [{ path: 'x y.ts', status: 'added', additions: 3, deletions: 0 }] })
    expect(parseNameStatusZ('M\0a.ts\0D\0dir/b c.ts\0')).toEqual([{ s: 'M', p: 'a.ts' }, { s: 'D', p: 'dir/b c.ts' }])
    expect([...parseNumstatZ('1\t2\ta.ts\0-\t-\tbin.dat\0')]).toEqual([['a.ts', [1, 2]], ['bin.dat', [null, null]]])
  })

  it('a path a caller may name', () => {
    for (const ok of ['a.ts', 'src/x/y.ts', 'with space.md', '.github/workflows/ci.yml']) expect(isValidSnapshotRelPath(ok)).toBe(true)
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', '.git/config', 'sub/.GIT/x', 'a\\b']) expect(isValidSnapshotRelPath(bad)).toBe(false)
  })
})
