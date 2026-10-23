/**
 * The package this Mac sends its cloud companion (src/core/companion-build/package.ts):
 * the compiled walnut file for the box plus the dist/cli.js shim every box starts
 * a build through (shim.ts). The walnut file source (host-file.ts) is a fake that
 * hands out a small sh script as "the file"; tar, gzip and the shim are real, and
 * the shim runs on this runtime the way a box runs it.
 *
 * Also the running dist's build id (host-server/package.ts), which the walnut file
 * source starts from on a Mac that runs a built checkout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-companion-package'))

import { WALNUT_HOME } from '../../src/constants.js'
import { boxRunsPackage, buildCompanionPackage, companionBuildId, companionTarget, EMPTY_DEPS_HASH } from '../../src/core/companion-build/package.js'
import { COMPANION_SHIM_JS } from '../../src/core/companion-build/shim.js'
import { buildIdOf, installRequestProblem } from '../../src/core/companion-build/wire.js'
import { readRunningBuild } from '../../src/core/host-server/package.js'
import type { HostFile, HostFileSource } from '../../src/core/host-server/host-file.js'
import type { HostFileTarget } from '../../src/core/host-server/host-target.js'

let root = ''
const cacheDir = () => path.join(WALNUT_HOME, 'cache', 'host-server')

/** A fake walnut file: prints its argv and the env a test asks about, exits as told. */
const FAKE_WALNUT = `#!/bin/sh
printf 'argv:%s\\n' "$*"
printf 'be-bun:%s\\n' "\${BUN_BE_BUN:-unset}"
[ -n "\${FAKE_SLEEP:-}" ] && { trap 'echo got-term; exit 0' TERM; while :; do sleep 0.05; done; }
exit "\${FAKE_EXIT:-0}"
`

function fakeSource(opts: { id?: string; version?: string; commit?: string; body?: string; fail?: string } = {}): HostFileSource & { asked: HostFileTarget[] } {
  const id = opts.id ?? '0.7.0-abc1234'
  const version = opts.version ?? '0.7.0'
  const commit = opts.commit ?? 'abc1234'
  const body = Buffer.from(opts.body ?? FAKE_WALNUT)
  const asked: HostFileTarget[] = []
  return {
    asked,
    async buildId() {
      if (opts.fail) throw new Error(opts.fail)
      return { id, version, commit }
    },
    async file(target, say) {
      asked.push(target)
      say?.(`Using the walnut file for ${target} built with this server.`)
      const gz = zlib.gzipSync(body)
      const f: HostFile = {
        id, version, commit, target, gz,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        gzSha256: crypto.createHash('sha256').update(gz).digest('hex'),
      }
      return f
    },
  }
}

function untar(tgz: Buffer): Promise<string> {
  const dir = fs.mkdtempSync(path.join(root, 'untar-'))
  const file = path.join(dir, 'p.tgz')
  fs.writeFileSync(file, tgz)
  return new Promise((resolve, reject) => {
    // -p: the modes the package records, not this process's umask on them.
    execFile('tar', ['-xpzf', file, '-C', dir], (err) => { if (err) reject(err); else resolve(dir) })
  })
}

function listTgz(tgz: Buffer): Promise<string[]> {
  const file = path.join(root, `list-${Math.random().toString(36).slice(2)}.tgz`)
  fs.writeFileSync(file, tgz)
  return new Promise((resolve, reject) => {
    execFile('tar', ['-tzf', file], (err, out) => {
      fs.rmSync(file, { force: true })
      if (err) reject(err)
      else resolve(out.split('\n').map((l) => l.replace(/^\.\//, '')).filter((l) => l && !l.endsWith('/')).sort())
    })
  })
}

/** Run the shim the way a box does: `<runtime> dist/cli.js <args>`, on this runtime. */
function runShim(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'dist', 'cli.js'), ...args], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => { out += s })
    child.stderr.setEncoding('utf8').on('data', (s: string) => { out += s })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, out }))
  })
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-companion-pkg-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(cacheDir(), { recursive: true, force: true })
})

