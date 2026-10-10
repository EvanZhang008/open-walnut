/**
 * The host server's one link: to its host's daemon, as a follower
 * (docs/plan/walnut-servers-everywhere.md, "One kind of link").
 *
 * It finds the daemon through its port file, says `follower.hello` with the
 * token the daemon started it with, and asks `follower.status` every few
 * seconds: who leads (the leader book's holder and epoch), whether the primary
 * was heard, whether the companion is linked, and the settings the Mac gave
 * this server. It keeps no view of its own beyond the last answer. Everything
 * else rides the same socket: byte streams to the Mac or the companion
 * (`openStream`, lib/link-stream.ts), streams the Mac opens to this server
 * (`accept`), and the report the Mac reads through the daemon (`report`).
 * A lost daemon (an upgrade restarts it) is dialled again, with backoff.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import WebSocket from 'ws'
import { createStreamEndpoint, type IncomingStreamInfo, type StreamEndpoint } from '../lib/link-stream.js'

export interface FollowerView {
  walnutId: string
  home: string
  epoch: number
  holder: 'primary' | 'backup'
  backup: boolean
  primaryConnected: boolean
  primaryHeardAgoMs: number
  takeoverMs: number
  bridge: { connected: boolean; companion: string | null }
  /** What the Mac set for this server (its tunnel); changes need no restart. */
  settings: Record<string, unknown>
}

export type DaemonLinkState = 'connecting' | 'following' | 'unknown-walnut' | 'not-started-here' | 'no-daemon'

export interface DaemonLinkOptions {
  daemonDir: string
  walnutId: string
  home: string
  token: string
  /** What an incoming stream (the Mac's) is plugged into; null refuses it. */
  accept?: (info: IncomingStreamInfo) => ((stream: Duplex) => void) | null
  /** Each fresh answer of follower.status. */
  onView?: (view: FollowerView) => void
  /** How long an open waits for the other server to accept. */
  openTimeoutMs?: number
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  /** How often follower.status is asked. */
  pollMs?: number
  now?: () => number
}

export interface DaemonLink {
  start(): void
  stop(): void
  state(): DaemonLinkState
  /** The last answer, and when it came. */
  view(): { view: FollowerView; at: number } | null
  lastError(): string | null
  /** A byte stream to the Mac or the companion, through the daemon. */
  openStream(to: 'primary' | 'companion', purpose?: string): Promise<Duplex>
  /** Tell the daemon how this server is (the Mac reads it with server.status). */
  report(body: Record<string, unknown>): void
}

const CALL_TIMEOUT_MS = 5_000
const MAX_REDIAL_MS = 30_000

