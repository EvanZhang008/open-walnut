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
import WebSocket from '#ws'
import { createStreamEndpoint, type IncomingStreamInfo, type StreamEndpoint } from '../lib/link-stream.js'
import { assertFrameFits } from '../providers/daemon-frame-cap.js'
import { DRAIN_SWAP_WINDOW_MS, resendThroughSwap, waitHostLink, wakeHostLink } from '../providers/daemon-drain-resend.js'

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
  /** The daemon's one quiet window (LEADER_QUIET_MS), when it says it (replica-host-v1). */
  quietMs?: number
  /** This home's journal records the current leader's drain can take (a drain still to run). */
  drainablePending?: number
  /**
   * The calls the daemon answered with its own away code while this server was linked to answer
   * them (follower-gateway-core.ts ownAnswers): the count task B drives to zero.
   */
  offlineAnswers?: { total: number; byOp: Record<string, number>; byWhy: Record<string, number> }
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
  /**
   * Said at follower.hello: this server answers the host's `walnut` calls while its leader is
   * away ('follower-gateway-v1'). The daemon then sends their `gateway-request` events here.
   */
  answersLocal?: boolean
  /**
   * Said at follower.hello: this server picks the session for this host's unclaimed trigger
   * fires while its leader is away ('follower-trigger-delivery-v1'): `trigger-delivery` events.
   */
  deliversTriggers?: boolean
  /**
   * Said at follower.hello: this server also takes a same-host message while its leader answers
   * ('follower-peer-v1', replica/away-sends.ts), in place of the daemon's own handleLocal. Read at
   * each hello (an experiment's switch: front.ts says it again in each report).
   */
  answersOnline?: () => boolean
  /** More of follower.hello, read at each hello (the host call entry's address, host-call-entry.ts). */
  helloExtra?: () => Record<string, unknown>
  /** A daemon event on the link (`{ev, ...}`, never an answer): a `gateway-request`, say. */
  onEvent?: (event: Record<string, unknown>) => void
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
  /** A command on the link (what a follower may send); the daemon's answer as it came. */
  request(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /** When the last frame from the daemon arrived (frames, never the socket's state), or null. */
  lastFrameAt(): number | null
  /** What the daemon advertised in its `hello` (asked once each link is following), or null before the first answer. */
  capabilities(): readonly string[] | null
}

const CALL_TIMEOUT_MS = 5_000
/** The keys of a command frame (`{ id, cmd, ...params }`): no parameter may take one. */
export const FRAME_KEYS = ['id', 'cmd'] as const

/**
 * A request that never left this server (no link, or the socket refused the
 * frame): the daemon cannot have acted on it. A timeout or a `closed` answer
 * carries no mark, because those frames were written.
 */
export function notSent(err: Error): Error & { notSent: true } {
  return Object.assign(err, { notSent: true as const })
}

/** Whether a request's failure proves the frame never reached the daemon. */
export function wasNotSent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { notSent?: unknown }).notSent === true
}
const MAX_REDIAL_MS = 30_000

let linkSeq = 0

/** A request whose link closed under it (drop answers it `closed`), carried to the resend loop. */
class LinkClosed extends Error {
  constructor(readonly reply: Record<string, unknown>) { super('the link to the daemon closed') }
}

/**
 * The checks a command takes before it goes to its daemon, on this socket link or the direct link of
 * a host's one Walnut service (core/link/follower-link-direct.ts): no parameter named like a frame
 * key (it would re-address the command, and its answer would never come back), and a frame under
 * the cap. Returns the frame's text; a refusal is marked notSent.
 */
export function preflightFrame(cmd: string, params: Record<string, unknown>, id: number): string {
  try {
    const clash = FRAME_KEYS.find((k) => k in params)
    if (clash) throw new Error(`the ${cmd} command has a parameter named "${clash}", which is a frame key; rename it`)
    const message = JSON.stringify({ id, cmd, ...params })
    assertFrameFits(message, `the ${cmd} command`, 'its daemon')
    return message
  } catch (err) { throw notSent(err instanceof Error ? err : new Error(String(err))) }
}

