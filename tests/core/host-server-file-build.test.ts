/**
 * The clone build of a host's walnut file (src/core/host-server/host-file-build.ts),
 * for real: a git checkout in a temp dir, real git, and a stand-in for
 * scripts/build-binary.mjs (run by a stand-in bun that is this test's own
 * runtime) that writes what it saw as the "file". What is checked: the files are
 * built from the dist's commit (not a newer HEAD, never the checkout's
 * uncommitted changes), every target asked in one run, against the checkout's
 * dependencies but the clone's own workspace packages and the running dist's web
 * app; the checkout itself is never touched; a build past its deadline is ended
 * with every process it started; a build dir a stopped server left is removed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildFileInClone, findBun, linkDependencies, packageJsonAt, pinnedBun, pruneAbandonedWork, WORK_OWNER, BUILD_MS,
} from '../../src/core/host-server/host-file-build.js'
import type { HostFileTarget } from '../../src/core/host-server/host-target.js'
import { gitChildEnv } from '../../src/lib/git-env.js'

let dir = ''
let repo = ''
let bun = ''

const git = (args: string[], cwd = repo) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: gitChildEnv(), encoding: 'utf8' }).trim()

/** What the stand-in build writes as the file: what it found in its tree. */
const BUILD_SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const targets = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--target' ? [a] : []))
if (fs.existsSync('FAIL')) { console.error('bundle failed: ' + fs.readFileSync('FAIL', 'utf8')); process.exit(3) }
if (fs.existsSync('HANG')) {
  // A compiler child that would outlive a kill of this process alone.
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  fs.writeFileSync(fs.readFileSync('HANG', 'utf8').trim(), String(child.pid))
  setInterval(() => {}, 1000)
} else {
const real = (p) => { try { return fs.realpathSync(p) } catch { return null } }
const seen = {
  args: process.argv.slice(2), cwd: process.cwd(),
  a: fs.readFileSync('src/a.txt', 'utf8'),
  added: fs.existsSync('src/new.txt') ? fs.readFileSync('src/new.txt', 'utf8') : null,
  web: fs.existsSync('dist/web/static/index.html') ? fs.readFileSync('dist/web/static/index.html', 'utf8') : null,
  dep: real('node_modules/dep'), api: real('node_modules/@open-walnut/plugin-api'), other: real('node_modules/@open-walnut/other'),
  webModules: real('web/node_modules'),
}
fs.mkdirSync('dist-bin', { recursive: true })
for (const t of targets) fs.writeFileSync(path.join('dist-bin', 'walnut-' + t), JSON.stringify({ ...seen, target: t }))
}
`

function write(rel: string, text: string, root = repo): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsfb-')))
  repo = path.join(dir, 'checkout')
  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  write('package.json', JSON.stringify({ name: 'open-walnut', version: '0.6.14', workspaces: ['packages/plugin-api'] }))
  write('packages/plugin-api/package.json', JSON.stringify({ name: '@open-walnut/plugin-api' }))
  write('scripts/build-binary.mjs', BUILD_SCRIPT)
  write('src/a.txt', 'v1')
  write('web/index.html', '<html>')
  write('.gitignore', 'node_modules/\ndist/\ndist-bin/\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'one'])
  // The checkout's installed dependencies (never in git): a package, the workspace
  // package linked as bun links it, a scoped package that is not a workspace.
  write('node_modules/dep/index.js', '')
  fs.mkdirSync(path.join(repo, 'node_modules', '@open-walnut'), { recursive: true })
  fs.symlinkSync('../../packages/plugin-api', path.join(repo, 'node_modules', '@open-walnut', 'plugin-api'))
  write('node_modules/@open-walnut/other/index.js', '')
  write('web/node_modules/vite/index.js', '')
  // The running dist and the web app it serves.
  write('dist/web/static/index.html', '<html>served</html>')
  // A stand-in bun: this test's own runtime runs the script.
  bun = path.join(dir, 'bin', 'bun')
  write('bin/bun', `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`, dir)
  fs.chmodSync(bun, 0o755)
})

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function buildOnce(commit: string, targets: HostFileTarget[] = ['linux-x64']) {
  const work = fs.mkdtempSync(path.join(dir, 'work-'))
  const log = path.join(dir, 'build.log')
  const files = await buildFileInClone({ checkout: repo, distDir: path.join(repo, 'dist'), commit, targets, work, log, bun })
  const file = files[targets[0]!]!
  return { files, file, work, log, seen: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any> }
}

describe('the clone build', () => {
  it('builds the dist\'s commit, not a newer HEAD, and leaves the checkout as it was', async () => {
    const built = git(['rev-parse', '--short', 'HEAD'])
    write('src/a.txt', 'v2')
    git(['commit', '-qam', 'two'])
    const before = git(['status', '--porcelain', '--ignored'])
    const { file, work, seen } = await buildOnce(built)
    expect(file).toBe(path.join(work, 'tree', 'dist-bin', 'walnut-linux-x64'))
    expect(seen.a).toBe('v1')
    expect(seen.added).toBeNull()
    expect(seen.args).toEqual(['--target', 'linux-x64', '--reuse-web'])
    expect(seen.cwd).toBe(path.join(work, 'tree'))
    // The web app the server serves, the checkout's dependencies, the clone's own workspace package.
    expect(seen.web).toBe('<html>served</html>')
    expect(seen.dep).toBe(path.join(repo, 'node_modules', 'dep'))
    expect(seen.other).toBe(path.join(repo, 'node_modules', '@open-walnut', 'other'))
    expect(seen.api).toBe(path.join(work, 'tree', 'packages', 'plugin-api'))
    expect(seen.webModules).toBe(path.join(repo, 'web', 'node_modules'))
    expect(git(['status', '--porcelain', '--ignored'])).toBe(before)
    expect(fs.existsSync(path.join(repo, 'dist-bin'))).toBe(false)
    expect(fs.readdirSync(path.join(repo, 'node_modules', '@open-walnut')).sort()).toEqual(['other', 'plugin-api'])
  })

  it('the checkout\'s uncommitted changes never reach the file', async () => {
    const commit = git(['rev-parse', '--short', 'HEAD'])
    write('src/a.txt', 'v3 (not committed)')
    write('src/new.txt', 'a new file')
    const { seen } = await buildOnce(commit)
    expect(seen.a).toBe('v1')
    expect(seen.added).toBeNull()
    expect(git(['status', '--porcelain'])).toBe('M src/a.txt\n?? src/new.txt')
  })

  it('every target asked at once is one run', async () => {
    const { files, work, seen } = await buildOnce(git(['rev-parse', 'HEAD']), ['linux-x64', 'linux-arm64-musl'])
    expect(seen.args).toEqual(['--target', 'linux-x64', '--target', 'linux-arm64-musl', '--reuse-web'])
    expect(files).toEqual({
      'linux-x64': path.join(work, 'tree', 'dist-bin', 'walnut-linux-x64'),
      'linux-arm64-musl': path.join(work, 'tree', 'dist-bin', 'walnut-linux-arm64-musl'),
    })
    expect(JSON.parse(fs.readFileSync(files['linux-arm64-musl']!, 'utf8')).target).toBe('linux-arm64-musl')
  })

  it('a build past its deadline is ended with the processes it started', async () => {
    const pidFile = path.join(dir, 'grandchild.pid')
    write('HANG', pidFile)
    git(['add', 'HANG'])
    git(['commit', '-qm', 'hangs'])
    const work = fs.mkdtempSync(path.join(dir, 'work-'))
    const started = Date.now()
    await expect(buildFileInClone({ checkout: repo, distDir: path.join(repo, 'dist'), commit: 'HEAD', targets: ['linux-x64'], work, log: path.join(dir, 'b.log'), bun, timeoutMs: 3_000 }))
      .rejects.toThrow(/failed \(it took too long\)/)
    expect(Date.now() - started).toBeLessThan(20_000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(1)
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      try { process.kill(pid, 0); spawnSync('sleep', ['0.1']) } catch { gone = true }
    }
    expect(gone).toBe(true)
  })

  it('without the running web app, the build makes its own', async () => {
    fs.rmSync(path.join(repo, 'dist'), { recursive: true, force: true })
    const { seen } = await buildOnce(git(['rev-parse', 'HEAD']), ['linux-arm64-musl'])
    expect(seen.args).toEqual(['--target', 'linux-arm64-musl'])
    expect(seen.web).toBeNull()
  })

  it('a failing build says how it ended and where its log is', async () => {
    write('FAIL', 'Could not resolve "missing-module"')
    git(['add', 'FAIL'])
    git(['commit', '-qm', 'broken'])
    const work = fs.mkdtempSync(path.join(dir, 'work-'))
    const log = path.join(dir, 'build.log')
    await expect(buildFileInClone({ checkout: repo, distDir: path.join(repo, 'dist'), commit: 'HEAD', targets: ['linux-x64'], work, log, bun }))
      .rejects.toThrow(new RegExp(`failed \\(exit 3\\): .*bundle failed: Could not resolve "missing-module".*the whole log is ${log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    expect(fs.readFileSync(log, 'utf8')).toMatch(/building the walnut file for linux-x64 from HEAD\n[\s\S]*bundle failed/)
  })

  it('a commit the checkout does not have fails at the checkout step', async () => {
    const work = fs.mkdtempSync(path.join(dir, 'work-'))
    await expect(buildFileInClone({ checkout: repo, distDir: path.join(repo, 'dist'), commit: 'deadbeef1', targets: ['linux-x64'], work, log: path.join(dir, 'b.log'), bun }))
      .rejects.toThrow(/git checkout failed/)
  })
})