export function createDaemonLink(opts: DaemonLinkOptions): DaemonLink {
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 3_000
  let ws: WebSocket | null = null
  let state: DaemonLinkState = 'connecting'
  let last: { view: FollowerView; at: number } | null = null
  let error: string | null = null
  let stopped = false
  let redialMs = 1_000
  let redialTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let nextId = 1
  const pending = new Map<number, (m: Record<string, unknown>) => void>()
  /** The streams on the socket in use; a new socket gets a new endpoint. */
  let streams: StreamEndpoint | null = null

  function setState(next: DaemonLinkState, why?: string): void {
    if (why !== undefined) error = why
    if (next === state) return
    state = next
    opts.log(next === 'following' ? 'info' : 'warn', 'host server: daemon link', { state: next, ...(why ? { why } : {}) })
  }

  function call(socket: WebSocket, cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${cmd} timed out`)) }, CALL_TIMEOUT_MS)
      pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
      try {
        socket.send(JSON.stringify({ id, cmd, ...params }))
      } catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        reject(err)
      }
    })
  }

  function take(m: Record<string, unknown>): void {
    const v = m as unknown as FollowerView & { ok?: boolean }
    if (m.ok !== true || typeof v.walnutId !== 'string') return
    last = {
      at: now(),
      view: {
        walnutId: v.walnutId, home: v.home, epoch: Number(v.epoch) || 0,
        holder: v.holder === 'backup' ? 'backup' : 'primary', backup: v.backup === true,
        primaryConnected: v.primaryConnected === true, primaryHeardAgoMs: Number(v.primaryHeardAgoMs) || 0,
        takeoverMs: Number(v.takeoverMs) || 0,
        bridge: { connected: v.bridge?.connected === true, companion: typeof v.bridge?.companion === 'string' ? v.bridge.companion : null },
        settings: v.settings && typeof v.settings === 'object' && !Array.isArray(v.settings) ? v.settings : {},
      },
    }
    try { opts.onView?.(last.view) } catch { /* a listener never breaks the link */ }
  }

  function scheduleRedial(): void {
    if (stopped || redialTimer) return
    redialTimer = setTimeout(() => { redialTimer = null; dial() }, redialMs)
    redialTimer.unref?.()
    redialMs = Math.min(MAX_REDIAL_MS, redialMs * 2)
  }

  function drop(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    for (const resolve of pending.values()) resolve({ ok: false, error: 'closed' })
    pending.clear()
    streams?.closeAll('the link to the daemon closed')
    streams = null
    const old = ws
    ws = null
    if (old) { try { old.terminate() } catch { /* closed */ } }
  }

  function dial(): void {
    if (stopped) return
    drop()
    let port: number
    try {
      port = Number(fs.readFileSync(path.join(opts.daemonDir, 'daemon.port'), 'utf8').trim())
      if (!Number.isInteger(port) || port <= 0) throw new Error('no port in daemon.port')
    } catch (err) {
      setState('no-daemon', `the daemon is not running here (${err instanceof Error ? err.message : String(err)})`)
      scheduleRedial()
      return
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    ws = socket
    const endpoint = createStreamEndpoint({
      send: (frame) => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('the link to the daemon is down')
        socket.send(JSON.stringify(frame))
      },
      accept: opts.accept,
      openTimeoutMs: opts.openTimeoutMs,
    })
    streams = endpoint
    socket.on('message', (data) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(String(data)) } catch { return }
      if (endpoint.handle(m)) return
      const resolve = typeof m.id === 'number' ? pending.get(m.id) : undefined
      if (resolve) { pending.delete(m.id as number); resolve(m) }
    })
    socket.on('error', () => { /* close follows */ })
    socket.on('close', () => {
      if (ws !== socket) return
      drop()
      if (!stopped) {
        setState('no-daemon', 'the link to the daemon closed')
        scheduleRedial()
      }
    })
    socket.on('open', () => {
      void (async () => {
        const hello: Record<string, unknown> = await call(socket, 'follower.hello', { walnutId: opts.walnutId, home: opts.home, token: opts.token })
          .catch((err: Error) => ({ ok: false, error: err.message }))
        if (ws !== socket) return
        if (hello.ok !== true) {
          // The leader has not described its Walnut to this daemon yet (it does on connect).
          setState(
            hello.errorKind === 'unknown_walnut' ? 'unknown-walnut' : hello.errorKind === 'not_started_here' ? 'not-started-here' : 'no-daemon',
            String(hello.error ?? 'follower.hello failed'),
          )
          drop()
          scheduleRedial()
          return
        }
        redialMs = 1_000
        take(hello)
        setState('following', '')
        error = null
        pollTimer = setInterval(() => {
          void call(socket, 'follower.status').then(take, () => { /* the next poll, or the close, says more */ })
        }, pollMs)
        pollTimer.unref?.()
      })()
    })
  }

  return {
    start: () => { stopped = false; dial() },
    stop: () => {
      stopped = true
      if (redialTimer) { clearTimeout(redialTimer); redialTimer = null }
      drop()
    },
    state: () => state,
    view: () => last,
    lastError: () => error,
    openStream: (to, purpose) => {
      if (state !== 'following' || !streams) return Promise.reject(new Error('not linked to the daemon'))
      return streams.open(to, purpose ? { purpose } : {})
    },
    report: (body) => {
      if (state !== 'following' || !ws || ws.readyState !== WebSocket.OPEN) return
      try { ws.send(JSON.stringify({ cmd: 'follower.report', report: body })) } catch { /* the next one */ }
    },
  }
}
