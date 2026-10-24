/**
 * The npm launcher when npm left this machine's platform package out
 * (scripts/npm-launcher/fetch-platform.js, postinstall.js, launch.js): npm
 * finishes an install without an optional dependency it could not get
 * (a registry that does not serve it yet), and an update from
 * a 0.6.x Node release restarts into the launcher without checking. The
 * postinstall fetches the file or fails the install (npm then keeps the version
 * before); a start that finds no file fetches it, or says what to run.
 *
 * Offline: a local registry serves a platform package whose `walnut` is a
 * small script printing its version.
 */
import { spawnSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ENTRY, LAUNCHER_LIB } from '../../scripts/npm-packages.mjs'

// The launcher is CommonJS (it runs on old Node): loaded the way Node loads it.
const requireCjs = createRequire(import.meta.url)
const { candidateTargets, reinstallCommand } = requireCjs('../../scripts/npm-launcher/launch.js')
const { fetchPlatformPackage, packageFiles, registryFor } = requireCjs('../../scripts/npm-launcher/fetch-platform.js')

const ROOT = path.resolve(__dirname, '../..')
const VERSION = '9.9.9'
const TARGET: string = candidateTargets()[0]
let tmp = ''
let server: http.Server
let base = ''
const hits: string[] = []
/** What the registry answers, by path; a test changes it. */
let routes: Record<string, { status: number; body: Buffer | string; type?: string }> = {}

/** One ustar entry (no checksum check on read, but a valid one is written). */
function tarEntry(name: string, data: Buffer, mode = 0o644): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const b of header) sum += b
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)])
}
const tgz = (entries: Buffer[]) => zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
const walnutScript = (printed: string) => Buffer.from(`#!/bin/sh\necho '${printed}'\n`)

/** Serve @open-walnut/<TARGET>@<version> with `files` (path inside package/ -> content). */
function publish(files: Record<string, Buffer>, { version = VERSION, integrityOf = null as Buffer | null } = {}) {
  const tarball = tgz(Object.entries(files).map(([n, d]) => tarEntry(`package/${n}`, d, n === 'walnut' ? 0o755 : 0o644)))
  const integrity = `sha512-${crypto.createHash('sha512').update(integrityOf ?? tarball).digest('base64')}`
  routes[`/@open-walnut%2f${TARGET}/${version}`] = { status: 200, type: 'application/json', body: JSON.stringify({ name: `@open-walnut/${TARGET}`, version, dist: { tarball: `${base}/t/${TARGET}-${version}.tgz`, integrity } }) }
  routes[`/t/${TARGET}-${version}.tgz`] = { status: 200, body: tarball }
}

/** A global prefix holding the launcher package and no platform package. */
function launcherOnly(name: string, { archive = false } = {}): { root: string; bin: string } {
  const prefix = path.join(tmp, name)
  const root = path.join(prefix, 'lib', 'node_modules', 'open-walnut')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  for (const f of LAUNCHER_LIB) fs.copyFileSync(path.join(ROOT, 'scripts/npm-launcher', f), path.join(root, 'lib', f))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'open-walnut', version: VERSION, type: 'commonjs' }))
  fs.writeFileSync(path.join(root, 'bin', 'open-walnut.js'), ENTRY('../lib/launch.js'))
  if (archive) fs.writeFileSync(path.join(prefix, 'open-walnut-runtime.json'), '{}')
  return { root, bin: path.join(root, 'bin', 'open-walnut.js') }
}

