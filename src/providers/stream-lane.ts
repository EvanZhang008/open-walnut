/**
 * The leader's stream lane to one host ('stream-lane-v1'): a second link to
 * the host's daemon, on its own SSH connection, that carries byte streams only
 * (lib/link-stream.ts). A copy of the search index or a page a browser loads
 * from the host server is megabytes; on a network that corrupts packets, one
 * bad MAC ends the SSH connection it rode. Here that is the lane's connection,
 * not the one every session on the host shares, and the lane dials again.
 *
 * Optional: while it is down (an old daemon, a login that needs a fresh
 * sign-in, a dial in progress), streams ride the session link as before.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket } from 'ws'
import { createStreamEndpoint, type StreamEndpoint, type StreamEndpointOptions, type StreamPeer } from '../lib/link-stream.js'
import { log } from '../logging/index.js'

/** What a forward that this side stopped says when it ends. */
export const STOPPED = 'stopped'

/** A local port that reaches the daemon's port on the host. */
export interface LaneForward {
  port: number
  /** Called once when the forward ends: why (ssh's last word), or STOPPED. */
  onExit(cb: (why: string) => void): void
  stop(): void
}

export interface StreamLaneOptions {
  hostKey: string
  /** Who this Walnut is, as its leader.configure described it to the daemon. */
  home: string
  walnutId: () => Promise<string>
  /** The daemon the session link reached; a lane that reaches another is not used. */
  daemonInstanceId: () => string | null
  /** Opens the forward (an SSH -L of its own; tests reach the daemon directly). */
  forward: () => Promise<LaneForward>
  accept: StreamEndpointOptions['accept']
  beatMs?: number
  /** First wait before a new dial; it doubles up to maxRetryMs. */
  retryMs?: number
  maxRetryMs?: number
}

const BEAT_MS = 15_000
/** Beats with no pong before the lane is taken for dead. */
const MISSED_BEATS = 3
const RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000
/** A lane up this long starts the wait over at its first step. */
const STEADY_MS = 60_000

export class StreamLane {
  private wanted = false
  private dialing = false
  private ws: WebSocket | null = null
  private fwd: LaneForward | null = null
  private endpoint: StreamEndpoint | null = null
  private upAt = 0
  private retryMs: number
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private heardAt = 0
  /** Bumped by every teardown, so a dial that finishes late installs nothing. */
  private gen = 0
  private _ready = false

  constructor(private readonly opts: StreamLaneOptions) {
    this.retryMs = opts.retryMs ?? RETRY_MS
  }

  get ready(): boolean { return this._ready }

  /** Keep the lane up (dialing again after a drop) until stop(). */
  start(): void {
    if (this.wanted) return
    this.wanted = true
    void this.dial()
  }

  stop(): void {
    this.wanted = false
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.teardown('the lane was closed')
  }

  open(to: StreamPeer, purpose?: string): Promise<Duplex> {
    if (!this._ready || !this.endpoint) return Promise.reject(new Error(`the stream lane to ${this.opts.hostKey} is not up`))
    return this.endpoint.open(to, purpose ? { purpose } : {})
  }

  private async dial(): Promise<void> {
    if (!this.wanted || this.dialing || this.ws) return
    this.dialing = true
    const gen = this.gen
    try {
      const fwd = await this.opts.forward()
      if (gen !== this.gen || !this.wanted) { fwd.stop(); return }
      this.fwd = fwd
      fwd.onExit((why) => {
        if (this.fwd === fwd) this.dropped(`its SSH connection ended (${why})`)
        // The socket often closes first; why the connection ended is still worth a line.
        else if (why !== STOPPED) log.session.warn('stream lane: its SSH connection ended', { host: this.opts.hostKey, why })
      })
      await this.connect(fwd.port, gen)
    } catch (err) {
      if (gen === this.gen) this.dropped(err instanceof Error ? err.message : String(err))
    } finally {
      this.dialing = false
    }
  }

