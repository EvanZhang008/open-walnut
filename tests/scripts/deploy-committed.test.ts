/**
 * scripts/deploy-committed.sh deploys a COMMIT, never the shared working tree:
 * it clones the commit into a temp dir, links the checkout's dependencies (the
 * npm workspace packages excepted: those must be the committed ones), and runs
 * the clone's dev-prod.sh with WALNUT_DEVPROD_SERVE_ROOT pointing back at the
 * checkout. The tests below turn the deploy's node_modules mirror off unless they pin it. Pinned here against a throwaway repo whose dev-prod.sh is a stub that
 * reports what it saw, so nothing is built and no server is touched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { guardedPath } from '../setup/exec-guard-core.js'

const WRAPPER = path.join(import.meta.dirname, '..', '..', 'scripts', 'deploy-committed.sh')
const ROOT = path.join(import.meta.dirname, '..', '..')
const roots: string[] = []

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitChildEnv(), stdio: 'pipe' }).toString().trim()

/** The stub records where it ran and what the workspace and dependency links resolve to. */
const STUB = `#!/usr/bin/env bash
# knows WALNUT_DEVPROD_SERVE_ROOT
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd -P)"
{
  echo "serve=$WALNUT_DEVPROD_SERVE_ROOT"
  echo "here=$here"
  echo "cwd=$(pwd -P)"
  echo "ws=$(cd node_modules/@acme/lib && pwd -P)"
  echo "ws_file=$(cat node_modules/@acme/lib/index.js)"
  echo "dep=$(cd node_modules/leftpad && pwd -P)"
  echo "scoped_dep=$(cd node_modules/@acme/other && pwd -P)"
  echo "web_dep=$(cd web/node_modules && pwd -P)"
  echo "app=$(cat app.txt)"
  echo "dry=\${WALNUT_DEVPROD_DRY_RUN:-}"
  echo "sqlite=$(cat vendor/sqlite/darwin/stamp.json 2>/dev/null || echo none)"
  echo "sqlite_link=$([ -L vendor/sqlite ] && echo yes || echo no)"
} > "$WALNUT_TEST_REPORT"
`

