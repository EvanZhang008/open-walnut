/**
 * transfer.pack against REAL git repos and folders in a temp dir: what the
 * receiving host gets must rebuild the sender's workspace exactly (the patch
 * applies onto a fresh clone, the untracked archive extracts the files, the
 * bundle carries the commits no remote has).
 *
 * MACHINE SAFETY: every repo, remote and output lives under one temp dir, git
 * runs with a temp global config and no inherited GIT_DIR (gitChildEnv), and
 * the core's spawn refuses any cwd outside the temp dir.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { createTransferPack, type TransferPackDeps } from '../../src/providers/transfer-pack-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transfer-pack-')))
afterAll(() => { if (tmp.includes('walnut-transfer-pack-')) fs.rmSync(tmp, { recursive: true, force: true }) })
const gitconfig = path.join(tmp, 'gitconfig')
fs.writeFileSync(gitconfig, '[user]\n\tname = Packer\n\temail = packer@example.com\n[init]\n\tdefaultBranch = main\n')
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' }
const gitEnv = gitChildEnv(env)

const packer = createTransferPack({
  fs, path, crypto, env, home: tmp,
  spawn: ((cmd: string, args: string[], o: Record<string, unknown>) => {
    if (!String(o.cwd).startsWith(tmp)) throw new Error('spawn outside the temp dir: ' + String(o.cwd))
    return spawn(cmd, args, o)
  }) as unknown as TransferPackDeps['spawn'],
})

let n = 0
function dir(name: string): string {
  const d = path.join(tmp, String(++n) + '-' + name)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString('utf8').trim()
const write = (p: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const BIN_A = Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 10, 13, 0, 7])
const BIN_B = crypto.randomBytes(3000)

/** A bare remote plus a clone with one commit pushed to it (upstream set). */
function pushedRepo(name: string): { root: string; remote: string; work: string } {
  const root = dir(name)
  const remote = path.join(root, 'remote.git')
  git(root, ['init', '-q', '--bare', remote])
  const work = path.join(root, 'work')
  git(root, ['clone', '-q', remote, work])
  write(path.join(work, 'src/a.txt'), 'a1\na2\na3\n')
  write(path.join(work, 'keep.txt'), 'keep\n')
  write(path.join(work, 'gone.txt'), 'to be deleted\n')
  write(path.join(work, 'img.bin'), BIN_A)
  write(path.join(work, '.gitignore'), 'node_modules/\n*.log\n')
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'first'])
  git(work, ['push', '-q', '-u', 'origin', 'main'])
  return { root, remote, work }
}

/** Every file under `d` except .git, as relative path -> sha256. */
function tree(d: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.name === '.git') continue
      if (e.isDirectory()) walk(r)
      else out[r] = sha(path.join(d, r))
    }
  }
  walk('')
  return out
}

