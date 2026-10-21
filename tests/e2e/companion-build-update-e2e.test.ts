/**
 * The Mac keeps its companion on the Mac's build (docs/plan/walnut-companion-unified-replica.md,
 * stage 1), end to end with real processes: the companion is this tree's BUILD
 * (`dist/cli.js web`, WALNUT_CLOUD_MODE=1) started by the real launcher
 * (scripts/cloud/companion-launch.mjs), restarted by a loop that does what
 * systemd's Restart=always does. The Mac's driver (core/companion-build/mac.ts)
 * runs in this process against it over HTTP with the machine credential; only
 * its endpoint lookup, its own build id and which dist it packs are stubbed.
 *
 *   base A   the box starts on this tree's build, nothing installed
 *   B        a build with another commit: uploaded, installed, smoke booted,
 *            started as the trial, confirmed, current; a restart keeps it
 *   C        a build that answers --version but never serves: the smoke boot
 *            fails, the box gives it up and keeps running B, the Mac does not retry it
 *
 * The dependency set is installed once, by hand, as a link to this tree's
 * node_modules: the install script then skips npm (its .ready is there).
 *
 * Needs the build: `npm run build`, then `cd web && npx vite build`. Without it
 * the file fails at once and says so (never a skipped test).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = path.join(REPO, 'dist')

const h = vi.hoisted(() => ({
  endpoint: null as { url: string; token: string } | null,
  mine: '' as string,
  dist: null as { distDir: string; root: string } | null,
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-companion-build-e2e'))
vi.mock('../../src/core/cloud-ingest.js', () => ({
  cloudSessionEndpoint: async () => h.endpoint,
  recoverCloudSessionCredential: async () => {},
}))
vi.mock('../../src/core/host-server/package.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/host-server/package.js')>()
  return {
    ...real,
    runningBuildId: async () => h.mine,
    buildCompanionAppPackage: (target: { platform: string; arch: string }, dist?: { distDir: string; root: string }) => real.buildCompanionAppPackage(target, dist ?? h.dist),
  }
})
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({ cloud_bridge: { auto_update: true } }),
}))

import { buildIdOf, type BoxBuildStatus } from '../../src/core/companion-build/wire.js'
import { buildCompanionAppPackage } from '../../src/core/host-server/package.js'
import { _resetCompanionBuildForTesting, companionBuildView, tickCompanionBuild } from '../../src/core/companion-build/mac.js'

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => resolve(a && typeof a === 'object' ? a.port : 0))
    })
  })
}

/** A dist made of links to this tree's dist, with its own build-info (another build id). */
async function linkedDist(root: string, info: Record<string, unknown>, cliJs?: string): Promise<{ distDir: string; root: string }> {
  const distDir = path.join(root, 'dist')
  await fsp.mkdir(distDir, { recursive: true })
  for (const name of await fsp.readdir(DIST)) {
    if (name === 'build-info.json' || (cliJs && name === 'cli.js')) continue
    await fsp.symlink(path.join(DIST, name), path.join(distDir, name))
  }
  await fsp.writeFile(path.join(distDir, 'build-info.json'), JSON.stringify(info, null, 2))
  if (cliJs) await fsp.writeFile(path.join(distDir, 'cli.js'), cliJs)
  await fsp.symlink(path.join(REPO, 'package.json'), path.join(root, 'package.json'))
  return { distDir, root }
}

