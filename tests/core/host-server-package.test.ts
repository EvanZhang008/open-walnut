/**
 * The package this Mac sends its cloud companion (src/core/host-server/package.ts):
 * the build plus the session daemon of the box's platform. A fake dist in a temp
 * dir, real tar. (A host server gets the compiled walnut file instead: host-file.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-package'))

import { WALNUT_HOME } from '../../src/constants.js'
import { buildCompanionAppPackage, keepsDaemonFile, readRunningBuild, runningBuildId } from '../../src/core/host-server/package.js'
import { buildIdOf } from '../../src/core/companion-build/wire.js'

let root = ''
let dist = { distDir: '', root: '' }

function write(rel: string, text = 'x'): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function writeBuildInfo(commit: string): void {
  write('dist/build-info.json', JSON.stringify({ version: '0.6.14', commit, branch: 'main', builtAt: '2026-10-20T10:00:00.000Z', dirty: false }))
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

const cacheDir = () => path.join(WALNUT_HOME, 'cache', 'host-server')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-dist-'))
  dist = { distDir: path.join(root, 'dist'), root }
  write('package.json', JSON.stringify({
    name: 'open-walnut', version: '0.6.14',
    dependencies: { express: '^5.1.0', yaml: '^2.0.0' },
    optionalDependencies: { 'fsevents': '^2.3.0' },
  }))
  writeBuildInfo('5408d5875')
  write('dist/cli.js', 'console.log(1)')
  write('dist/cli.js.map', '{}')
  write('dist/web/index.html', '<html></html>')
  write('dist/web/app.js.gz', 'gz')
  for (const name of [
    'daemon-linux-arm64', 'daemon-linux-arm64.version',
    'daemon-linux-x64', 'daemon-linux-x64.version',
    'daemon-darwin-arm64', 'daemon-darwin-arm64.version',
    'dtach-darwin-arm64', 'dtach-darwin-arm64.source-hash',
    'dtach-linux-arm64', 'dtach-linux-arm64.source-hash',
    'acp-worker.js', 'acp-worker.js.version',
    'daemon-cron-runtime.cjs', 'daemon-service-cli.cjs', 'pi-acp.js',
  ]) write(`dist/daemon-binaries/${name}`)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(cacheDir(), { recursive: true, force: true })
})

describe('the running build', () => {
  it('keeps the id it always had (the host file and the companion package are named by it)', async () => {
    const id = await runningBuildId(dist)
    expect(id).toBe('0.6.14-5408d5875')
    expect(id).toBe(buildIdOf({ version: '0.6.14', commit: '5408d5875', dirty: false, builtAt: '2026-10-20T10:00:00.000Z' }))
    expect(await readRunningBuild(dist)).toEqual({ id, info: { version: '0.6.14', commit: '5408d5875', branch: 'main', builtAt: '2026-10-20T10:00:00.000Z', dirty: false } })
    expect(await runningBuildId(null)).toBeNull()
  })

  it('marks a dirty build with a hash of its build time', async () => {
    write('dist/build-info.json', JSON.stringify({ version: '0.6.14', commit: 'abc1234', builtAt: '2026-10-20T10:00:00.000Z', dirty: true }))
    expect(await runningBuildId(dist)).toMatch(/^0\.6\.14-abc1234-d[a-f0-9]{6}$/)
  })
})

describe('companion package', () => {
  it('is the build plus the daemon binaries of the box platform only', async () => {
    const pkg = await buildCompanionAppPackage({ platform: 'linux', arch: 'arm64' }, dist)
    expect(pkg.id).toBe('0.6.14-5408d5875')
    expect(pkg.dependencies).toEqual({ express: '^5.1.0', yaml: '^2.0.0' })
    expect(pkg.depsHash).toMatch(/^[a-f0-9]{16}$/)
    expect(pkg.optionalDependencies).toEqual({ fsevents: '^2.3.0' })
    expect(pkg.companionDepsHash).toMatch(/^[a-f0-9]{16}$/)
    expect(pkg.companionDepsHash).not.toBe(pkg.depsHash)
    expect(await listTgz(pkg.tgz)).toEqual([
      'package/dist/build-info.json',
      'package/dist/cli.js',
      'package/dist/daemon-binaries/acp-worker.js',
      'package/dist/daemon-binaries/acp-worker.js.version',
      'package/dist/daemon-binaries/daemon-cron-runtime.cjs',
      'package/dist/daemon-binaries/daemon-linux-arm64',
      'package/dist/daemon-binaries/daemon-linux-arm64.version',
      'package/dist/daemon-binaries/daemon-service-cli.cjs',
      'package/dist/daemon-binaries/dtach-linux-arm64',
      'package/dist/daemon-binaries/dtach-linux-arm64.source-hash',
      'package/dist/daemon-binaries/pi-acp.js',
      'package/dist/web/index.html',
    ])
    expect(fs.existsSync(path.join(cacheDir(), `${pkg.id}-companion-linux-arm64.tgz`))).toBe(true)
  })

  it('leaves dtach out when the platform has none', async () => {
    const pkg = await buildCompanionAppPackage({ platform: 'linux', arch: 'x64' }, dist)
    const files = await listTgz(pkg.tgz)
    expect(files.filter((f) => f.includes('/daemon-binaries/') && /(daemon|dtach)-(linux|darwin)-/.test(f))).toEqual([
      'package/dist/daemon-binaries/daemon-linux-x64',
      'package/dist/daemon-binaries/daemon-linux-x64.version',
    ])
  })

  it('has an empty optionalDependencies when package.json has none', async () => {
    write('package.json', JSON.stringify({ name: 'open-walnut', version: '0.6.14', dependencies: { express: '^5.1.0' } }))
    const pkg = await buildCompanionAppPackage({ platform: 'linux', arch: 'arm64' }, dist)
    expect(pkg.optionalDependencies).toEqual({})
    expect(pkg.companionDepsHash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('refuses a platform whose daemon this build lacks, and any other platform or arch', async () => {
    fs.rmSync(path.join(dist.distDir, 'daemon-binaries', 'daemon-linux-arm64'))
    await expect(buildCompanionAppPackage({ platform: 'linux', arch: 'arm64' }, dist))
      .rejects.toThrow("this Mac's build has no session daemon for linux-arm64; run scripts/build-daemon.sh and build again")
    await expect(buildCompanionAppPackage({ platform: 'win32', arch: 'x64' }, dist)).rejects.toThrow(/linux or darwin/)
    await expect(buildCompanionAppPackage({ platform: 'linux', arch: 'ia32' }, dist)).rejects.toThrow(/x64 or arm64/)
    await expect(buildCompanionAppPackage({ platform: 'linux', arch: 'x64' }, null)).rejects.toThrow(/not running from a build/)
  })

  it('answers the cached package for the same build', async () => {
    const first = await buildCompanionAppPackage({ platform: 'linux', arch: 'arm64' }, dist)
    write('dist/cli.js', 'changed without a new build id')
    const second = await buildCompanionAppPackage({ platform: 'linux', arch: 'arm64' }, dist)
    expect(second.tgz.equals(first.tgz)).toBe(true)
  })

  it('prunes each family on its own: a host package of the Node layout survives a run of companion builds', async () => {
    const host = { id: '0.6.13-0ld0001' }
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(path.join(cacheDir(), `${host.id}.tgz`), 'host package')
    const ids: string[] = []
    for (const commit of ['aaa0001', 'aaa0002', 'aaa0003', 'aaa0004', 'aaa0005']) {
      writeBuildInfo(commit)
      ids.push((await buildCompanionAppPackage({ platform: 'linux', arch: 'arm64' }, dist)).id)
      // mtimes must differ for the newest-first order.
      await new Promise((r) => setTimeout(r, 15))
    }
    const kept = fs.readdirSync(cacheDir()).sort()
    expect(kept).toContain(`${host.id}.tgz`)
    expect(kept.filter((n) => n.includes('-companion-'))).toEqual(ids.slice(-3).map((id) => `${id}-companion-linux-arm64.tgz`).sort())
  })
})

describe('keepsDaemonFile', () => {
  it('drops only the binaries of other platforms and their sidecars', () => {
    expect(keepsDaemonFile('daemon-linux-arm64', 'linux', 'arm64')).toBe(true)
    expect(keepsDaemonFile('daemon-linux-arm64.version', 'linux', 'arm64')).toBe(true)
    expect(keepsDaemonFile('daemon-linux-x64', 'linux', 'arm64')).toBe(false)
    expect(keepsDaemonFile('dtach-darwin-arm64.source-hash', 'linux', 'arm64')).toBe(false)
    expect(keepsDaemonFile('daemon-cron-runtime.cjs', 'linux', 'arm64')).toBe(true)
    expect(keepsDaemonFile('daemon-instance-lock.cjs', 'linux', 'arm64')).toBe(true)
    expect(keepsDaemonFile('acp-worker.js.version', 'linux', 'arm64')).toBe(true)
  })
})