function tarList(file: string): string[] {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map((l) => l.replace(/^\.\//, '')).filter((l) => l && l !== '.' && !l.endsWith('/')).sort()
}

describe('transfer.pack: git repos', () => {
  it('a clean repo whose HEAD is pushed: meta only, no bundle', async () => {
    const { root, work, remote } = pushedRepo('clean')
    const out = path.join(root, 'out')
    const r = await packer.pack({ cwd: path.join(work, 'src'), outDir: out })
    expect(r.files.map((f) => f.name)).toEqual(['meta.json'])
    expect(r.meta).toMatchObject({
      kind: 'git', root: work, relCwd: 'src', branch: 'main', head: git(work, ['rev-parse', 'HEAD']),
      upstream: 'origin/main', headOnRemote: true, dirty: false, bundle: null,
      remotes: [{ name: 'origin', url: remote }], untracked: { count: 0, bytes: 0, skipped: [] },
    })
    expect(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'))).toEqual(r.meta)
    expect(r.files[0].sha256).toBe(sha(path.join(out, 'meta.json')))
  })

  it('a dirty repo (staged, unstaged, deleted, untracked, binary) rebuilds exactly on a fresh clone', async () => {
    const { root, work, remote } = pushedRepo('dirty')
    write(path.join(work, 'src/a.txt'), 'a1\nCHANGED\na3\n') // unstaged
    write(path.join(work, 'staged.txt'), 'staged new file\n')
    git(work, ['add', 'staged.txt']) // staged add
    write(path.join(work, 'keep.txt'), 'keep, staged edit\n')
    git(work, ['add', 'keep.txt'])
    write(path.join(work, 'keep.txt'), 'keep, staged edit\nthen unstaged on top\n') // both
    fs.rmSync(path.join(work, 'gone.txt')) // deletion
    write(path.join(work, 'img.bin'), BIN_B) // binary change
    write(path.join(work, 'notes/todo.md'), 'untracked é\n') // untracked, nested
    write(path.join(work, 'raw.dat'), crypto.randomBytes(2048)) // untracked binary
    write(path.join(work, 'node_modules/x/index.js'), 'ignored\n')
    write(path.join(work, 'debug.log'), 'ignored\n')
    // A list line starting with `-` must stay a file name for tar, never an option.
    write(path.join(work, '--checkpoint=1'), 'odd name\n')
    const out = path.join(root, 'out')
    const r = await packer.pack({ cwd: work, outDir: out })
    expect(r.files.map((f) => f.name)).toEqual(['meta.json', 'changes.patch', 'untracked.tgz'])
    expect(r.meta.dirty).toBe(true)
    expect(r.meta.headOnRemote).toBe(true)
    expect(r.meta.bundle).toBeNull()
    expect(r.meta.untracked!.count).toBe(3)
    for (const f of r.files) {
      expect(f.sha256).toBe(sha(path.join(out, f.name)))
      expect(f.size).toBe(fs.statSync(path.join(out, f.name)).size)
    }
    expect(tarList(path.join(out, 'untracked.tgz'))).toEqual(['--checkpoint=1', 'notes/todo.md', 'raw.dat'])

    const clone = path.join(root, 'clone')
    git(root, ['clone', '-q', remote, clone])
    git(clone, ['apply', '--index', '--binary', path.join(out, 'changes.patch')])
    execFileSync('tar', ['-xzf', path.join(out, 'untracked.tgz')], { cwd: clone })
    const expected = tree(work)
    delete expected['node_modules/x/index.js']
    delete expected['debug.log']
    expect(tree(clone)).toEqual(expected)
  })

  it('commits no remote has go in a bundle from the merge base', async () => {
    const { root, work, remote } = pushedRepo('ahead')
    const base = git(work, ['rev-parse', 'HEAD'])
    write(path.join(work, 'src/a.txt'), 'second\n')
    git(work, ['commit', '-q', '-am', 'second'])
    write(path.join(work, 'img.bin'), BIN_B)
    git(work, ['commit', '-q', '-am', 'third'])
    const head = git(work, ['rev-parse', 'HEAD'])
    const out = path.join(root, 'out')
    const r = await packer.pack({ cwd: work, outDir: out })
    expect(r.meta).toMatchObject({ headOnRemote: false, head, dirty: false, bundle: { base } })
    expect(r.files.map((f) => f.name)).toEqual(['meta.json', 'repo.bundle'])
    const clone = path.join(root, 'clone')
    git(root, ['clone', '-q', remote, clone])
    expect(git(clone, ['rev-parse', 'HEAD'])).toBe(base)
    git(clone, ['bundle', 'verify', path.join(out, 'repo.bundle')])
    git(clone, ['fetch', '-q', path.join(out, 'repo.bundle'), 'refs/heads/main:refs/heads/moved'])
    expect(git(clone, ['rev-parse', 'moved'])).toBe(head)
  })

  it('a repo with no remote at all gets a full bundle', async () => {
    const root = dir('noremote')
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    git(work, ['init', '-q'])
    write(path.join(work, 'x.txt'), 'x\n')
    git(work, ['add', '-A'])
    git(work, ['commit', '-q', '-m', 'only'])
    const r = await packer.pack({ cwd: work, outDir: path.join(root, 'out') })
    expect(r.meta).toMatchObject({ headOnRemote: false, remotes: [], upstream: null, bundle: {} })
    const clone = path.join(root, 'clone')
    git(root, ['clone', '-q', path.join(root, 'out', 'repo.bundle'), clone])
    expect(git(clone, ['rev-parse', 'HEAD'])).toBe(git(work, ['rev-parse', 'HEAD']))
  })

  it('a detached HEAD has no branch', async () => {
    const { root, work } = pushedRepo('detached')
    git(work, ['checkout', '-q', '--detach'])
    const r = await packer.pack({ cwd: work, outDir: path.join(root, 'out') })
    expect(r.meta.branch).toBeNull()
    expect(r.meta.headOnRemote).toBe(true)
  })

  it('a repo with no commit yet: no patch, no bundle, every file in untracked.tgz', async () => {
    const root = dir('nocommit')
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    git(work, ['init', '-q'])
    write(path.join(work, 'staged.txt'), 'staged\n')
    git(work, ['add', 'staged.txt'])
    write(path.join(work, 'loose.txt'), 'loose\n')
    write(path.join(work, '.gitignore'), 'skip.me\n')
    write(path.join(work, 'skip.me'), 'ignored\n')
    const out = path.join(root, 'out')
    const r = await packer.pack({ cwd: work, outDir: out })
    expect(r.meta).toMatchObject({ kind: 'git', noCommits: true, head: null, branch: 'main', bundle: null, dirty: true })
    expect(r.files.map((f) => f.name)).toEqual(['meta.json', 'untracked.tgz'])
    expect(tarList(path.join(out, 'untracked.tgz'))).toEqual(['.gitignore', 'loose.txt', 'staged.txt'])
  })

  it('untracked files over the cap are skipped and listed, not packed', async () => {
    const { root, work } = pushedRepo('overcap')
    write(path.join(work, 'big1.dat'), crypto.randomBytes(6000))
    write(path.join(work, 'big2.dat'), crypto.randomBytes(6000))
    const r = await packer.pack({ cwd: work, outDir: path.join(root, 'out'), maxUntrackedBytes: 10_000 })
    expect(r.files.map((f) => f.name)).toEqual(['meta.json'])
    expect(r.meta.untracked).toMatchObject({ count: 2, bytes: 12_000, skipped: ['big1.dat', 'big2.dat'], skippedCount: 2 })
    expect(r.meta.dirty).toBe(true)
  })

  it('refuses an outDir inside the workspace, and a stale output is cleared', async () => {
    const { root, work } = pushedRepo('inside')
    await expect(packer.pack({ cwd: work, outDir: path.join(work, 'out') })).rejects.toMatchObject({ code: 'bad_request' })
    const out = path.join(root, 'out')
    write(path.join(out, 'repo.bundle'), 'stale from an earlier pack')
    const r = await packer.pack({ cwd: work, outDir: out })
    expect(r.files.map((f) => f.name)).toEqual(['meta.json'])
    expect(fs.existsSync(path.join(out, 'repo.bundle'))).toBe(false)
  })

  it('refuses a cwd that is not a folder and a relative path', async () => {
    await expect(packer.pack({ cwd: path.join(tmp, 'nope'), outDir: path.join(tmp, 'o1') })).rejects.toMatchObject({ code: 'not_found' })
    await expect(packer.pack({ cwd: 'relative/dir', outDir: path.join(tmp, 'o2') })).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('transfer.pack: plain folders', () => {
  it('tars the folder without build output and dependency dirs', async () => {
    const root = dir('plain')
    const work = path.join(root, 'work')
    write(path.join(work, 'main.py'), 'print(1)\n')
    write(path.join(work, 'lib/util.py'), 'x = 1\n')
    write(path.join(work, 'node_modules/a/index.js'), 'dep\n')
    write(path.join(work, 'lib/node_modules/b.js'), 'nested dep\n')
    write(path.join(work, '.venv/bin/python'), 'venv\n')
    write(path.join(work, 'dist/out.js'), 'built\n')
    write(path.join(work, 'lib/__pycache__/util.pyc'), 'cache\n')
    write(path.join(work, 'target/debug/app'), 'rust\n')
    const out = path.join(root, 'out')
    const r = await packer.pack({ cwd: '~/' + path.relative(tmp, work), outDir: out })
    expect(r.meta).toMatchObject({ kind: 'dir', root: work, relCwd: '' })
    expect(r.meta.tooLarge).toBeUndefined()
    expect(r.files.map((f) => f.name)).toEqual(['meta.json', 'workspace.tgz'])
    expect(tarList(path.join(out, 'workspace.tgz'))).toEqual(['lib/util.py', 'main.py'])
    expect(r.meta.tarBytes).toBe(fs.statSync(path.join(out, 'workspace.tgz')).size)
  })

  it('a folder over maxTarBytes is cut, deleted and marked tooLarge', async () => {
    const root = dir('huge')
    const work = path.join(root, 'work')
    write(path.join(work, 'noise.bin'), crypto.randomBytes(400_000))
    const out = path.join(root, 'out')
    const r = await packer.pack({ cwd: work, outDir: out, maxTarBytes: 50_000 })
    expect(r.meta.tooLarge).toBe(true)
    expect(r.meta.tarBytes).toBeGreaterThan(50_000)
    expect(r.files.map((f) => f.name)).toEqual(['meta.json'])
    expect(fs.existsSync(path.join(out, 'workspace.tgz'))).toBe(false)
  })
})
