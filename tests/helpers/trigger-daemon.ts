/**
 * A real session daemon twin, driven over its WebSocket as a Walnut server would, for the trigger
 * suites that stop and start daemons on the same dirs (a restart, a reboot, a replace by the other
 * twin): the standalone twin under bun, the source twin (getDaemonSource) under node with the
 * sidecars a deploy ships beside it, built by bun.
 *
 * MACHINE SAFETY: the caller passes temp dirs only; every daemon is spawned detached in its own
 * group, and `killTriggerDaemons` (call it in afterEach) signals only those groups.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from './source-twin.js'
import { testBun } from './bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
export const TRIGGER_BUN = process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH) ? process.env.BUN_PATH : testBun() ?? null
export type Twin = 'standalone' | 'source'
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Write the source twin and its sidecars into `bin` (scripts/build-daemon.sh ships the same files). */
export function buildSourceTwin(bin: string): void {
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
  const sidecars: Array<[string, string]> = [
    ['trigger-check-core', 'trigger-check-sidecar'],
    ...['task-dir-core', 'host-exec-core', 'daemon-cron-runtime', 'daemon-instance-lock'].map((n) => [n, n] as [string, string]),
  ]
  for (const [out, src] of sidecars) {
    const built = spawnSync(TRIGGER_BUN!, ['build', '--target=node', '--format=cjs', '--outfile', path.join(bin, `${out}.cjs`),
      path.join(ROOT, `src/providers/${src}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error(`sidecar ${src} build failed: ${built.stderr}`)
  }
}

export async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}`)
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
  /** Where buildSourceTwin wrote the source twin (the source twin only). */
  bin?: string
}

export class TriggerDaemon {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (reply: Record<string, unknown>) => void>()
  private constructor(readonly child: ChildProcess, private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
      const waiter = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (waiter) { this.waiters.delete(msg.id as number); waiter(msg) }
    })
  }

  static async start(twin: Twin, o: TriggerDaemonStart): Promise<TriggerDaemon> {
    const [cmd, args] = twin === 'standalone'
      ? [TRIGGER_BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), o.mode]]
      : [SOURCE_TWIN.file, [path.join(o.bin!, 'daemon.cjs'), o.mode]]
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, detached: true, stdio: 'ignore' })
    children.push(child)
    const portFile = path.join(o.runDir, 'daemon.port')
    const pidFile = path.join(o.runDir, 'daemon.pid')
    // Its own pid in the pid file: a daemon killed before it left both files behind.
    await waitFor(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) === child.pid && fs.existsSync(portFile) ? true : undefined } catch { return undefined }
    }, 60_000, `the ${twin} daemon to serve`)
    // The daemon writes daemon.pid before daemon.port, so the port file seen next to its pid can
    // still be the last daemon's (killed in the restart under test): a refused connect reads the
    // port again until this daemon's own one answers.
    const connect = (port: number) => new Promise<WebSocket | null>((res, rej) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`)
      s.on('open', () => res(s))
      s.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? res(null) : rej(err)))
    })
    const ws = await waitFor(() => fs.readFileSync(portFile, 'utf8').trim() || undefined, 10_000, 'its port').then(async (first) => {
      const by = Date.now() + 10_000
      for (let port = first; ; port = fs.readFileSync(portFile, 'utf8').trim() || port) {
        const s = await connect(parseInt(port, 10))
        if (s) return s
        if (Date.now() > by) throw new Error(`the ${twin} daemon refused its port ${port}`)
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the ${twin} daemon exited`)
        await sleep(50)
      }
    })
    return new TriggerDaemon(child, ws)
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
