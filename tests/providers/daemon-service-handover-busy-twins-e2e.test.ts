/**
 * The service install's handover request against a real daemon that is busy (daemon-standalone.ts under bun).
 *
 * 2026-11-02 (Fresh Mac join, existing Mac): right after an older Walnut's server started, it
 * kept its daemon busy, the daemon refused the install's handover ("Daemon has active operations;
 * retry after they finish"), and the install gave up and removed the login service it had just
 * written. Pinned here end to end: while a command of the daemon's client is still running, the
 * request is refused, asked again, and handed over once that command is done; the daemon then
 * writes its handover snapshot and exits.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the commands it runs are
 * `sleep`, `cat` of a FIFO it made and `mkfifo`; the only signals are signal 0 and SIGTERM to the
 * daemon this file started, SIGKILL to it after each test, and SIGKILL to the process group of a
 * run this file started (its pid recorded by the run itself) when that run still lives at the end.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { daemonInstallRoot } from '../../src/providers/daemon-service-config.js'
import { requestDaemonServiceHandover } from '../../src/providers/daemon-service-cli.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-handover-busy-twins-')))
afterAll(() => { if (root.includes('walnut-handover-busy-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const BUN: string | undefined = testBun()
/** What a resumable run's log ends with when the daemon stops (RESUMABLE_RUN_ENDED). */
const RESUMABLE_NOTE = '[walnut] the daemon on this host stopped (an update or a restart); this run was marked resumable, so run it again to go on waiting.'
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

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