describe('the companion package', () => {
  it('is the walnut file for the box target and the shim, with no dependencies', async () => {
    const source = fakeSource()
    const said: string[] = []
    const pkg = await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source, say: (m) => said.push(m) })
    expect(source.asked).toEqual(['linux-arm64'])
    expect(said).toEqual(['Using the walnut file for linux-arm64 built with this server.'])
    expect(pkg).toMatchObject({ id: '0.7.0-abc1234', version: '0.7.0', commit: 'abc1234', dependencies: {}, optionalDependencies: {}, companionDepsHash: EMPTY_DEPS_HASH })
    expect(JSON.parse(pkg.appPackageJson)).toEqual({ name: 'open-walnut', version: '0.7.0', private: true, type: 'module' })
    expect(await listTgz(pkg.tgz)).toEqual(['package/dist/cli.js', 'package/walnut'])
    const dir = await untar(pkg.tgz)
    expect(fs.readFileSync(path.join(dir, 'package', 'walnut'), 'utf8')).toBe(FAKE_WALNUT)
    expect(fs.statSync(path.join(dir, 'package', 'walnut')).mode & 0o111).toBe(0o111)
    expect(fs.readFileSync(path.join(dir, 'package', 'dist', 'cli.js'), 'utf8')).toBe(COMPANION_SHIM_JS)
    expect(fs.existsSync(path.join(cacheDir(), '0.7.0-abc1234-companion-linux-arm64.tgz'))).toBe(true)
  })

  it('makes an install request any box takes, a box from before the compiled file included', async () => {
    const pkg = await buildCompanionPackage({ platform: 'linux', arch: 'x64' }, { source: fakeSource() })
    // The request mac.ts sends (wire.ts InstallRequest), checked as every box version checks it.
    const req = { id: pkg.id, depsHash: pkg.companionDepsHash, dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies, appPackageJson: pkg.appPackageJson }
    expect(installRequestProblem(req)).toBeNull()
  })

  it('packs with COPYFILE_DISABLE, so a Mac adds no AppleDouble `._` member for a file with extended attributes', async () => {
    // A tar in front of the real one notes the variable it was given. (A v0.6.17
    // box unpacked `._walnut` and `._dist` beside the build before this.)
    const bin = fs.mkdtempSync(path.join(root, 'bin-'))
    const seen = path.join(bin, 'seen')
    const realTar = execFileSync('/bin/sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim()
    fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/sh\nprintf '%s\\n' "\${COPYFILE_DISABLE:-unset}" >> '${seen}'\nexec '${realTar}' "$@"\n`, { mode: 0o755 })
    const saved = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${saved ?? ''}`
    try {
      await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource({ id: '0.7.0-ccc0001', commit: 'ccc0001' }) })
    } finally {
      process.env.PATH = saved
    }
    expect(fs.readFileSync(seen, 'utf8').trim().split('\n')).toEqual(['1'])
  })

  it('names the target the box runs: glibc Linux or a Mac, x64 or arm64; refuses anything else', () => {
    expect(companionTarget('linux', 'arm64')).toBe('linux-arm64')
    expect(companionTarget('linux', 'x64')).toBe('linux-x64')
    expect(companionTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(() => companionTarget('win32', 'x64')).toThrow(/linux and darwin only/)
    expect(() => companionTarget('linux', 'ia32')).toThrow(/x64 and arm64 only/)
  })

  it('goes only to a box that can run it: a system with a walnut file, and a runtime that starts the shim', () => {
    // Node 22 from scripts/cloud/setup.sh before bun; bun reports a current Node version.
    expect(boxRunsPackage({ platform: 'linux', arch: 'arm64', node: 'v22.23.4' })).toBeNull()
    expect(boxRunsPackage({ platform: 'linux', arch: 'x64', node: 'v24.3.0' })).toBeNull()
    expect(boxRunsPackage({ platform: 'linux', arch: 'x64', node: 'v14.21.3' })).toMatch(/runs Node v14\.21\.3, .*Node 16 or newer, or bun\. Run scripts\/cloud\/setup\.sh/)
    expect(boxRunsPackage({ platform: 'linux', arch: 'x64', node: '' })).toMatch(/did not say which Node it runs/)
    expect(boxRunsPackage({ platform: 'linux', arch: 'x64' })).toMatch(/did not say which Node it runs/)
    expect(boxRunsPackage({ platform: 'freebsd', arch: 'x64', node: 'v22.0.0' })).toMatch(/linux and darwin only/)
    expect(boxRunsPackage({ platform: 'linux', arch: 'ppc64', node: 'v22.0.0' })).toMatch(/x64 and arm64 only/)
  })

  it('answers the cached package for the same file, and packs again for another', async () => {
    const first = await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource() })
    const again = await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource() })
    expect(again.tgz.equals(first.tgz)).toBe(true)
    // Same id, another file (a rebuilt cache entry): the package follows the file.
    const other = await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource({ body: `${FAKE_WALNUT}# other\n` }) })
    expect(other.fileSha256).not.toBe(first.fileSha256)
    const dir = await untar(other.tgz)
    expect(fs.readFileSync(path.join(dir, 'package', 'walnut'), 'utf8')).toContain('# other')
  })

  it('keeps the newest three packages', async () => {
    for (const commit of ['aaa0001', 'aaa0002', 'aaa0003', 'aaa0004']) {
      await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource({ id: `0.7.0-${commit}`, commit }) })
      await new Promise((r) => setTimeout(r, 15))
    }
    const kept = fs.readdirSync(cacheDir()).filter((n) => n.endsWith('.tgz')).sort()
    expect(kept).toEqual(['0.7.0-aaa0002-companion-linux-arm64.tgz', '0.7.0-aaa0003-companion-linux-arm64.tgz', '0.7.0-aaa0004-companion-linux-arm64.tgz'])
  })

  it('the build id is the walnut file source\'s, and its error says why there is none', async () => {
    expect(await companionBuildId(fakeSource())).toBe('0.7.0-abc1234')
    await expect(companionBuildId(fakeSource({ fail: 'This server runs from source, not from a build' }))).rejects.toThrow(/runs from source/)
  })
})

