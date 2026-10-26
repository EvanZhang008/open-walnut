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
 * small script printing its version. The npm the fetch asks first is a fake
 * one (npm_execpath) unless a test says otherwise; the one test of a real npm
 * gives it its own config files and cache.
 */
import { spawnSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { realNodeOnPath } from '../../scripts/outside-node.mjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ENTRY, LAUNCHER_LIB } from '../../scripts/npm-packages.mjs'

// The launcher is CommonJS (it runs on old Node): loaded the way Node loads it.
const requireCjs = createRequire(import.meta.url)
const { reinstallCommand, INSTALL_SH } = requireCjs('../../scripts/npm-launcher/launch.js')
const { fetchPlatformPackage, packageFiles, registryFor } = requireCjs('../../scripts/npm-launcher/fetch-platform.js')

const ROOT = path.resolve(__dirname, '../..')
const FETCH_JS = path.join(ROOT, 'scripts/npm-launcher/fetch-platform.js')
const VERSION = '9.9.9'
// The launcher runs on the Node npm installs it with. Under `bun --bun` the first `node` on
// PATH is bun's own shim, so a bare 'node' would test it on bun (scripts/outside-node.mjs).
const node = process.env.WALNUT_TEST_NODE || realNodeOnPath() || 'node'
const onNode = node !== 'node' || typeof (process.versions as { bun?: string }).bun !== 'string'
// The target the Node under test looks for (WALNUT_TEST_NODE may be another arch, under Rosetta say).
const TARGET = spawnSync(node, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(ROOT, 'scripts/npm-launcher/launch.js'))}).candidateTargets()[0])`], { encoding: 'utf8' }).stdout
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
let tmp = ''
let fakeCli = ''
let npmState = ''
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

/**
 * Serve @open-walnut/<TARGET>@<version> with `files` (path inside package/ ->
 * content, or [content, mode]) under `at` (a registry's path). `index` also
 * serves the package's document as npm reads it: true names the version, 'stale'
 * names none yet. Returns the tarball.
 */
function publish(files: Record<string, Buffer | [Buffer, number]>, { version = VERSION, integrityOf = null as Buffer | null, at = '', index = false as boolean | 'stale' } = {}): Buffer {
  const tarball = tgz(Object.entries(files).map(([n, d]) => (Array.isArray(d) ? tarEntry(`package/${n}`, d[0], d[1]) : tarEntry(`package/${n}`, d, n === 'walnut' ? 0o755 : 0o644))))
  const integrity = `sha512-${crypto.createHash('sha512').update(integrityOf ?? tarball).digest('base64')}`
  const name = `@open-walnut/${TARGET}`
  const doc = { name, version, dist: { tarball: `${base}${at}/t/${TARGET}-${version}.tgz`, integrity } }
  routes[`${at}/@open-walnut%2f${TARGET}/${version}`] = { status: 200, type: 'application/json', body: JSON.stringify(doc) }
  routes[`${at}/t/${TARGET}-${version}.tgz`] = { status: 200, body: tarball }
  if (index) {
    const versions = index === 'stale' ? { '0.0.1': { ...doc, version: '0.0.1' } } : { [version]: doc }
    routes[`${at}/@open-walnut%2f${TARGET}`] = { status: 200, type: 'application/json', body: JSON.stringify({ name, 'dist-tags': { latest: index === 'stale' ? '0.0.1' : version }, versions }) }
  }
  return tarball
}

/** What the fake npm does: `pack` copies `tgz` (none: npm's 404), `view` prints `integrity`, `config get <key>` prints `config[key]`. */
function fakeNpm(state: { tgz?: string | null; integrity?: string; config?: Record<string, string> }) {
  fs.writeFileSync(npmState, JSON.stringify({ tgz: null, config: { registry: `${base}/` }, ...state }))
  fs.rmSync(`${npmState}.log`, { force: true })
}
const npmCalls = (): string[][] => (fs.existsSync(`${npmState}.log`) ? fs.readFileSync(`${npmState}.log`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])

// Run by the Node under test, so ES2017 and Node 8 APIs.
const FAKE_NPM = `'use strict'
const fs = require('fs')
const path = require('path')
const statePath = process.env.FAKE_NPM_STATE
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(statePath + '.log', JSON.stringify(args) + '\\n')
if (args[0] === 'pack') {
  if (!state.tgz) { process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET ' + args[1] + '\\n'); process.exit(1) }
  fs.writeFileSync(path.join(process.cwd(), 'open-walnut-x.tgz'), fs.readFileSync(state.tgz))
  process.stdout.write('open-walnut-x.tgz\\n')
  process.exit(0)
}
if (args[0] === 'view') {
  if (!state.integrity) { process.stderr.write('npm error code E404\\n'); process.exit(1) }
  process.stdout.write(state.integrity + '\\n')
  process.exit(0)
}
if (args[0] === 'config' && args[1] === 'get') {
  const v = state.config[args[2]]
  process.stdout.write((v === undefined ? 'undefined' : v) + '\\n')
  process.exit(0)
}
process.exit(1)
`

/** A global prefix holding the launcher package and no platform package. */
function launcherOnly(name: string, { archive = false } = {}): { root: string; bin: string } {
  const prefix = path.join(tmp, name)
  const root = path.join(prefix, 'lib', 'node_modules', 'open-walnut')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  for (const f of LAUNCHER_LIB) fs.copyFileSync(path.join(ROOT, 'scripts/npm-launcher', f), path.join(root, 'lib', f))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'open-walnut', version: VERSION, type: 'commonjs' }))
  fs.writeFileSync(path.join(root, 'bin', 'open-walnut.js'), ENTRY())
  if (archive) fs.writeFileSync(path.join(prefix, 'open-walnut-runtime.json'), '{}')
  return { root, bin: path.join(root, 'bin', 'open-walnut.js') }
}

const env = (): NodeJS.ProcessEnv => ({ ...process.env, npm_config_registry: base, WALNUT_UPDATE_REGISTRY_URL: '', npm_execpath: fakeCli, FAKE_NPM_STATE: npmState })
type Ran = { code: number | null; out: string; err: string; ms: number }
const runAsync = (args: string[], cwd?: string, extra: { file?: string; env?: NodeJS.ProcessEnv } = {}) => new Promise<Ran>((resolve) => {
  const started = Date.now()
  const child = spawn(extra.file ?? node, args, { cwd, env: extra.env ?? env(), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }))
})

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launcher-fetch-')))
  fakeCli = path.join(tmp, 'fake-npm', 'bin', 'npm-cli.js')
  fs.mkdirSync(path.dirname(fakeCli), { recursive: true })
  fs.writeFileSync(fakeCli, FAKE_NPM)
  npmState = path.join(tmp, 'fake-npm', 'state.json')
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    const r = routes[req.url ?? '']
    if (!r) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}') }
    res.writeHead(r.status, { 'content-type': r.type ?? 'application/octet-stream' })
    res.end(r.body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  fakeNpm({})
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(tmp, { recursive: true, force: true })
})

const platformFiles = (printed = `${VERSION} (fetched)`) => ({ 'package.json': Buffer.from(`{"name":"@open-walnut/${TARGET}","version":"${VERSION}"}`), walnut: walnutScript(printed) })
const scopeOf = (root: string) => path.join(root, 'node_modules/@open-walnut')
const modeOf = (p: string) => fs.statSync(p).mode & 0o777

describe('fetch-platform.js', () => {
  it('reads every file under package/ with its mode, and refuses an entry outside it', () => {
    const files = packageFiles(zlib.gunzipSync(tgz([tarEntry('package/walnut', walnutScript('x'), 0o755), tarEntry('package/a/b.txt', Buffer.from('b'), 0o600), tarEntry('package/bin/x', Buffer.from('x'), 0o700), tarEntry('other/c', Buffer.from('c'))])))
    expect([...files.keys()].sort()).toEqual(['a/b.txt', 'bin/x', 'walnut'])
    expect([files.get('walnut').mode, files.get('a/b.txt').mode, files.get('bin/x').mode]).toEqual([0o755, 0o644, 0o755])
    expect(() => packageFiles(zlib.gunzipSync(tgz([tarEntry('package/../evil', Buffer.from('e'))])))).toThrow('outside itself')
  })

  it('without npm, reads the registry npm runs against, else the update check\'s, else npm\'s own', () => {
    expect(registryFor({ npm_config_registry: 'http://mirror.example/npm/' })).toBe('http://mirror.example/npm')
    expect(registryFor({ WALNUT_UPDATE_REGISTRY_URL: 'http://r.example/-/package/open-walnut/dist-tags' })).toBe('http://r.example')
    expect(registryFor({})).toBe('https://registry.npmjs.org')
  })

  it('puts a checked package beside the launcher, where the launcher finds it', async () => {
    publish(platformFiles())
    const { root } = launcherOnly('ok')
    const file = await fetchPlatformPackage({ packageRoot: root, target: TARGET, version: VERSION, registry: base })
    expect(file).toBe(path.join(scopeOf(root), TARGET, 'walnut'))
    expect(spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`${VERSION} (fetched)`)
    expect(fs.readdirSync(scopeOf(root))).toEqual([TARGET])
  })

  it('asks npm first, so the settings npm has (a mirror, a proxy, a login) apply', async () => {
    const tarball = publish(platformFiles('9.9.9 (from npm)'))
    const packed = path.join(tmp, 'packed.tgz')
    fs.writeFileSync(packed, tarball)
    const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`
    fakeNpm({ tgz: packed, integrity })
    const { root } = launcherOnly('via-npm')
    const before = hits.length
    const file = await fetchPlatformPackage({ packageRoot: root, target: TARGET, version: VERSION, npm: [process.execPath, fakeCli], env: env() })
    expect(spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('9.9.9 (from npm)')
    const spec = `@open-walnut/${TARGET}@${VERSION}`
    expect(npmCalls()).toEqual([['pack', spec], ['view', spec, 'dist.integrity']])
    expect(hits.length).toBe(before)
    fakeNpm({})
  })

  it('refuses what npm packed when it does not match the integrity npm reports, and leaves nothing behind', async () => {
    const packed = path.join(tmp, 'packed-tampered.tgz')
    fs.writeFileSync(packed, publish(platformFiles()))
    fakeNpm({ tgz: packed, integrity: `sha512-${crypto.createHash('sha512').update('other bytes').digest('base64')}`, config: { registry: `${base}/nowhere/` } })
    const { root } = launcherOnly('via-npm-tampered')
    const { npm_config_registry: _drop, ...noRegistry } = env()
    await expect(fetchPlatformPackage({ packageRoot: root, target: TARGET, version: VERSION, npm: [process.execPath, fakeCli], env: noRegistry })).rejects.toThrow(/does not match its integrity.*is not on/)
    expect(fs.existsSync(scopeOf(root)) ? fs.readdirSync(scopeOf(root)) : []).toEqual([])
    fakeNpm({})
  })

  it('when npm cannot get it (an index that does not name the version yet), reads the version\'s document from the registry npm uses for the scope', async () => {
    publish(platformFiles('9.9.9 (mirror)'), { at: '/mirror' })
    fakeNpm({ config: { '@open-walnut:registry': `${base}/mirror/`, registry: 'http://127.0.0.1:9/' } })
    const { root } = launcherOnly('via-scope')
    const { npm_config_registry: _drop, ...noRegistry } = env()
    const file = await fetchPlatformPackage({ packageRoot: root, target: TARGET, version: VERSION, npm: [process.execPath, fakeCli], env: noRegistry })
    expect(spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('9.9.9 (mirror)')
    expect(npmCalls().map((c) => c.slice(0, 3))).toEqual([['pack', `@open-walnut/${TARGET}@${VERSION}`], ['config', 'get', '@open-walnut:registry']])
    expect(hits).toContain(`/mirror/@open-walnut%2f${TARGET}/${VERSION}`)
    fakeNpm({})
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
      const scope = scopeOf(root)
      expect(fs.existsSync(scope) ? fs.readdirSync(scope) : [], name).toEqual([])
    }
  })

  it('under a umask of 077 (sudo npm i -g as root), every user can read what it put in place, with the modes the package gives', async () => {
    publish({ ...platformFiles(), 'bin/helper': [Buffer.from('#!/bin/sh\n'), 0o755], 'doc/a.txt': [Buffer.from('a'), 0o600] })
    const { root } = launcherOnly('umask')
    const script = `require(${JSON.stringify(FETCH_JS)}).fetchPlatformPackage({ packageRoot: ${JSON.stringify(root)}, target: ${JSON.stringify(TARGET)}, version: ${JSON.stringify(VERSION)}, registry: ${JSON.stringify(base)} }).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1) })`
    const r = await runAsync(['-c', 'umask 077 && exec "$0" -e "$1"', node, script], undefined, { file: '/bin/sh' })
    expect(r.code, r.err).toBe(0)
    const pkg = path.join(scopeOf(root), TARGET)
    expect([modeOf(path.join(root, 'node_modules')), modeOf(scopeOf(root)), modeOf(pkg), modeOf(path.join(pkg, 'bin')), modeOf(path.join(pkg, 'doc'))]).toEqual([0o755, 0o755, 0o755, 0o755, 0o755])
    expect([modeOf(path.join(pkg, 'walnut')), modeOf(path.join(pkg, 'bin/helper')), modeOf(path.join(pkg, 'doc/a.txt')), modeOf(path.join(pkg, 'package.json'))]).toEqual([0o755, 0o755, 0o644, 0o644])
  })

  it('gives up on a registry that sends nothing within the limit, connecting included (Node 12 started its clock only once connected)', async () => {
    const silent = http.createServer(() => { /* never answers */ })
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    try {
      const probe = (target: string) => runAsync(['-e', `require(${JSON.stringify(FETCH_JS)}).get(${JSON.stringify(target)}, { timeoutMs: 1000 }).then(() => console.log('answered'), (e) => console.log(e.message))`])
      const accepted = await probe(`http://127.0.0.1:${(silent.address() as { port: number }).port}/x`)
      expect(accepted.out).toMatch(/sent nothing for 1s/)
      expect(accepted.ms).toBeLessThan(10_000)
      // A documentation address nothing answers: no reply to the connect either (or an
      // unreachable network at once), never the OS's 75 s connect timeout. Node's request
      // timeout covers the connect; bun's (the shim, when no Node is on PATH) does not.
      if (onNode) {
        const blackHole = await probe('http://192.0.2.1/x')
        expect(blackHole.out).not.toMatch(/answered/)
        expect(blackHole.ms).toBeLessThan(10_000)
      }
    } finally {
      silent.close()
    }
  }, 30_000)
})

