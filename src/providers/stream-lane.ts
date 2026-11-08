/**
 * The leader's stream lane to one host ('stream-lane-v1'): a second link to
 * the host's daemon, on its own SSH connection, that carries byte streams only
 * (lib/link-stream.ts). A copy of the search index or a page a browser loads
 * from the host server is megabytes; on a network that corrupts packets, one
 * bad MAC ends the SSH connection it rode. Here that is the lane's connection,
 * not the one every session on the host shares, and the lane dials again at
 * once. Streams wait for it while it does (waitReady, and the daemon holds a
 * follower's open for a moment), so their bytes stay off the session link.
 *
 * Optional: when it cannot come up (an old daemon, a login that needs a fresh
 * sign-in), streams ride the session link as before.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket } from '#ws'
import { createStreamEndpoint, type StreamEndpoint, type StreamEndpointOptions, type StreamPeer } from '../lib/link-stream.js'
import { log } from '../logging/index.js'
import { createUploadPacer, type UploadPacer } from '../lib/upload-pacer.js'
import { PACED_STREAM_PURPOSES, RELAY_UPLOAD_BURST_BYTES, RELAY_UPLOAD_BYTES_PER_SEC } from './ssh-upload-budget.js'
import { exitControlMaster, MASTER_CONTROL_TIMEOUT_MS, MAX_SOCKET_PATH, masterLogFile, ownedMuxClientArgs, startControlMaster, type SshRunner } from './ssh-control-master.js'

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
  /** First wait before a new dial after one failed; it doubles up to maxRetryMs. */
  retryMs?: number
  maxRetryMs?: number
  /** Wait before dialing again after a lane that was up dropped. */
  redialMs?: number
  /** The pace of a background stream's upload (ssh-upload-budget.ts); tests set their own. */
  pace?: { bytesPerSec: number; burstBytes: number } | null
}

const BEAT_MS = 15_000
/** Beats with no pong before the lane is taken for dead. */
const MISSED_BEATS = 3
const RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000
/**
 * A lane that was up and dropped is dialed again at once: on a network that
 * corrupts packets a bulk stream ends its connection every few megabytes, and
 * the streams wait for the lane meanwhile (waitReady).
 */
const REDIAL_MS = 300

export class StreamLane {
  private wanted = false
  private dialing = false
  private ws: WebSocket | null = null
  private fwd: LaneForward | null = null
  private endpoint: StreamEndpoint | null = null
  private retryMs: number
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private heardAt = 0
  /** Bumped by every teardown, so a dial that finishes late installs nothing. */
  private gen = 0
  private _ready = false
  /** The last dial did not come up: streams do not wait for this lane. */
  private failing = false
  private waiters: Array<(up: boolean) => void> = []
  /** This connection's pacer for background streams; a new one per connection. */
  private pacer: UploadPacer | null = null
  /** Frame bytes this connection's streams sent, by purpose; logged when it drops. */
  private sentByPurpose = new Map<string, number>()
  private upAt = 0

  constructor(private readonly opts: StreamLaneOptions) {
    this.retryMs = opts.retryMs ?? RETRY_MS
  }

  get ready(): boolean { return this._ready }

