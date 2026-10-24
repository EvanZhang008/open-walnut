/**
 * The two daemon twins at `--start`, booted for real, against a pid file a dead
 * daemon left. A daemon predating the kernel instance lock holds no lock, so a
 * starting daemon still yields to the pid in daemon.pid; but after a restart (a
 * container's above all) that pid may name another live process. The daemon
 * then printed the dead daemon's port and exited, and the dir had no daemon
 * until the pid went away. A live pid is a legacy daemon now only when its port
 * takes a connection.
 *
 * MACHINE SAFETY: every daemon dir, HOME and streams dir is a temp dir; the
 * "other process" and the "legacy daemon" are this test's own children, ended in
 * afterEach; each daemon this test boots is SIGKILLed (no session is started).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
const children: ChildProcess[] = []

/** Boots the twin in `daemonDir`; resolves with the port it printed and how it ended (null: still running). */
async function boot(twin: Twin, daemonDir: string): Promise<{ port: number; exit: Promise<number | null>; proc: ChildProcess }> {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home,
    WALNUT_DAEMON_DIR: daemonDir, WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
  }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']) delete env[k]
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(proc)
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon printed no port in 30s')), 30_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
  return { port, exit, proc }
}

function hello(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no hello answer')) }, 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'hello' })))
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.id === 1) { clearTimeout(timer); ws.close(); resolve(msg) }
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** A port nothing listens on (bound, then closed). */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)) })
  })
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stale-pid-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode !== null || c.signalCode !== null) continue
    c.kill('SIGKILL')
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, 2000); c.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('daemon twin at --start: $name', (twin) => {
  it('a pid file naming a live process that is no daemon (nothing on its port): it starts, and leaves that process alone', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stale-pid-')))
    const daemonDir = path.join(root, 'daemon')
    fs.mkdirSync(daemonDir, { recursive: true })
    const other = spawn('sleep', ['60'], { stdio: 'ignore' })
    children.push(other)
    const stale = await closedPort()
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(other.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(stale))

    const { port, proc } = await boot(twin, daemonDir)
    expect(port).not.toBe(stale)
    expect((await hello(port)).ok).toBe(true)
    expect(proc.exitCode).toBeNull()
    expect(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim()).toBe(String(proc.pid))
    expect(other.exitCode).toBeNull()
    expect(() => process.kill(other.pid!, 0)).not.toThrow()
  }, 60_000)

  it('a pid file naming a live process whose port takes connections (a daemon older than the lock): it yields, prints that port and exits', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stale-pid-')))
    const daemonDir = path.join(root, 'daemon')
    fs.mkdirSync(daemonDir, { recursive: true })
    // The legacy daemon: a process that listens on loopback.
    const legacy = spawn(process.execPath, ['-e', "const s=require('net').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(legacy)
    const legacyPort = await new Promise<number>((resolve) => legacy.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(legacy.pid))
    fs.writeFileSync(path.join(daemonDir, 'daemon.port'), String(legacyPort))

    const { port, exit } = await boot(twin, daemonDir)
    expect(port).toBe(legacyPort)
    expect(await exit).toBe(0)
    expect(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim()).toBe(String(legacy.pid))
  }, 60_000)
})