async function boot(dir: string): Promise<{ home: string; daemonDir: string }> {
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
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    // The daemon went (a handover): an answer still owed never comes.
    sock.once('close', () => { clearTimeout(timer); reject(new Error('socket closed: ' + String(cmd.cmd))) })
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

function prepState(home: string): string {
  const stateDir = daemonInstallRoot(process.platform === 'darwin' ? 'darwin' : 'linux', home)
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(stateDir, 0o700)
  return stateDir
}

/** Whether a process still runs (a zombie waiting for its reaper does not). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

describe.skipIf(!BUN)('standalone daemon (bun)', () => {
  it('waits out a running command, then hands over and the daemon exits', async () => {
    const dir = path.join(root, 'standalone')
    const { home, daemonDir } = await boot(dir)
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
    const dir = path.join(root, 'standalone-bg')
    const { home, daemonDir } = await boot(dir)
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

  it('a resumable run (it only waits; its caller runs it again) does not hold the handover, and its log says to run it again (2026-11-17)', async () => {
    // A chain of 2-hour waits on one host kept its daemon about 3 h behind production.
    const dir = path.join(root, 'standalone-resumable')
    const { home, daemonDir } = await boot(dir)
    const stateDir = daemonInstallRoot(process.platform === 'darwin' ? 'darwin' : 'linux', home)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(stateDir, 0o700)
    const taskId = 'handover-resumable-task'
    const started = await rpc({ cmd: 'exec.run', jobId: 'hx-handover-res', taskId, command: 'sleep 60', cwd: '~', background: true, resumable: true, caller: { task: taskId, host: 'devbox' } })
    expect(started).toMatchObject({ ok: true, running: true, resumable: true })
    expect(await rpc({ cmd: 'hello' })).toMatchObject({ ok: true, execRunning: 1, execHolding: 0 })

    const notes: string[] = []
    const asked = Date.now()
    expect(await requestDaemonServiceHandover(daemonDir, stateDir, { pauseMs: 300, note: (text) => notes.push(text) })).toBe(true)
    expect(notes.filter((n) => n.includes('running host_exec jobs must finish first'))).toEqual([])
    // Not the run's 60 s: the handover went ahead at once.
    expect(Date.now() - asked).toBeLessThan(30_000)
    const logFile = path.join(dir, 'state', 'tasks', taskId, 'host-exec', 'hx-handover-res.log')
    expect(fs.readFileSync(logFile, 'utf8')).toContain(RESUMABLE_NOTE)
  }, 90_000)

  it('a detached run holds no update for a server that knows it, but an older server waits for it (its daemon cannot follow it: 2026-11-21 rollback rehearsal)', async () => {
    const dir = path.join(root, 'standalone-detached')
    const { home } = await boot(dir)
    prepState(home)
    const taskId = 'handover-detached-task'
    const started = await rpc({ cmd: 'exec.run', jobId: 'hx-handover-det', taskId, command: 'sleep 60', cwd: '~', background: true, endGroup: true, detach: true, caller: { task: taskId, host: 'devbox' } })
    expect(started).toMatchObject({ ok: true, running: true, detached: true })
    // execHolding is what an older server reads before it replaces this daemon; execHoldsUpdate, a newer one.
    expect(await rpc({ cmd: 'hello' })).toMatchObject({ ok: true, execRunning: 1, execHolding: 1, execHoldsUpdate: 0 })
    expect(await rpc({ cmd: 'exec.kill', jobId: 'hx-handover-det', taskId })).toMatchObject({ ok: true })
  }, 90_000)

  it('a resumable run beside one that is not: the handover is refused, and the resumable one is not ended', async () => {
    const dir = path.join(root, 'standalone-mixed')
    const { home } = await boot(dir)
    const stateDir = prepState(home)
    const taskId = 'handover-mixed-task'
    const run = (jobId: string, resumable: boolean) => rpc({ cmd: 'exec.run', jobId, taskId, command: 'sleep 60', cwd: '~', background: true, ...(resumable ? { resumable: true } : {}), caller: { task: taskId, host: 'devbox' } })
    expect(await run('hx-mixed-wait', true)).toMatchObject({ ok: true, resumable: true })
    expect(await run('hx-mixed-work', false)).toMatchObject({ ok: true, running: true })
    const hello = await rpc({ cmd: 'hello' })
    expect(hello).toMatchObject({ execRunning: 2, execHolding: 1 })
    const refused = await rpc({ cmd: 'service.handover', instanceId: hello.instanceId, stateDir })
    expect(String(refused.error)).toContain('running host_exec jobs must finish first')
    const wait = await rpc({ cmd: 'exec.read', jobId: 'hx-mixed-wait', taskId })
    expect(wait).toMatchObject({ ok: true, running: true, resumable: true })
    expect(fs.readFileSync(String(wait.logFile), 'utf8')).not.toContain('[walnut]')
    for (const jobId of ['hx-mixed-wait', 'hx-mixed-work']) await rpc({ cmd: 'exec.kill', jobId, taskId })
  }, 90_000)

  it('a waiting read of a resumable run does not hold the handover, and no run starts while it drains', async () => {
    // The caller of a resumable run reads it with long waits, almost always in flight: had that read
    // held the pause ("has active operations"), the update would still wait out the overdue bound.
    const dir = path.join(root, 'standalone-drain')
    const { home } = await boot(dir)
    const stateDir = prepState(home)
    const taskId = 'handover-drain-task'
    const started = await rpc({ cmd: 'exec.run', jobId: 'hx-drain-wait', taskId, command: 'sleep 60', cwd: '~', background: true, resumable: true, caller: { task: taskId, host: 'devbox' } })
    expect(started).toMatchObject({ ok: true, resumable: true })
    const reading = rpc({ cmd: 'exec.read', jobId: 'hx-drain-wait', taskId, wait: 30_000 }, 60_000).catch((error: Error) => ({ lost: error.message }))
    const fifo = path.join(home, 'drain.fifo')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    const hello = await rpc({ cmd: 'hello' })
    // A file write the drain waits for, until the FIFO is read. One socket keeps the order: the write
    // is under way when the handover pauses, and the run is asked for after the pause.
    const write = rpc({ cmd: 'fs.write', path: fifo, data: 'drained' }, 60_000).catch(() => null)
    const handover = rpc({ cmd: 'service.handover', instanceId: hello.instanceId, stateDir }, 60_000)
    const during = await rpc({ cmd: 'exec.run', jobId: 'hx-drain-work', taskId, command: 'sleep 60', cwd: '~', background: true, caller: { task: taskId, host: 'devbox' } })
    expect(String(during.error)).toContain('Daemon is shutting down')
    const reader = spawn('cat', [fifo], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const answer = await handover
      expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true, prepared: true })
    } finally { reader.kill() }
    await write
    // The waiting read is answered as the going daemon ends the run: by the daemon, never as the
    // caller's own host_exec_stop (which would say nothing more comes).
    const read = await reading
    expect(read, JSON.stringify(read)).toMatchObject({ ok: true, running: false, killed: false, daemonEnded: true, resumable: true })
    const exited = proc!.exitCode !== null || proc!.signalCode !== null
      || await new Promise<boolean>((r) => { const t = setTimeout(() => r(false), 10_000); proc!.once('exit', () => { clearTimeout(t); r(true) }) })
    expect(exited).toBe(true)
    expect(fs.readFileSync(String(started.logFile), 'utf8')).toContain(RESUMABLE_NOTE)
  }, 90_000)

  it('a SIGTERM stop ends a resumable run with its note and leaves the others running, as before', async () => {
    // The unmanaged stop path (stopUnmanagedDaemon, a service restart): runs are their own process
    // groups, so a resumable waiter would outlive the daemon with no deadline.
    const dir = path.join(root, 'standalone-sigterm')
    const { home } = await boot(dir)
    const taskId = 'sigterm-task'
    const pidOf = (name: string) => path.join(home, `${name}.pid`)
    const run = (jobId: string, resumable: boolean) => rpc({ cmd: 'exec.run', jobId, taskId, command: `echo $$ > '${pidOf(jobId)}'; exec sleep 60`, cwd: '~', background: true, ...(resumable ? { resumable: true } : {}), caller: { task: taskId, host: 'devbox' } })
    const wait = await run('hx-sigterm-wait', true)
    await run('hx-sigterm-work', false)
    const recorded = async (jobId: string) => {
      for (const t0 = Date.now(); Date.now() - t0 < 10_000; await new Promise((r) => setTimeout(r, 50))) {
        try { const n = Number(fs.readFileSync(pidOf(jobId), 'utf8').trim()); if (n > 1) return n } catch { /* not written yet */ }
      }
      return 0
    }
    const waitPid = await recorded('hx-sigterm-wait')
    const workPid = await recorded('hx-sigterm-work')
    expect(waitPid).toBeGreaterThan(1)
    expect(workPid).toBeGreaterThan(1)
    try {
      const exited = new Promise<void>((r) => proc!.once('exit', () => r()))
      proc!.kill('SIGTERM')
      await exited
      expect(fs.readFileSync(String(wait.logFile), 'utf8')).toContain(RESUMABLE_NOTE)
      const t0 = Date.now()
      while (alive(waitPid) && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 100))
      expect(alive(waitPid), 'the resumable run ended with the daemon').toBe(false)
      expect(alive(workPid), 'the other run keeps running, as before').toBe(true)
    } finally {
      for (const pid of [waitPid, workPid]) if (pid > 1 && alive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }, 90_000)
})
