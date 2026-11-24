/**
 * A batch's dirs (src/core/standby/batch-dirs.ts): every leader dir of the home at the batch's
 * moment is in the copy, an empty one too. Found by the liveness test: once `git gc` packed every
 * ref, `.git/refs` held only empty dirs, the copy had no `.git/refs`, and git did not count the
 * copy as a repository ("not a git repository"): a leader started from it would have had no git
 * history.
 *
 * MACHINE SAFETY: every home and target is a temp dir of the test's own.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homePathClass } from '../../../src/core/home-manifest/index.js'
import { snapshotTo, takeBatch, verifyStandby } from '../../../src/core/standby/index.js'
import { RECEIVER_READS } from '../../../src/core/standby/receive.js'
import { RemoteStandbyTarget } from '../../../src/core/standby/remote-transport.js'
import { readManifest, readState, targetPaths } from '../../../src/core/standby/target-files.js'
import { fakeStandbyHost } from './fake-standby-host.js'
import { sandbox, seedHome, write, type Sandbox } from './helpers.js'

let sb: Sandbox | null = null
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
  sb = null
})
const settle = () => new Promise((r) => setTimeout(r, 30))

function dirsUnder(root: string, rel = ''): string[] {
  const abs = rel ? path.join(root, rel) : root
  return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name
    return [child, ...dirsUnder(root, child)]
  })
}
const leaderDirs = (home: string) => dirsUnder(home).filter((d) => homePathClass(d) === 'leader-data').sort()
const copyOf = () => path.join(sb!.target, 'copy')
const manifestDirs = async () => {
  const t = targetPaths(sb!.target)
  const state = await readState(t)
  return (await readManifest(t, state.current!.manifest)).dirs ?? []
}

/** A home with empty leader dirs: one alone, a nested one, and git's after every ref was packed. */
function homeWithEmptyDirs(home: string): void {
  dbs.push(...seedHome(home).dbs)
  fs.mkdirSync(path.join(home, 'artifacts/notes/empty'), { recursive: true })
  fs.mkdirSync(path.join(home, 'artifacts/notes/deep/x/y'), { recursive: true })
  write(home, '.git/HEAD', 'ref: refs/heads/main\n')
  write(home, '.git/packed-refs', `# pack-refs with: peeled fully-peeled sorted \n${'a'.repeat(40)} refs/heads/main\n`)
  fs.mkdirSync(path.join(home, '.git/refs/heads'), { recursive: true })
  fs.mkdirSync(path.join(home, '.git/refs/tags'), { recursive: true })
  write(home, '.git/objects/pack/pack-1.pack', 'p')
  fs.mkdirSync(path.join(home, '.git/objects/info'), { recursive: true })
}

