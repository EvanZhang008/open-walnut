/**
 * An isolated-dir daemon (a test, a sandbox, an ephemeral server) ends its
 * sessions' process groups when it exits, with the SIGINT → SIGTERM → SIGKILL
 * ladder run synchronously in cleanup(). Both twins, booted for real.
 *
 * What matters: a CLI that exits on SIGINT ends the ladder at once. The ladder
 * blocks the event loop, so the daemon never reaps its own dead children while
 * it waits, and kill(-pgid, 0) keeps answering for their zombies: before, every
 * such exit waited out the whole 5s + 2s budget. A CLI that ignores SIGINT still
 * gets the full grace before SIGTERM (its stop hooks must not be cut short).
 *
 * MACHINE SAFETY: HOME is a temp dir, PATH is pinned to system dirs and
 * SHELL=/bin/sh, the daemon dir is a temp path, and the only processes started
 * are /bin/sleep sessions in their own groups, which the daemon ends itself
 * (afterEach SIGKILLs anything a failed test left).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

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
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
const started: number[] = []

async function boot(twin: Twin): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exit-reap-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
  }
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_PARENT_PID']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

let nextId = 1
function rpc(frame: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc ${String(frame.cmd)} timeout`)), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...frame }))
  })
}

/** Start a session running `args` and return its pid (the group's leader). */
async function startSession(sid: string, args: string[]): Promise<number> {
  const reply = await rpc({ cmd: 'start', sid, args, cwd: root, message: 'init\n' })
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
  expect(pid).toBeGreaterThan(1)
  started.push(pid)
  return pid
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** SIGTERM the daemon and resolve with how long it took to exit. */
async function stopDaemonTimed(): Promise<number> {
  ws?.close()
  ws = null
  const t0 = Date.now()
  const exited = new Promise<void>((resolve) => proc!.once('exit', () => resolve()))
  proc!.kill('SIGTERM')
  await exited
  return Date.now() - t0
}

function commandOf(pid: number): string {
  try { return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

/** Wait until the group has no member left (its zombie is reaped by init once the daemon is gone). */
async function waitGroupGone(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!groupAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !groupAlive(pid)
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-exit-reap-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  // Only groups this file started, and only while they still exist.
  for (const pid of started.splice(0)) if (pid > 1 && groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('isolated-dir exit reap: $name', (twin) => {
  it('a CLI that exits on SIGINT ends the ladder at once', async () => {
    await boot(twin)
    const a = await startSession('exit-reap-a', ['/bin/sleep', '60'])
    const b = await startSession('exit-reap-b', ['/bin/sleep', '60'])
    const ms = await stopDaemonTimed()
    expect(await waitGroupGone(a)).toBe(true)
    expect(await waitGroupGone(b)).toBe(true)
    // The SIGINT grace alone is 5s; a dead group must not wait it out.
    expect(ms).toBeLessThan(3_000)
  }, 60_000)

  it('a CLI that ignores SIGINT keeps the full grace, then SIGTERM ends it', async () => {
    await boot(twin)
    // An ignored signal stays ignored across exec, so the sleep itself ignores SIGINT.
    const pid = await startSession('exit-reap-stubborn', ['/bin/sh', '-c', 'trap "" INT; exec /bin/sleep 60'])
    // The pid execs its way from the spawn shell to sleep; only then is SIGINT ignored.
    expect(await waitFor(() => commandOf(pid).endsWith('sleep'))).toBe(true)
    const ms = await stopDaemonTimed()
    expect(await waitGroupGone(pid)).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(4_500)
  }, 60_000)
})
