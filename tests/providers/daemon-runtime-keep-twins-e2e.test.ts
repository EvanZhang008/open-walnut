/**
 * The session daemon (daemon-standalone.ts), booted for real, puts back their own runtime files after the temp
 * cleanup removes them under a running daemon (keepRuntimeFiles, daemon-core.ts; 2026-11-02:
 * a Mac whose Walnut had run 26 days had lost daemon.pid, daemon.port and sessions.json).
 * WALNUT_RUNTIME_KEEP_MS runs the hourly clock every 300 ms here.
 *
 * MACHINE SAFETY: HOME and the daemon dir are temp dirs, PATH is system dirs only, a random
 * port, and the daemon is SIGKILLed after each test (no session is started).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { recoverLostDaemon } from '../../src/commands/net.js'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { guardedPath } from '../setup/exec-guard.js'

let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let proc: ChildProcess | null = null

async function boot(env: Record<string, string>): Promise<number> {
  const full: Record<string, string | undefined> = { ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), ...env }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']) if (!(k in env)) delete full[k]
  proc = spawn(BUN!, [STANDALONE, '--start'], { env: full, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir: full.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * What a temp cleaner does to a daemon dir (macOS's periodic clean of /tmp, systemd-tmpfiles):
 * every regular file goes, at any depth; sockets and directories stay. A start path that comes to
 * need one more file in the dir fails here, whatever that file is called.
 */
function sweepRegularFiles(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) fs.rmSync(path.join(entry.parentPath, entry.name), { force: true })
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

