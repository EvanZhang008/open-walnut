/**
 * Cloud-side registry of daemon bridges (WALNUT_CLOUD_MODE only).
 *
 * Each execution host's daemon dials wss://<cloud>/bridge (see the bridge
 * section in src/providers/daemon-standalone.ts) and speaks its native RPC
 * protocol over the socket: we send `{id, cmd, ...}` frames, it answers
 * `{id, ok, ...}` and pushes `{ev, ...}` events — this side is effectively a
 * DaemonConnection minus SSH. The phone endpoints in
 * routes/session-stream-v1.ts proxy through bridgeRequest()/attachSession().
 *
 * Single-connection-per-host semantics: a new authenticated dial for the same
 * hostAlias REPLACES the old socket (close code 4000) — the daemon's redial
 * loop guarantees eventual convergence, and two live sockets for one host
 * would double every jsonl event.
 */

import type { WebSocket } from 'ws'
import { emitSse } from '../sse-channels.js'
import { log } from '../../logging/index.js'

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface BridgeConn {
  ws: WebSocket
  hostAlias: string
  deviceName: string
  version?: string
  instanceId?: string
  since: number
  cmdCounter: number
  pending: Map<number, PendingRequest>
  /** Sessions this conn has sent an `attach` for (idempotence guard). */
  attachSent: Set<string>
  lastInbound: number
}

/** Close code for "replaced by a newer connection from the same host". */
const CLOSE_REPLACED = 4000
const DEFAULT_TIMEOUT_MS = 15_000
// Daemon pings every 30s; two misses + margin = dead link.
const SILENCE_MS = 75_000
const SILENCE_SWEEP_MS = 30_000

const bridges = new Map<string, BridgeConn>()
/** Sockets that connected but haven't sent their hello yet. */
const preHello = new Map<WebSocket, { deviceName: string; timer: NodeJS.Timeout }>()

let silenceSweepTimer: NodeJS.Timeout | null = null

function ensureSilenceSweep(): void {
  if (silenceSweepTimer) return
  silenceSweepTimer = setInterval(() => {
    const now = Date.now()
    for (const conn of bridges.values()) {
      if (now - conn.lastInbound > SILENCE_MS) {
        log.ws.warn('bridge: host silent — dropping', {
          hostAlias: conn.hostAlias, silentMs: now - conn.lastInbound,
        })
        try { conn.ws.close() } catch { /* already closed */ }
      }
    }
  }, SILENCE_SWEEP_MS)
  silenceSweepTimer.unref?.()
}

function channelKey(sessionId: string): string {
  return `session:${sessionId}`
}

/** Map a raw daemon jsonl line to phone SSE events (main lane only). */
function forwardJsonlLine(sessionId: string, line: string): void {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(line) } catch { return }
  const key = channelKey(sessionId)
  const type = parsed.type as string

  if (type === 'stream_event') {
    // Live deltas. Subagent deltas arrive via full assistant lines instead,
    // so no parent_tool_use_id filtering is needed on this branch.
    const se = parsed as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }
    const delta = se.event?.type === 'content_block_delta' ? se.event.delta : undefined
    if (delta?.type === 'text_delta' && delta.text) emitSse(key, 'text-delta', { delta: delta.text })
    else if (delta?.type === 'thinking_delta' && delta.thinking) emitSse(key, 'thinking', { delta: delta.thinking })
    return
  }

  if (type === 'assistant') {
    // Tool starts only — text already streamed via stream_event deltas, and
    // re-emitting full text blocks here would duplicate it on the phone.
    if (parsed.parent_tool_use_id) return
    const content = (parsed.message as { content?: unknown[] } | undefined)?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      const b = block as { type?: string; id?: string; name?: string }
      if (b.type === 'tool_use') {
        emitSse(key, 'tool', { name: b.name ?? 'unknown', toolUseId: b.id ?? '' })
      }
    }
    return
  }

  if (type === 'user') {
    if (parsed.parent_tool_use_id) return
    // Mobile turn-start marker (appendUserMarker) — the phone already shows
    // its optimistic bubble; other user lines carry tool results.
    if (parsed.subtype === 'walnut-injected') return
    const content = (parsed.message as { content?: unknown[] } | undefined)?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      const b = block as { type?: string; tool_use_id?: string }
      if (b.type === 'tool_result') {
        emitSse(key, 'tool-result', { toolUseId: b.tool_use_id ?? '' })
      }
    }
    return
  }

  if (type === 'result') {
    emitSse(key, 'turn-end', {})
    return
  }
}