describe('linkDependencies', () => {
  it('never writes into a node_modules that is already there (a link to the checkout\'s)', async () => {
    const tree = path.join(dir, 'tree')
    fs.mkdirSync(tree)
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(tree, 'package.json'))
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tree, 'node_modules'))
    const before = fs.readdirSync(path.join(repo, 'node_modules')).sort()
    await expect(linkDependencies(repo, tree)).rejects.toThrow(/already exists/)
    expect(fs.readdirSync(path.join(repo, 'node_modules')).sort()).toEqual(before)
  })
})

describe('findBun', () => {
  function fakeBun(name: string, version: string): string {
    const p = path.join(dir, name, 'bun')
    write(`${name}/bun`, `#!/bin/sh\necho ${version}\n`, dir)
    fs.chmodSync(p, 0o755)
    return p
  }

  it('takes $WALNUT_BUN first, else the first bun on PATH, of the pinned version or newer', async () => {
    const old = fakeBun('old', '1.3.9')
    const pinned = fakeBun('pinned', '1.4.4')
    const newer = fakeBun('newer', '1.5.0')
    expect(await findBun({ WALNUT_BUN: newer, PATH: path.dirname(pinned) }, '1.4.4', [], null)).toEqual({ path: newer, version: '1.5.0' })
    // Where findBun looks: only the stand-in buns' dirs.
    const lookIn = [path.join(dir, 'nothing'), path.dirname(old), path.dirname(pinned)].join(path.delimiter)
    expect(await findBun({ PATH: lookIn }, '1.4.4', [], null)).toEqual({ path: pinned, version: '1.4.4' })
    expect(await findBun({ PATH: path.dirname(old) }, null, [], null)).toEqual({ path: old, version: '1.3.9' })
  })

  it('an older bun only, or none, says so', async () => {
    const old = fakeBun('old', '1.3.9')
    const pick = await findBun({ PATH: path.dirname(old) }, '1.4.4', [], null)
    expect('why' in pick && pick.why).toMatch(new RegExp(`needs bun 1\\.4\\.4 or newer .*only 1\\.3\\.9 at ${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*WALNUT_BUN`))
    const none = await findBun({ PATH: path.join(dir, 'nothing') }, '1.4.4', [], null)
    expect('why' in none && none.why).toMatch(/needs bun on this computer/)
  })

  it('reads the pin from package.json', () => {
    expect(pinnedBun(JSON.stringify({ packageManager: 'bun@1.4.4' }))).toBe('1.4.4')
    expect(pinnedBun(JSON.stringify({ packageManager: 'npm@10.0.0' }))).toBeNull()
    expect(pinnedBun('not json')).toBeNull()
  })

  it('the pin is the commit\'s, not the working tree\'s', async () => {
    write('package.json', JSON.stringify({ name: 'open-walnut', version: '0.6.14', packageManager: 'bun@1.4.4' }))
    git(['commit', '-qam', 'pin'])
    const commit = git(['rev-parse', '--short', 'HEAD'])
    write('package.json', JSON.stringify({ name: 'open-walnut', version: '0.6.14', packageManager: 'bun@9.9.9' }))
    expect(pinnedBun(await packageJsonAt(repo, commit))).toBe('1.4.4')
  })
})

