/**
 * A forced service update against a real busy service daemon, on BOTH twins
 * (daemon-update-behind.ts, daemon-over-busy.ts).
 *
 * 2026-11-05: clouddev's daemon refused every update as busy for hours ("Daemon has active
 * operations; retry after they finish"): a request of some client was always open. Pinned here:
 * while a host_exec run (an admitted request) goes on, a plain service.update is refused, and a
 * forced one goes ahead at once and the daemon exits, without waiting for the run, whose log says why it ended.
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
import { requestDaemonServiceUpdate } from '../../src/providers/daemon-service-cli.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-force-twins-')))
afterAll(() => { if (root.includes('walnut-update-force-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds its sidecars next to it, as deployed: the handover needs the cron runtime.
if (BUN) {
  for (const name of ['task-dir-core', 'host-exec-core', 'daemon-cron-runtime', 'daemon-instance-lock']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  ...(BUN ? [{ name: `source twin (${SOURCE_TWIN.runtime})`, command: (): [string, string[]] => [SOURCE_TWIN.file, [scriptPath, '--service']] }] : []),
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--service']] }] : []),
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

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<{ home: string; daemonDir: string; stateDir: string }> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const daemonDir = path.join(dir, 'daemon')
  const stateDir = daemonInstallRoot(process.platform === 'darwin' ? 'darwin' : 'linux', home)
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(stateDir, 0o700)
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
    WALNUT_DAEMON_STATE_DIR: stateDir,
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
  return { home, daemonDir, stateDir }
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
  it('a forced update goes over a running request; a plain one is refused', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    const { daemonDir, stateDir } = await boot(twin, dir)
    const hello = await rpc({ cmd: 'hello' })
    expect(hello).toMatchObject({ ok: true })
    expect(hello.capabilities).toContain('service-update-v1')
    const instanceId = String(hello.instanceId)

    const taskId = 'update-force-task'
    void rpc({ cmd: 'exec.run', jobId: 'hx-update-force', taskId, command: 'sleep 20', cwd: '~', caller: { task: taskId, host: 'devbox' } }, 60_000).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))

    const plain = await rpc({ cmd: 'service.update', instanceId, stateDir })
    expect(plain.ok).not.toBe(true)
    expect(String(plain.error)).toMatch(/must finish first|has active operations/)
    expect(proc!.exitCode).toBeNull()

    expect(hello.capabilities).toContain('service-update-force-v1')
    // Never forced within its window (an older daemon ignores force the same way): the CLI says
    // 'unprepared', so its service restarts the daemon, and nothing was changed here yet.
    const said: string[] = []
    expect(await requestDaemonServiceUpdate(daemonDir, stateDir, { force: true, plainMs: 60_000, pauseMs: 200, busyMs: 1_000, note: (text) => said.push(text) })).toBe('unprepared')
    expect(said.at(-1)).toContain('restarting it instead')
    expect(proc!.exitCode).toBeNull()
    expect(await rpc({ cmd: 'hello' })).toMatchObject({ ok: true, instanceId })
    // The CLI's way (daemon-over-busy.ts): plain asks first, force once they were refused for plainMs.
    const notes: string[] = []
    const asked = Date.now()
    await requestDaemonServiceUpdate(daemonDir, stateDir, { force: true, plainMs: 1_000, pauseMs: 200, busyMs: 30_000, note: (text) => notes.push(text) })
    expect(notes[0]).toMatch(/must finish first|has active operations/)
    expect(Date.now() - asked).toBeGreaterThanOrEqual(1_000)
    // It returned once the daemon's pid was gone, without waiting for the 20 s run.
    const exited = proc!.exitCode !== null || proc!.signalCode !== null
      || await new Promise<boolean>((r) => { const t = setTimeout(() => r(false), 5_000); proc!.once('exit', () => { clearTimeout(t); r(true) }) })
    expect(exited).toBe(true)
    expect(Date.now() - asked).toBeLessThan(15_000)
    // The run it ended says why in its own log (host-exec-core.ts endForUpdate).
    const find = (d: string): string | null => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { const hit = find(p); if (hit) return hit } else if (e.name === 'hx-update-force.log') return p
      }
      return null
    }
    const logFile = find(dir)
    expect(logFile, 'the run log').not.toBeNull()
    expect(fs.readFileSync(logFile!, 'utf8')).toContain('[walnut] the daemon on this host was replaced by an update')
  }, 90_000)
})