  /**
   * True once the lane is up, within `ms`. False at once when its last dial
   * failed (a login that needs a fresh sign-in, say) or it is stopped: the
   * caller then uses the session link.
   */
  waitReady(ms: number): Promise<boolean> {
    if (this._ready) return Promise.resolve(true)
    if (this.failing || !this.wanted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (up: boolean) => { clearTimeout(timer); this.waiters = this.waiters.filter((w) => w !== done); resolve(up) }
      const timer = setTimeout(() => done(false), ms)
      timer.unref?.()
      this.waiters.push(done)
    })
  }

  private settle(up: boolean): void {
    for (const w of this.waiters.slice()) w(up)
  }

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
    this.settle(false)
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
      const paceOpts = this.opts.pace === undefined
        ? { bytesPerSec: RELAY_UPLOAD_BYTES_PER_SEC, burstBytes: RELAY_UPLOAD_BURST_BYTES } : this.opts.pace
      const pacer = paceOpts ? createUploadPacer(paceOpts) : null
      this.pacer = pacer
      this.sentByPurpose = new Map()
      const sentByPurpose = this.sentByPurpose
      const endpoint = createStreamEndpoint({
        send: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error(`the stream lane to ${this.opts.hostKey} is down`)
          ws.send(JSON.stringify(frame))
        },
        accept: this.opts.accept,
        // A background stream's upload is paced: a relay ends a connection that bursts (ssh-upload-budget.ts).
        pace: (purpose) => (pacer && PACED_STREAM_PURPOSES.has(purpose) ? pacer : null),
        sent: (purpose, bytes) => { sentByPurpose.set(purpose || 'none', (sentByPurpose.get(purpose || 'none') ?? 0) + bytes) },
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
          this.failing = false
          this.retryMs = this.opts.retryMs ?? RETRY_MS
          this.heardAt = Date.now()
          this.startBeat(ws)
          this.upAt = Date.now()
          log.session.info('stream lane: up', { host: this.opts.hostKey, port })
          this.settle(true)
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
    this.pacer?.drop(reason)
    this.pacer = null
    const fwd = this.fwd
    this.fwd = null
    fwd?.stop()
  }

  private dropped(why: string): void {
    const wasUp = this._ready
    this.teardown(`the stream lane to ${this.opts.hostKey} closed`)
    if (!wasUp) {
      // A dial that did not come up: nobody waits for this lane until one does.
      this.failing = true
      this.settle(false)
    }
    if (!this.wanted || this.retryTimer) return
    let wait = this.opts.redialMs ?? REDIAL_MS
    if (!wasUp) {
      wait = this.retryMs
      this.retryMs = Math.min(this.retryMs * 2, this.opts.maxRetryMs ?? MAX_RETRY_MS)
    }
    log.session.warn(wasUp ? 'stream lane: dropped, dialing again' : 'stream lane: dial failed, trying again', {
      host: this.opts.hostKey, why, waitMs: wait,
      ...(wasUp ? laneUploadSummary(this.sentByPurpose, this.upAt, Date.now()) : {}),
    })
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.dial() }, wait)
    this.retryTimer.unref?.()
  }
}

/** What a lane that dropped had sent up, by stream purpose, for its log line. */
export function laneUploadSummary(sent: ReadonlyMap<string, number>, upAt: number, now: number): Record<string, unknown> {
  const kb: Record<string, number> = {}
  let total = 0
  for (const [purpose, bytes] of sent) { kb[purpose] = Math.round(bytes / 1024); total += bytes }
  return { lifeS: upAt ? Math.round((now - upAt) / 1000) : null, sentKB: Math.round(total / 1024), sentKBByPurpose: kb }
}

let forwardForTesting: ((hostKey: string) => Promise<LaneForward>) | null = null

/** Tests reach the daemon without SSH; null restores the SSH forward. */
export function _setLaneForwardForTesting(fn: ((hostKey: string) => Promise<LaneForward>) | null): void {
  forwardForTesting = fn
}

export function laneForwardForTesting(): ((hostKey: string) => Promise<LaneForward>) | null {
  return forwardForTesting
}

let bulkForwardForTesting: ((hostKey: string) => Promise<LaneForward>) | null = null

/** Tests give a host's bulk channel a forward of its own without SSH; null restores the SSH forward. */
export function _setBulkForwardForTesting(fn: ((hostKey: string) => Promise<LaneForward>) | null): void {
  bulkForwardForTesting = fn
}

export function bulkForwardHook(): ((hostKey: string) => Promise<LaneForward>) | null {
  return bulkForwardForTesting
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

/** How long an alias lane's own master outlives its last client: a crashed server's lane master ends by itself. */
export const LANE_MASTER_PERSIST_SECS = 30

export interface LaneForwardDeps {
  spawn?: (cmd: string, args: string[], opts: { stdio: ['pipe', 'ignore', 'pipe'] }) => ChildProcess
  run?: SshRunner
  freePort?: () => Promise<number>
  accepting?: (port: number, timeoutMs: number, exited: () => boolean) => Promise<boolean>
  makeDir?: () => string
  stopWaitMs?: number
}

/** A fresh owner-only dir for an alias lane's socket, short enough for MAX_SOCKET_PATH. */
function makeLaneDir(): string {
  for (const base of [os.tmpdir(), '/tmp']) {
    if (path.join(base, 'wl-XXXXXX', 'm').length <= MAX_SOCKET_PATH) return fs.mkdtempSync(path.join(base, 'wl-'))
  }
  throw new Error('no temp dir short enough for an SSH control socket')
}

/** Only once its socket is gone: remove this lane's log and its empty dir. A socket still there keeps them all. */
function removeOwnLaneFiles(dir: string, socket: string): void {
  try { fs.lstatSync(socket); return } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return }
  try { if (fs.lstatSync(masterLogFile(socket)).isFile()) fs.unlinkSync(masterLogFile(socket)) } catch { /* not there */ }
  try { fs.rmdirSync(dir) } catch { /* not empty or gone: left as it is */ }
}