const node = process.env.WALNUT_TEST_NODE || 'node'
const env = () => ({ ...process.env, npm_config_registry: base, WALNUT_UPDATE_REGISTRY_URL: '' })
const runAsync = (args: string[], cwd?: string) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const child = spawn(node, args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  child.on('close', (code) => resolve({ code, out, err }))
})

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launcher-fetch-')))
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    const r = routes[req.url ?? '']
    if (!r) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}') }
    res.writeHead(r.status, { 'content-type': r.type ?? 'application/octet-stream' })
    res.end(r.body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('fetch-platform.js', () => {
  it('reads every file under package/ and refuses an entry outside it', () => {
    const files = packageFiles(zlib.gunzipSync(tgz([tarEntry('package/walnut', walnutScript('x')), tarEntry('package/a/b.txt', Buffer.from('b')), tarEntry('other/c', Buffer.from('c'))])))
    expect([...files.keys()].sort()).toEqual(['a/b.txt', 'walnut'])
    expect(() => packageFiles(zlib.gunzipSync(tgz([tarEntry('package/../evil', Buffer.from('e'))])))).toThrow('outside itself')
  })

  it('fetches from the registry npm runs against, else the update check\'s, else npm\'s own', () => {
    expect(registryFor({ npm_config_registry: 'http://mirror.example/npm/' })).toBe('http://mirror.example/npm')
    expect(registryFor({ WALNUT_UPDATE_REGISTRY_URL: 'http://r.example/-/package/open-walnut/dist-tags' })).toBe('http://r.example')
    expect(registryFor({})).toBe('https://registry.npmjs.org')
  })

  it('puts a checked package beside the launcher, where require finds it', async () => {
    publish({ 'package.json': Buffer.from(`{"name":"@open-walnut/${TARGET}","version":"${VERSION}"}`), walnut: walnutScript(`${VERSION} (fetched)`) })
    const { root } = launcherOnly('ok')
    const file = await fetchPlatformPackage({ packageRoot: root, target: TARGET, version: VERSION, registry: base })
    expect(file).toBe(path.join(root, 'node_modules/@open-walnut', TARGET, 'walnut'))
    expect(spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`${VERSION} (fetched)`)
    expect(fs.readdirSync(path.join(root, 'node_modules/@open-walnut'))).toEqual([TARGET])
  })

  it('leaves nothing behind for a download that does not match, a file that does not run as the version, or a missing version', async () => {
    const tries: Array<[string, () => void, RegExp]> = [
      ['tampered', () => publish({ walnut: walnutScript(VERSION) }, { integrityOf: Buffer.from('other bytes') }), /does not match its integrity/],
      ['wrong', () => publish({ walnut: walnutScript('1.0.0 (old)') }), /does not run here \(it printed: 1\.0\.0/],
      ['fails', () => publish({ walnut: Buffer.from("#!/bin/sh\necho 'cannot start here' >&2\nexit 1\n") }), /does not run here \(cannot start here\)/],
      ['missing', () => { routes = {} }, /is not on/],
    ]
    for (const [name, setup, error] of tries) {
      setup()
      const { root } = launcherOnly(`bad-${name}`)
      await expect(fetchPlatformPackage({ packageRoot: root, target: TARGET, version: VERSION, registry: base }), name).rejects.toThrow(error)
      const scope = path.join(root, 'node_modules/@open-walnut')
      expect(fs.existsSync(scope) ? fs.readdirSync(scope) : [], name).toEqual([])
    }
  })
})

describe('the launcher without its file', () => {
  it('fetches it at its first start and runs it; the next start finds it', async () => {
    publish({ 'package.json': Buffer.from(`{"name":"@open-walnut/${TARGET}","version":"${VERSION}"}`), walnut: walnutScript(`${VERSION} (fetched)`) })
    const { bin } = launcherOnly('heal')
    const first = await runAsync([bin, '--version'])
    expect(first.code, first.err).toBe(0)
    expect(first.out.trim()).toBe(`${VERSION} (fetched)`)
    expect(first.err).toContain(`fetching @open-walnut/${TARGET}@${VERSION}`)
    const downloads = hits.filter((h) => h.endsWith('.tgz')).length
    const again = await runAsync([bin, '--version'])
    expect(again.out.trim()).toBe(`${VERSION} (fetched)`)
    expect(again.err).toBe('')
    expect(hits.filter((h) => h.endsWith('.tgz')).length).toBe(downloads)
  })

  it('says what to run when it cannot fetch it: npm for an npm install, install.sh for the Node archive', async () => {
    routes = {}
    const npm = await runAsync([launcherOnly('nofile').bin, '--version'])
    expect(npm.code).toBe(1)
    expect(npm.err).toContain(`Install it again with: npm install -g open-walnut@${VERSION}`)
    const archive = await runAsync([launcherOnly('nofile-archive', { archive: true }).bin, '--version'])
    expect(archive.code).toBe(1)
    expect(archive.err).toContain('releases/latest/download/install.sh | sh')
    expect(reinstallCommand('/x/lib/node_modules/open-walnut', '1.2.3', () => false)).toBe('npm install -g open-walnut@1.2.3')
  })
})

describe('postinstall.js', () => {
  it('passes at once when npm installed the file', async () => {
    const { root } = launcherOnly('post-ok')
    const dir = path.join(root, 'node_modules/@open-walnut', TARGET)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"@open-walnut/${TARGET}"}`)
    fs.writeFileSync(path.join(dir, 'walnut'), walnutScript(VERSION), { mode: 0o755 })
    const before = hits.length
    const r = await runAsync([path.join(root, 'lib/postinstall.js')], root)
    expect(r.code, r.err).toBe(0)
    expect(hits.length).toBe(before)
  })

  it('fetches a file npm left out, or fails the install so npm keeps the version before', async () => {
    publish({ walnut: walnutScript(VERSION) })
    const fixed = launcherOnly('post-fetch')
    const ok = await runAsync([path.join(fixed.root, 'lib/postinstall.js')], fixed.root)
    expect(ok.code, ok.err).toBe(0)
    expect(fs.existsSync(path.join(fixed.root, 'node_modules/@open-walnut', TARGET, 'walnut'))).toBe(true)
    routes = {}
    const lag = launcherOnly('post-lag')
    const failed = await runAsync([path.join(lag.root, 'lib/postinstall.js')], lag.root)
    expect(failed.code).toBe(1)
    expect(failed.err).toContain(`npm did not install @open-walnut/${TARGET}@${VERSION}`)
    expect(failed.err).toContain('The install stops here')
  })
})
