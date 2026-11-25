/**
 * A real session daemon (daemon-standalone.ts under bun), driven over its WebSocket as a Walnut
 * server would, for the trigger suites that stop and start daemons on the same dirs (a restart,
 * a reboot, a replace).
 *
 * MACHINE SAFETY: the caller passes temp dirs only; every daemon is spawned detached in its own
 * group, and `killTriggerDaemons` (call it in afterEach) signals only those groups.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { testBun } from './bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
export const TRIGGER_BUN = process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH) ? process.env.BUN_PATH : testBun() ?? null
/** The one daemon there is; kept so a suite can still name it. */
export type Twin = 'standalone'
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * A socket to the daemon of `runDir`. The daemon writes daemon.pid before daemon.port, so the port
 * file seen next to its pid can still be the last daemon's (killed in the restart under test): a
 * refused connect reads the port again until this daemon's own one answers.
 */
async function connectDaemon(child: ChildProcess, runDir: string, twin: Twin): Promise<WebSocket> {
  const portFile = path.join(runDir, 'daemon.port')
  const connect = (port: number) => new Promise<WebSocket | null>((res, rej) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => res(s))
    s.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? res(null) : rej(err)))
  })
  const first = await waitFor(() => fs.readFileSync(portFile, 'utf8').trim() || undefined, 10_000, 'its port')
  const by = Date.now() + 10_000
  for (let port = first; ; port = fs.readFileSync(portFile, 'utf8').trim() || port) {
    const s = await connect(parseInt(port, 10))
    if (s) return s
    if (Date.now() > by) throw new Error(`the ${twin} daemon refused its port ${port}`)
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the ${twin} daemon exited`)
    await sleep(50)
  }
}

const children: ChildProcess[] = []

/** SIGKILL every daemon group this helper started that is still up. */
export function killTriggerDaemons(): void {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && typeof child.pid === 'number' && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
  }
}

export interface TriggerDaemonStart {
  /** `--start` (a daemon on WALNUT_DAEMON_DIR) or `--service` (the install-root layout). */
  mode: '--start' | '--service'
  env: Record<string, string>
  /** WALNUT_DAEMON_DIR: where it writes daemon.pid and daemon.port. */
  runDir: string
  cwd: string
}

export class TriggerDaemon {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (reply: Record<string, unknown>) => void>()
  private constructor(readonly child: ChildProcess, private ws: WebSocket, private readonly runDir: string) {
    this.attach(ws)
  }

  private attach(ws: WebSocket): void {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (waiter) { this.waiters.delete(msg.id as number); waiter(msg) }
    })
  }

  /** The server goes away: its socket is closed (the daemon keeps running, with no server). */
  async disconnect(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((r) => { this.ws.once('close', () => r()); this.ws.close() })
  }

  /** A server comes back: a new socket to the same daemon (events keep accumulating in `events`). */
  async reconnect(): Promise<void> {
    await this.disconnect()
    this.ws = await connectDaemon(this.child, this.runDir, 'standalone')
    this.attach(this.ws)
  }

  static async start(twin: Twin, o: TriggerDaemonStart): Promise<TriggerDaemon> {
    if (!TRIGGER_BUN) throw new Error('the session daemon runs on bun, and there is none (BUN_PATH, BUN_INSTALL, ~/.bun/bin/bun)')
    const child = spawn(TRIGGER_BUN, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), o.mode], { cwd: o.cwd, env: o.env, detached: true, stdio: 'ignore' })
    children.push(child)
    const portFile = path.join(o.runDir, 'daemon.port')
    const pidFile = path.join(o.runDir, 'daemon.pid')
    // Its own pid in the pid file: a daemon killed before it left both files behind.
    await waitFor(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) === child.pid && fs.existsSync(portFile) ? true : undefined } catch { return undefined }
    }, 60_000, `the ${twin} daemon to serve`)
    return new TriggerDaemon(child, await connectDaemon(child, o.runDir, twin), o.runDir)
  }

  get pid(): number { return this.child.pid! }

  rpc(frame: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`rpc ${String(frame.cmd)} timed out`)) }, timeoutMs)
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id, ...frame }))
    })
  }

  /** One per (epoch, seq): a replay repeats both. */
  fires(id: string) { return [...new Map(this.events.filter((e) => e.ev === 'trigger.fired' && e.id === id).map((e) => [`${e.epoch}:${e.seq}`, e])).values()] }
  checks(id: string) { return this.events.filter((e) => e.ev === 'trigger.checked' && e.id === id) }

  /** Run now and wait for its outcome (the clock's own first run may be in flight). */
  async runOnce(id: string, home?: string): Promise<void> {
    for (;;) {
      const before = this.checks(id).length + this.fires(id).length
      const reply = await this.rpc({ cmd: 'triggers.run', triggerId: id, ...(home ? { home } : {}) })
      await waitFor(() => (this.checks(id).length + this.fires(id).length > before ? true : undefined), 20_000, `the ${id} check`)
      if (reply.started === true) return
    }
  }

  private async exited(): Promise<void> {
    await waitFor(() => (this.child.exitCode !== null || this.child.signalCode !== null ? true : undefined), 30_000, 'the daemon to exit')
  }

  /** A clean stop of the whole group (SIGTERM). */
  async stop(): Promise<void> {
    try { this.ws.close() } catch { /* already gone */ }
    process.kill(-this.pid, 'SIGTERM')
    await this.exited()
  }

  /**
   * The daemon dies on the spot (SIGKILL to its own pid, a crash or an OOM kill): it writes nothing
   * more, and what it spawned detached (a check, a CLI) lives on, as on a real host.
   */
  async kill(): Promise<void> {
    try { this.ws.close() } catch { /* already gone */ }
    process.kill(this.pid, 'SIGKILL')
    await this.exited()
  }
}
