/**
 * The service install's handover request against a real daemon that is busy, on BOTH twins.
 *
 * 2026-11-02 (Fresh Mac join, existing Mac): right after an older Walnut's server started, it
 * kept its daemon busy, the daemon refused the install's handover ("Daemon has active operations;
 * retry after they finish"), and the install gave up and removed the login service it had just
 * written. Pinned here end to end: while a command of the daemon's client is still running, the
 * request is refused, asked again, and handed over once that command is done; the daemon then
 * writes its handover snapshot and exits.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the command it runs is
 * `sleep`; the only signals are signal 0 to the daemon this file started, and SIGKILL to it after
 * each twin.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { daemonInstallRoot } from '../../src/providers/daemon-service-config.js'
import { requestDaemonServiceHandover } from '../../src/providers/daemon-service-cli.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-handover-busy-twins-')))
afterAll(() => { if (root.includes('walnut-handover-busy-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds its sidecars next to it, as deployed: the handover needs the cron runtime.
if (BUN) {
  for (const name of ['task-dir-core', 'host-exec-core', 'daemon-cron-runtime']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  ...(BUN ? [{ name: `source twin (${SOURCE_TWIN.runtime})`, command: (): [string, string[]] => [SOURCE_TWIN.file, [scriptPath, '--start']] }] : []),
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
afterEach(async () => {
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<{ home: string; daemonDir: string }> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const daemonDir = path.join(dir, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  // The instance file comes last at startup; the request reads it.
  const until = Date.now() + 15_000
  while (!fs.existsSync(path.join(daemonDir, 'daemon.instance')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  return { home, daemonDir }
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

describe.each(TWINS)('$name', (twin) => {
  it('waits out a running command, then hands over and the daemon exits', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    const { home, daemonDir } = await boot(twin, dir)
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const stateDir = daemonInstallRoot(platform, home)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(stateDir, 0o700)

    // A command of the server still running (an admitted one, as fs, git and exec are).
    const taskId = 'handover-busy-task'
    const running = rpc({ cmd: 'exec.run', jobId: 'hx-handover-busy', taskId, command: 'sleep 2', cwd: '~', caller: { task: taskId, host: 'devbox' } })
    await new Promise((r) => setTimeout(r, 200))

    const notes: string[] = []
    const started = Date.now()
    expect(await requestDaemonServiceHandover(daemonDir, stateDir, { pauseMs: 200, note: (text) => notes.push(text) })).toBe(true)
    expect(notes).toHaveLength(1)
    // The run is a host_exec job: refused for it before the drain is even asked (exec-runs-hold.ts).
    expect(notes[0]).toContain('running host_exec jobs must finish first')
    // Handed over only after the command finished, never by cutting it short.
    expect(Date.now() - started).toBeGreaterThan(1000)
    expect(await running).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(stateDir, 'handover.json'))).toBe(true)
    // requestDaemonServiceHandover returned only after the daemon's pid was gone.
    const exited = proc!.exitCode !== null || proc!.signalCode !== null
      || await new Promise<boolean>((r) => { const t = setTimeout(() => r(false), 5000); proc!.once('exit', () => { clearTimeout(t); r(true) }) })
    expect(exited).toBe(true)
  }, 90_000)

  it('a background host_exec run holds the handover until it ends, and hello counts it', async () => {
    // 2026-11-03: a deploy updated a Mac's daemon under an iOS test run started in the
    // background through host_exec; the run ended with the old daemon.
    const dir = path.join(root, twin.name.replace(/\W+/g, '-') + '-bg')
    const { home, daemonDir } = await boot(twin, dir)
    const stateDir = daemonInstallRoot(process.platform === 'darwin' ? 'darwin' : 'linux', home)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(stateDir, 0o700)
    const taskId = 'handover-bg-task'
    const started = await rpc({ cmd: 'exec.run', jobId: 'hx-handover-bg', taskId, command: 'sleep 3; echo finished', cwd: '~', background: true, caller: { task: taskId, host: 'devbox' } })
    expect(started).toMatchObject({ ok: true })
    expect(await rpc({ cmd: 'hello' })).toMatchObject({ ok: true, execRunning: 1 })

    const notes: string[] = []
    const asked = Date.now()
    expect(await requestDaemonServiceHandover(daemonDir, stateDir, { pauseMs: 300, note: (text) => notes.push(text) })).toBe(true)
    expect(notes[0]).toContain('running host_exec jobs must finish first')
    expect(Date.now() - asked).toBeGreaterThan(2000)
    // The run went to its end before the daemon left.
    const logFile = path.join(dir, 'state', 'tasks', taskId, 'host-exec', 'hx-handover-bg.log')
    expect(fs.readFileSync(logFile, 'utf8')).toContain('finished')
  }, 90_000)
})