describe('the Mac keeps its companion on its build (real launcher, real build)', () => {
  let base = ''
  let R = ''
  let port = 0
  const machineToken = crypto.randomBytes(16).toString('hex')
  let launcher: ChildProcess | null = null
  let stopping = false
  let starts = 0
  let log = ''
  let idA = ''
  let idB = ''
  let idC = ''
  let distB: { distDir: string; root: string }
  let distC: { distDir: string; root: string }

  const box = { home: '', data: '' }

  function env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      WALNUT_CLOUD_MODE: '1',
      OPEN_WALNUT_HOME: box.data,
      HOME: box.home,
      USERPROFILE: box.home,
      WALNUT_HOME_OVERRIDE: box.home,
      SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: path.join(base, 'daemon'),
      WALNUT_TUNNEL_DAEMON_DIR: path.join(base, 'tunnel'),
      WALNUT_STREAMS_DIR: '',
      WALNUT_GIT_HUB_DIR: path.join(base, 'hub'),
      WALNUT_LOCAL_CLAUDE_PROBE: '0',
      WALNUT_DISABLE_BACKGROUND_AI: '1',
      WALNUT_DISABLE_SEARCH: '1',
      WALNUT_STT_AUTO_SETUP: '0',
      WALNUT_COMPANION_ROOT: R,
      WALNUT_COMPANION_BASE: path.join(base, 'base'),
      WALNUT_COMPANION_MAC_BUILDS: '1',
      WALNUT_COMPANION_CONFIRM_MS: '3000',
      WALNUT_COMPANION_SMOKE_MS: '120000',
      WALNUT_COMPANION_TRIAL_DEADLINE_MS: '240000',
      VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', NODE_ENV: 'production',
    }
  }

  /** systemd's Restart=always: start the launcher again whenever it ends. */
  function startLauncher(): void {
    starts++
    const p = spawn(process.execPath, [path.join(REPO, 'scripts/cloud/companion-launch.mjs'), 'web', '--port', String(port)], {
      cwd: path.join(base, 'base'), env: env(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    const keep = (b: Buffer) => { log = (log + b.toString()).slice(-400_000) }
    p.stdout!.on('data', keep)
    p.stderr!.on('data', keep)
    p.once('exit', () => {
      if (launcher === p) launcher = null
      if (!stopping) setTimeout(() => { if (!stopping) startLauncher() }, 500)
    })
    launcher = p
  }

  /** The box server's own log (LOG_DIR is its WALNUT_DAEMON_DIR). */
  function serverLog(): string {
    const dir = path.join(base, 'daemon')
    try {
      return fs.readdirSync(dir).filter((n) => /^open-walnut-.*\.log$/.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('')
    } catch { return '' }
  }
  const uploadsStarted = () => (serverLog().match(/package upload started/g) ?? []).length

  async function status(): Promise<BoxBuildStatus | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/bridge/build`, { headers: { Authorization: `Bearer ${machineToken}` }, signal: AbortSignal.timeout(5_000) })
      return r.status === 200 ? await r.json() as BoxBuildStatus : null
    } catch { return null }
  }

  async function waitFor(what: string, ok: (s: BoxBuildStatus) => boolean, ms: number): Promise<BoxBuildStatus> {
    const deadline = Date.now() + ms
    let last: BoxBuildStatus | null = null
    while (Date.now() < deadline) {
      last = await status()
      if (last && ok(last)) return last
      await sleep(500)
    }
    throw new Error(`${what}: not within ${ms} ms. Last status: ${JSON.stringify(last)}\n--- box log ---\n${log.slice(-6000)}`)
  }

  beforeAll(async () => {
    for (const f of [path.join(DIST, 'cli.js'), path.join(DIST, 'build-info.json'), path.join(DIST, 'daemon-binaries', `daemon-${process.platform}-${process.arch}`)]) {
      if (!fs.existsSync(f)) throw new Error(`this test runs a real build and ${f} is missing: npm run build, then cd web && npx vite build`)
    }
    // Short: socket paths under it must fit in 104 bytes on macOS. Never `open-walnut-*`.
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cbu-'))
    R = path.join(base, 'host')
    box.home = path.join(base, 'home')
    box.data = path.join(base, 'data')
    for (const d of [box.home, box.data, path.join(base, 'hub'), path.join(base, 'base')]) await fsp.mkdir(d, { recursive: true })
    await fsp.symlink(DIST, path.join(base, 'base', 'dist'))
    await fsp.writeFile(path.join(box.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
    const now = new Date().toISOString()
    await fsp.writeFile(path.join(box.data, 'auth.json'), JSON.stringify({ devices: [
      { name: 'bridge-local', id: `d${crypto.randomBytes(8).toString('hex')}`, tokenHash: sha(machineToken), createdAt: now, kind: 'machine' },
    ] }), { mode: 0o600 })

    const infoA = JSON.parse(await fsp.readFile(path.join(DIST, 'build-info.json'), 'utf8'))
    idA = buildIdOf(infoA)
    const infoB = { version: infoA.version, commit: 'e2eb00001', branch: 'main', builtAt: new Date().toISOString(), dirty: false }
    const infoC = { ...infoB, commit: 'e2ec00001' }
    idB = buildIdOf(infoB)
    idC = buildIdOf(infoC)
    distB = await linkedDist(path.join(base, 'pkg-b'), infoB)
    // C answers --version (the install's check) and never serves (the smoke boot's).
    distC = await linkedDist(path.join(base, 'pkg-c'), infoC,
      "if (process.argv.includes('--version')) { console.log('0.0.0'); process.exit(0) }\nconsole.error('build C does not serve'); process.exit(7)\n")

    // The dependency set, installed by hand: a link to this tree's node_modules.
    const pkg = await buildCompanionAppPackage({ platform: process.platform, arch: process.arch }, distB)
    const deps = path.join(R, 'deps', pkg.companionDepsHash)
    await fsp.mkdir(deps, { recursive: true })
    await fsp.symlink(path.join(REPO, 'node_modules'), path.join(deps, 'node_modules'))
    await fsp.writeFile(path.join(deps, '.ready'), '')

    port = await freePort()
    h.endpoint = { url: `http://127.0.0.1:${port}/bridge`, token: machineToken }
    process.env.WALNUT_COMPANION_BUILD_POLL_MS = '500'
    startLauncher()
    await waitFor('the base build serves the build door', (s) => s.running.id === idA, 120_000)
  }, 300_000)

  afterAll(async () => {
    stopping = true
    delete process.env.WALNUT_COMPANION_BUILD_POLL_MS
    await _resetCompanionBuildForTesting().catch(() => {})
    const p = launcher
    if (p?.pid && p.pid > 1 && p.exitCode === null) {
      p.kill('SIGTERM')
      await Promise.race([new Promise((r) => p.once('exit', r)), sleep(20_000)])
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
    }
    if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  }, 60_000)

  it('starts on the base: the box takes builds and runs none of the Mac\'s yet', async () => {
    const s = (await status())!
    expect(s.accepts).toBe(true)
    expect(s.running).toMatchObject({ id: idA, base: true, trial: false })
    expect(s.current).toBeNull()
    expect(s.trial).toBeNull()
  })

  it('a Mac on build B brings the box to B: upload, install, smoke, trial, confirm', async () => {
    h.mine = idB
    h.dist = distB
    const startsBefore = starts
    await tickCompanionBuild('retry')
    expect(companionBuildView(), log.slice(-4000)).toMatchObject({ state: 'current', mine: idB, theirs: idB })
    const s = (await status())!
    expect(s.running).toMatchObject({ id: idB, base: false })
    expect(s.current).toBe(idB)
    expect(s.trial).toBeNull()
    // One restart into the trial; the box confirmed it itself.
    expect(starts - startsBefore).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(path.join(R, 'app', idB, '.ready'))).toBe(true)
    expect(log).toContain('[companion-launch]')
  }, 900_000)

  it('a restart of the box keeps B (current, not a trial)', async () => {
    const p = launcher!
    p.kill('SIGTERM')
    await waitFor('the box is back on B after a restart', (s) => s.running.id === idB && !s.running.trial && s.current === idB, 120_000)
    // The Mac sees nothing to do.
    await tickCompanionBuild('retry')
    expect(companionBuildView()).toMatchObject({ state: 'current', mine: idB })
  }, 180_000)

  it('a build that never serves is given up after its smoke boot; the box keeps B and the Mac does not try again', async () => {
    // A Mac changes its build only by restarting: the driver keeps its id per process.
    await _resetCompanionBuildForTesting()
    h.mine = idC
    h.dist = distC
    await tickCompanionBuild('retry')
    const view = companionBuildView()
    expect(view.state, JSON.stringify(view)).toBe('failed')
    expect(view.message ?? '').toMatch(/smoke|serve|exited/i)
    const s = (await status())!
    expect(s.running.id).toBe(idB)
    expect(s.current).toBe(idB)
    expect(s.failed.map((f) => f.id)).toContain(idC)
    // An automatic tick (a probe) does not upload it again.
    const uploadsBefore = uploadsStarted()
    expect(uploadsBefore).toBeGreaterThanOrEqual(2)
    process.env.WALNUT_COMPANION_AUTO_TICKS = '1'
    process.env.WALNUT_COMPANION_BUILD_BOOT_DELAY_MS = '0'
    try {
      await tickCompanionBuild('probe')
    } finally {
      delete process.env.WALNUT_COMPANION_AUTO_TICKS
      delete process.env.WALNUT_COMPANION_BUILD_BOOT_DELAY_MS
    }
    expect(companionBuildView().state).toBe('failed')
    expect(uploadsStarted()).toBe(uploadsBefore)
  }, 600_000)
})
