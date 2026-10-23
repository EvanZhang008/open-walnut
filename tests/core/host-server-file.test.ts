/**
 * Where a host's walnut file comes from (src/core/host-server/host-file.ts): this
 * server's build, found beside it, built from its checkout or downloaded from its
 * release, kept in the data dir's cache. The clone build is a stand-in here (its
 * real run is host-server-file-build.test.ts); the release is real files, read
 * over file:// and over a real HTTP server; the staged copy production runs from
 * is a real dir with its marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-file'))

import {
  createHostFileSource, defaultReleaseBase, fileContains, runningOrigin, sumsFor, versionLineMatches,
  type BuildOrigin, type FileVersion, type HostFileSourceOptions,
} from '../../src/core/host-server/host-file.js'
import { WORK_OWNER, type CloneBuild } from '../../src/core/host-server/host-file-build.js'
import type { HostFileTarget } from '../../src/core/host-server/host-target.js'
import type { BuildInfo } from '../../src/lib/build-info.js'

let dir = ''
let cacheDir = ''
let workDir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsf-'))
  cacheDir = path.join(dir, 'cache', 'host-server')
  workDir = path.join(dir, 'work')
  fs.mkdirSync(workDir)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({ version: '0.6.14', commit: '80dc024a8', branch: 'main', builtAt: '2026-10-22T10:00:00.000Z', dirty: false, ...over })

function checkout(over: Partial<BuildInfo> = {}, id = '0.6.14-80dc024a8'): BuildOrigin {
  return { kind: 'checkout', checkout: '/work/walnut', distDir: '/work/walnut/dist', info: info(over), id }
}

/** A stand-in clone build: writes "<target> built from <commit>" per target, and counts. */
function fakeBuild(ms = 20) {
  const calls: CloneBuild[] = []
  const build = async (b: CloneBuild): Promise<Partial<Record<HostFileTarget, string>>> => {
    calls.push(b)
    await new Promise((r) => setTimeout(r, ms))
    const out: Partial<Record<HostFileTarget, string>> = {}
    for (const t of b.targets) {
      const file = path.join(b.work, 'tree', 'dist-bin', `walnut-${t}`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${t} built from ${b.commit}\n`.repeat(1000))
      out[t] = file
    }
    return out
  }
  return { calls, build }
}

const pinned = async () => JSON.stringify({ name: 'open-walnut', packageManager: 'bun@1.4.4' })
const aBun = async () => ({ path: '/opt/bun/bin/bun', version: '1.4.4' })
/** A source with the stand-ins every test wants, `over` on top. */
const source = (over: Partial<HostFileSourceOptions>) => createHostFileSource({
  cacheDir, workDir, bun: aBun, packageJsonAt: pinned, versionHere: async () => null, batchWindowMs: 20, ...over,
})

describe('from this server\'s checkout', () => {
  it('builds the file once per build and target, then reads it from the cache', async () => {
    const { calls, build } = fakeBuild()
    const said: string[] = []
    const src = source({ origin: async () => checkout(), build })
    expect(await src.buildId()).toEqual({ id: '0.6.14-80dc024a8', version: '0.6.14', commit: '80dc024a8' })
    const f = await src.file('linux-x64', (m) => said.push(m))
    const plain = zlib.gunzipSync(f.gz)
    expect(plain.toString()).toMatch(/^linux-x64 built from 80dc024a8\n/)
    expect(f).toMatchObject({ id: '0.6.14-80dc024a8', version: '0.6.14', commit: '80dc024a8', target: 'linux-x64', sha256: sha(plain), gzSha256: sha(f.gz) })
    expect(said).toEqual(['Building Walnut 0.6.14-80dc024a8 for linux-x64 on this computer (about a minute, once per build).'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      checkout: '/work/walnut', distDir: '/work/walnut/dist', commit: '80dc024a8', targets: ['linux-x64'], bun: '/opt/bun/bin/bun',
      log: path.join(cacheDir, 'build-0.6.14-80dc024a8.log'),
    })
    // The build's own dir is gone; the cache holds the gz and its sums, nothing else.
    expect(calls[0]!.work.startsWith(workDir)).toBe(true)
    expect(fs.existsSync(calls[0]!.work)).toBe(false)
    expect(fs.readdirSync(path.join(cacheDir, 'files', '0.6.14-80dc024a8')).sort()).toEqual(['walnut-linux-x64.gz', 'walnut-linux-x64.json'])

    // A second source (a restart of this server) reads the cache: no build.
    const again = source({ origin: async () => checkout(), build })
    const g = await again.file('linux-x64', (m) => said.push(m))
    expect(g.gz.equals(f.gz)).toBe(true)
    expect(g).toMatchObject({ sha256: f.sha256, gzSha256: f.gzSha256, commit: '80dc024a8' })
    expect(calls).toHaveLength(1)
    expect(said).toHaveLength(1)
  })

  it('two hosts asking at once share one build, and both hear how it goes', async () => {
    const { calls, build } = fakeBuild()
    const src = source({ origin: async () => checkout(), build })
    const a: string[] = []
    const b: string[] = []
    const [x, y] = await Promise.all([src.file('linux-x64', (m) => a.push(m)), src.file('linux-x64', (m) => b.push(m))])
    expect(x.gz.equals(y.gz)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
    expect(b).toHaveLength(1)
  })

  it('targets asked together are one build-binary run; one asked during a build waits for the next', async () => {
    const { calls, build } = fakeBuild(200)
    const src = source({ origin: async () => checkout(), build, batchWindowMs: 50 })
    const said: Record<string, string[]> = { x64: [], musl: [], arm: [] }
    const first = Promise.all([src.file('linux-x64', (m) => said.x64!.push(m)), src.file('linux-arm64-musl', (m) => said.musl!.push(m))])
    // Asked while that build runs (after the window): its own build, after that one, never two at once.
    await new Promise((r) => setTimeout(r, 120))
    const late = src.file('linux-arm64', (m) => said.arm!.push(m))
    const [[x64, musl], arm] = await Promise.all([first, late])
    expect(calls.map((c) => c.targets)).toEqual([['linux-x64', 'linux-arm64-musl'], ['linux-arm64']])
    expect(zlib.gunzipSync(musl.gz).toString()).toMatch(/^linux-arm64-musl built/)
    expect(zlib.gunzipSync(x64.gz).toString()).toMatch(/^linux-x64 built/)
    expect(zlib.gunzipSync(arm.gz).toString()).toMatch(/^linux-arm64 built/)
    expect(said.x64).toEqual(['Building Walnut 0.6.14-80dc024a8 for linux-x64, linux-arm64-musl on this computer (about a minute, once per build).'])
    expect(said.musl).toEqual(said.x64)
    expect(said.arm).toEqual(['Building Walnut 0.6.14-80dc024a8 for linux-arm64 on this computer (about a minute, once per build).'])
  })

  it('asks for a bun as new as the commit pins (its package.json, not the working tree\'s)', async () => {
    const { calls, build } = fakeBuild()
    const asked: Array<string | null> = []
    const at: string[] = []
    const src = source({
      build, origin: async () => checkout(),
      packageJsonAt: async (co, commit) => { at.push(`${co}@${commit}`); return JSON.stringify({ packageManager: 'bun@1.4.4' }) },
      bun: async (min) => { asked.push(min); return { path: '/b/bun', version: '1.4.4' } },
    })
    await src.file('linux-x64')
    expect(at).toEqual(['/work/walnut@80dc024a8'])
    expect(asked).toEqual(['1.4.4'])
    expect(calls[0]!.bun).toBe('/b/bun')
  })

  it('a build from uncommitted changes is refused: the host would not run what this server runs', async () => {
    const { calls, build } = fakeBuild()
    const src = source({ origin: async () => checkout({ dirty: true }, '0.6.14-80dc024a8-d1a2b3c'), build })
    await expect(src.buildId()).rejects.toThrow(/built from a tree with uncommitted changes \(0\.6\.14 \(80dc024a8\+dirty.*deploy a commit \(scripts\/deploy-committed\.sh\), then press Retry/)
    await expect(src.file('linux-x64')).rejects.toThrow(/uncommitted changes/)
    expect(calls).toEqual([])
  })

  it('a cached file that went bad is built again', async () => {
    const { calls, build } = fakeBuild()
    const src = () => source({ origin: async () => checkout(), build })
    await src().file('linux-x64')
    const gz = path.join(cacheDir, 'files', '0.6.14-80dc024a8', 'walnut-linux-x64.gz')
    const bytes = fs.readFileSync(gz)
    bytes[bytes.length - 10] ^= 0xff
    fs.writeFileSync(gz, bytes)
    const f = await src().file('linux-x64')
    expect(calls).toHaveLength(2)
    expect(zlib.gunzipSync(f.gz).toString()).toMatch(/^linux-x64 built/)
  })

  it('a failed build is not remembered: the next ask builds again', async () => {
    let n = 0
    const { build } = fakeBuild()
    const src = source({
      origin: async () => checkout(),
      build: async (b) => { if (n++ === 0) throw new Error('building the walnut file for linux-x64 failed (exit 1): boom'); return build(b) },
    })
    await expect(src.file('linux-x64')).rejects.toThrow(/failed \(exit 1\): boom/)
    expect((await src.file('linux-x64')).target).toBe('linux-x64')
  })

  it('without bun, or a build with no commit, says what is missing', async () => {
    const { calls, build } = fakeBuild()
    await expect(source({ origin: async () => checkout(), build, bun: async () => ({ why: 'Building the walnut file needs bun on this computer (https://bun.sh); none was found.' }) }).file('linux-x64'))
      .rejects.toThrow(/needs bun on this computer/)
    await expect(source({ origin: async () => checkout({ commit: null }), build }).file('linux-x64'))
      .rejects.toThrow(/names no commit/)
    expect(calls).toEqual([])
  })

  it('keeps the newest few builds and drops the Node layout\'s host packages, never the companion\'s', async () => {
    const { build } = fakeBuild()
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, '0.6.10-aaa.tgz'), 'old host package')
    fs.writeFileSync(path.join(cacheDir, '0.6.10-aaa-companion-linux-arm64.tgz'), 'companion package')
    for (const [i, id] of ['0.6.11-a', '0.6.12-b', '0.6.13-c', '0.6.14-d'].entries()) {
      await source({ origin: async () => checkout({}, id), build }).file('linux-x64')
      const d = path.join(cacheDir, 'files', id)
      const t = new Date(Date.now() - (10 - i) * 60_000)
      if (fs.existsSync(d)) fs.utimesSync(d, t, t)
    }
    expect(fs.readdirSync(path.join(cacheDir, 'files')).sort()).toEqual(['0.6.12-b', '0.6.13-c', '0.6.14-d'])
    expect(fs.existsSync(path.join(cacheDir, '0.6.10-aaa.tgz'))).toBe(false)
    expect(fs.existsSync(path.join(cacheDir, '0.6.10-aaa-companion-linux-arm64.tgz'))).toBe(true)
  })

  it('a build dir a stopped server left is removed on the first ask', async () => {
    const { build } = fakeBuild()
    const left = path.join(workDir, 'walnut-host-file-left')
    fs.mkdirSync(path.join(left, 'tree', 'dist-bin'), { recursive: true })
    fs.writeFileSync(path.join(left, WORK_OWNER), JSON.stringify({ pid: 999_999_999, at: Date.now() }))
    await source({ origin: async () => checkout(), build }).file('linux-x64')
    expect(fs.existsSync(left)).toBe(false)
  })
})

describe('the files beside the running build', () => {
  const ASSETS = '0.6.14-978b9c24b11f'
  /** A dist-bin dir of one build-binary run: every file carries the run's asset archive id. */
  function distBin(root: string, targets: HostFileTarget[], assets = ASSETS): string {
    const bin = path.join(root, 'dist-bin')
    fs.mkdirSync(bin, { recursive: true })
    for (const t of targets) fs.writeFileSync(path.join(bin, `walnut-${t}`), Buffer.concat([Buffer.alloc(3 << 20, 1), Buffer.from(`var ASSETS_ID = ${JSON.stringify(assets)};`), Buffer.from(`${t}\n`)]))
    return bin
  }

  it('the compiled file\'s siblings of its own run are sent as they are: no build', async () => {
    const { calls, build } = fakeBuild()
    const bin = distBin(path.join(dir, 'stage'), ['darwin-arm64', 'linux-x64', 'linux-arm64-musl'])
    const said: string[] = []
    const src = source({ origin: async () => ({ ...checkout(), siblings: [{ dir: bin, assetsId: ASSETS }] }), build })
    const f = await src.file('linux-x64', (m) => said.push(m))
    expect(zlib.gunzipSync(f.gz).equals(fs.readFileSync(path.join(bin, 'walnut-linux-x64')))).toBe(true)
    expect(f.sha256).toBe(sha(fs.readFileSync(path.join(bin, 'walnut-linux-x64'))))
    expect(said).toEqual(['Using the walnut file for linux-x64 built with this server.'])
    expect(calls).toEqual([])
    // One whose cross-compile failed is not there: that target is built.
    await src.file('linux-arm64')
    expect(calls.map((c) => c.targets)).toEqual([['linux-arm64']])
  })

  it('a file of another run (another asset archive) is not this build: it is built instead', async () => {
    const { calls, build } = fakeBuild()
    const bin = distBin(path.join(dir, 'stage'), ['linux-x64'], '0.6.14-000000000000')
    await source({ origin: async () => ({ ...checkout(), siblings: [{ dir: bin, assetsId: ASSETS }] }), build }).file('linux-x64')
    expect(calls).toHaveLength(1)
  })

  it('a dist\'s dist-bin is checked through its own system\'s file: its --version and its archive id', async () => {
    const { calls, build } = fakeBuild()
    const own = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as HostFileTarget
    const other: HostFileTarget = own === 'linux-arm64' ? 'linux-x64' : 'linux-arm64'
    const bin = distBin(path.join(dir, 'checkout'), [own, other])
    const asked: string[] = []
    const answer = (line: string): HostFileSourceOptions['versionHere'] => async (file, target) => {
      asked.push(`${path.basename(file)}:${target}`)
      return target === own ? { line, assetsId: ASSETS } satisfies FileVersion : null
    }
    const good = await source({ origin: async () => ({ ...checkout(), siblings: [{ dir: bin }] }), build, versionHere: answer('0.6.14 (80dc024a8, 2026-10-22)') }).file(other)
    expect(zlib.gunzipSync(good.gz).subarray(-(other.length + 1)).toString()).toBe(`${other}\n`)
    expect(calls).toEqual([])
    expect(asked).toEqual([`walnut-${own}:${own}`])
    // The same files saying another commit: built.
    await source({ cacheDir: path.join(dir, 'other-cache'), origin: async () => ({ ...checkout(), siblings: [{ dir: bin }] }), build, versionHere: answer('0.6.14 (1111111aa, 2026-10-22)') }).file(other)
    expect(calls).toHaveLength(1)
  })

  it('reads a --version line the way the host does', () => {
    expect(versionLineMatches('0.6.14 (80dc024a8, 2026-10-22)', '0.6.14', '80dc024a8')).toBe(true)
    expect(versionLineMatches('0.6.14 (80dc024a8)', '0.6.14', '80dc024a8')).toBe(true)
    expect(versionLineMatches('0.6.14 (80dc024a8+dirty, 2026-10-22)', '0.6.14', '80dc024a8')).toBe(false)
    expect(versionLineMatches('0.6.14 (80dc024a81, 2026-10-22)', '0.6.14', '80dc024a8')).toBe(false)
    expect(versionLineMatches('0.6.140 (80dc024a8, 2026-10-22)', '0.6.14', '80dc024a8')).toBe(false)
  })

  it('finds a string across the chunks it reads', async () => {
    const f = path.join(dir, 'big')
    // The needle straddles the 1 MB read boundary.
    fs.writeFileSync(f, Buffer.concat([Buffer.alloc((1 << 20) - 5, 0), Buffer.from('"0.6.14-abc"'), Buffer.alloc(100, 0)]))
    expect(await fileContains(f, '"0.6.14-abc"')).toBe(true)
    expect(await fileContains(f, '"0.6.14-abd"')).toBe(false)
  })
})

/** A release laid out as GitHub serves it: <base>/v<version>/{SHA256SUMS, walnut-<version>-<target>.gz}. */
function release(base: string, version: string, files: Record<string, Buffer>, opts: { tamper?: string; wrongPlain?: string } = {}): void {
  const d = path.join(base, `v${version}`)
  fs.mkdirSync(d, { recursive: true })
  const lines: string[] = []
  for (const [target, file] of Object.entries(files)) {
    const gz = zlib.gzipSync(file, { level: 9 })
    const name = `walnut-${version}-${target}`
    fs.writeFileSync(path.join(d, `${name}.gz`), opts.tamper === target ? Buffer.concat([gz, Buffer.from('x')]) : gz)
    lines.push(`${sha(gz)}  ${name}.gz`, `${opts.wrongPlain === target ? 'f'.repeat(64) : sha(file)}  ${name}`)
  }
  fs.writeFileSync(path.join(d, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

const released = (over: Partial<BuildInfo> = {}, what = 'this compiled walnut file'): BuildOrigin =>
  ({ kind: 'release', info: info(over), id: `0.6.14-80dc024a8`, what })

describe('from the release of this server\'s version', () => {
  const linuxFile = Buffer.from('the linux-x64 walnut file\n'.repeat(5000))

  it('downloads the asset, checks both sums, and keeps it', async () => {
    const base = path.join(dir, 'releases')
    release(base, '0.6.14', { 'linux-x64': linuxFile, 'darwin-arm64': Buffer.from('mac') })
    const said: string[] = []
    const src = source({ origin: async () => released(), releaseBase: `file://${base}` })
    const f = await src.file('linux-x64', (m) => said.push(m))
    expect(zlib.gunzipSync(f.gz).equals(linuxFile)).toBe(true)
    expect(f).toMatchObject({ id: '0.6.14-80dc024a8', version: '0.6.14', target: 'linux-x64', sha256: sha(linuxFile) })
    expect(said).toEqual(['Downloading Walnut 0.6.14 for linux-x64 (walnut-0.6.14-linux-x64.gz).'])
    // Cached: the release can go away.
    fs.rmSync(base, { recursive: true, force: true })
    expect((await source({ origin: async () => released(), releaseBase: `file://${base}` }).file('linux-x64')).sha256).toBe(sha(linuxFile))
    expect(fs.readdirSync(cacheDir).filter((n) => n.startsWith('download-'))).toEqual([])
  })

  it('over HTTP, following the release\'s redirect, once', async () => {
    const base = path.join(dir, 'releases')
    release(base, '0.6.14', { 'linux-arm64': linuxFile })
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      seen.push(req.url!)
      if (req.url!.startsWith('/download/')) {
        // The asset host: what GitHub's redirect lands on.
        const file = path.join(base, req.url!.slice('/download/'.length))
        if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return }
        res.end(fs.readFileSync(file))
        return
      }
      res.statusCode = 302
      res.setHeader('location', `/download${req.url!.replace(/^\/releases/, '')}`)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const port = (server.address() as AddressInfo).port
      const src = source({ origin: async () => released(), releaseBase: `http://127.0.0.1:${port}/releases` })
      const f = await src.file('linux-arm64')
      expect(zlib.gunzipSync(f.gz).equals(linuxFile)).toBe(true)
      expect(seen).toEqual([
        '/releases/v0.6.14/SHA256SUMS', '/download/v0.6.14/SHA256SUMS',
        '/releases/v0.6.14/walnut-0.6.14-linux-arm64.gz', '/download/v0.6.14/walnut-0.6.14-linux-arm64.gz',
      ])
      await src.file('linux-arm64')
      expect(seen).toHaveLength(4)
    } finally {
      server.close()
    }
  })

  it('a download that does not match its sums is refused and not kept', async () => {
    const base = path.join(dir, 'releases')
    release(base, '0.6.14', { 'linux-x64': linuxFile }, { tamper: 'linux-x64' })
    const src = source({ origin: async () => released(), releaseBase: `file://${base}` })
    await expect(src.file('linux-x64')).rejects.toThrow(/does not match its SHA256SUMS entry/)
    expect(fs.existsSync(path.join(cacheDir, 'files'))).toBe(false)
    release(base, '0.6.14', { 'linux-x64': linuxFile }, { wrongPlain: 'linux-x64' })
    await expect(src.file('linux-x64')).rejects.toThrow(/does not unpack to the file its SHA256SUMS names/)
  })

  it('a version that was never released, or a target it has no file for, says so', async () => {
    const base = path.join(dir, 'releases')
    const src = source({ origin: async () => released(), releaseBase: `file://${base}` })
    await expect(src.file('linux-x64')).rejects.toThrow(/Walnut 0\.6\.14 is not a published release .* and this compiled walnut file has no checkout to build the walnut file for linux-x64 from/)
    release(base, '0.6.14', { 'linux-x64': linuxFile })
    await expect(src.file('linux-arm64-musl')).rejects.toThrow(/Release 0\.6\.14 has no walnut file for linux-arm64-musl/)
  })

  it('a release of the same version from another commit is refused when its file runs here', async () => {
    const base = path.join(dir, 'releases')
    release(base, '0.6.14', { 'linux-x64': linuxFile })
    const lines: string[] = []
    const answering = (line: string) => source({
      origin: async () => released(), releaseBase: `file://${base}`,
      versionHere: async (file) => { lines.push(fs.readFileSync(file, 'utf8').slice(0, 9)); return { line, assetsId: null } },
    })
    await expect(answering('0.6.14 (5bf3ccc9f, 2026-10-20)').file('linux-x64'))
      .rejects.toThrow(/Release 0\.6\.14 was built from another commit than this Walnut \(its file says "0\.6\.14 \(5bf3ccc9f, 2026-10-20\)", this is 0\.6\.14 \(80dc024a8/)
    expect(fs.existsSync(path.join(cacheDir, 'files'))).toBe(false)
    // It ran the downloaded file itself, unpacked.
    expect(lines).toEqual(['the linux'])
    expect((await answering('0.6.14 (80dc024a8, 2026-10-22)').file('linux-x64')).commit).toBe('80dc024a8')
  })

  it('a build from uncommitted changes with no checkout, or one that names no commit, is refused before anything is fetched', async () => {
    const fetchSpy = vi.fn()
    const src = source({ origin: async () => released({ dirty: true }, 'this install of Walnut'), fetch: fetchSpy as unknown as typeof fetch, releaseBase: 'https://example.invalid/r' })
    await expect(src.file('linux-x64')).rejects.toThrow(/was built from a tree with uncommitted changes, and this install of Walnut has no checkout/)
    await expect(source({ origin: async () => released({ version: 'local' }), fetch: fetchSpy as unknown as typeof fetch }).file('linux-x64'))
      .rejects.toThrow(/is not a release version/)
    await expect(source({ origin: async () => released({ commit: null }), fetch: fetchSpy as unknown as typeof fetch }).file('linux-x64'))
      .rejects.toThrow(/names no commit, and this compiled walnut file has no checkout/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reads SHA256SUMS lines in both forms and only for the version asked', () => {
    const text = `${'a'.repeat(64)}  walnut-0.6.14-linux-x64.gz\n${'b'.repeat(64)} *walnut-0.6.14-linux-x64\n${'c'.repeat(64)}  walnut-0.6.13-linux-x64.gz\n`
    expect(sumsFor(text, '0.6.14', 'linux-x64')).toEqual({ gz: 'a'.repeat(64), file: 'b'.repeat(64) })
    expect(sumsFor(text, '0.6.14', 'linux-x64-musl')).toEqual({})
  })

  it('the release base is install.sh\'s knob, else the project\'s GitHub releases', () => {
    expect(defaultReleaseBase({ OPEN_WALNUT_RELEASE_BASE_URL: 'https://mirror.example.invalid/dl/' })).toBe('https://mirror.example.invalid/dl')
    expect(defaultReleaseBase({})).toBe('https://example.invalid/open-walnut/releases/download')
  })
})

describe('which build this server runs', () => {
  function tree(withCheckout: boolean, name = withCheckout ? 'checkout' : 'npm-install'): { distDir: string; root: string } {
    const root = path.join(dir, name)
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'open-walnut', version: '0.6.14' }))
    fs.writeFileSync(path.join(root, 'dist', 'build-info.json'), JSON.stringify(info()))
    if (withCheckout) {
      for (const d of ['.git', 'node_modules', 'scripts', 'src/binary']) fs.mkdirSync(path.join(root, d), { recursive: true })
      fs.writeFileSync(path.join(root, 'scripts', 'build-binary.mjs'), '')
      fs.writeFileSync(path.join(root, 'src', 'binary', 'main.ts'), '')
    }
    return { distDir: path.join(root, 'dist'), root }
  }

  /** What scripts/dev-prod.sh stages and production runs from: dist, package.json, a node_modules link, the marker. */
  function stage(source: string, name = 'open-walnut-stage.1792700000.4242'): { distDir: string; root: string } {
    const root = path.join(dir, name)
    fs.mkdirSync(root)
    fs.cpSync(path.join(source, 'dist'), path.join(root, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'))
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, '.walnut-source-root'), `${source}\n`)
    return { distDir: path.join(root, 'dist'), root }
  }

  it('a dist in a checkout that can build the file is built from', async () => {
    const t = tree(true)
    expect(await runningOrigin(t, null)).toEqual({
      kind: 'checkout', checkout: t.root, distDir: t.distDir, info: info(), id: '0.6.14-80dc024a8', siblings: [{ dir: path.join(t.root, 'dist-bin') }],
    })
  })

  it('production\'s staged copy follows its marker to the checkout and keeps its own dist for the web app', async () => {
    const co = tree(true)
    const st = stage(co.root)
    expect(await runningOrigin(st, null)).toEqual({
      kind: 'checkout', checkout: co.root, distDir: st.distDir, info: info(), id: '0.6.14-80dc024a8',
      siblings: [{ dir: path.join(st.root, 'dist-bin') }, { dir: path.join(co.root, 'dist-bin') }],
    })
    // The rollback snapshot carries the same marker.
    const lkg = stage(co.root, 'lkg')
    expect(await runningOrigin(lkg, null)).toMatchObject({ kind: 'checkout', checkout: co.root, distDir: lkg.distDir })
  })

  it('a marker naming something that is not a checkout counts for nothing', async () => {
    const npm = tree(false)
    const st = stage(npm.root)
    expect(await runningOrigin(st, null)).toMatchObject({ kind: 'release', what: 'this install of Walnut' })
    fs.writeFileSync(path.join(st.root, '.walnut-source-root'), 'relative/path\n')
    expect(await runningOrigin(st, null)).toMatchObject({ kind: 'release' })
  })

  it('the compiled file in a stage\'s dist-bin: its checkout, its runtime tree\'s dist, its siblings by its archive id', async () => {
    const co = tree(true)
    const st = stage(co.root)
    const runtime = path.join(dir, 'runtime', '0.6.14-978b9c24b11f')
    fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(runtime, '.walnut-runtime'), '0.6.14-978b9c24b11f\n')
    const exe = path.join(st.root, 'dist-bin', 'walnut-darwin-arm64')
    // `dist` is what runningDist() finds inside the compiled file: its runtime tree. It must not win.
    const o = await runningOrigin({ distDir: path.join(runtime, 'dist'), root: runtime }, { root: runtime }, exe)
    expect(o).toMatchObject({
      kind: 'checkout', checkout: co.root, distDir: path.join(runtime, 'dist'),
      siblings: [{ dir: path.join(st.root, 'dist-bin'), assetsId: '0.6.14-978b9c24b11f' }],
    })
    // Installed anywhere else (install.sh, the Mac app), it is a release, still with its siblings.
    expect(await runningOrigin(null, { root: runtime }, path.join(dir, 'bin', 'walnut'))).toMatchObject({
      kind: 'release', what: 'this compiled walnut file', siblings: [{ dir: path.join(dir, 'bin'), assetsId: '0.6.14-978b9c24b11f' }],
    })
  })

  it('any other dist (an npm install) downloads its release', async () => {
    const t = tree(false)
    expect(await runningOrigin(t, null)).toEqual({
      kind: 'release', info: info(), id: '0.6.14-80dc024a8', what: 'this install of Walnut', siblings: [{ dir: path.join(t.root, 'dist-bin') }],
    })
  })

  it('running from source has nothing to send, and says how to get a build', async () => {
    const o = await runningOrigin(null, null)
    expect(o).toMatchObject({ kind: 'none' })
    const src = source({ origin: async () => o })
    await expect(src.buildId()).rejects.toThrow(/runs from source, not from a build.*bun run build/)
    await expect(src.file('linux-x64')).rejects.toThrow(/runs from source/)
  })
})
