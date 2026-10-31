/**
 * A task's own work moves, and nothing else ('task-move-v1': transfer.scan, transfer.pack
 * with paths/exclude/asDir, transfer.apply), with real git in a temp dir, on the factory as
 * imported AND as the source twin inlines it.
 *
 * The shape of 2026-10-31: the session ran in a SHARED checkout with other agents'
 * uncommitted files, while the task's work was a `--shared` clone in its task directory
 * (commits no remote has, an edit, an untracked file) plus a plan file. The shared
 * checkout's main is one commit ahead of its remote, so the clone's base exists nowhere
 * else; the target host has its own checkout of the repository at the remote's commit.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { createTransferPack, type TransferPackDeps } from '../../src/providers/transfer-pack-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-move-')))
afterAll(() => { if (tmp.includes('walnut-task-move-')) fs.rmSync(tmp, { recursive: true, force: true }) })
const gitconfig = path.join(tmp, 'gitconfig')
fs.writeFileSync(gitconfig, '[user]\n\tname = Mover\n\temail = mover@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n')
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' }
const strict = <T>(fn: T): T => new Function('"use strict"; return (' + String(fn) + ')')() as T
const guardedSpawn = ((cmd: string, args: string[], o: Record<string, unknown>) => {
  if (o.cwd && !String(o.cwd).startsWith(tmp)) throw new Error('spawn outside the temp dir: ' + String(o.cwd))
  return spawn(cmd, args, o)
})
const URL = 'https://example.invalid/acme/marina.git'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitChildEnv(env), stdio: 'pipe' }).toString('utf8').trim()
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** The world of one run: a remote, a shared checkout, a task directory, a target host's checkout. */
function world(name: string) {
  const root = path.join(tmp, name)
  const bare = path.join(root, 'remote.git')
  const shared = path.join(root, 'mac', 'shared')
  const taskDir = path.join(root, 'mac', 'tasks', 'T1')
  const clone = path.join(taskDir, 'marina')
  const ref = path.join(taskDir, 'reference')
  const targetBase = path.join(root, 'cloud', 'base')
  const targetTaskDir = path.join(root, 'cloud', 'tasks', 'T1')
  fs.mkdirSync(path.dirname(shared), { recursive: true })
  fs.mkdirSync(path.dirname(targetBase), { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitChildEnv(env) })
  git(path.dirname(shared), ['clone', '-q', bare, shared])
  write(path.join(shared, 'a.txt'), 'a1\n')
  write(path.join(shared, 'b.txt'), 'b1\n')
  write(path.join(shared, 'own.txt'), 'own1\n')
  git(shared, ['add', '-A'])
  git(shared, ['commit', '-q', '-m', 'base'])
  git(shared, ['push', '-q', 'origin', 'main'])
  const remoteHead = git(shared, ['rev-parse', 'HEAD'])
  git(path.dirname(targetBase), ['clone', '-q', bare, targetBase])
  // Landed on the shared checkout, not pushed: the clone's base exists only here.
  write(path.join(shared, 'landed.txt'), 'landed\n')
  git(shared, ['add', '-A'])
  git(shared, ['commit', '-q', '-m', 'landed, not pushed'])
  git(shared, ['remote', 'set-url', 'origin', URL])
  // The task's work: a --shared clone in its task directory.
  fs.mkdirSync(taskDir, { recursive: true })
  git(taskDir, ['clone', '-q', '--shared', shared, clone])
  git(clone, ['checkout', '-q', '-b', 'wt/T1'])
  write(path.join(clone, 'feature.txt'), 'f1\n')
  git(clone, ['add', '-A'])
  git(clone, ['commit', '-q', '-m', 'task commit 1'])
  write(path.join(clone, 'feature.txt'), 'f2\n')
  git(clone, ['commit', '-q', '-am', 'task commit 2'])
  write(path.join(clone, 'b.txt'), 'b-task-edit\n')
  write(path.join(clone, 'scratch', 'notes.txt'), 'untracked in the clone\n')
  write(path.join(taskDir, 'plan.md'), '# plan\n')
  write(path.join(taskDir, 'drafts', 'reply.md'), 'draft\n')
  // A reference clone with nothing of the task's own.
  git(taskDir, ['clone', '-q', bare, ref])
  // Other agents' uncommitted files in the shared checkout.
  write(path.join(shared, 'a.txt'), 'FOREIGN edit\n')
  write(path.join(shared, 'foreign.txt'), 'FOREIGN untracked\n')
  write(path.join(shared, 'own.txt'), 'own2 by this task\n')
  return { root, bare, shared, taskDir, clone, ref, targetBase, targetTaskDir, remoteHead }
}