function handleFrame(conn: BridgeConn, raw: string): void {
  conn.lastInbound = Date.now()
  let msg: Record<string, unknown>
  try { msg = JSON.parse(raw) } catch { return }

  // RPC response — settle the pending request.
  if (typeof msg.id === 'number' && conn.pending.has(msg.id)) {
    const req = conn.pending.get(msg.id)!
    conn.pending.delete(msg.id)
    clearTimeout(req.timer)
    req.resolve(msg)
    return
  }

  const ev = msg.ev as string | undefined
  if (!ev) return

  if (ev === 'bridge-ping') return // lastInbound already stamped

  if (ev === 'jsonl') {
    const sid = msg.sid as string | undefined
    const line = msg.line as string | undefined
    if (sid && line && conn.attachSent.has(sid)) forwardJsonlLine(sid, line)
    return
  }

  if (ev === 'session_state') {
    const sid = msg.sid as string | undefined
    const state = msg.state as string | undefined
    if (sid && conn.attachSent.has(sid)) {
      emitSse(channelKey(sid), 'status', { processStatus: state === 'dead' ? 'stopped' : 'running' })
    }
    return
  }
}

/**
 * Wire an authenticated /bridge socket. Registration completes when the
 * daemon's hello arrives (carries the hostAlias).
 */
export function attachBridge(ws: WebSocket, deviceName: string): void {
  ensureSilenceSweep()
  // A daemon that never says hello is holding a slot — drop it.
  const helloTimer = setTimeout(() => {
    preHello.delete(ws)
    try { ws.close() } catch { /* already closed */ }
  }, 10_000)
  preHello.set(ws, { deviceName, timer: helloTimer })

  ws.on('message', (data) => {
    const raw = data.toString()

    const waiting = preHello.get(ws)
    if (waiting) {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.ev !== 'hello' || typeof msg.hostAlias !== 'string') return
      clearTimeout(waiting.timer)
      preHello.delete(ws)
      registerBridge(ws, waiting.deviceName, msg)
      return
    }

    const conn = findConn(ws)
    if (conn) handleFrame(conn, raw)
  })

  ws.on('close', () => {
    const waiting = preHello.get(ws)
    if (waiting) { clearTimeout(waiting.timer); preHello.delete(ws) }
    const conn = findConn(ws)
    if (conn) dropBridge(conn, 'socket closed')
  })

  ws.on('error', () => { /* close always follows */ })
}

function findConn(ws: WebSocket): BridgeConn | null {
  for (const conn of bridges.values()) {
    if (conn.ws === ws) return conn
  }
  return null
}

function registerBridge(ws: WebSocket, deviceName: string, hello: Record<string, unknown>): void {
  const hostAlias = hello.hostAlias as string
  const existing = bridges.get(hostAlias)
  if (existing) {
    log.ws.info('bridge: replacing existing connection', { hostAlias })
    try { existing.ws.close(CLOSE_REPLACED, 'replaced') } catch { /* already closed */ }
    dropBridge(existing, 'replaced')
  }
  const conn: BridgeConn = {
    ws,
    hostAlias,
    deviceName,
    version: hello.version as string | undefined,
    instanceId: hello.instanceId as string | undefined,
    since: Date.now(),
    cmdCounter: 0,
    pending: new Map(),
    attachSent: new Set(),
    lastInbound: Date.now(),
  }
  bridges.set(hostAlias, conn)
  log.ws.info('bridge: host connected', {
    hostAlias, deviceName, version: conn.version,
    sids: Array.isArray(hello.sids) ? hello.sids.length : 0,
  })
  // Live SSE consumers from before a bridge drop re-attach on the daemon:
  // channels with open conns are re-subscribed by session-stream-v1 when it
  // sees bridge-online.
  emitSseToAllAttachedChannels(conn, 'bridge-online')
}

