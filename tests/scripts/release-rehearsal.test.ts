/**
 * scripts/release-rehearsal/: the pieces CI's rehearsal is built from.
 *
 * - registry.mjs serves open-walnut tarballs the way npm does; real `npm`
 *   installs from it and reads its dist-tags (offline: the fake package has no
 *   dependencies), and everything else passes through to an upstream.
 * - version-order.mjs answers exactly as the update check's comparator.
 * - walnut.mjs keeps every path an installed Walnut touches inside its work dir,
 *   and its `claude` is the mock CLI.
 * - pack.mjs refuses to rebuild a git checkout outside CI.
 *
 * The full rehearsal (install, serve, session, restart, update) runs in CI on
 * Linux and macOS (ci.yml, job `rehearsal`).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { buildPackument, distOf, readPackedManifest, startRegistry } from '../../scripts/release-rehearsal/registry.mjs'
import { compareVersions as scriptCompare } from '../../scripts/release-rehearsal/version-order.mjs'
import { IsolatedWalnut, MOCK_CLAUDE } from '../../scripts/release-rehearsal/walnut.mjs'
import { compareVersions } from '../../src/core/self-update/version-compare.js'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-test-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A packed open-walnut with a bin and no dependencies, as `npm pack` lays it out. */
function fakeTarball(version: string): string {
  const dir = path.join(tmp, `src-${version}`)
  fs.mkdirSync(path.join(dir, 'package/bin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package/package.json'), `${JSON.stringify({ name: 'open-walnut', version, bin: { 'open-walnut': 'bin/w.js' } }, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'package/bin/w.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)})\n`, { mode: 0o755 })
  const file = path.join(tmp, `open-walnut-${version}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', dir, 'package'])
  return file
}

const A = fakeTarball('1.0.0')
const B = fakeTarball('1.1.0')

describe('registry', () => {
  it('reads the manifest a tarball carries and the dist npm verifies a download by', () => {
    expect(readPackedManifest(A)).toMatchObject({ name: 'open-walnut', version: '1.0.0' })
    const dist = distOf(A, 'http://x/a.tgz')
    expect(dist.tarball).toBe('http://x/a.tgz')
    expect(dist.shasum).toMatch(/^[0-9a-f]{40}$/)
    expect(dist.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
  })

  it('builds a packument with every version, the dist-tags and publish times in order', () => {
    const doc = buildPackument({ tarballs: [{ file: A }, { file: B }], distTags: { latest: '1.1.0', nightly: '1.0.0' }, baseUrl: 'http://r' })
    expect(Object.keys(doc.versions)).toEqual(['1.0.0', '1.1.0'])
    expect(doc['dist-tags']).toEqual({ latest: '1.1.0', nightly: '1.0.0' })
    expect(doc.versions['1.1.0'].dist.tarball).toBe('http://r/open-walnut/-/open-walnut-1.1.0.tgz')
    expect(Date.parse(doc.time['1.0.0'])).toBeLessThan(Date.parse(doc.time['1.1.0']))
    expect(() => buildPackument({ tarballs: [{ file: A }], distTags: { latest: '9.9.9' }, baseUrl: 'http://r' })).toThrow('not served')
  })

  it('real npm installs from it, the update check reads its dist-tags, and nothing else of open-walnut exists', async () => {
    const registry = await startRegistry({ tarballs: [{ file: A }, { file: B }], distTags: { latest: '1.1.0' }, upstream: 'http://127.0.0.1:9' })
    try {
      const prefix = path.join(tmp, 'prefix')
      const env = { ...process.env, npm_config_prefix: prefix, npm_config_registry: `${registry.url}/`, npm_config_cache: path.join(tmp, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }
      // Async: the registry answers from this same event loop, so a sync spawn would deadlock.
      const install = await new Promise<number>((resolve) => {
        const child = spawn('npm', ['install', '-g', 'open-walnut@1.0.0'], { env, stdio: 'ignore' })
        child.on('close', (code) => resolve(code ?? 1))
      })
      expect(install).toBe(0)
      const installed = JSON.parse(fs.readFileSync(path.join(prefix, 'lib/node_modules/open-walnut/package.json'), 'utf8'))
      expect(installed.version).toBe('1.0.0')
      const tags = await (await fetch(registry.distTagsUrl)).json()
      expect(tags).toEqual({ latest: '1.1.0' })
      expect(registry.hits).toEqual(expect.arrayContaining(['/open-walnut', '/open-walnut/-/open-walnut-1.0.0.tgz', '/-/package/open-walnut/dist-tags']))
      expect((await fetch(`${registry.url}/open-walnut/-/open-walnut-7.7.7.tgz`)).status).toBe(404)
    } finally {
      await registry.close()
    }
  }, 120_000)

  it('passes other packages through, decoded, with a correct length', async () => {
    const body = JSON.stringify({ name: 'left-pad', 'dist-tags': { latest: '1.3.0' } })
    const upstream = http.createServer((req, res) => {
      if (req.url !== '/left-pad') { res.writeHead(404); return res.end() }
      const gz = zlib.gzipSync(body)
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length })
      res.end(gz)
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const registry = await startRegistry({ tarballs: [{ file: A }], distTags: { latest: '1.0.0' }, upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` })
    try {
      const res = await fetch(`${registry.url}/left-pad`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
      expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body))
      expect(await res.json()).toEqual(JSON.parse(body))
      expect((await fetch(`${registry.url}/nope`)).status).toBe(404)
      expect(registry.hits).toEqual([])
    } finally {
      await registry.close()
      await new Promise((r) => upstream.close(r))
    }
  })
})