afterEach(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, 2000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.skipIf(!BUN)('standalone daemon (bun)', () => {
  it('writes back its pid, port and version files when the temp cleanup removes them', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-keep-')))
    const daemonDir = path.join(root, 'daemon')
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const port = await boot({ HOME: home, WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_RUNTIME_KEEP_MS: '300' })
    const file = (n: string) => path.join(daemonDir, n)
    expect(await waitFor(() => fs.existsSync(file('daemon.pid')) && fs.existsSync(file('daemon.version')))).toBe(true)
    const version = fs.readFileSync(file('daemon.version'), 'utf8')
    for (const n of ['daemon.pid', 'daemon.port', 'daemon.version']) fs.rmSync(file(n))
    expect(await waitFor(() => ['daemon.pid', 'daemon.port', 'daemon.version'].every((n) => fs.existsSync(file(n))))).toBe(true)
    expect(fs.readFileSync(file('daemon.pid'), 'utf8').trim()).toBe(String(proc!.pid))
    expect(fs.readFileSync(file('daemon.port'), 'utf8').trim()).toBe(String(port))
    expect(fs.readFileSync(file('daemon.version'), 'utf8')).toBe(version)
    // Another daemon's pid file is never written over.
    fs.writeFileSync(file('daemon.pid'), '999999')
    fs.rmSync(file('daemon.port'))
    await new Promise((r) => setTimeout(r, 1200))
    expect(fs.readFileSync(file('daemon.pid'), 'utf8')).toBe('999999')
    expect(fs.existsSync(file('daemon.port'))).toBe(false)
  }, 60_000)

  // An older daemon has no keeper: `walnut net join` finds it through its instance lock and
  // writes its files back from there, so the login service install can hand it over.
  it('the join writes back the files of a daemon that lost them, from its instance lock', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-keep-')))
    const daemonDir = path.join(root, 'daemon')
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const port = await boot({ HOME: home, WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_RUNTIME_KEEP_MS: '600000' })
    const file = (n: string) => path.join(daemonDir, n)
    expect(await waitFor(() => fs.existsSync(file('daemon.pid')) && fs.existsSync(file('daemon.instance')))).toBe(true)
    const instance = fs.readFileSync(file('daemon.instance'), 'utf8')
    const was = process.env.WALNUT_JOIN_DAEMON_DIR
    process.env.WALNUT_JOIN_DAEMON_DIR = daemonDir
    try {
      expect(await recoverLostDaemon()).toBeNull()
      for (const n of ['daemon.pid', 'daemon.port', 'daemon.instance']) fs.rmSync(file(n))
      expect(await recoverLostDaemon()).toBe(proc!.pid)
      expect(fs.readFileSync(file('daemon.pid'), 'utf8')).toBe(String(proc!.pid))
      expect(fs.readFileSync(file('daemon.port'), 'utf8')).toBe(String(port))
      expect(fs.readFileSync(file('daemon.instance'), 'utf8')).toBe(instance)
      // A file that survived and says the same is kept.
      fs.rmSync(file('daemon.pid'))
      expect(await recoverLostDaemon()).toBe(proc!.pid)
      // One that says something else is never overwritten, and no pid file joins it.
      fs.rmSync(file('daemon.pid'))
      fs.writeFileSync(file('daemon.port'), '1')
      expect(await recoverLostDaemon()).toBeNull()
      expect(fs.readFileSync(file('daemon.port'), 'utf8')).toBe('1')
      expect(fs.existsSync(file('daemon.pid'))).toBe(false)
    } finally {
      if (was === undefined) delete process.env.WALNUT_JOIN_DAEMON_DIR
      else process.env.WALNUT_JOIN_DAEMON_DIR = was
    }
  }, 60_000)

  // 2026-11-25: a Mac's 15-day-old daemon lost daemon.port, daemon.pid and daemon.instance; every
  // session start since spawned a new daemon that met the old one's instance lock and exited, and
  // the server waited for a port file that never came ("port file not created within 10s").
  it('a second --start meets the live owner, writes its door files back and prints its port', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-keep-')))
    const daemonDir = path.join(root, 'daemon')
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const env = { HOME: home, WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_RUNTIME_KEEP_MS: '600000' }
    const port = await boot(env)
    const file = (n: string) => path.join(daemonDir, n)
    expect(await waitFor(() => fs.existsSync(file('daemon.pid')) && fs.existsSync(file('daemon.instance')))).toBe(true)
    const instance = fs.readFileSync(file('daemon.instance'), 'utf8')
    sweepRegularFiles(daemonDir)
    const full: Record<string, string | undefined> = { ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), ...env }
    delete full.WALNUT_STREAMS_DIR
    const second = spawnSync(BUN!, [STANDALONE, '--start'], { env: full, encoding: 'utf8', timeout: 30_000 })
    expect(second.status).toBe(0)
    expect(second.stdout.trim().split('\n').at(-1)).toBe(String(port))
    expect(fs.readFileSync(file('daemon.pid'), 'utf8')).toBe(String(proc!.pid))
    expect(fs.readFileSync(file('daemon.port'), 'utf8')).toBe(String(port))
    expect(fs.readFileSync(file('daemon.instance'), 'utf8')).toBe(instance)
    expect(proc!.exitCode).toBeNull()
  }, 60_000)

  it('the server start adopts a live daemon that lost its door files, starting none beside it', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-keep-')))
    const daemonDir = path.join(root, 'daemon')
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const port = await boot({ HOME: home, WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_RUNTIME_KEEP_MS: '600000' })
    const file = (n: string) => path.join(daemonDir, n)
    expect(await waitFor(() => fs.existsSync(file('daemon.pid')) && fs.existsSync(file('daemon.instance')))).toBe(true)
    sweepRegularFiles(daemonDir)
    // The daemon program the server would start: it notes each start, so a spawn beside the live one shows.
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const starts = path.join(root, 'starts')
    const wrapper = path.join(bin, 'daemon-wrapper')
    fs.writeFileSync(wrapper, `#!/bin/sh\necho start >> '${starts}'\nexec '${BUN}' '${STANDALONE}' "$@"\n`, { mode: 0o755 })
    const server = new LocalDaemon({ daemonDir, binaryPath: wrapper, envOverrides: { HOME: home, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy') } })
    expect(await server.ensureRunning()).toBe(port)
    expect(fs.existsSync(starts)).toBe(false)
    expect(fs.readFileSync(file('daemon.pid'), 'utf8')).toBe(String(proc!.pid))
    expect(fs.readFileSync(file('daemon.port'), 'utf8')).toBe(String(port))
  }, 60_000)

  // The case as it was: the daemon that lost its files is an older build than the server's.
  // Found through its lock, it goes through the update like any running daemon of another build.
  it('an older build that lost its door files is found and replaced by the server build', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-keep-')))
    const daemonDir = path.join(root, 'daemon')
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const noLegacy = path.join(root, 'no-legacy')
    const port = await boot({ HOME: home, WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: noLegacy, WALNUT_RUNTIME_KEEP_MS: '600000', DAEMON_VERSION: 'walnut-daemon-old' })
    const oldPid = proc!.pid!
    const file = (n: string) => path.join(daemonDir, n)
    expect(await waitFor(() => fs.existsSync(file('daemon.pid')) && fs.existsSync(file('daemon.instance')))).toBe(true)
    sweepRegularFiles(daemonDir)
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const wrapper = path.join(bin, 'daemon-wrapper')
    fs.writeFileSync(wrapper, `#!/bin/sh\nDAEMON_VERSION=walnut-daemon-new exec '${BUN}' '${STANDALONE}' "$@"\n`, { mode: 0o755 })
    fs.writeFileSync(`${wrapper}.version`, 'walnut-daemon-new')
    const server = new LocalDaemon({ daemonDir, binaryPath: wrapper, envOverrides: { HOME: home, WALNUT_LEGACY_STREAMS_DIR: noLegacy } })
    const served = await server.ensureRunning()
    expect(served).toBeGreaterThan(0)
    // Replaced now, or by the update it started beside the old one: either way the old pid ends and the new build serves.
    expect(await waitFor(() => proc!.exitCode !== null || proc!.signalCode !== null, 30_000)).toBe(true)
    const again = await server.ensureRunning()
    const pid = Number(fs.readFileSync(file('daemon.pid'), 'utf8'))
    expect(pid).not.toBe(oldPid)
    expect(fs.readFileSync(file('daemon.version'), 'utf8')).toBe('walnut-daemon-new')
    expect(again).not.toBe(port)
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }, 90_000)
})