/**
 * A daemon swap is invisible to a follower link's callers, on either link: a refusal of the draining
 * daemon (daemon-drain-resend.ts), or a request the swap left with no link, is sent again once the
 * daemon answers again, inside the caller's own timeout. `once` sends on the link as it is (throws
 * notSent with no link; answers `{ ok:false, error:'closed' }` when the link closed under it);
 * `linked` says the link is up; `answered()` is the link's edge of a daemon answering again.
 */
export function swapResender(now: () => number, linked: () => boolean): {
  request(cmd: string, once: (budget: number) => Promise<Record<string, unknown>>, timeoutMs: number): Promise<Record<string, unknown>>
  answered(): void
} {
  const key = `host-server-link:${++linkSeq}`
  let drainSeenAt = 0
  return {
    request: (cmd, once, timeoutMs) => resendThroughSwap(cmd, {
      once: async (budget) => {
        const reply = await once(budget)
        if (reply.ok === false && reply.error === 'closed') throw new LinkClosed(reply)
        return reply
      },
      failure: (err) => (wasNotSent(err) ? 'no-link' : err instanceof LinkClosed ? 'lost' : null),
      swapUnderway: () => now() - drainSeenAt < DRAIN_SWAP_WINDOW_MS,
      noteRefusal: () => { drainSeenAt = now() },
      waitLink: (ms, fresh) => waitHostLink(key, ms, fresh ? () => false : linked),
    }, timeoutMs).catch((err) => {
      if (err instanceof LinkClosed) return err.reply
      throw err
    }),
    answered: () => { drainSeenAt = 0; wakeHostLink(key) },
  }
}

/** A view's `offlineAnswers`, kept only when it has the shape the daemon sends. */
function offlineAnswersOf(raw: unknown): Pick<FollowerView, 'offlineAnswers'> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as { total?: unknown; byOp?: unknown; byWhy?: unknown }
  const counts = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {}
    if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
    return out
  }
  return typeof r.total === 'number' && Number.isFinite(r.total) ? { offlineAnswers: { total: r.total, byOp: counts(r.byOp), byWhy: counts(r.byWhy) } } : {}
}

/**
 * A follower.hello / follower.status answer as the view the follower keeps, or null when it is no
 * answer of a known Walnut. The direct link (core/link/follower-link.ts) reads the daemon's own
 * `entry.view(home)` through the same function, so both links hand over one shape.
 */
export function followerViewOf(m: Record<string, unknown>): FollowerView | null {
  const v = m as unknown as FollowerView
  if (typeof v.walnutId !== 'string') return null
  const journal = (m as { journal?: { drainable?: unknown } }).journal
  const drainable = Number(m.drainablePending ?? journal?.drainable)
  return {
    walnutId: v.walnutId, home: v.home, epoch: Number(v.epoch) || 0,
    holder: v.holder === 'backup' ? 'backup' : 'primary', backup: v.backup === true,
    primaryConnected: v.primaryConnected === true, primaryHeardAgoMs: Number(v.primaryHeardAgoMs) || 0,
    takeoverMs: Number(v.takeoverMs) || 0,
    bridge: { connected: v.bridge?.connected === true, companion: typeof v.bridge?.companion === 'string' ? v.bridge.companion : null },
    settings: v.settings && typeof v.settings === 'object' && !Array.isArray(v.settings) ? v.settings : {},
    ...(Number(v.quietMs) > 0 ? { quietMs: Number(v.quietMs) } : {}),
    ...(Number.isFinite(drainable) && drainable > 0 ? { drainablePending: drainable } : {}),
    ...offlineAnswersOf((m as { offlineAnswers?: unknown }).offlineAnswers),
  }
}