describe('the launcher without its file', () => {
  it('fetches it at its first start and runs it; the next start finds it', async () => {
    publish(platformFiles())
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
    expect(npm.err).toContain(`Install it again with: npm install -g open-walnut@${VERSION} --allow-scripts=open-walnut\n`)
    const archive = await runAsync([launcherOnly('nofile-archive', { archive: true }).bin, '--version'])
    expect(archive.code).toBe(1)
    expect(archive.err).toContain('releases/latest/download/install.sh | sh')
  })

  it.skipIf(asRoot)('a file there that this user may not read is named, not fetched again', async () => {
    publish(platformFiles())
    const { root, bin } = launcherOnly('unreadable')
    const pkg = path.join(scopeOf(root), TARGET)
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'walnut'), walnutScript(VERSION), { mode: 0o755 })
    fs.chmodSync(pkg, 0o000)
    try {
      const before = hits.length
      const r = await runAsync([bin, '--version'])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`open-walnut: cannot read ${pkg}: it was installed for another user`)
      expect(r.err).toContain(`sudo chmod -R a+rX ${pkg}`)
      const post = await runAsync([path.join(root, 'lib/postinstall.js')], root)
      expect(post.code).toBe(1)
      expect(post.err).toContain(`cannot read ${pkg}`)
      expect(hits.length).toBe(before)
    } finally {
      fs.chmodSync(pkg, 0o755)
    }
  })

  it.skipIf(asRoot)('in an install this user cannot write (sudo npm i -g), names the sudo command instead of downloading', async () => {
    publish(platformFiles())
    const { root, bin } = launcherOnly('root-owned')
    fs.chmodSync(root, 0o555)
    try {
      const before = hits.length
      const r = await runAsync([bin, '--version'])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`this user cannot write ${root} to fetch it`)
      expect(r.err).toContain(`Install it again with: sudo npm install -g open-walnut@${VERSION} --allow-scripts=open-walnut\n`)
      expect(hits.length).toBe(before)
    } finally {
      fs.chmodSync(root, 0o755)
    }
  })

  it('reinstallCommand: Homebrew for a keg, install.sh for the archive, npm (with sudo where this user cannot write) for npm', () => {
    const io = (o: Record<string, unknown>) => ({ exists: () => false, realpath: (p: string) => p, writable: () => true, sudo: false, ...o })
    const npmRoot = '/x/lib/node_modules/open-walnut'
    expect(reinstallCommand(npmRoot, '1.2.3', io({}))).toBe('npm install -g open-walnut@1.2.3 --allow-scripts=open-walnut')
    expect(reinstallCommand(npmRoot, '1.2.3', io({ writable: () => false }))).toBe('sudo npm install -g open-walnut@1.2.3 --allow-scripts=open-walnut')
    expect(reinstallCommand(npmRoot, '1.2.3', io({ sudo: true }))).toBe('sudo npm install -g open-walnut@1.2.3 --allow-scripts=open-walnut')
    expect(reinstallCommand(npmRoot, '1.2.3', io({ exists: (p: string) => p === '/x/open-walnut-runtime.json' }))).toBe(INSTALL_SH)
    // A keg holds the archive's layout, its marker included.
    const keg = '/opt/homebrew/Cellar/open-walnut/1.2.3/libexec/lib/node_modules/open-walnut'
    expect(reinstallCommand('/opt/homebrew/opt/open-walnut/libexec/lib/node_modules/open-walnut', '1.2.3', io({ realpath: () => keg, exists: () => true }))).toBe('brew reinstall open-walnut')
  })
})

