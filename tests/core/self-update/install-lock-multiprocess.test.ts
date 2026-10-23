/**
 * The update lock of a binary install across real processes
 * (src/core/self-update/install-lock.ts, scripts/install.sh): updaters started
 * together, a stale lock that several of them judge dead at the same moment,
 * and install.sh and Walnut's own updater on one root. binary-install.test.ts
 * covers the rules in one process.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serveReleases } from '../../../scripts/release-rehearsal/runtime.mjs'
import { guardedPath } from '../../setup/exec-guard.js'
import { swapLink } from '../../../src/core/self-update/binary-install.js'
import { BINARY_MARKER } from '../../../src/core/self-update/install-kind.js'

const ROOT = path.resolve(__dirname, '../../..')
const WORKER = path.join(ROOT, 'tests/fixtures/self-update/lock-worker.ts')
const SCRIPT = path.join(ROOT, 'scripts/install.sh')
const TARGET = 'darwin-arm64'
const HOST = `${process.platform}-${process.arch}`
let scratch = ''
let registry: http.Server
let registryUrl = ''
let releases: { url: string; close: () => Promise<void> }
const packages = new Map<string, { bytes: Buffer; integrity: string }>()
const children: ChildProcess[] = []

const standInScript = (version: string) => `#!/bin/sh\n[ "$1" = --version ] && echo '${version} (abc12345, standin)'\n`

/** The platform package npm would serve for `version`. */
function publishPackage(version: string): void {
  const dir = fs.mkdtempSync(path.join(scratch, 'pkg-'))
  fs.mkdirSync(path.join(dir, 'package'))
  fs.writeFileSync(path.join(dir, 'package', 'walnut'), standInScript(version), { mode: 0o755 })
  const out = path.join(dir, 'p.tgz')
  execFileSync('tar', ['-czf', out, '-C', dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = fs.readFileSync(out)
  packages.set(version, { bytes, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` })
}

/** The release install.sh would download for `version`. */
function publishRelease(version: string): void {
  const dir = path.join(scratch, 'releases', `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = Buffer.from(standInScript(version))
  const name = `walnut-${version}-${HOST}`
  const gz = zlib.gzipSync(file)
  fs.writeFileSync(path.join(dir, `${name}.gz`), gz)
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha(gz)}  ${name}.gz\n${sha(file)}  ${name}\n`)
}

/** A root laid out as install.sh leaves it, with 0.7.0 in use. */
function layout(): string {
  const root = fs.mkdtempSync(path.join(scratch, 'root-'))
  fs.mkdirSync(path.join(root, 'versions', '0.7.0'), { recursive: true })
  fs.writeFileSync(path.join(root, 'versions', '0.7.0', 'walnut'), standInScript('0.7.0'), { mode: 0o755 })
  fs.writeFileSync(path.join(root, BINARY_MARKER), JSON.stringify({ layout: 'versions', target: TARGET }))
  swapLink(root, '0.7.0')
  return root
}

const deadPid = () => Number(spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim())

/** A lock left by an updater that died while it held it. */
function staleLock(root: string): void {
  fs.mkdirSync(path.join(root, '.update.lock'))
  fs.writeFileSync(path.join(root, '.update.lock', 'owner'), `${deadPid()} 1a2b3c4d5e6f\n`)
}

interface Started { ready: Promise<void>; done: Promise<{ code: number; out: string }> }

function start(file: string, args: string[], env: NodeJS.ProcessEnv = process.env, readyWhen = 'ready\n'): Started {
  const child = spawn(file, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  let onReady!: () => void
  const ready = new Promise<void>((resolve) => { onReady = resolve })
  if (!readyWhen) onReady()
  child.stdout!.on('data', (d: Buffer) => { out += d; if (readyWhen && out.includes(readyWhen)) onReady() })
  child.stderr!.on('data', (d: Buffer) => { out += d })
  const done = new Promise<{ code: number; out: string }>((resolve) => child.on('close', (code) => resolve({ code: code ?? 1, out })))
  return { ready, done }
}

/** An updater process: bun, which runs TypeScript itself (no loader, no watcher, no IPC socket). */
const worker = (args: string[]) => start(process.execPath, [WORKER, ...args])

const installSh = (root: string, home: string) => start('/bin/sh', [SCRIPT], {
  PATH: guardedPath([], '/usr/bin:/bin:/usr/sbin:/sbin'), HOME: home,
  OPEN_WALNUT_INSTALL_DIR: root, OPEN_WALNUT_BIN_DIR: path.join(home, 'bin'),
  OPEN_WALNUT_RELEASE_BASE_URL: releases.url, OPEN_WALNUT_VERSION: '0.8.0',
}, '')

const lastJson = (out: string) => JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)!)
const leftovers = (root: string) => fs.readdirSync(root).filter((n) => n.startsWith('.update.lock') || n.startsWith('.staging-') || n === 'inside')
  .concat(fs.readdirSync(path.join(root, 'versions')).filter((n) => n.startsWith('.')))
const linked = (root: string) => execFileSync(path.join(root, 'bin', 'walnut'), ['--version'], { encoding: 'utf8' }).trim()

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-lock-mp-')))
  registry = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    const meta = /^\/@open-walnut\/([^/]+)\/([^/]+)$/.exec(url)
    if (meta && packages.has(meta[2]!)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ dist: { tarball: `${registryUrl}/tgz/${meta[2]}`, integrity: packages.get(meta[2]!)!.integrity } }))
    }
    const tgz = /^\/tgz\/(.+)$/.exec(url)
    if (tgz && packages.has(tgz[1]!)) return res.writeHead(200).end(packages.get(tgz[1]!)!.bytes)
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', () => resolve()))
  registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`
  fs.mkdirSync(path.join(scratch, 'releases'))
  releases = await serveReleases(path.join(scratch, 'releases'))
  for (const v of ['0.8.0', '0.9.0']) publishPackage(v)
  publishRelease('0.8.0')
})
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})
afterAll(async () => {
  await new Promise((resolve) => registry.close(resolve))
  await releases.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the update lock across processes', () => {
  it('a stale lock judged dead by four processes at once: one holder at a time, and every one gets its turn', async () => {
    const root = layout()
    staleLock(root)
    const go = path.join(root, 'go')
    const lockers = Array.from({ length: 4 }, () => worker(['lock', root, go, '120', '40', '2']))
    await Promise.all(lockers.map((l) => l.ready))
    fs.writeFileSync(go, '')
    const results = await Promise.all(lockers.map((l) => l.done))
    for (const r of results) expect(r.code, r.out).toBe(0)
    const parsed = results.map((r) => lastJson(r.out))
    expect(parsed.map((p) => p.overlaps)).toEqual([0, 0, 0, 0])
    expect(parsed.map((p) => p.got)).toEqual([2, 2, 2, 2])
    expect(leftovers(root)).toEqual([])
  })

  it('two updates of one root started together: the link is whole and nothing is left behind', async () => {
    const root = layout()
    const go = path.join(root, 'go')
    const both = [worker(['install', root, TARGET, '0.8.0', registryUrl, go]), worker(['install', root, TARGET, '0.9.0', registryUrl, go])]
    await Promise.all(both.map((w) => w.ready))
    fs.writeFileSync(go, '')
    const results = (await Promise.all(both.map((w) => w.done))).map((r) => lastJson(r.out))
    const ok = results.filter((r) => r.ok)
    expect(ok.length).toBeGreaterThanOrEqual(1)
    for (const r of results.filter((x) => !x.ok)) expect(r.error).toMatch(/another update .* is running/)
    expect(ok.map((r) => r.to)).toContain(linked(root).split(' ')[0])
    fs.rmSync(go)
    expect(leftovers(root)).toEqual([])
  })

  it('install.sh and Walnut\'s updater on one root, over a stale lock: each waits for or refuses the other, never both inside', async () => {
    for (let round = 0; round < 3; round++) {
      const root = layout()
      staleLock(root)
      const home = fs.mkdtempSync(path.join(scratch, 'home-'))
      const go = path.join(root, 'go')
      const updaters = [worker(['install', root, TARGET, '0.9.0', registryUrl, go]), worker(['install', root, TARGET, '0.9.0', registryUrl, go])]
      await Promise.all(updaters.map((w) => w.ready))
      const shells = [installSh(root, home), installSh(root, home)]
      fs.writeFileSync(go, '')
      const shellRuns = await Promise.all(shells.map((s) => s.done))
      // install.sh waits its turn (up to a minute), so each of its runs installs.
      for (const r of shellRuns) expect(r.code, r.out).toBe(0)
      for (const r of (await Promise.all(updaters.map((w) => w.done))).map((x) => lastJson(x.out))) {
        if (!r.ok) expect(r.error).toMatch(/another update .* is running/)
      }
      fs.rmSync(go)
      expect(leftovers(root)).toEqual([])
      expect(linked(root)).toMatch(/^0\.(8|9)\.0 /)
      // Every version directory holds its file: no half-made one.
      for (const v of fs.readdirSync(path.join(root, 'versions'))) expect(fs.existsSync(path.join(root, 'versions', v, 'walnut')), v).toBe(true)
    }
  })

  it('install.sh\'s owner line is read by the updater as install.sh means it: alive, gone, or a pid handed on', async () => {
    const root = layout()
    // A live shell standing in for an install.sh that holds the lock, with the line it writes.
    const holder = spawn('/bin/sh', ['-c', 'printf "%s install.sh %s\\n" "$$" "$(ps -o lstart= -p $$ | awk \'{ $1 = $1; print }\')" > "$0/.update.lock/owner"; sleep 30', root], { stdio: 'ignore' })
    children.push(holder)
    fs.mkdirSync(path.join(root, '.update.lock'))
    const owner = path.join(root, '.update.lock', 'owner')
    for (let i = 0; i < 200 && !(fs.existsSync(owner) && fs.readFileSync(owner, 'utf8').trim().split(' ').length > 2); i++) await new Promise((r) => setTimeout(r, 10))
    const go = path.join(root, 'go')
    fs.writeFileSync(go, '')
    const refused = lastJson((await worker(['install', root, TARGET, '0.8.0', registryUrl, go]).done).out)
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/another update .* is running/) })
    // The same pid with another start time: its pid was handed on.
    fs.writeFileSync(owner, `${holder.pid} install.sh Mon Jan  1 00:00:00 2001\n`)
    const taken = lastJson((await worker(['install', root, TARGET, '0.8.0', registryUrl, go]).done).out)
    expect(taken).toMatchObject({ ok: true, to: '0.8.0' })
    holder.kill()
  })
})
