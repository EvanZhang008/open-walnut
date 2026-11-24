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
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { recoverLostDaemon } from '../../src/commands/net.js'
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
})