describe('postinstall.js', () => {
  it('passes at once when npm installed the file', async () => {
    const { root } = launcherOnly('post-ok')
    const dir = path.join(scopeOf(root), TARGET)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), `{"name":"@open-walnut/${TARGET}"}`)
    fs.writeFileSync(path.join(dir, 'walnut'), walnutScript(VERSION), { mode: 0o755 })
    const before = hits.length
    fakeNpm({})
    const r = await runAsync([path.join(root, 'lib/postinstall.js')], root)
    expect(r.code, r.err).toBe(0)
    expect(hits.length).toBe(before)
    expect(npmCalls()).toEqual([])
  })

  it('fetches a file npm left out, or fails the install so npm keeps the version before', async () => {
    publish({ walnut: walnutScript(VERSION) })
    const fixed = launcherOnly('post-fetch')
    const ok = await runAsync([path.join(fixed.root, 'lib/postinstall.js')], fixed.root)
    expect(ok.code, ok.err).toBe(0)
    expect(fs.existsSync(path.join(scopeOf(fixed.root), TARGET, 'walnut'))).toBe(true)
    routes = {}
    const lag = launcherOnly('post-lag')
    const failed = await runAsync([path.join(lag.root, 'lib/postinstall.js')], lag.root)
    expect(failed.code).toBe(1)
    expect(failed.err).toContain(`npm did not install @open-walnut/${TARGET}@${VERSION}`)
    expect(failed.err).toContain('The install stops here')
  })
})

