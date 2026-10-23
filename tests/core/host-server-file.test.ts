/**
 * Where a host's walnut file comes from (src/core/host-server/host-file.ts): this
 * server's build, built from its checkout or downloaded from its release, kept in
 * the data dir's cache. The clone build is a stand-in here (its real run is
 * host-server-file-build.test.ts); the release is real files, read over file://
 * and over a real HTTP server.
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

import { createHostFileSource, defaultReleaseBase, runningOrigin, sumsFor, type BuildOrigin } from '../../src/core/host-server/host-file.js'
import type { CloneBuild } from '../../src/core/host-server/host-file-build.js'
import type { BuildInfo } from '../../src/lib/build-info.js'

let dir = ''
let cacheDir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsf-'))
  cacheDir = path.join(dir, 'cache', 'host-server')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const info = (over: Partial<BuildInfo> = {}): BuildInfo => ({ version: '0.6.14', commit: '80dc024a8', branch: 'main', builtAt: '2026-10-22T10:00:00.000Z', dirty: false, ...over })

function checkout(over: Partial<BuildInfo> = {}, id = '0.6.14-80dc024a8'): BuildOrigin {
  return { kind: 'checkout', checkout: '/work/walnut', distDir: '/work/walnut/dist', info: info(over), id }
}

/** A stand-in clone build: writes "<target> built from <commit>" and counts. */
function fakeBuild() {
  const calls: CloneBuild[] = []
  const build = async (b: CloneBuild): Promise<string> => {
    calls.push(b)
    await new Promise((r) => setTimeout(r, 20))
    const out = path.join(b.work, 'tree', 'dist-bin', `walnut-${b.target}`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `${b.target} built from ${b.commit}${b.dirty ? ' (dirty)' : ''}\n`.repeat(1000))
    return out
  }
  return { calls, build }
}