function emitSseToAllAttachedChannels(conn: BridgeConn, event: 'bridge-online' | 'bridge-offline'): void {
  for (const sid of conn.attachSent) {
    emitSse(channelKey(sid), event, {})
  }
}

function dropBridge(conn: BridgeConn, reason: string): void {
  // Only drop if this exact conn is still registered (replace races).
  if (bridges.get(conn.hostAlias) === conn) bridges.delete(conn.hostAlias)
  for (const [, req] of conn.pending) {
    clearTimeout(req.timer)
    req.reject(new Error('bridge disconnected'))
  }
  conn.pending.clear()
  emitSseToAllAttachedChannels(conn, 'bridge-offline')
  log.ws.info('bridge: host disconnected', { hostAlias: conn.hostAlias, reason })
}

// ─── Public API (used by routes/session-stream-v1.ts + status) ─────────────

export function bridgeForHost(hostAlias: string): { connected: boolean } {
  return { connected: bridges.has(hostAlias) }
}

export function bridgeHosts(): Array<{ hostAlias: string; since: number; version?: string }> {
  return [...bridges.values()].map((c) => ({
    hostAlias: c.hostAlias, since: c.since, version: c.version,
  }))
}

export class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}

/** Send one RPC to a host's daemon and await its `{id, ...}` response. */
export function bridgeRequest(
  hostAlias: string,
  cmd: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const conn = bridges.get(hostAlias)
  if (!conn) return Promise.reject(new BridgeOfflineError(hostAlias))
  const id = ++conn.cmdCounter
  const frame = JSON.stringify({ id, cmd, ...params })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      reject(new Error(`bridge request timed out: ${cmd} → ${hostAlias}`))
    }, timeoutMs)
    conn.pending.set(id, { resolve, reject, timer })
    try {
      conn.ws.send(frame)
    } catch (err) {
      conn.pending.delete(id)
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Ensure the daemon streams a session's jsonl over this bridge (idempotent).
 * fromOffset MAX_SAFE_INTEGER = future-only; the phone's initial state comes
 * from the transcript fetch, so no byte replay is needed here.
 */
export async function bridgeAttachSession(hostAlias: string, sessionId: string): Promise<void> {
  const conn = bridges.get(hostAlias)
  if (!conn) throw new BridgeOfflineError(hostAlias)
  if (conn.attachSent.has(sessionId)) return
  const res = await bridgeRequest(hostAlias, 'attach', {
    sid: sessionId, fromOffset: Number.MAX_SAFE_INTEGER,
  })
  if (res.ok !== true) throw new Error(`attach failed: ${String(res.error ?? 'unknown')}`)
  conn.attachSent.add(sessionId)
}

/** Interest bookkeeping: the last phone SSE consumer for a session left. */
export function bridgeDetachSession(hostAlias: string, sessionId: string): void {
  // The daemon has no unsubscribe-per-sid RPC; dropping our interest flag
  // stops the SSE forwarding, and the daemon-side subscription dies with the
  // socket. Cheap and correct for a single-digit session count.
  bridges.get(hostAlias)?.attachSent.delete(sessionId)
}

/** Tests / shutdown: close everything. */
export function closeAllBridges(): void {
  for (const conn of [...bridges.values()]) {
    try { conn.ws.close() } catch { /* already closed */ }
    dropBridge(conn, 'shutdown')
  }
  for (const [ws, waiting] of preHello) {
    clearTimeout(waiting.timer)
    try { ws.close() } catch { /* already closed */ }
  }
  preHello.clear()
  if (silenceSweepTimer) { clearInterval(silenceSweepTimer); silenceSweepTimer = null }
}
