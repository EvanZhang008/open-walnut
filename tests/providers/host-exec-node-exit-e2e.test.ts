/**
 * The daemon's JS twin (daemon-source.ts) on node still stops when a wait_for file look is stuck
 * in the thread pool. A stat on a network mount that stopped answering never returns, and node's
 * exit waits for every pool thread, so the daemon's stop (and with it an update or a handover)
 * hung for as long as the mount did (2026-11-04 review, probe9; bun's exit does not wait). The
 * daemon now ends itself hard after its normal shutdown when a look is stuck.
 *
 * The stuck stat: a preload sends the stat of one directory's paths to the open of a FIFO that
 * nobody writes, which holds a pool thread the same way. A boot with no stuck look stops as before.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the task root are temp paths; the one job is `sleep`;
 * the daemon is SIGKILLed if it does not stop by itself.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const BUN = testBun()
const ON_NODE = SOURCE_TWIN.runtime === 'node' && BUN !== undefined && process.platform !== 'win32'
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-node-exit-')))
afterAll(() => { if (root.includes('walnut-host-exec-node-exit-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
const fifo = path.join(root, 'nobody-writes')
const stuckDir = path.join(root, 'dead-mount')
// A slow mount: its stat waits on a FIFO the test writes to later.
const slowFifo = path.join(root, 'written-later')
const slowDir = path.join(root, 'slow-mount')
const preload = path.join(root, 'stuck-stat.cjs')
if (ON_NODE) {
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  for (const name of ['task-dir-core', 'host-exec-core']) {
    const built = spawnSync(BUN!, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
  spawnSync('mkfifo', [fifo])
  spawnSync('mkfifo', [slowFifo])
  fs.writeFileSync(preload, [
    "const fs = require('fs')",
    'const stat = fs.promises.stat',
    `fs.promises.stat = function (p, ...rest) { return String(p).startsWith(${JSON.stringify(stuckDir)}) ? fs.promises.readFile(${JSON.stringify(fifo)})`
      + ` : String(p).startsWith(${JSON.stringify(slowDir)}) ? fs.promises.readFile(${JSON.stringify(slowFifo)}) : stat.call(this, p, ...rest) }`,
  ].join('\n'))
}

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
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

async function boot(dir: string): Promise<void> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  proc = spawn(SOURCE_TWIN.file, ['-r', preload, scriptPath, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

let rpcId = 1
function rpc(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

/** SIGTERM, then how long the daemon took to exit (null: not within `ms`). */
async function stopTook(ms: number): Promise<number | null> {
  const p = proc!
  const t0 = Date.now()
  const exited = new Promise<boolean>((r) => { const t = setTimeout(() => r(false), ms); p.once('exit', () => { clearTimeout(t); r(true) }) })
  p.kill('SIGTERM')
  return (await exited) ? Date.now() - t0 : null
}

describe.runIf(ON_NODE)('the source twin on node', () => {
  it('stops on SIGTERM; with a file look stuck in the thread pool too, instead of hanging in its exit', async () => {
    await boot(path.join(root, 'plain'))
    expect((await rpc({ cmd: 'hello' })).capabilities as string[]).toContain('host-exec-wait-v1')
    expect(await stopTook(20_000)).not.toBeNull()

    await boot(path.join(root, 'stuck'))
    const taskId = 'task-node-exit'
    const bg = await rpc({ cmd: 'exec.run', jobId: 'hx-node-exit-0001', taskId, command: 'sleep 30', background: true })
    expect(bg).toMatchObject({ ok: true, running: true })
    // The look at a path on the dead mount does not answer: the wait says so, and the stat stays stuck.
    const read = await rpc({ cmd: 'exec.read', jobId: 'hx-node-exit-0001', taskId, wait: 1_500, until: { file: path.join(stuckDir, 'ready') } })
    expect(read).toMatchObject({ ok: true, running: true, waitedFor: { matched: null, unchecked: expect.stringContaining('did not answer') } })
    expect(await rpc({ cmd: 'exec.kill', jobId: 'hx-node-exit-0001', taskId })).toMatchObject({ ok: true })
    expect(await stopTook(20_000)).not.toBeNull()
  }, 90_000)

  it('a look that is only slow gets a moment at exit: the daemon exits by itself, not by SIGKILL', async () => {
    // 2026-11-04 review: a look near a wait's bound gets only 200 ms, and one past that was taken for
    // a stuck mount at exit, which turned an orderly exit into a SIGKILL.
    await boot(path.join(root, 'slow'))
    const taskId = 'task-node-exit'
    await rpc({ cmd: 'exec.run', jobId: 'hx-node-exit-0002', taskId, command: 'sleep 30', background: true })
    const read = await rpc({ cmd: 'exec.read', jobId: 'hx-node-exit-0002', taskId, wait: 300, until: { file: path.join(slowDir, 'ready') } })
    expect(read).toMatchObject({ ok: true, waitedFor: { matched: null, unchecked: expect.stringContaining('did not answer') } })
    await rpc({ cmd: 'exec.kill', jobId: 'hx-node-exit-0002', taskId })
    const p = proc!
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => p.once('exit', (code, signal) => r({ code, signal })))
    p.kill('SIGTERM')
    // The mount answers a moment into the exit: the look ends, and nothing holds the pool.
    setTimeout(() => {
      void fs.promises.open(slowFifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK).then((fh) => fh.close()).catch(() => {})
    }, 300)
    expect(await exited).toEqual({ code: 0, signal: null })
  }, 90_000)
})