  private connect(port: number, gen: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 10_000 })
      this.ws = ws
      const endpoint = createStreamEndpoint({
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error(`the stream lane to ${this.opts.hostKey} is down`)
          ws.send(JSON.stringify(frame))
        },
        accept: this.opts.accept,
      })
      this.endpoint = endpoint
      const pending = new Map<number, (msg: Record<string, unknown>) => void>()
      const ask = (id: number, frame: Record<string, unknown>) => new Promise<Record<string, unknown>>((res, rej) => {
        const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${String(frame.cmd)}: no answer in 10s`)) }, 10_000)
        pending.set(id, (msg) => { clearTimeout(timer); res(msg) })
        ws.send(JSON.stringify({ id, ...frame }))
      })
      ws.on('message', (data) => {
        this.heardAt = Date.now()
        let msg: Record<string, unknown>
        try { msg = JSON.parse(data.toString()) as Record<string, unknown> } catch { return }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const done = pending.get(msg.id)!
          pending.delete(msg.id)
          done(msg)
          return
        }
        endpoint.handle(msg)
      })
      ws.on('pong', () => { this.heardAt = Date.now() })
      ws.on('error', () => { /* close follows */ })
      ws.on('close', () => {
        reject(new Error('the daemon closed the lane'))
        if (this.ws === ws) this.dropped('the daemon closed it')
      })
      ws.on('open', () => {
        void (async () => {
          const hello = await ask(1, { cmd: 'hello' })
          const expected = this.opts.daemonInstanceId()
          if (hello.ok !== true) throw new Error(`hello failed: ${String(hello.error ?? '')}`)
          if (expected && typeof hello.instanceId === 'string' && hello.instanceId !== expected) {
            throw new Error('it reached another daemon than the session link')
          }
          const lane = await ask(2, { cmd: 'stream.lane', home: this.opts.home, walnutId: await this.opts.walnutId() })
          if (lane.ok !== true) throw new Error(`the daemon refused it: ${String(lane.error ?? '')}`)
          if (gen !== this.gen || this.ws !== ws) return
          this._ready = true
          this.upAt = Date.now()
          this.heardAt = this.upAt
          this.startBeat(ws)
          log.session.info('stream lane: up', { host: this.opts.hostKey, port })
          resolve()
        })().catch((err: Error) => {
          try { ws.terminate() } catch { /* gone */ }
          reject(err)
        })
      })
    })
  }

  private startBeat(ws: WebSocket): void {
    const beat = this.opts.beatMs ?? BEAT_MS
    this.beatTimer = setInterval(() => {
      if (Date.now() - this.heardAt > beat * MISSED_BEATS) {
        this.dropped(`no answer for ${MISSED_BEATS} beats`)
        return
      }
      try { ws.ping() } catch { /* close follows */ }
    }, beat)
    this.beatTimer.unref?.()
  }

  private teardown(reason: string): void {
    this.gen += 1
    this._ready = false
    if (this.beatTimer) { clearInterval(this.beatTimer); this.beatTimer = null }
    this.endpoint?.closeAll(reason)
    this.endpoint = null
    const ws = this.ws
    this.ws = null
    if (ws) { try { ws.terminate() } catch { /* gone */ } }
    const fwd = this.fwd
    this.fwd = null
    fwd?.stop()
  }

  private dropped(why: string): void {
    const wasUp = this._ready
    const steady = wasUp && Date.now() - this.upAt >= STEADY_MS
    this.teardown(`the stream lane to ${this.opts.hostKey} closed`)
    if (!this.wanted || this.retryTimer) return
    if (steady) this.retryMs = this.opts.retryMs ?? RETRY_MS
    const wait = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, this.opts.maxRetryMs ?? MAX_RETRY_MS)
    log.session.warn(wasUp ? 'stream lane: dropped, dialing again' : 'stream lane: dial failed, trying again', { host: this.opts.hostKey, why, waitMs: wait })
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.dial() }, wait)
    this.retryTimer.unref?.()
  }
}

let forwardForTesting: ((hostKey: string) => Promise<LaneForward>) | null = null

/** Tests reach the daemon without SSH; null restores the SSH forward. */
export function _setLaneForwardForTesting(fn: ((hostKey: string) => Promise<LaneForward>) | null): void {
  forwardForTesting = fn
}

export function laneForwardForTesting(): ((hostKey: string) => Promise<LaneForward>) | null {
  return forwardForTesting
}

/** A free local port (closed again: ssh binds it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function accepting(port: number, timeoutMs: number, exited: () => boolean): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until && !exited()) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true) })
      sock.on('error', () => { sock.destroy(); resolve(false) })
      sock.setTimeout(500, () => { sock.destroy(); resolve(false) })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * The lane's own SSH forward to the daemon's port: never through the session
 * connection's ControlMaster (`ControlMaster=no`, `ControlPath=none` come
 * before anything a config file says). Its remote command reads stdin, so the
 * forward ends with the server that holds the pipe, also one that crashed.
 */
export async function sshLaneForward(sshArgs: string[], sshHost: string, remotePort: number): Promise<LaneForward> {
  const port = await freePort()
  const args = [
    // A RemoteCommand in a config file would refuse the command below.
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RemoteCommand=none',
    ...sshArgs,
    '-T',
    '-L', `${port}:127.0.0.1:${remotePort}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    sshHost,
    'exec cat >/dev/null',
  ]
  const proc: ChildProcess = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  // Drained: an unread pipe fills and ssh blocks.
  proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2_000) })
  proc.stdin?.on('error', () => { /* ssh is gone; exit follows */ })
  let exited: string | null = null
  const exitCbs: Array<(why: string) => void> = []
  let stopping = false
  proc.on('exit', (code, signal) => {
    // What ssh said wins: a connection a bad packet ended may close its socket before ssh exits.
    const said = stderr.trim().split('\n').filter((l) => !/^Killed by signal/.test(l)).pop()
    exited = said ? `${signal ?? `code ${code}`}: ${said}` : stopping ? STOPPED : `${signal ?? `code ${code}`}`
    for (const cb of exitCbs.splice(0)) cb(exited)
  })
  proc.on('error', (err) => {
    exited = err.message
    for (const cb of exitCbs.splice(0)) cb(exited)
  })
  const stop = () => { if (exited === null) { stopping = true; try { proc.kill('SIGTERM') } catch { /* gone */ } } }
  if (!(await accepting(port, 10_000, () => exited !== null))) {
    stop()
    throw new Error(`its SSH forward did not open${exited ? ` (${exited})` : stderr.trim() ? ` (${stderr.trim().split('\n').pop()})` : ''}`)
  }
  // From here on, what ssh says is about the connection (not a known-hosts note from the login).
  stderr = ''
  return {
    port,
    onExit: (cb) => { if (exited !== null) cb(exited); else exitCbs.push(cb) },
    stop,
  }
}