/** An alias lane's own master: its own TCP, alias auth with no config forwards. `end` only sends it `-O exit`. */
async function startLaneMaster(sshArgs: string[], sshHost: string, hostname: string, deps: LaneForwardDeps): Promise<{ socket: string; end: () => Promise<void> }> {
  const dir = (deps.makeDir ?? makeLaneDir)()
  const socket = path.join(dir, 'm')
  let ended: Promise<void> | null = null
  const end = () => (ended ??= Promise.resolve()
    .then(() => exitControlMaster(socket, ownedMuxClientArgs(socket), hostname, { run: deps.run }))
    .catch(() => undefined).then(() => removeOwnLaneFiles(dir, socket)))
  // A socket already there is not this lane's: never reused, never removed.
  if (socket.length > MAX_SOCKET_PATH || fs.existsSync(socket)) throw new Error('its SSH master socket path is not usable')
  try {
    await startControlMaster(socket, sshArgs, sshHost, { run: deps.run, persistSecs: LANE_MASTER_PERSIST_SECS })
  } catch (err) {
    await end()
    throw err
  }
  return { socket, end }
}

/**
 * The lane's own SSH forward to the daemon's port: never through the session
 * connection's ControlMaster (`ControlMaster=no`, `ControlPath=none` come
 * before anything a config file says). Its remote command reads stdin, so the
 * forward ends with the server that holds the pipe, also one that crashed.
 * A host from ~/.ssh/config (`ownMaster`) gets a master of the lane's own, and its client is mux-only.
 */
export async function sshLaneForward(
  sshArgs: string[], sshHost: string, remotePort: number,
  opts: { ownMaster?: { hostname: string }; deps?: LaneForwardDeps } = {},
): Promise<LaneForward> {
  const deps = opts.deps ?? {}
  const port = await (deps.freePort ?? freePort)()
  const owned = opts.ownMaster ? await startLaneMaster(sshArgs, sshHost, opts.ownMaster.hostname, deps) : null
  const args = owned
    ? [
      ...ownedMuxClientArgs(owned.socket),
      '-T',
      '-L', `${port}:127.0.0.1:${remotePort}`,
      '-o', 'ExitOnForwardFailure=yes',
      opts.ownMaster!.hostname,
      'exec cat >/dev/null',
    ]
    : [
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
  let proc: ChildProcess
  try {
    proc = deps.spawn ? deps.spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] }) : spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] })
  } catch (err) {
    await owned?.end()
    throw err
  }
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
    const lost = owned && !stopping && !fs.existsSync(owned.socket) ? 'SSH master lost: ' : ''
    exited = stopping ? STOPPED : said ? `${lost}${signal ?? `code ${code}`}: ${said}` : `${lost}${signal ?? `code ${code}`}`
    void owned?.end()
    for (const cb of exitCbs.splice(0)) cb(exited)
  })
  proc.on('error', (err) => {
    exited = err.message
    void owned?.end()
    for (const cb of exitCbs.splice(0)) cb(exited)
  })
  // An alias lane first asks its own master to exit (bounded); only a client of ours still alive after it gets SIGTERM.
  let stopped: Promise<void> | null = null
  const stopOnce = (): Promise<void> => (stopped ??= (async () => {
    if (exited !== null) return
    stopping = true
    if (owned) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([owned.end(), new Promise<void>((r) => { timer = setTimeout(r, deps.stopWaitMs ?? MASTER_CONTROL_TIMEOUT_MS + 1_000) })])
      clearTimeout(timer)
      if (exited !== null || proc.exitCode !== null) return
    }
    try { proc.kill('SIGTERM') } catch { /* gone */ }
  })())
  const stop = () => { void stopOnce() }
  let ready = false
  try {
    ready = await (deps.accepting ?? accepting)(port, 10_000, () => exited !== null)
  } catch (err) {
    await stopOnce()
    throw err
  }
  if (!ready) {
    await stopOnce()
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
