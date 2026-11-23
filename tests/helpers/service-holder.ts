/**
 * A Walnut service holding a daemon dir in a process of its own (tests/providers/fixtures/
 * in-process-service-holder.ts): its env on one temp root, its start and stop, and a client on its
 * door (daemon.port). With `serviceHome` it holds the dir as a host's one Walnut service does
 * (startInProcessDaemon's `service`: mode 'service', daemon.pid, hello `serves: 'walnut-serve'`).
 * Used by tests/providers/one-service-lock.test.ts, one-service-door.test.ts and one-service-lead-e2e.test.ts.
 * MACHINE SAFETY: every path is under the root the caller made; a holder ends when its stdin
 * closes; nothing is signalled.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { guardedPath } from '../setup/exec-guard.js'

const FIXTURE = path.resolve(__dirname, '../providers/fixtures/in-process-service-holder.ts')

/** A fake CLI under `root`: an init line, then a result line for every line it reads. */
export function fakeStreamCli(root: string): string {
  const file = path.join(root, 'fake-cli.sh')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'sid=fake',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "--session-id" ]; then sid="$2"; fi',
    '  shift',
    'done',
    'echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"fake\\",\\"tools\\":[]}"',
    'while IFS= read -r line; do',
    '  echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"session_id\\":\\"$sid\\",\\"result\\":\\"ok\\"}"',
    'done',
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

/** The holder's env on `root`: its own HOME, data home and daemon dir; with `serviceHome`, the launcher's state dir too. */
export function holderEnv(root: string, opts: { serviceHome?: string; extra?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, WALNUT_HOME_OVERRIDE: home, OPEN_WALNUT_HOME: path.join(root, 'walnut-home'),
    WALNUT_DAEMON_DIR: path.join(root, 'd'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'), WALNUT_TASK_DIR_ROOT: path.join(root, 'tasks'),
    WALNUT_NET_NO_DOWNLOAD: '1', SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'),
  }
  for (const k of ['WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID', 'WALNUT_NET_BIN', 'XDG_STATE_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  if (opts.serviceHome) {
    // The service's state dir is private, as the launcher's install root is.
    const launcher = path.join(root, 's', 'launcher')
    fs.mkdirSync(launcher, { recursive: true, mode: 0o700 })
    Object.assign(env, { WALNUT_DAEMON_STATE_DIR: path.join(root, 's'), WALNUT_LAUNCHER_DIR: launcher, HOLDER_SERVICE_HOME: opts.serviceHome })
  }
  return { ...env, ...opts.extra }
}

export interface Holder { pid: number; child: ChildProcess; output: () => string; stop: () => Promise<void> }

/** Starts a holder and waits for its `ready <pid> started`. */
export function startHolder(env: NodeJS.ProcessEnv, track: ChildProcess[] = []): Promise<Holder> {
  const child = spawn(process.execPath, [FIXTURE], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  track.push(child)
  let out = ''
  let err = ''
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const gone = new Promise((r) => child.once('exit', r))
    try { child.stdin?.end() } catch { /* closed */ }
    await gone
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the holder did not start: ${err.slice(-1500)}`)), 40_000)
    child.stderr!.on('data', (c) => { err += c })
    child.stdout!.on('data', (c) => {
      out += c
      const m = /ready (\d+) started/.exec(out)
      if (m) { clearTimeout(timer); resolve({ pid: Number(m[1]), child, output: () => out + err, stop }) }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the holder exited ${code}: ${err.slice(-1500)}`)) })
  })
}

/** Ends every holder still running (a test's afterAll). */
export async function stopHolders(track: ChildProcess[]): Promise<void> {
  for (const h of track) { try { h.stdin?.end() } catch { /* gone */ } }
  await Promise.all(track.map((h) => new Promise((r) => (h.exitCode !== null || h.signalCode !== null ? r(null) : h.once('exit', r)))))
}

export function doorPort(dir: string): number { return Number(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')) }

export interface DoorClient {
  ws: WebSocket
  call: (cmd: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** Every frame the door sent that answers no call (events, stream frames). */
  onEvent: (fn: (frame: Record<string, unknown>) => void) => void
  close: () => void
}

/** A client on the door at `port`. `beat`: a ping every second (what keeps a leader link fresh). */
export async function openDoor(port: number, opts: { beat?: boolean } = {}): Promise<DoorClient> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => { s.terminate(); reject(new Error('the door did not open')) }, 15_000)
    s.once('open', () => { clearTimeout(t); resolve(s) })
    s.once('error', (e) => { clearTimeout(t); reject(e) })
  })
  const waiting = new Map<number, (m: Record<string, unknown>) => void>()
  const listeners: Array<(frame: Record<string, unknown>) => void> = []
  let next = 1
  ws.on('message', (data) => {
    let v: Record<string, unknown>
    try { v = JSON.parse(String(data)) } catch { return }
    const done = typeof v.id === 'number' && v.id > 0 ? waiting.get(v.id) : undefined
    if (done) { waiting.delete(v.id as number); done(v); return }
    for (const fn of listeners) fn(v)
  })
  const call = (cmd: Record<string, unknown>, timeoutMs = 30_000) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = next++
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${String(cmd.cmd)}`)) }, timeoutMs)
    waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
    ws.send(JSON.stringify({ id, ...cmd }))
  })
  const beat = opts.beat ? setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 1_000) : null
  return { ws, call, onEvent: (fn) => { listeners.push(fn) }, close: () => { if (beat) clearInterval(beat); try { ws.close() } catch { /* closed */ } } }
}

/** A leader on the door (a Walnut's session link): it names its Walnut and describes it, and keeps the link fresh. */
export async function leaderOnDoor(port: number, home: string, walnutId: string): Promise<DoorClient> {
  const door = await openDoor(port, { beat: true })
  await door.call({ cmd: 'hello' })
  const configured = await door.call({ cmd: 'leader.configure', home, walnutId })
  if (configured.ok !== true) throw new Error(`leader.configure refused: ${JSON.stringify(configured)}`)
  const slice = { v: 1, home, hash: 'h1', asOf: Date.now(), host: 'test host', sessions: [], tasks: [], requests: [] }
  const sliced = await door.call({ cmd: 'host.slice', slice })
  if (sliced.ok !== true) throw new Error(`host.slice refused: ${JSON.stringify(sliced)}`)
  return door
}

export async function until<T>(what: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}