describe('from this server\'s checkout', () => {
  it('builds the file once per build and target, then reads it from the cache', async () => {
    const { calls, build } = fakeBuild()
    const said: string[] = []
    const src = createHostFileSource({ cacheDir, origin: async () => checkout(), build, bun: async () => ({ path: '/opt/bun/bin/bun', version: '1.4.4' }) })
    expect(await src.buildId()).toEqual({ id: '0.6.14-80dc024a8', version: '0.6.14' })
    const f = await src.file('linux-x64', (m) => said.push(m))
    const plain = zlib.gunzipSync(f.gz)
    expect(plain.toString()).toMatch(/^linux-x64 built from 80dc024a8\n/)
    expect(f).toMatchObject({ id: '0.6.14-80dc024a8', version: '0.6.14', target: 'linux-x64', sha256: sha(plain) })
    expect(said).toEqual(['Building Walnut 0.6.14-80dc024a8 for linux-x64 on this computer (about a minute, once per build).'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      checkout: '/work/walnut', distDir: '/work/walnut/dist', commit: '80dc024a8', dirty: false, target: 'linux-x64', bun: '/opt/bun/bin/bun',
      log: path.join(cacheDir, 'build-0.6.14-80dc024a8-linux-x64.log'),
    })
    // The build's own dir is gone; the cache holds the gz and its sums, nothing else.
    expect(fs.existsSync(calls[0]!.work)).toBe(false)
    expect(fs.readdirSync(path.join(cacheDir, 'files', '0.6.14-80dc024a8')).sort()).toEqual(['walnut-linux-x64.gz', 'walnut-linux-x64.json'])

    // A second source (a restart of this server) reads the cache: no build.
    const again = createHostFileSource({ cacheDir, origin: async () => checkout(), build, bun: async () => ({ path: '/opt/bun/bin/bun', version: '1.4.4' }) })
    const g = await again.file('linux-x64', (m) => said.push(m))
    expect(g.gz.equals(f.gz)).toBe(true)
    expect(g.sha256).toBe(f.sha256)
    expect(calls).toHaveLength(1)
    expect(said).toHaveLength(1)
  })

  it('two hosts asking at once share one build; another target is its own build', async () => {
    const { calls, build } = fakeBuild()
    const src = createHostFileSource({ cacheDir, origin: async () => checkout(), build, bun: async () => ({ path: '/b/bun', version: '1.4.4' }) })
    const [a, b] = await Promise.all([src.file('linux-x64'), src.file('linux-x64')])
    expect(a.gz.equals(b.gz)).toBe(true)
    expect(calls).toHaveLength(1)
    const musl = await src.file('linux-arm64-musl')
    expect(zlib.gunzipSync(musl.gz).toString()).toMatch(/^linux-arm64-musl built/)
    expect(calls.map((c) => c.target)).toEqual(['linux-x64', 'linux-arm64-musl'])
  })

  it('asks for a bun as new as the checkout pins (package.json packageManager)', async () => {
    const { calls, build } = fakeBuild()
    const co = path.join(dir, 'co')
    fs.mkdirSync(co)
    fs.writeFileSync(path.join(co, 'package.json'), JSON.stringify({ name: 'open-walnut', packageManager: 'bun@1.4.4' }))
    const asked: Array<string | null> = []
    const src = createHostFileSource({
      cacheDir, build,
      origin: async () => ({ kind: 'checkout', checkout: co, distDir: path.join(co, 'dist'), info: info(), id: '0.6.14-80dc024a8' }),
      bun: async (min) => { asked.push(min); return { path: '/b/bun', version: '1.4.4' } },
    })
    await src.file('linux-x64')
    expect(asked).toEqual(['1.4.4'])
    expect(calls[0]!.bun).toBe('/b/bun')
  })

  it('a build from uncommitted changes asks the clone for them too', async () => {
    const { calls, build } = fakeBuild()
    const src = createHostFileSource({ cacheDir, origin: async () => checkout({ dirty: true }, '0.6.14-80dc024a8-d1a2b3c'), build, bun: async () => ({ path: '/b/bun', version: '1.4.4' }) })
    await src.file('linux-x64')
    expect(calls[0]).toMatchObject({ dirty: true, commit: '80dc024a8' })
  })

  it('a cached file that went bad is built again', async () => {
    const { calls, build } = fakeBuild()
    const src = () => createHostFileSource({ cacheDir, origin: async () => checkout(), build, bun: async () => ({ path: '/b/bun', version: '1.4.4' }) })
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
    const src = createHostFileSource({
      cacheDir, origin: async () => checkout(), bun: async () => ({ path: '/b/bun', version: '1.4.4' }),
      build: async (b) => { if (n++ === 0) throw new Error('building the walnut file for linux-x64 failed (exit 1): boom'); return build(b) },
    })
    await expect(src.file('linux-x64')).rejects.toThrow(/failed \(exit 1\): boom/)
    expect((await src.file('linux-x64')).target).toBe('linux-x64')
  })

  it('without bun, or a build with no commit, says what is missing', async () => {
    const { calls, build } = fakeBuild()
    await expect(createHostFileSource({ cacheDir, origin: async () => checkout(), build, bun: async () => ({ why: 'Building the walnut file needs bun on this computer (https://bun.sh); none was found.' }) }).file('linux-x64'))
      .rejects.toThrow(/needs bun on this computer/)
    await expect(createHostFileSource({ cacheDir, origin: async () => checkout({ commit: null }), build, bun: async () => ({ path: '/b/bun', version: '1.4.4' }) }).file('linux-x64'))
      .rejects.toThrow(/names no commit/)
    expect(calls).toEqual([])
  })

  it('keeps the newest few builds and drops the Node layout\'s host packages, never the companion\'s', async () => {
    const { build } = fakeBuild()
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, '0.6.10-aaa.tgz'), 'old host package')
    fs.writeFileSync(path.join(cacheDir, '0.6.10-aaa-companion-linux-arm64.tgz'), 'companion package')
    for (const [i, id] of ['0.6.11-a', '0.6.12-b', '0.6.13-c', '0.6.14-d'].entries()) {
      await createHostFileSource({ cacheDir, origin: async () => checkout({}, id), build, bun: async () => ({ path: '/b/bun', version: '1.4.4' }) }).file('linux-x64')
      const d = path.join(cacheDir, 'files', id)
      const t = new Date(Date.now() - (10 - i) * 60_000)
      if (fs.existsSync(d)) fs.utimesSync(d, t, t)
    }
    expect(fs.readdirSync(path.join(cacheDir, 'files')).sort()).toEqual(['0.6.12-b', '0.6.13-c', '0.6.14-d'])
    expect(fs.existsSync(path.join(cacheDir, '0.6.10-aaa.tgz'))).toBe(false)
    expect(fs.existsSync(path.join(cacheDir, '0.6.10-aaa-companion-linux-arm64.tgz'))).toBe(true)
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
    const src = createHostFileSource({ cacheDir, origin: async () => released(), releaseBase: `file://${base}` })
    const f = await src.file('linux-x64', (m) => said.push(m))
    expect(zlib.gunzipSync(f.gz).equals(linuxFile)).toBe(true)
    expect(f).toMatchObject({ id: '0.6.14-80dc024a8', version: '0.6.14', target: 'linux-x64', sha256: sha(linuxFile) })
    expect(said).toEqual(['Downloading Walnut 0.6.14 for linux-x64 (walnut-0.6.14-linux-x64.gz).'])
    // Cached: the release can go away.
    fs.rmSync(base, { recursive: true, force: true })
    expect((await createHostFileSource({ cacheDir, origin: async () => released(), releaseBase: `file://${base}` }).file('linux-x64')).sha256).toBe(sha(linuxFile))
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
      const src = createHostFileSource({ cacheDir, origin: async () => released(), releaseBase: `http://127.0.0.1:${port}/releases` })
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
    const src = createHostFileSource({ cacheDir, origin: async () => released(), releaseBase: `file://${base}` })
    await expect(src.file('linux-x64')).rejects.toThrow(/does not match its SHA256SUMS entry/)
    expect(fs.existsSync(path.join(cacheDir, 'files'))).toBe(false)
    release(base, '0.6.14', { 'linux-x64': linuxFile }, { wrongPlain: 'linux-x64' })
    await expect(src.file('linux-x64')).rejects.toThrow(/does not unpack to the file its SHA256SUMS names/)
  })

  it('a version that was never released, or a target it has no file for, says so', async () => {
    const base = path.join(dir, 'releases')
    const src = createHostFileSource({ cacheDir, origin: async () => released(), releaseBase: `file://${base}` })
    await expect(src.file('linux-x64')).rejects.toThrow(/Walnut 0\.6\.14 is not a published release .* and this compiled walnut file has no checkout to build the walnut file for linux-x64 from/)
    release(base, '0.6.14', { 'linux-x64': linuxFile })
    await expect(src.file('linux-arm64-musl')).rejects.toThrow(/Release 0\.6\.14 has no walnut file for linux-arm64-musl/)
  })

  it('a build from uncommitted changes with no checkout is refused before anything is fetched', async () => {
    const fetchSpy = vi.fn()
    const src = createHostFileSource({ cacheDir, origin: async () => released({ dirty: true }, 'this install of Walnut'), fetch: fetchSpy as unknown as typeof fetch, releaseBase: 'https://example.invalid/r' })
    await expect(src.file('linux-x64')).rejects.toThrow(/was built from a tree with uncommitted changes, and this install of Walnut has no checkout/)
    await expect(createHostFileSource({ cacheDir, origin: async () => released({ version: 'local' }), fetch: fetchSpy as unknown as typeof fetch }).file('linux-x64'))
      .rejects.toThrow(/is not a release version/)
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
  function tree(withCheckout: boolean): { distDir: string; root: string } {
    const root = path.join(dir, withCheckout ? 'checkout' : 'npm-install')
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

  it('a dist in a checkout that can build the file is built from', async () => {
    const t = tree(true)
    expect(await runningOrigin(t, false)).toEqual({ kind: 'checkout', checkout: t.root, distDir: t.distDir, info: info(), id: '0.6.14-80dc024a8' })
  })

  it('any other dist (an npm install) and the compiled file download their release', async () => {
    expect(await runningOrigin(tree(false), false)).toEqual({ kind: 'release', info: info(), id: '0.6.14-80dc024a8', what: 'this install of Walnut' })
    expect(await runningOrigin(null, true)).toMatchObject({ kind: 'release', what: 'this compiled walnut file' })
  })

  it('running from source has nothing to send, and says how to get a build', async () => {
    const o = await runningOrigin(null, false)
    expect(o).toMatchObject({ kind: 'none' })
    const src = createHostFileSource({ cacheDir, origin: async () => o })
    await expect(src.buildId()).rejects.toThrow(/runs from source, not from a build.*bun run build/)
    await expect(src.file('linux-x64')).rejects.toThrow(/runs from source/)
  })
})