describe('version-order', () => {
  it('answers exactly as the update check does', () => {
    const versions = ['0.6.0', '0.6.1', '0.6.1-rehearsal.1', '0.6.1-nightly.20261001.5', '0.6.1-nightly.20261002.1',
      '0.6.1-nightly.20261002.12', '0.7.0', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-alpha', '1.0.0', 'v1.0.0', '1.0.0+build.1', 'garbage', '']
    for (const a of versions) for (const b of versions) expect(scriptCompare(a, b), `${a} vs ${b}`).toBe(compareVersions(a, b))
  })
})

describe('IsolatedWalnut', () => {
  const w = new IsolatedWalnut({ work: tmp, name: 'iso' })

  it('keeps every path it hands the installed Walnut inside its work dir', () => {
    for (const key of ['HOME', 'OPEN_WALNUT_HOME', 'WALNUT_DAEMON_DIR', 'WALNUT_STREAMS_DIR', 'WALNUT_LEGACY_STREAMS_DIR', 'npm_config_prefix', 'MOCK_CLAUDE_TRANSCRIPT_DIR']) {
      expect((w.env as Record<string, string>)[key], key).toMatch(new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
    }
    expect(w.env.HOME).not.toBe(os.homedir())
    expect(w.env.PATH.split(path.delimiter)[0]).toBe(w.binDir)
    expect(w.bin).toBe(path.join(w.prefix, 'bin', 'open-walnut'))
  })

  it('puts the mock CLI on PATH as `claude`, and where Claude Code installs itself', () => {
    for (const p of [path.join(w.binDir, 'claude'), path.join(w.home, '.local/bin/claude')]) {
      expect(fs.statSync(p).mode & 0o111).not.toBe(0)
      expect(fs.readFileSync(p, 'utf8')).toContain(MOCK_CLAUDE)
    }
    const out = execFileSync(path.join(w.binDir, 'claude'), ['-p', '--output-format', 'json', 'ping'], { env: { ...process.env, ...w.env }, encoding: 'utf8', timeout: 30_000 })
    expect(out).toContain('I processed your message: ping')
  })
})

describe('the scripts refuse what would be unsafe or meaningless', () => {
  it('pack.mjs will not rebuild a git checkout outside CI', () => {
    const env = { ...process.env }
    delete env.CI
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-rehearsal/pack.mjs'), '--out', path.join(tmp, 'p'), '--rehearsal'], { env, encoding: 'utf8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('run it in CI or in a copy of the tree')
    expect(fs.existsSync(path.join(tmp, 'p'))).toBe(false)
  })

  it('every `npm pack --json` skips lifecycle scripts, whose output would corrupt the JSON', () => {
    // A checkout without .git (git archive) makes `prepare` (husky) print to stdout.
    for (const file of ['scripts/check-publish.mjs', 'scripts/release-rehearsal/pack.mjs']) {
      const calls = fs.readFileSync(path.join(ROOT, file), 'utf8').match(/\['pack',[^\]]*\]/g) ?? []
      expect(calls.length, file).toBeGreaterThan(0)
      for (const call of calls) expect(call, file).toContain("'--ignore-scripts'")
    }
  })

  it('run.mjs needs the package it rehearses', () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-rehearsal/run.mjs')], { encoding: 'utf8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('usage: run.mjs --current')
  })

  it('run.mjs creates the --work dir CI names before it exists', () => {
    const work = path.join(tmp, 'not-yet', 'work')
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-rehearsal/run.mjs'), '--current', path.join(tmp, 'missing.tgz'), '--work', work], { encoding: 'utf8' })
    expect(res.status).toBe(1)
    expect(fs.existsSync(work)).toBe(true)
    // It got as far as reading the tarball.
    expect(res.stderr).not.toContain('lstat')
    expect(res.stderr).toContain('missing.tgz')
  })
})