export function createDaemonLink(opts: DaemonLinkOptions): DaemonLink {
  const now = opts.now ?? Date.now
  const linked = () => state === 'following' && !!ws && ws.readyState === WebSocket.OPEN
  const swaps = swapResender(now, linked)
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
  let frameAt: number | null = null
  // Kept across a redial: a link blip is no downgrade, the next hello says.
  let caps: readonly string[] | null = null
  const helloExtra = (): Record<string, unknown> => {
    try { return opts.helloExtra?.() ?? {} } catch { return {} }
  }

  function setState(next: DaemonLinkState, why?: string): void {
    if (why !== undefined) error = why
    if (next === state) return
    state = next
    opts.log(next === 'following' ? 'info' : 'warn', 'host server: daemon link', { state: next, ...(why ? { why } : {}) })
  }

  function call(socket: WebSocket, cmd: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${cmd} timed out`)) }, timeoutMs)
      pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
      try {
        socket.send(preflightFrame(cmd, params, id))
      } catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        reject(notSent(err instanceof Error ? err : new Error(String(err))))
      }
    })
  }

  function take(m: Record<string, unknown>): void {
    const view = m.ok === true ? followerViewOf(m) : null
    if (!view) return
    last = { at: now(), view }
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
      frameAt = now()
      let m: Record<string, unknown>
      try { m = JSON.parse(String(data)) } catch { return }
      if (endpoint.handle(m)) return
      const resolve = typeof m.id === 'number' ? pending.get(m.id) : undefined
      if (resolve) { pending.delete(m.id as number); resolve(m); return }
      if (typeof m.ev === 'string' && opts.onEvent) {
        try { opts.onEvent(m) } catch { /* a listener never breaks the link */ }
      }
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
        const hello: Record<string, unknown> = await call(socket, 'follower.hello', { ...helloExtra(), walnutId: opts.walnutId, home: opts.home, token: opts.token, ...(opts.answersLocal ? { answersLocal: true } : {}), ...(opts.deliversTriggers ? { deliversTriggers: true } : {}), ...(opts.answersOnline?.() ? { answersOnline: true } : {}) })
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
        // A daemon answers again: requests waiting out a swap go to it (daemon-drain-resend.ts).
        swaps.answered()
        error = null
        pollTimer = setInterval(() => {
          void call(socket, 'follower.status').then(take, () => { /* the next poll, or the close, says more */ })
        }, pollMs)
        pollTimer.unref?.()
        askCapabilities(socket)
      })()
    })
  }

  /** The daemon's capabilities (`hello`, which a follower may send): what the replica may ask it. */
  function askCapabilities(socket: WebSocket): void {
    void call(socket, 'hello').then((m) => {
      if (ws === socket && m.ok === true && Array.isArray(m.capabilities)) caps = m.capabilities.filter((c): c is string => typeof c === 'string')
    }, () => { /* the next link asks again */ })
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
    lastFrameAt: () => frameAt,
    capabilities: () => caps,
    openStream: (to, purpose) => {
      if (state !== 'following' || !streams) return Promise.reject(new Error('not linked to the daemon'))
      return streams.open(to, purpose ? { purpose } : {})
    },
    // A daemon swap is invisible here too: a refusal of the draining daemon, or a request the
    // swap left without a link, is sent again once the next daemon is followed.
    request: (cmd, params = {}, timeoutMs) => swaps.request(cmd, async (budget) => {
      if (!linked() || !ws) throw notSent(new Error('not linked to the daemon'))
      return call(ws, cmd, params, budget)
    }, timeoutMs ?? CALL_TIMEOUT_MS),
    report: (body) => {
      if (state !== 'following' || !ws || ws.readyState !== WebSocket.OPEN) return
      try { ws.send(JSON.stringify({ cmd: 'follower.report', report: body })) } catch { /* the next one */ }
    },
  }
}