describe('a batch keeps the home\'s dirs', () => {
  it('every leader dir of the home is in the copy, an empty one too; a batch after it changes nothing', async () => {
    sb = await sandbox('dirs-all')
    homeWithEmptyDirs(sb.home)
    await settle()
    const first = await snapshotTo(sb.home, sb.target)
    expect(first.ok, first.ok ? '' : first.reason).toBe(true)
    // The guard for the class: whatever makes a dir go missing from a copy fails here.
    expect(leaderDirs(copyOf())).toEqual(leaderDirs(sb.home))
    expect(await manifestDirs()).toEqual(['.git/objects/info', '.git/refs/heads', '.git/refs/tags', 'artifacts/notes/deep/x/y', 'artifacts/notes/empty'])
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
    const again = await snapshotTo(sb.home, sb.target)
    expect(again.ok && again.commit.unchanged, again.ok ? JSON.stringify(again.stats.roundFailures) : again.reason).toBe(true)
    expect(leaderDirs(copyOf())).toEqual(leaderDirs(sb.home))
  })

  it('a dir that goes, empties or gets a file moves the copy with it', async () => {
    sb = await sandbox('dirs-move')
    homeWithEmptyDirs(sb.home)
    await settle()
    expect((await snapshotTo(sb.home, sb.target)).ok).toBe(true)

    // Gone: only the dirs list changed, and that is a change.
    fs.rmdirSync(path.join(sb.home, 'artifacts/notes/empty'))
    await settle()
    const gone = await snapshotTo(sb.home, sb.target)
    expect(gone.ok && gone.commit).toMatchObject({ written: 0, deleted: 0, unchanged: false })
    expect(fs.existsSync(path.join(copyOf(), 'artifacts/notes/empty'))).toBe(false)
    expect(leaderDirs(copyOf())).toEqual(leaderDirs(sb.home))

    // Emptied: its last file went, the dir stays (git packing its last loose ref is this).
    fs.rmSync(path.join(sb.home, 'artifacts/notes/deep/a/b/c.md'))
    // Filled: a file in an empty dir lists it no more; the file implies it.
    write(sb.home, 'artifacts/notes/deep/x/y/new.md', 'new\n')
    await settle()
    const moved = await snapshotTo(sb.home, sb.target)
    expect(moved.ok && moved.commit).toMatchObject({ written: 1, deleted: 1, unchanged: false })
    expect(fs.statSync(path.join(copyOf(), 'artifacts/notes/deep/a/b')).isDirectory()).toBe(true)
    expect(leaderDirs(copyOf())).toEqual(leaderDirs(sb.home))
    expect(await manifestDirs()).toContain('artifacts/notes/deep/a/b')
    expect(await manifestDirs()).not.toContain('artifacts/notes/deep/x/y')

    // A dir that becomes a file, and back.
    fs.rmSync(path.join(sb.home, 'artifacts/notes/deep/a/b'), { recursive: true })
    write(sb.home, 'artifacts/notes/deep/a/b', 'now a file\n')
    await settle()
    const asFile = await snapshotTo(sb.home, sb.target)
    expect(asFile.ok, asFile.ok ? '' : asFile.reason).toBe(true)
    expect(fs.readFileSync(path.join(copyOf(), 'artifacts/notes/deep/a/b'), 'utf8')).toBe('now a file\n')
    fs.rmSync(path.join(sb.home, 'artifacts/notes/deep/a/b'))
    fs.mkdirSync(path.join(sb.home, 'artifacts/notes/deep/a/b'))
    await settle()
    const asDir = await snapshotTo(sb.home, sb.target)
    expect(asDir.ok, asDir.ok ? '' : asDir.reason).toBe(true)
    expect(leaderDirs(copyOf())).toEqual(leaderDirs(sb.home))
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })

  it('verify makes again a dir the copy lost, and reports it once', async () => {
    sb = await sandbox('dirs-verify')
    homeWithEmptyDirs(sb.home)
    await settle()
    expect((await snapshotTo(sb.home, sb.target)).ok).toBe(true)
    const parent = path.join(copyOf(), '.git/refs')
    fs.chmodSync(parent, 0o700)
    fs.rmdirSync(path.join(parent, 'tags'))
    const v = await verifyStandby(sb.target)
    expect(v.drift.map((d) => [d.p, d.kind])).toEqual([['.git/refs/tags/', 'deleted']])
    expect(fs.statSync(path.join(parent, 'tags')).isDirectory()).toBe(true)
    expect((await verifyStandby(sb.target)).drift).toEqual([])
  })

  const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true } catch { return false } })()
  it.skipIf(!hasGit)('git counts the copy as a repository after gc packed every ref', async () => {
    sb = await sandbox('dirs-git')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' }).toString().trim()
    git(sb.home, 'init', '-q', '-b', 'main')
    write(sb.home, 'artifacts/notes/a.md', 'a\n')
    git(sb.home, 'add', '-A')
    git(sb.home, 'commit', '-qm', 'one')
    git(sb.home, '-c', 'gc.autoDetach=false', 'gc', '-q', '--prune=now')
    expect(fs.readdirSync(path.join(sb.home, '.git/refs/heads'))).toEqual([])
    await settle()
    const out = await snapshotTo(sb.home, sb.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    const check = path.join(sb.root, 'check')
    fs.cpSync(copyOf(), check, { recursive: true })
    execFileSync('chmod', ['-R', 'u+w', check])
    expect(git(check, 'fsck', '--full', '--no-dangling')).toBe('')
    expect(git(check, 'rev-parse', 'HEAD')).toBe(git(sb.home, 'rev-parse', 'HEAD'))
  })

  it('a receiver on another host keeps the dirs; one older than them gets the batch without them', async () => {
    sb = await sandbox('dirs-remote')
    homeWithEmptyDirs(sb.home)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const remote = () => new RemoteStandbyTarget({ connect: async () => l.link, dir: sb!.target, spoolDir: path.join(sb!.root, 'spool'), applyPollMs: 20, applyLateMs: 300, applyJobBytes: 0, linkWaitMs: 5_000 })
    const batch = (t: RemoteStandbyTarget) => takeBatch({ home: sb!.home, transport: t, stagingDir: path.join(sb!.root, 'staging') })
    const first = await batch(remote())
    expect(first.ok, first.ok ? '' : first.reason).toBe(true)
    expect(leaderDirs(copyOf())).toEqual(leaderDirs(sb.home))
    expect(await manifestDirs()).toContain('.git/refs/tags')

    // An older receiver names nothing it reads beyond files: the leader leaves the dirs out, and
    // the receiver's own rebuild of the manifest (without them) matches the leader's hash.
    const saved = RECEIVER_READS.splice(0)
    try {
      write(sb.home, 'memory/MEMORY.md', '# changed\n')
      await settle()
      const old = await batch(remote())
      expect(old.ok, old.ok ? '' : old.reason).toBe(true)
      expect(await manifestDirs()).toEqual([])
    } finally {
      RECEIVER_READS.push(...saved)
    }
  })
})