// A real npm, as npm runs the postinstall: npm 7 and later hand an install script
// only the settings on its command line or in its environment, so a registry set
// in ~/.npmrc reaches the fetch only through npm itself.
const realNpm = spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0
describe.skipIf(!realNpm)('postinstall.js with a real npm', () => {
  const npmEnv = (dir: string): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(e)) if (/^npm_/i.test(k)) delete e[k]
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'npmrc'), `@open-walnut:registry=${base}/real/\n`)
    fs.writeFileSync(path.join(dir, 'globalrc'), '')
    return {
      ...e,
      WALNUT_UPDATE_REGISTRY_URL: '',
      npm_config_userconfig: path.join(dir, 'npmrc'),
      npm_config_globalconfig: path.join(dir, 'globalrc'),
      npm_config_cache: path.join(dir, 'cache'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    }
  }

  it('takes the scoped registry from npm\'s config, and an index without the version falls back to the version\'s document there', async () => {
    publish(platformFiles('9.9.9 (real npm)'), { at: '/real', index: true })
    const fresh = launcherOnly('real-npm')
    const before = hits.length
    const ok = await runAsync([path.join(fresh.root, 'lib/postinstall.js')], fresh.root, { env: npmEnv(path.join(tmp, 'real-npm-config')) })
    expect(ok.code, ok.err).toBe(0)
    expect(spawnSync(path.join(scopeOf(fresh.root), TARGET, 'walnut'), { encoding: 'utf8' }).stdout.trim()).toBe('9.9.9 (real npm)')
    expect(hits.slice(before)).toContain(`/real/t/${TARGET}-${VERSION}.tgz`)
    expect(hits.slice(before)).not.toContain(`/real/@open-walnut%2f${TARGET}/${VERSION}`)

    publish(platformFiles('9.9.9 (stale index)'), { at: '/real', index: 'stale' })
    const stale = launcherOnly('real-npm-stale')
    const mark = hits.length
    const healed = await runAsync([path.join(stale.root, 'lib/postinstall.js')], stale.root, { env: npmEnv(path.join(tmp, 'real-npm-config-stale')) })
    expect(healed.code, healed.err).toBe(0)
    expect(spawnSync(path.join(scopeOf(stale.root), TARGET, 'walnut'), { encoding: 'utf8' }).stdout.trim()).toBe('9.9.9 (stale index)')
    expect(hits.slice(mark)).toContain(`/real/@open-walnut%2f${TARGET}/${VERSION}`)
  }, 180_000)
})