async function run(factory: typeof createTransferPack, name: string) {
  const w = world(name)
  const packer = factory({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp, now: () => 0 })
  const out = (n: string) => path.join(w.root, 'mac-transfers', n)

  const scan = await packer.scan({ dir: w.taskDir })
  const cloneHead = git(w.clone, ['rev-parse', 'HEAD'])
  const repoPack = await packer.pack({ cwd: w.clone, outDir: out('repo') })
  const refPack = await packer.pack({ cwd: w.ref, outDir: out('ref') })
  const filesPack = await packer.pack({ cwd: w.taskDir, outDir: out('files'), asDir: true, exclude: scan.repos.map((r) => r.rel) })
  const ownPack = await packer.pack({ cwd: w.shared, outDir: out('own'), paths: ['own.txt'] })
  const nonePack = await packer.pack({ cwd: w.shared, outDir: out('none'), paths: [] })

  // On the target: the clone from the target's own checkout, the files into the task dir.
  const applied = await packer.apply({ dest: path.join(w.targetTaskDir, 'marina'), bundleDir: out('repo'), cloneFrom: w.targetBase, url: URL })
  const files = await packer.apply({ dest: w.targetTaskDir, bundleDir: out('files') })
  const dest = path.join(w.targetTaskDir, 'marina')
  const listing = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).filter((p) => !p.startsWith('.git') && !p.includes('/.git')).sort()
  return {
    scan: { repos: scan.repos.map((r) => r.rel).sort(), loose: scan.loose.count, sample: [...scan.loose.sample].sort() },
    repo: {
      names: repoPack.files.map((f) => f.name), ahead: repoPack.meta.ahead, upstreamUrl: repoPack.meta.upstreamUrl,
      headOnRemote: repoPack.meta.headOnRemote, dirty: repoPack.meta.dirty,
    },
    ref: { names: refPack.files.map((f) => f.name), headOnRemote: refPack.meta.headOnRemote, dirty: refPack.meta.dirty },
    filesKind: filesPack.meta.kind,
    own: {
      patch: fs.readFileSync(path.join(out('own'), 'changes.patch'), 'utf8').match(/^diff --git .*$/gm),
      names: ownPack.files.map((f) => f.name), limited: ownPack.meta.limited,
    },
    none: { names: nonePack.files.map((f) => f.name).filter((n) => n !== 'repo.bundle'), limited: nonePack.meta.limited },
    applied: { head: applied.head === cloneHead, branch: applied.branch, clonedFrom: applied.clonedFrom === w.targetBase, patched: applied.patched, untracked: applied.untracked },
    target: {
      status: execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dest, env: gitChildEnv(env) }).toString('utf8').split('\n').filter(Boolean).sort(),
      log: git(dest, ['log', '--format=%s', '-4']).split('\n'),
      origin: git(dest, ['remote', 'get-url', 'origin']),
      a: fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'),
      foreign: fs.existsSync(path.join(dest, 'foreign.txt')),
      files: listing(w.targetTaskDir).filter((p) => !p.startsWith('marina')),
      filesSteps: files.steps,
    },
  }
}