function fixture(opts: { stub?: string } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-committed-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'packages', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'open-walnut', workspaces: ['packages/lib'] }))
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'package.json'), JSON.stringify({ name: '@acme/lib' }))
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'index.js'), 'committed lib\n')
  fs.writeFileSync(path.join(repo, 'web', 'index.html'), '<p>app</p>\n')
  fs.writeFileSync(path.join(repo, 'app.txt'), 'committed app\n')
  fs.copyFileSync(WRAPPER, path.join(repo, 'scripts', 'deploy-committed.sh'))
  fs.writeFileSync(path.join(repo, 'scripts', 'dev-prod.sh'), opts.stub ?? STUB)
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  // The checkout's dependencies, as npm lays them out: a workspace link into its own packages/.
  fs.mkdirSync(path.join(repo, 'node_modules', 'leftpad'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules', '@acme', 'other'), { recursive: true })
  fs.symlinkSync('../../packages/lib', path.join(repo, 'node_modules', '@acme', 'lib'))
  fs.mkdirSync(path.join(repo, 'web', 'node_modules'), { recursive: true })
  // A peer's uncommitted edits: neither may reach the build.
  fs.writeFileSync(path.join(repo, 'app.txt'), 'half-written app\n')
  fs.writeFileSync(path.join(repo, 'packages', 'lib', 'index.js'), 'half-written lib\n')
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(tmp)
  return { repo, tmp, report: path.join(root, 'report.txt') }
}

function run(f: ReturnType<typeof fixture>, env: Record<string, string> = {}, args: string[] = []) {
  const r = spawnSync('bash', [path.join(f.repo, 'scripts', 'deploy-committed.sh'), ...args], {
    cwd: f.repo,
    encoding: 'utf-8',
    // Never read the real production server: a config file stands in for it. The deploy
    // itself, not its queue (tests/scripts/deploy-queue.test.ts), is what these pin.
    env: { ...gitChildEnv(), TMPDIR: f.tmp, WALNUT_TEST_REPORT: f.report, WALNUT_DEPLOY_CONFIG_URL: `file://${f.tmp}/no-config.json`, WALNUT_DEPLOY_QUEUE: '0', WALNUT_DEPLOY_DEPS_MIRROR: '0', WALNUT_DEPLOY_DEPS_DIR: path.join(f.tmp, '..', 'deps'), ...env },
  })
  const report = fs.existsSync(f.report)
    ? Object.fromEntries(fs.readFileSync(f.report, 'utf-8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    : null
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report }
}

describe('deploy-committed.sh', () => {
  it('builds the committed tree in a clone and serves as the checkout', () => {
    const f = fixture()
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const rep = r.report!
    expect(rep.serve).toBe(f.repo)
    expect(rep.here).toMatch(new RegExp(`^${f.tmp}/open-walnut-build\\.[0-9a-f]{12}\\.\\d+$`))
    expect(rep.cwd).toBe(rep.here)
    // Committed content only: the peer's edits stay in the checkout.
    expect(rep.app).toBe('committed app')
    expect(rep.ws).toBe(path.join(rep.here, 'packages', 'lib'))
    expect(rep.ws_file).toBe('committed lib')
    // Everything else resolves from the checkout's node_modules.
    expect(rep.dep).toBe(path.join(f.repo, 'node_modules', 'leftpad'))
    expect(rep.scoped_dep).toBe(path.join(f.repo, 'node_modules', '@acme', 'other'))
    expect(rep.web_dep).toBe(path.join(f.repo, 'web', 'node_modules'))
    expect(rep.dry).toBe('1')
    // The clone is gone, the checkout untouched.
    expect(fs.existsSync(rep.here)).toBe(false)
    expect(fs.readFileSync(path.join(f.repo, 'app.txt'), 'utf-8')).toBe('half-written app\n')
    expect(git(f.repo, 'status', '--porcelain')).toBe('M app.txt\n M packages/lib/index.js'.trim())
    expect(git(f.repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  // bun and esbuild read every package.json above a dependency's real path, so a link into the
  // checkout made its own package.json part of the build: one left mid-merge failed every deploy
  // (2026-11-10). Where the volume clones files (macOS), dependencies come from the deploy's mirror.
  const clones = process.platform === 'darwin'
  it('takes dependencies from its own copy-on-write mirror, so a checkout mid-merge cannot break the build', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.repo, 'package.json'), '<<<<<<< HEAD\n{"name":"open-walnut"}\n=======\n{}\n>>>>>>> theirs\n')
    const deps = path.join(f.tmp, '..', 'deps')
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_DEPLOY_DEPS_MIRROR: '1' })
    expect(r.status).toBe(0)
    const rep = r.report!
    expect(rep.ws).toBe(path.join(rep.here, 'packages', 'lib'))
    if (!clones && !r.stdout.includes('Copying')) {
      expect(r.stdout).toContain('No copy-on-write mirror of node_modules here')
      return
    }
    const [key] = fs.readdirSync(deps).filter((n) => !n.startsWith('.'))
    const mirror = path.join(fs.realpathSync(deps), key)
    for (const p of [rep.dep, rep.scoped_dep, rep.web_dep]) {
      expect(p.startsWith(mirror + '/')).toBe(true)
      expect(p.startsWith(f.repo + '/')).toBe(false)
    }
    // The directory above the mirror's node_modules holds a package.json that parses.
    expect(JSON.parse(fs.readFileSync(path.join(mirror, 'package.json'), 'utf-8'))).toEqual({ private: true })
    expect(JSON.parse(fs.readFileSync(path.join(mirror, 'web', 'package.json'), 'utf-8'))).toEqual({ private: true })
    // The checkout itself is untouched.
    expect(fs.readFileSync(path.join(f.repo, 'package.json'), 'utf-8')).toContain('<<<<<<< HEAD')
  })

  it('copies the mirror once per install, and drops an old one once unused for two hours', () => {
    if (!clones) return
    const f = fixture()
    const deps = path.join(f.tmp, '..', 'deps')
    const env = { WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_DEPLOY_DEPS_MIRROR: '1' }
    const mirrors = () => fs.readdirSync(deps).filter((n) => /^[0-9a-f]{16}$/.test(n)).sort()
    const first = run(f, env)
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('Copying this checkout')
    const [k1] = mirrors()
    const again = run(f, env)
    expect(again.status).toBe(0)
    expect(again.stdout).not.toContain('Copying this checkout')
    expect(mirrors()).toEqual([k1])
    // An install changes what the checkout holds: a new mirror; the old one stays while recent.
    fs.mkdirSync(path.join(f.repo, 'node_modules', 'rightpad'))
    fs.writeFileSync(path.join(f.repo, 'node_modules', 'rightpad', 'package.json'), '{"name":"rightpad"}')
    const third = run(f, env)
    expect(third.status).toBe(0)
    expect(third.stdout).toContain('Copying this checkout')
    expect(mirrors()).toHaveLength(2)
    const k2 = mirrors().find((k) => k !== k1)!
    expect(fs.existsSync(path.join(deps, k2, 'node_modules', 'rightpad', 'package.json'))).toBe(true)
    // Unused for over two hours: the next deploy removes it, and nothing it does not own.
    const old = (Date.now() - 3 * 3600_000) / 1000
    fs.utimesSync(path.join(deps, k1), old, old)
    fs.mkdirSync(path.join(deps, 'not-a-mirror'))
    fs.utimesSync(path.join(deps, 'not-a-mirror'), old, old)
    expect(run(f, env).status).toBe(0)
    expect(mirrors()).toEqual([k2])
    expect(fs.existsSync(path.join(deps, 'not-a-mirror'))).toBe(true)
  })

  it('a tool cache inside node_modules neither joins the mirror nor makes a new one when it changes', () => {
    if (!clones) return
    const f = fixture()
    const deps = path.join(f.tmp, '..', 'deps')
    const env = { WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_DEPLOY_DEPS_MIRROR: '1' }
    const mirrors = () => fs.readdirSync(deps).filter((n) => /^[0-9a-f]{16}$/.test(n))
    fs.mkdirSync(path.join(f.repo, 'web', 'node_modules', '.vite-temp'))
    fs.writeFileSync(path.join(f.repo, 'web', 'node_modules', '.vite-temp', 'a.mjs'), '1')
    fs.mkdirSync(path.join(f.repo, 'node_modules', '.bin'))
    fs.writeFileSync(path.join(f.repo, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n')
    expect(run(f, env).status).toBe(0)
    const [key] = mirrors()
    expect(fs.existsSync(path.join(deps, key, 'web', 'node_modules', '.vite-temp'))).toBe(false)
    expect(fs.existsSync(path.join(deps, key, 'node_modules', '.bin', 'tool'))).toBe(true)
    // vite writes there on every run: no new copy for it.
    fs.writeFileSync(path.join(f.repo, 'web', 'node_modules', '.vite-temp', 'b.mjs'), '2')
    const again = run(f, env)
    expect(again.status).toBe(0)
    expect(again.stdout).not.toContain('Copying this checkout')
    expect(mirrors()).toEqual([key])
  })

  it('loading a dependency fails on a checkout mid-merge with the links, and builds with the mirror', () => {
    if (!clones) return
    const stub = `#!/usr/bin/env bash
# knows WALNUT_DEVPROD_SERVE_ROOT
set -uo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd -P)"
out="$(cd "$here" && bun -e "console.log(require('leftpad'))" 2>&1)"; rc=$?
{ echo "rc=$rc"; echo "out=$(printf '%s' "$out" | tr '\\n' ' ')"; } > "$WALNUT_TEST_REPORT"
`
    const f = fixture({ stub })
    fs.writeFileSync(path.join(f.repo, 'node_modules', 'leftpad', 'package.json'), '{"name":"leftpad","main":"index.js"}')
    fs.writeFileSync(path.join(f.repo, 'node_modules', 'leftpad', 'index.js'), 'module.exports = "padded"\n')
    fs.writeFileSync(path.join(f.repo, 'package.json'), '<<<<<<< HEAD\n{"name":"open-walnut"}\n=======\n{}\n>>>>>>> theirs\n')
    const linked = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    // bun reads the checkout's package.json above the linked package's real path.
    expect(linked.report!.out).toMatch(/<<<<<<<|not allowed in JSON|Expected/)
    const mirrored = run(f, { WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_DEPLOY_DEPS_MIRROR: '1' })
    expect(mirrored.report!.out).not.toMatch(/<<<<<<<|not allowed in JSON|Expected/)
    expect(mirrored.report!.out).toContain('padded')
    expect(mirrored.report!.rc).toBe('0')
  })

  it('links the checkout\'s node_modules as before when the mirror is off', () => {
    const f = fixture()
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.status).toBe(0)
    expect(r.report!.dep).toBe(path.join(f.repo, 'node_modules', 'leftpad'))
    expect(fs.existsSync(path.join(f.tmp, '..', 'deps'))).toBe(false)
  })

  it('copies the checkout\'s built SQLite into the clone, so a deploy never downloads it again', () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.repo, 'vendor', 'sqlite', 'darwin'), { recursive: true })
    fs.writeFileSync(path.join(f.repo, 'vendor', 'sqlite', 'darwin', 'stamp.json'), '{"version":"pinned"}')
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.status).toBe(0)
    expect(r.report!.sqlite).toBe('{"version":"pinned"}')
    // A copy: the build may rebuild it in the clone without touching the checkout.
    expect(r.report!.sqlite_link).toBe('no')
    expect(fs.readFileSync(path.join(f.repo, 'vendor', 'sqlite', 'darwin', 'stamp.json'), 'utf-8')).toBe('{"version":"pinned"}')
  })

  it('copies the files behind a linked vendor/sqlite, never the link', () => {
    const f = fixture()
    const real = path.join(path.dirname(f.repo), 'sqlite-real')
    fs.mkdirSync(path.join(real, 'darwin'), { recursive: true })
    fs.writeFileSync(path.join(real, 'darwin', 'stamp.json'), '{"version":"linked"}')
    fs.mkdirSync(path.join(f.repo, 'vendor'))
    fs.symlinkSync(real, path.join(f.repo, 'vendor', 'sqlite'))
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.status).toBe(0)
    expect(r.report!.sqlite).toBe('{"version":"linked"}')
    expect(r.report!.sqlite_link).toBe('no')
  })

  it('deploys as before when the checkout has no built SQLite', () => {
    const f = fixture()
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.status).toBe(0)
    expect(r.report!.sqlite).toBe('none')
  })

  it('copies every built input the repo keeps out of git under vendor/', () => {
    // A clean clone lacks whatever .gitignore holds back, so each such vendor/ dir must be
    // copied or every deploy builds (and maybe downloads) it again.
    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8').split('\n')
      .map((l) => l.trim()).filter((l) => /^\/?vendor\//.test(l)).map((l) => l.replace(/^\//, '').replace(/\/$/, ''))
    expect(ignored.length).toBeGreaterThan(0)
    const listed = /^VENDOR_BUILT=\(([^)]*)\)/m.exec(fs.readFileSync(WRAPPER, 'utf-8'))
    expect(listed).not.toBeNull()
    expect(listed![1].trim().split(/\s+/).sort()).toEqual(ignored.sort())
  })

  /**
   * A stand-in for bun or node that records its argv and runs the snippet on
   * this test's own runtime, read from stdin the way that runtime reads it.
   */
  function standIn(dir: string, name: string): string {
    const bin = path.join(dir, name)
    const runStdin = process.versions.bun ? `"${process.execPath}" run -` : `"${process.execPath}" -`
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${dir}/${name}.args"`,
      // The wrapper must hand the script over stdin: `bun run -` or `node -`.
      name === 'bun' ? '[ "$1" = run ] && [ "$2" = - ] || exit 9; shift 2' : '[ "$1" = - ] || exit 9; shift',
      `exec ${runStdin} "$@"`,
    ].join('\n') + '\n', { mode: 0o755 })
    return bin
  }

  it('links the dependencies through bun run - (a bare `bun -` would run bun add)', () => {
    const f = fixture()
    const bin = path.join(path.dirname(f.repo), 'bin')
    fs.mkdirSync(bin)
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_BUN: standIn(bin, 'bun') })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const args = fs.readFileSync(path.join(bin, 'bun.args'), 'utf-8').trim()
    expect(args).toBe(`run - ${f.repo}/node_modules ${r.report!.here}/node_modules ${r.report!.here}`)
    expect(r.report!.dep).toBe(path.join(f.repo, 'node_modules', 'leftpad'))
    expect(r.report!.ws_file).toBe('committed lib')
  })

  it('installs the commit\'s lockfile in the clone when the checkout lacks a dependency it declares, never in the checkout', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.repo, 'node_modules', 'leftpad', 'package.json'), '{"name":"leftpad"}')
    const pkg = JSON.parse(fs.readFileSync(path.join(f.repo, 'package.json'), 'utf-8'))
    fs.writeFileSync(path.join(f.repo, 'package.json'), JSON.stringify({ ...pkg, dependencies: { leftpad: '1.0.0', freshdep: '1.0.0' } }))
    git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'adds freshdep', '--', 'package.json')
    const bin = path.join(path.dirname(f.repo), 'bin')
    fs.mkdirSync(bin)
    const runStdin = process.versions.bun ? `"${process.execPath}" run -` : `"${process.execPath}" -`
    const bun = path.join(bin, 'bun')
    fs.writeFileSync(bun, [
      '#!/bin/sh',
      `printf '%s|%s\\n' "$(pwd -P)" "$*" >> "${bin}/bun.args"`,
      'if [ "$1" = run ] && [ "$2" = - ]; then shift 2; exec ' + runStdin + ' "$@"; fi',
      // A stand-in for the install: what bun and the postinstall would lay out.
      'if [ "$1" = install ]; then mkdir -p node_modules/leftpad node_modules/freshdep node_modules/@acme/other web/node_modules; ln -s ../../packages/lib node_modules/@acme/lib; exit 0; fi',
      'exit 9',
    ].join('\n') + '\n', { mode: 0o755 })
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1', WALNUT_BUN: bun })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('lacks what this commit declares (root freshdep')
    const calls = fs.readFileSync(path.join(bin, 'bun.args'), 'utf-8').trim().split('\n')
    expect(calls.filter((c) => c.endsWith('|install --frozen-lockfile'))).toEqual([`${r.report!.here}|install --frozen-lockfile`])
    // The clone has its own dependencies now; the checkout's are as they were.
    expect(r.report!.dep).toBe(path.join(r.report!.here, 'node_modules', 'leftpad'))
    expect(fs.existsSync(path.join(f.repo, 'node_modules', 'freshdep'))).toBe(false)
  })

  it('links, and installs nothing, when the checkout has every dependency the commit declares', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.repo, 'node_modules', 'leftpad', 'package.json'), '{"name":"leftpad"}')
    const pkg = JSON.parse(fs.readFileSync(path.join(f.repo, 'package.json'), 'utf-8'))
    fs.writeFileSync(path.join(f.repo, 'package.json'), JSON.stringify({ ...pkg, dependencies: { leftpad: '1.0.0' } }))
    git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'declares leftpad', '--', 'package.json')
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('lacks what this commit declares')
    expect(r.report!.dep).toBe(path.join(f.repo, 'node_modules', 'leftpad'))
  })

  it('needs bun: a machine with only node is told how to install it, and nothing runs on node', () => {
    const f = fixture()
    const bin = path.join(path.dirname(f.repo), 'bin')
    fs.mkdirSync(bin)
    standIn(bin, 'node')
    const home = path.join(path.dirname(f.repo), 'home')
    fs.mkdirSync(home)
    const r = run(f, { WALNUT_DEVPROD_DRY_RUN: '1', PATH: guardedPath([bin], '/usr/bin:/bin'), HOME: home })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/No bun found .*curl -fsSL https:\/\/bun\.sh\/install \| bash/)
    expect(fs.existsSync(path.join(bin, 'node.args'))).toBe(false)
    expect(r.report).toBeNull()
  })

  it('deploys a named commit, and keeps the clone on request', () => {
    const f = fixture()
    const first = git(f.repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(f.repo, 'app.txt'), 'second app\n')
    git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-am', 'second')
    const later = run(f, { WALNUT_DEPLOY_KEEP_BUILD: '1' })
    expect(later.status).toBe(0)
    expect(later.report!.app).toBe('second app')
    expect(later.stdout).toMatch(/Build clone kept: /)
    expect(fs.existsSync(later.report!.here)).toBe(true)
    const earlier = run(f, {}, [first])
    expect(earlier.status).toBe(0)
    expect(earlier.report!.app).toBe('committed app')
  })

  it('refuses a ref that is not a commit, and a commit whose dev-prod.sh predates the serve root', () => {
    const f = fixture()
    const bad = run(f, {}, ['no-such-ref'])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/Not a commit in .*: no-such-ref/)
    const old = fixture({ stub: '#!/usr/bin/env bash\necho "would serve from the clone" > "$WALNUT_TEST_REPORT"\n' })
    const r = run(old)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/predates WALNUT_DEVPROD_SERVE_ROOT/)
    expect(r.report).toBeNull()
    expect(fs.readdirSync(old.tmp)).toEqual([])
  })

  it('in a rehearsal, clones into the rehearsal dir, never the caller\'s TMPDIR', () => {
    const f = fixture()
    const dir = path.join(path.dirname(f.repo), 'rehearsal')
    fs.mkdirSync(dir)
    const r = run(f, { WALNUT_DEVPROD_REHEARSAL: '1', WALNUT_DEVPROD_REHEARSAL_DIR: dir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.report!.here).toMatch(new RegExp(`^${dir}/open-walnut-build\\.[0-9a-f]{12}\\.\\d+$`))
    expect(fs.readdirSync(f.tmp)).toEqual([])
    // Without the rehearsal switch, or with a dir dev-prod.sh will refuse, TMPDIR as before.
    for (const env of [{ WALNUT_DEVPROD_REHEARSAL_DIR: dir }, { WALNUT_DEVPROD_REHEARSAL: '1', WALNUT_DEVPROD_REHEARSAL_DIR: 'relative' }]) {
      const other = run(f, env)
      expect(other.report!.here.startsWith(`${f.tmp}/open-walnut-build.`)).toBe(true)
    }
  })

  it('skips a commit production already serves, or one a later served commit contains', () => {
    const f = fixture()
    const first = git(f.repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(f.repo, 'more.txt'), 'second\n')
    git(f.repo, 'add', 'more.txt')
    git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'second')
    const second = git(f.repo, 'rev-parse', 'HEAD')
    const config = path.join(path.dirname(f.repo), 'config.json')
    const serving = (commit: string, dirty = false) =>
      fs.writeFileSync(config, JSON.stringify({ build: { version: '0.0.0', commit: commit.slice(0, 9), dirty } }))
    const url = { WALNUT_DEPLOY_CONFIG_URL: `file://${config}` }

    serving(second)
    for (const ref of [[], [first]]) {
      const r = run(f, url, ref)
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/Deploy skipped: production already serves [0-9a-f]{9}/)
      expect(r.report).toBeNull()
      expect(fs.readdirSync(f.tmp)).toEqual([])
    }
    // Forced, or a dry run: it goes on.
    expect(run(f, { ...url, WALNUT_DEVPROD_FORCE: '1' }).report).not.toBeNull()
    fs.rmSync(f.report)
    expect(run(f, { ...url, WALNUT_DEVPROD_DRY_RUN: '1' }).report).not.toBeNull()
    fs.rmSync(f.report)
    // An older served commit, a dirty build, an unknown commit, no answer: it deploys.
    for (const write of [() => serving(first), () => serving(second, true), () => serving('abcdef1234'), () => fs.writeFileSync(config, 'not json')]) {
      write()
      const r = run(f, url)
      expect(r.status).toBe(0)
      expect(r.report).not.toBeNull()
      fs.rmSync(f.report)
    }
  })

  it('passes the stub\'s failure through and still removes the clone', () => {
    const f = fixture({ stub: '#!/usr/bin/env bash\n# WALNUT_DEVPROD_SERVE_ROOT\necho "build failed" >&2\nexit 7\n' })
    const r = run(f)
    expect(r.status).toBe(7)
    expect(r.stderr).toMatch(/build failed/)
    expect(fs.readdirSync(f.tmp)).toEqual([])
  })
})
