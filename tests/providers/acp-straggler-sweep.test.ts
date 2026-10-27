/**
 * The ACP daemon's startup straggler sweep signals a pid from the last daemon
 * life only while it is provably that worker's. Every process signalled here is
 * one this file spawned in its own process group (`sleep`, and a shell whose
 * leader exits while its `sleep` lives on); a stub stands in for `ps` only to
 * say "no answer".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpDaemon, type AcpProcessInfo } from '../../src/providers/acp-daemon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT = path.join(__dirname, 'mock-acp-agent.mjs')
const WORKER_BUNDLE = path.join(__dirname, '../../dist/daemon-binaries/acp-worker.js')

interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }
let tmpDir = ''
let daemonDir = ''
let streamsDir = ''
const children: ChildProcess[] = []
/** Processes this file did not spawn directly (a shell's child), with their start time: signalled only while still that process. */
const extraPids: Array<{ pid: number; start: string }> = []

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function lstart(pid: number): string {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
}
async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
/** A `sleep` that leads its own process group. */
function sleeper(): number {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  children.push(child)
  return child.pid!
}
function daemon(processInfo?: (pid: number) => Promise<AcpProcessInfo>, logs: string[] = [], bootMinute?: () => number) {
  return createAcpDaemon<FakeWs>({
    streamsDir, daemonDir, sendEvent: () => {}, isWsOpen: () => true,
    log: (_level, msg) => { logs.push(msg) }, processInfo, bootMinute,
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
  })
}
const writeRows = (rows: Record<string, unknown>) => fs.writeFileSync(path.join(daemonDir, 'acp-workers.json'), JSON.stringify(rows))

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-straggler-'))
  daemonDir = path.join(tmpDir, 'daemon')
  streamsDir = path.join(tmpDir, 'streams')
  fs.mkdirSync(daemonDir, { recursive: true })
})
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid && alive(child.pid)) child.kill('SIGKILL')
  for (const { pid, start } of extraPids.splice(0)) {
    let now = ''
    try { now = lstart(pid) } catch { /* gone */ }
    if (now && now === start) process.kill(pid, 'SIGKILL')
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ACP straggler sweep', () => {
  it('kills a straggler whose start time is the one recorded, and empties the pid file at once', async () => {
    const pid = sleeper()
    writeRows({ 'sid-a': { pid, cmd: 'acp-worker.js', start: lstart(pid) } })
    const sweep = daemon().startupRepair()
    expect(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf8')).toBe('{}')
    await sweep
    await until(() => !alive(pid), 'the straggler to die')
  })

  it('leaves alone a pid now held by a process that started at another time', async () => {
    const pid = sleeper()
    const logs: string[] = []
    writeRows({ 'sid-b': { pid, cmd: 'sleep', start: 'Mon Jan  1 00:00:00 2001' } })
    await daemon(undefined, logs).startupRepair()
    expect(alive(pid)).toBe(true)
    expect(logs).toContain('acp: straggler pid now belongs to another process; left alone')
  })

  it('reads an older pid file of bare pids, and signals only a process running the worker', async () => {
    const pid = sleeper()
    writeRows({ 'sid-c': pid })
    await daemon().startupRepair()
    expect(alive(pid)).toBe(true)
  })

  /** A group whose leader (a shell) exited while its `sleep <secs>` runs on: [group id, the sleep's pid]. */
  async function leaderlessGroup(secs: number): Promise<[number, number]> {
    const shell = spawn('sh', ['-c', `sleep ${secs} & echo $!`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(shell)
    let out = ''
    shell.stdout!.on('data', (chunk) => { out += String(chunk) })
    await until(() => /\d+\n/.test(out) && shell.exitCode !== null, 'the leader to exit with its child running')
    const orphan = Number(out.trim())
    extraPids.push({ pid: orphan, start: lstart(orphan) })
    expect(alive(orphan)).toBe(true)
    return [shell.pid!, orphan]
  }
  const thisBoot = () => Math.round((Date.now() / 1000 - os.uptime()) / 60)

  it('kills the group a dead worker left behind while it still runs that worker\'s adapter', async () => {
    const [pgid, orphan] = await leaderlessGroup(61)
    writeRows({ 'sid-d': { pid: pgid, cmd: 'acp-worker.js', adapter: 'sleep 61', boot: thisBoot(), start: 'whatever it was' } })
    await daemon().startupRepair()
    await until(() => !alive(orphan), 'the orphaned group to die')
  })

  it('leaves alone a group of that id that runs anything but the adapter', async () => {
    const [pgid, orphan] = await leaderlessGroup(62)
    const logs: string[] = []
    writeRows({ 'sid-f': { pid: pgid, cmd: 'acp-worker.js', adapter: 'codex-acp', boot: thisBoot(), start: 'whatever it was' } })
    await daemon(undefined, logs).startupRepair()
    expect(alive(orphan)).toBe(true)
    expect(logs).toContain('acp: straggler group runs no adapter of this worker; left alone')
  })

  it('leaves alone every row written before this host last booted', async () => {
    const pid = sleeper()
    const [pgid, orphan] = await leaderlessGroup(63)
    writeRows({
      'sid-g': { pid, cmd: 'sleep', adapter: 'sleep', boot: thisBoot() - 600, start: lstart(pid) },
      'sid-h': { pid: pgid, cmd: 'acp-worker.js', adapter: 'sleep 63', boot: thisBoot() - 600 },
    })
    await daemon().startupRepair()
    expect(alive(pid)).toBe(true)
    expect(alive(orphan)).toBe(true)
  })

  it('leaves a pid alone when ps gives no answer', async () => {
    const pid = sleeper()
    writeRows({ 'sid-e': { pid, cmd: 'sleep', start: lstart(pid) } })
    await daemon(async () => ({ state: 'unknown' })).startupRepair()
    expect(alive(pid)).toBe(true)
  })

  it('records a running worker with its script and start time', async () => {
    const acp = daemon()
    const started = await acp.acpStart({ open: true, frames: [] }, {
      sid: 'sid-live', cwd: tmpDir, workerCmd: [process.execPath, WORKER_BUNDLE], adapterCmd: [process.execPath, MOCK_AGENT],
    })
    expect(started.ok).toBe(true)
    const file = path.join(daemonDir, 'acp-workers.json')
    let row: { pid: number; cmd: string; start?: string } | undefined
    await until(() => { row = JSON.parse(fs.readFileSync(file, 'utf8'))['sid-live']; return !!row?.start }, 'the start time to be recorded')
    expect(row!.cmd).toBe('acp-worker.js')
    expect(row).toMatchObject({ adapter: `${process.execPath} ${MOCK_AGENT}`, boot: expect.any(Number) })
    expect(row!.start).toBe(lstart(row!.pid))
    await acp.acpStop('sid-live')
  })
})