describe('a task moves with exactly its own work', () => {
  it('imported and inlined factories agree, and carry the task-dir clone, its files, and none of the shared checkout\'s', async () => {
    const imported = await run(createTransferPack, 'imported')
    const inlined = await run(strict(createTransferPack), 'inlined')
    expect(inlined).toEqual(imported)

    expect(imported.scan).toEqual({ repos: ['marina', 'reference'], loose: 2, sample: ['drafts/reply.md', 'plan.md'] })
    // The clone: two commits of its own plus the shared checkout's unpushed one, measured
    // against the remote the shared checkout tracks, never against the shared checkout's branch.
    expect(imported.repo).toEqual({
      names: ['meta.json', 'changes.patch', 'untracked.tgz', 'repo.bundle'], ahead: 3, upstreamUrl: URL, headOnRemote: false, dirty: true,
    })
    // A reference clone with nothing of the task's own is only its meta.
    expect(imported.ref).toEqual({ names: ['meta.json'], headOnRemote: true, dirty: false })
    expect(imported.filesKind).toBe('dir')
    // The shared checkout: only the file this task changed rides; the foreign ones are counted, not carried.
    expect(imported.own.patch).toEqual(['diff --git a/own.txt b/own.txt'])
    expect(imported.own.names).not.toContain('untracked.tgz')
    expect(imported.own.limited).toMatchObject({ paths: 1, leftOutTracked: 1, leftOutUntracked: 1 })
    expect(imported.own.limited?.leftOut.sort()).toEqual(['a.txt', 'foreign.txt'])
    // Own files unknown: the committed state only.
    expect(imported.none.names).toEqual(['meta.json'])
    expect(imported.none.limited).toMatchObject({ paths: 0, leftOutTracked: 2, leftOutUntracked: 1 })

    expect(imported.applied).toEqual({ head: true, branch: 'wt/T1', clonedFrom: true, patched: true, untracked: 1 })
    expect(imported.target.status).toEqual([' M b.txt', '?? scratch/notes.txt'])
    expect(imported.target.log).toEqual(['task commit 2', 'task commit 1', 'landed, not pushed', 'base'])
    expect(imported.target.origin).toBe(URL)
    expect(imported.target.a).toBe('a1\n')
    expect(imported.target.foreign).toBe(false)
    expect(imported.target.files).toEqual(['drafts', 'drafts/reply.md', 'plan.md'])
  }, 120_000)

  it('apply refuses a folder that already holds something, and never writes into it', async () => {
    const w = world('occupied')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
    await packer.pack({ cwd: w.clone, outDir: path.join(w.root, 'p') })
    const dest = path.join(w.targetTaskDir, 'marina')
    write(path.join(dest, 'keep.txt'), 'the user\'s\n')
    await expect(packer.apply({ dest, bundleDir: path.join(w.root, 'p'), cloneFrom: w.targetBase })).rejects.toMatchObject({ code: 'dest_not_empty' })
    expect(fs.readdirSync(dest)).toEqual(['keep.txt'])
  }, 60_000)

  it('a failed apply removes only what it made: a missing folder is gone again, an empty one stays empty', async () => {
    const w = world('failclean')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
    await packer.pack({ cwd: w.clone, outDir: path.join(w.root, 'p') })
    // A clone source of another history, and no remote holding the bundle's base: fetching the bundle fails.
    const empty = path.join(w.root, 'other')
    fs.mkdirSync(empty, { recursive: true })
    git(empty, ['init', '-q'])
    write(path.join(empty, 'x.txt'), 'other\n')
    git(empty, ['add', '-A'])
    git(empty, ['commit', '-q', '-m', 'other history'])
    const missing = path.join(w.targetTaskDir, 'gone')
    const err1 = await packer.apply({ dest: missing, bundleDir: path.join(w.root, 'p'), cloneFrom: empty }).catch((e: unknown) => e as { code?: string; data?: Record<string, unknown> })
    expect(err1).toMatchObject({ code: 'apply_failed', data: { removed: true } })
    expect(fs.existsSync(missing)).toBe(false)
    const kept = path.join(w.targetTaskDir, 'kept')
    fs.mkdirSync(kept, { recursive: true })
    await expect(packer.apply({ dest: kept, bundleDir: path.join(w.root, 'p'), cloneFrom: empty })).rejects.toMatchObject({ code: 'apply_failed' })
    expect(fs.readdirSync(kept)).toEqual([])
    // A refusal for an occupied folder removes nothing (see the test above); neither does one for bad input.
    write(path.join(w.targetTaskDir, 'busy', 'keep.txt'), 'x\n')
    await expect(packer.apply({ dest: path.join(w.targetTaskDir, 'busy'), bundleDir: path.join(w.root, 'p'), cloneFrom: empty })).rejects.toMatchObject({ code: 'dest_not_empty' })
    expect(fs.readdirSync(path.join(w.targetTaskDir, 'busy'))).toEqual(['keep.txt'])
  }, 60_000)

  it('a folder over the size cap never sets up as an empty copy, and a probe of a plain folder archives nothing', async () => {
    const w = world('toolarge')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
    write(path.join(w.root, 'notes', 'big.bin'), crypto.randomBytes(64 * 1024).toString('base64'))
    const big = await packer.pack({ cwd: path.join(w.root, 'notes'), outDir: path.join(w.root, 'pb'), asDir: true, maxTarBytes: 1024 })
    expect(big.meta.tooLarge).toBe(true)
    const dest = path.join(w.targetTaskDir, 'notes')
    await expect(packer.apply({ dest, bundleDir: path.join(w.root, 'pb') })).rejects.toMatchObject({ code: 'too_large' })
    expect(fs.existsSync(dest)).toBe(false)
    const probe = await packer.pack({ cwd: path.join(w.root, 'notes'), outDir: path.join(w.root, 'pp'), paths: [] })
    expect(probe.meta.kind).toBe('dir')
    expect(probe.files.map((f) => f.name)).toEqual(['meta.json'])
  }, 60_000)

  it('clear backs up and clears exactly the moved files of a shared checkout, only those that hold this task\'s change alone', async () => {
    const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex')
    for (const [label, factory] of [['imported', createTransferPack], ['inlined', strict(createTransferPack)]] as const) {
      const w = world(`clear-${label}`)
      const packer = factory({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
      // The task's own files in the shared checkout: an edit (own.txt), a new file, one a peer
      // touches after the pack (b.txt), one a peer had edited before the task did (a.txt), and
      // an ignored file the session wrote (secret.env: never packed, so never cleared).
      write(path.join(w.shared, 'mine-new.txt'), 'the task\'s new file\n')
      write(path.join(w.shared, 'b.txt'), 'the task edited b\n')
      write(path.join(w.shared, 'a.txt'), 'FOREIGN edit\nand the task\'s line\n')
      write(path.join(w.shared, '.git', 'info', 'exclude'), 'secret.env\n')
      write(path.join(w.shared, 'secret.env'), 'TOKEN=x\n')
      const ownBefore = { 'own.txt': sha('own1\n'), 'mine-new.txt': sha(''), 'b.txt': sha('b1\n'), 'a.txt': sha('FOREIGN edit\n'), 'secret.env': sha('') }
      const out = path.join(w.root, 'pk')
      const paths = ['own.txt', 'mine-new.txt', 'b.txt', 'a.txt', 'secret.env']
      const pk = await packer.pack({ cwd: w.shared, outDir: out, paths, ownBefore })
      const byPath = Object.fromEntries((pk.meta.limited?.files ?? []).map((f) => [f.path, f]))
      expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'b.txt', 'mine-new.txt', 'own.txt'])
      expect(byPath['a.txt']).toMatchObject({ clearable: false, why: 'it held other edits before this task changed it' })
      expect(byPath['own.txt']).toMatchObject({ clearable: true, inHead: true })
      expect(byPath['mine-new.txt']).toMatchObject({ clearable: true, inHead: false })
      write(path.join(w.shared, 'b.txt'), 'a peer wrote b after the pack\n')
      const backupTo = path.join(w.taskDir, 'moved-out', 'x')
      const res = await packer.clear({ root: w.shared, files: pk.meta.limited!.files, backupFrom: out, backupTo })
      expect(res.cleared.sort()).toEqual(['mine-new.txt', 'own.txt'])
      expect(res.kept.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
        { path: 'a.txt', reason: 'it held other edits before this task changed it' },
        { path: 'b.txt', reason: 'changed since the move packed it' },
      ])
      expect(fs.readFileSync(path.join(w.shared, 'own.txt'), 'utf8')).toBe('own1\n')
      expect(fs.existsSync(path.join(w.shared, 'mine-new.txt'))).toBe(false)
      expect(fs.readFileSync(path.join(w.shared, 'b.txt'), 'utf8')).toBe('a peer wrote b after the pack\n')
      expect(fs.readFileSync(path.join(w.shared, 'a.txt'), 'utf8')).toBe('FOREIGN edit\nand the task\'s line\n')
      expect(fs.readFileSync(path.join(w.shared, 'secret.env'), 'utf8')).toBe('TOKEN=x\n')
      expect(fs.existsSync(path.join(w.shared, 'foreign.txt'))).toBe(true)
      expect(fs.readdirSync(backupTo).sort()).toEqual(['README.txt', 'changes.patch', 'meta.json', 'untracked.tgz'])
      const readme = fs.readFileSync(path.join(backupTo, 'README.txt'), 'utf8')
      expect(readme).toContain('Kept:\n  a.txt (it held other edits')
      expect(readme).toContain('apply --3way')
      // The backup puts the cleared files back.
      git(w.shared, ['apply', path.join(backupTo, 'changes.patch'), '--include=own.txt'])
      expect(fs.readFileSync(path.join(w.shared, 'own.txt'), 'utf8')).toBe('own2 by this task\n')
      execFileSync('tar', ['-xzf', path.join(backupTo, 'untracked.tgz'), '-C', w.shared, '--keep-old-files'], { stdio: 'pipe' })
      expect(fs.readFileSync(path.join(w.shared, 'mine-new.txt'), 'utf8')).toBe('the task\'s new file\n')
      // A second clear into the same backup folder is refused before it touches anything.
      await expect(packer.clear({ root: w.shared, files: pk.meta.limited!.files, backupFrom: out, backupTo })).rejects.toMatchObject({ code: 'dest_not_empty' })
      await expect(packer.clear({ root: w.shared, files: [{ path: '../x', sha256: null, inHead: false, clearable: true }], backupFrom: out, backupTo: path.join(w.root, 'b3') })).rejects.toMatchObject({ code: 'bad_request' })
    }
  }, 120_000)

  it('new files past the size cap did not move, so they are never cleared; without ownBefore nothing is', async () => {
    const w = world('clear-cap')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
    write(path.join(w.shared, 'big-new.txt'), 'x'.repeat(4096))
    const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex')
    const out = path.join(w.root, 'pk')
    const pk = await packer.pack({ cwd: w.shared, outDir: out, paths: ['own.txt', 'big-new.txt'], ownBefore: { 'own.txt': sha('own1\n'), 'big-new.txt': sha('') }, maxUntrackedBytes: 100 })
    expect(pk.meta.untracked?.skippedCount).toBe(1)
    expect(pk.meta.limited?.files?.map((f) => f.path)).toEqual(['own.txt'])
    const none = await packer.pack({ cwd: w.shared, outDir: path.join(w.root, 'pk2'), paths: ['own.txt'] })
    expect(none.meta.limited?.files).toEqual([expect.objectContaining({ path: 'own.txt', clearable: false, why: 'which edits are this task\'s is unknown' })])
    const res = await packer.clear({ root: w.shared, files: none.meta.limited!.files, backupFrom: path.join(w.root, 'pk2'), backupTo: path.join(w.root, 'bk') })
    expect(res.cleared).toEqual([])
    expect(fs.readFileSync(path.join(w.shared, 'own.txt'), 'utf8')).toBe('own2 by this task\n')
    expect(fs.existsSync(path.join(w.shared, 'big-new.txt'))).toBe(true)
  }, 60_000)

  it('apply without a checkout or URL to clone from says so', async () => {
    const w = world('nosource')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
    await packer.pack({ cwd: w.clone, outDir: path.join(w.root, 'p') })
    await expect(packer.apply({ dest: path.join(w.targetTaskDir, 'marina'), bundleDir: path.join(w.root, 'p') }))
      .rejects.toMatchObject({ code: 'apply_failed', message: expect.stringContaining('no checkout of this repository') })
  }, 60_000)

  it('paths and exclude refuse anything but relative paths', async () => {
    const w = world('badpaths')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp })
    for (const bad of [['/etc/passwd'], ['../x'], ['a/../../x'], ['a\u0000b']]) {
      await expect(packer.pack({ cwd: w.shared, outDir: path.join(w.root, 'p'), paths: bad })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(packer.pack({ cwd: w.taskDir, outDir: path.join(w.root, 'p'), asDir: true, exclude: bad })).rejects.toMatchObject({ code: 'bad_request' })
    }
  }, 60_000)
})