describe('the shim a box starts the file through', () => {
  async function unpacked(body?: string): Promise<string> {
    const pkg = await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource(body ? { body } : {}) })
    return path.join(await untar(pkg.tgz), 'package')
  }

  it('starts ../walnut with the same arguments and ends with its exit code', async () => {
    const dir = await unpacked()
    const r = await runShim(dir, ['web', '--port', '3456'])
    expect(r).toEqual({ code: 0, out: 'argv:web --port 3456\nbe-bun:unset\n' })
    expect((await runShim(dir, ['--version'], { FAKE_EXIT: '7' })).code).toBe(7)
  })

  it('never passes BUN_BE_BUN on: a box running the compiled file starts the shim with its file told to be bun', async () => {
    const dir = await unpacked()
    expect((await runShim(dir, ['--version'], { BUN_BE_BUN: '1' })).out).toContain('be-bun:unset')
  })

  it('passes SIGTERM on and exits once the file has', async () => {
    const dir = await unpacked()
    const child = spawn(process.execPath, [path.join(dir, 'dist', 'cli.js'), 'web'], { env: { PATH: process.env.PATH, HOME: root, FAKE_SLEEP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (s: string) => { out += s })
    for (const end = Date.now() + 10_000; !out.includes('argv:'); await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error(`the file did not start: ${out}`)
    }
    child.kill('SIGTERM')
    const code = await new Promise<number | null>((resolve) => child.once('close', (c) => resolve(c)))
    expect(out).toContain('got-term')
    expect(code).toBe(0)
  })

  it('under the launcher, stops a walnut file an earlier shim left running, and only that', async () => {
    const hostRoot = path.join(root, 'host')
    const appDir = path.join(hostRoot, 'app', '0.7.0-abc1234')
    const pkg = await buildCompanionPackage({ platform: 'linux', arch: 'arm64' }, { source: fakeSource() })
    fs.mkdirSync(appDir, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const file = path.join(root, 'p.tgz')
      fs.writeFileSync(file, pkg.tgz)
      execFile('tar', ['-xzf', file, '-C', appDir, '--strip-components=1'], (err) => { if (err) reject(err); else resolve() })
    })
    // An orphan: the walnut file's web, started under this root, whose shim is gone.
    const orphan = spawn(path.join(appDir, 'walnut'), ['web'], { env: { PATH: process.env.PATH, FAKE_SLEEP: '1' }, stdio: 'ignore' })
    // A process the pid file may name by mistake (a recycled pid): never touched.
    const bystander = spawn('/bin/sh', ['-c', 'while :; do sleep 0.05; done'], { stdio: 'ignore' })
    try {
      fs.mkdirSync(path.join(hostRoot, 'companion'), { recursive: true })
      const env = { WALNUT_COMPANION_ROOT: hostRoot, WALNUT_COMPANION_LAUNCHER: '1' }
      fs.writeFileSync(path.join(hostRoot, 'companion', 'file-server.pid'), `${bystander.pid}\n`)
      const first = await runShim(appDir, ['web'], env)
      expect(first.code).toBe(0)
      expect(bystander.exitCode).toBeNull()

      fs.writeFileSync(path.join(hostRoot, 'companion', 'file-server.pid'), `${orphan.pid}\n`)
      const second = await runShim(appDir, ['web'], env)
      expect(second.code).toBe(0)
      expect(second.out).toContain(`a walnut file from an earlier start (pid ${orphan.pid}) is still running; sending SIGTERM`)
      await new Promise<void>((resolve) => { if (orphan.exitCode !== null || orphan.signalCode !== null) resolve(); else orphan.once('exit', () => resolve()) })
      // The shim names its own file while it runs, and removes the note when the file ends.
      expect(fs.existsSync(path.join(hostRoot, 'companion', 'file-server.pid'))).toBe(false)
    } finally {
      for (const c of [orphan, bystander]) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
    }
  })

  it('is plain JavaScript with node: builtins only, so a box from before the compiled file runs it on Node', () => {
    const imports = [...COMPANION_SHIM_JS.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((s) => !s.startsWith('node:'))).toEqual([])
    expect(COMPANION_SHIM_JS.split('\n')[0]).toBe('#!/usr/bin/env node')
  })
})

describe('the running dist', () => {
  function distWith(info: Record<string, unknown>): { distDir: string; root: string } {
    const dir = fs.mkdtempSync(path.join(root, 'dist-'))
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'open-walnut', version: '0.6.14' }))
    fs.writeFileSync(path.join(dir, 'dist', 'build-info.json'), JSON.stringify(info))
    return { distDir: path.join(dir, 'dist'), root: dir }
  }

  it('keeps the id it always had (the host file and the companion package are named by it)', async () => {
    const info = { version: '0.6.14', commit: '5408d5875', branch: 'main', builtAt: '2026-10-20T10:00:00.000Z', dirty: false }
    const got = await readRunningBuild(distWith(info))
    expect(got).toEqual({ id: '0.6.14-5408d5875', info })
    expect(got.id).toBe(buildIdOf(info))
  })

  it('marks a dirty build with a hash of its build time', async () => {
    const got = await readRunningBuild(distWith({ version: '0.6.14', commit: 'abc1234', builtAt: '2026-10-20T10:00:00.000Z', dirty: true }))
    expect(got.id).toMatch(/^0\.6\.14-abc1234-d[a-f0-9]{6}$/)
  })
})
