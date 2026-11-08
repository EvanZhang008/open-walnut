/**
 * `stop` on both real daemon twins when the CLI exits on the SIGINT at once but a child it
 * started is still in its process group. The CLI (the group leader) is reaped by the daemon's
 * exit handler, so its pid no longer reads as the recorded process; the group is still alive.
 * Pinned: the stop keeps waiting for the group and answers { stopped: true } once it is empty,
 * never "process identity changed" (2026-11-12: a Demo reset's owner stop of a remote session
 * got that error 200 ms after the CLI ended, so the reset refused).
 *
 * MACHINE SAFETY: HOME, the daemon and streams dirs are temp paths; PATH is the exec guard's.
 * Signals: the daemon's own stop path (SIGINT, SIGTERM to the group of the CLI it spawned
 * detached, so only that CLI and its child are in it), the daemon's reap of that group, and
 * SIGTERM to the daemons this file started (their own stop path). Cleanup sends SIGKILL only to
 * a pid this file recorded (above 1, and still running this file's own fixture script), and only
 * if it outlived its wait. The child ends by itself 1.5 s after its parent, or after 30 s.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { bunRuntime } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const BUN = bunRuntime()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

// Stand-in CLI: starts the lingering child (default spawn: same process group, no pipes held),
// prints init, and exits at once on SIGINT or SIGTERM. argv: <ready file> --session-id <sid>.
const CLI = `
const { spawn } = require('child_process')
const path = require('path')
const ready = process.argv[2]
spawn(process.execPath, [path.join(__dirname, 'lingering-child.cjs'), String(process.pid), ready], { stdio: 'ignore' }).unref()
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
setTimeout(() => process.exit(0), 60000).unref()
setInterval(() => {}, 1000)
`
// The child ignores SIGINT (the stop's) and SIGTERM: the daemon's reap SIGTERMs the group the
// moment the leader exits, and a child that died on it would empty the group before the stop's
// first check, so the test would pass with the bug in place. It writes its pid once its handlers
// are on, notes when its parent is gone, and exits 1.5 s later (the reap's SIGKILL at 2 s may end
// it first; either empties the group).
const CHILD = `
const fs = require('fs')
const [parent, ready] = [Number(process.argv[2]), process.argv[3]]
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
fs.writeFileSync(ready + '.tmp', String(process.pid))
fs.renameSync(ready + '.tmp', ready)
const parentGone = () => { if (process.ppid !== parent) return true; try { process.kill(parent, 0); return false } catch { return true } }
let goneAt = 0
setInterval(() => {
  if (!goneAt && parentGone()) { goneAt = Date.now(); fs.writeFileSync(ready + '.parent-gone', '') }
  if (goneAt && Date.now() - goneAt >= 1500) process.exit(0)
}, 50)
setTimeout(() => process.exit(0), 30000)
`

let lib = ''
let scriptDir = ''
beforeAll(() => {
  lib = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-lib-')))
  fs.writeFileSync(path.join(lib, 'native-cli.cjs'), CLI)
  fs.writeFileSync(path.join(lib, 'lingering-child.cjs'), CHILD)
  scriptDir = path.join(lib, 'source')
  fs.mkdirSync(scriptDir)
  fs.writeFileSync(path.join(scriptDir, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
})
// A fixture or daemon that outlived cleanup may still run a script from lib: then lib stays.
let keepLib = false
afterAll(() => { if (!keepLib && lib.includes('wsl-lib-')) fs.rmSync(lib, { recursive: true, force: true }) })

type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [path.join(scriptDir, 'daemon.cjs'), '--start']] },
  // No bun is a failure here, never a skip.
  { name: 'standalone twin (bun)', command: () => [BUN, [STANDALONE, '--start']] },
]

interface Daemon { proc: ChildProcess; ws: WebSocket; base: string }
// Registered right after the spawn, so a boot that fails at the port is still stopped.
const daemons: Array<Omit<Daemon, 'ws'> & { ws: WebSocket | null }> = []
// Pids of fixture processes (the CLI and its child) this file recorded.
const fixturePids: number[] = []
let rpcId = 1

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** True when `pid` still runs one of this file's fixture scripts (read-only `ps`). */
function runsOurFixture(pid: number): boolean {
  const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
  return args.includes(path.join(lib, 'lingering-child.cjs')) || args.includes(path.join(lib, 'native-cli.cjs'))
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

afterEach(async () => {
  for (const pid of fixturePids.splice(0)) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue
    if (await waitFor(() => !isAlive(pid), 5_000)) continue
    if (runsOurFixture(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    if (!(await waitFor(() => !isAlive(pid), 5_000))) keepLib = true
  }
  for (const d of daemons.splice(0)) {
    try { d.ws?.close() } catch { /* closed */ }
    if (d.proc.exitCode === null && d.proc.signalCode === null) {
      // The daemon's own stop: an isolated dir reaps its sessions on the way out.
      const exited = new Promise<void>((r) => { const t = setTimeout(r, 30_000); d.proc.once('exit', () => { clearTimeout(t); r() }) })
      d.proc.kill('SIGTERM')
      await exited
    }
    const exitedOwnStop = d.proc.exitCode !== null || d.proc.signalCode !== null
    if (exitedOwnStop) fs.rmSync(d.base, { recursive: true, force: true })
    else keepLib = true
    expect(exitedOwnStop, 'daemon exited on its own stop').toBe(true)
  }
})

async function boot(twin: Twin): Promise<Daemon> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-')))
  const home = path.join(base, 'home')
  const daemonDir = path.join(base, 'd')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    CLAUDE_CONFIG_DIR: undefined, WALNUT_DAEMON_KEEP_SESSIONS: undefined, WALNUT_DAEMON_STATE_DIR: undefined,
    WALNUT_DEMO_ROOT: undefined, WALNUT_DEMO_GENERATION: undefined,
    WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: daemonDir + '-streams',
    WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(base, 'spawn-journal.jsonl'),
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry: Omit<Daemon, 'ws'> & { ws: WebSocket | null } = { proc, ws: null, base }
  daemons.push(entry)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  entry.ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  return entry as Daemon
}

function rpc(d: Daemon, cmd: Record<string, unknown>, timeoutMs = 45_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id !== id) return
      clearTimeout(timer)
      d.ws.off('message', onMessage)
      resolve(msg)
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/** The same start the quiesce twins test sends for its native CLI, with the ready file as a lead arg. */
function nativeStart(d: Daemon, sid: string, lead: string[]) {
  const sh = `exec ${[process.execPath, path.join(lib, 'native-cli.cjs'), ...lead].map((a) => JSON.stringify(a)).join(' ')} "$@"`
  return rpc(d, { cmd: 'start', sid, cwd: lib, message: '', resume: false, mode: 'default', args: ['/bin/sh', '-c', sh, 'sh', '--session-id', sid] })
}

describe.each(TWINS)('stop with a lingering child on the $name', (twin) => {
  it('waits for the group after the CLI exits on SIGINT, and answers stopped instead of "identity changed"', async () => {
    const d = await boot(twin)
    const sid = 'cccccccc-0000-4000-8000-0000000000c1'
    const ready = path.join(d.base, 'child.pid')
    const started = await nativeStart(d, sid, [ready])
    expect(started).toMatchObject({ ok: true })
    const cliPid = started.pid as number
    fixturePids.push(cliPid)
    // The child's handlers are on before the stop's SIGINT can reach it.
    expect(await waitFor(() => fs.existsSync(ready))).toBe(true)
    const childPid = Number(fs.readFileSync(ready, 'utf8'))
    fixturePids.push(childPid)
    expect(childPid).toBeGreaterThan(1)
    expect(isAlive(childPid)).toBe(true)

    const stopped = await rpc(d, { cmd: 'stop', sid, reason: 'user' })
    expect(String(stopped.error ?? '')).not.toMatch(/identity changed/)
    expect(stopped).toMatchObject({ ok: true, stopped: true })
    // The scenario really ran: the CLI ended first and the child saw it gone while it lived on.
    expect(fs.existsSync(ready + '.parent-gone')).toBe(true)
    // The reply waited for the empty group, so both are gone by now.
    expect(isAlive(cliPid)).toBe(false)
    expect(isAlive(childPid)).toBe(false)
  }, 90_000)
})