describe('pruneAbandonedWork', () => {
  it('removes the build dirs of a server that is gone, and old ones, never one in use', async () => {
    const tmp = path.join(dir, 'tmp')
    fs.mkdirSync(tmp)
    const make = (name: string, owner?: Record<string, unknown>) => {
      fs.mkdirSync(path.join(tmp, name, 'tree'), { recursive: true })
      if (owner) fs.writeFileSync(path.join(tmp, name, WORK_OWNER), JSON.stringify(owner))
    }
    // A pid that existed and is gone: a child this test ran to its end.
    const dead = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    const now = Date.now()
    make('walnut-host-file-dead', { pid: Number(dead), at: now })
    make('walnut-host-file-live', { pid: process.pid, at: now })
    make('walnut-host-file-old', { pid: process.pid, at: now - 3 * BUILD_MS })
    make('walnut-host-file-new') // being made: no owner file yet
    make('other-dir', { pid: Number(dead), at: now })
    const removed = await pruneAbandonedWork(tmp, 'walnut-host-file-', now)
    expect(removed.map((r) => path.basename(r)).sort()).toEqual(['walnut-host-file-dead', 'walnut-host-file-old'])
    expect(fs.readdirSync(tmp).sort()).toEqual(['other-dir', 'walnut-host-file-live', 'walnut-host-file-new'])
  })
})
