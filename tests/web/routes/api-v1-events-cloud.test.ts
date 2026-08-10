/**
 * GET /api/v1/events — CLOUD_MODE (REPLICA) behavior. On the cloud box the
 * session half of the feed is fed by `mobile-event` frames arriving over the
 * daemon bridge (primary bus → primary daemon → bridge WS → bridge-registry →
 * events-v1 fan-out). Real startServer with CLOUD_MODE forced; the bridge
 * socket is a fake ws driven through the REAL attachBridge/handleFrame path,
 * so the hello handshake, the __local__ trust gate, and the kind allowlist
 * are all exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-events-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

// ── Fake bridge WebSocket: enough surface for attachBridge/handleFrame ──

class FakeBridgeWs extends EventEmitter {
  sent: string[] = []
  send(payload: string): void { this.sent.push(payload) }
  close(): void { this.emit('close') }
  /** Drive an inbound frame as if the daemon sent it. */
  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
}

/** Register a fake daemon bridge for a host and complete the hello handshake. */
function connectFakeBridge(hostAlias: string, deviceName: string): FakeBridgeWs {
  const ws = new FakeBridgeWs()
  // attachBridge expects a `ws`-library WebSocket; the fake covers the used
  // surface (on/send/close).
  attachBridge(ws as never, deviceName)
  ws.inbound({ ev: 'hello', hostAlias, version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

// ── Minimal SSE client (same shape as api-v1-events.test.ts) ──

interface SseEvt { event: string; data: Record<string, unknown> }
interface SseConn {
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}

async function connectSse(url: string): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${deviceToken}` },
    signal: controller.signal,
  })
  if (res.status !== 200 || !res.body) {
    controller.abort()
    throw new Error(`SSE connect failed: ${res.status}`)
  }
  const events: SseEvt[] = []
  const waiters: Array<{ pred: (e: SseEvt) => boolean; resolve: (e: SseEvt) => void }> = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { event, data: data ? JSON.parse(data) : {} }
          events.push(evt)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(evt)) {
              waiters[i].resolve(evt)
              waiters.splice(i, 1)
            }
          }
        }
      }
    } catch { /* aborted */ }
  })()
  return {
    events,
    waitFor: (pred, timeoutMs = 10_000) => {
      const existing = events.find(pred)
      if (existing) return Promise.resolve(existing)
      return new Promise<SseEvt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE waitFor timed out')), timeoutMs)
        waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e) } })
      })
    },
    close: () => controller.abort(),
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('events-cloud-test-phone')
  deviceToken = device.token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/events on a REPLICA', () => {
  it('sends a snapshot frame (empty replica state is fine) and heartbeat-only when no bridge', async () => {
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      const snap = await sse.waitFor((e) => e.event === 'snapshot')
      expect(Array.isArray(snap.data.sessions)).toBe(true)
      expect(Array.isArray(snap.data.tasks)).toBe(true)
    } finally {
      sse.close()
    }
  })

  it('bridge mobile-event from the primary (__local__) reaches SSE subscribers', async () => {
    const bridge = connectFakeBridge('__local__', 'bridge-local')
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')

      const sessionRow = {
        id: 'primary-session-1', title: 'From the Mac', host: '',
        process_status: 'running', started_at: '2026-08-08T00:00:00.000Z',
        last_active_at: '2026-08-08T00:01:00.000Z', message_count: 3,
      }
      bridge.inbound({ ev: 'mobile-event', kind: 'session-upsert', data: sessionRow })
      const upsert = await sse.waitFor((e) => e.event === 'session-upsert' && e.data.id === 'primary-session-1')
      expect(upsert.data).toEqual(sessionRow)

      bridge.inbound({ ev: 'mobile-event', kind: 'task-delete', data: { id: 'task-gone-1' } })
      const del = await sse.waitFor((e) => e.event === 'task-delete' && e.data.id === 'task-gone-1')
      expect(del.data).toEqual({ id: 'task-gone-1' })
    } finally {
      sse.close()
      bridge.close()
    }
  })

  it('projection/transcript cache frames land on disk and never reach phone SSE', async () => {
    const bridge = connectFakeBridge('__local__', 'bridge-local')
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      const before = sse.events.length

      const envelope = {
        version: 1, exportedAt: '2026-08-10T00:00:00.000Z',
        sessions: [{ id: 'pushed-s1', host: '', process_status: 'running', started_at: 'x', last_active_at: 'y', message_count: 1 }],
      }
      const tail = { version: 1, sessionId: 'pushed-s1', exportedAt: 'z', truncated: false, messages: [] }
      bridge.inbound({ ev: 'mobile-event', kind: 'projection-upsert', data: { which: 'sessions', data: envelope } })
      bridge.inbound({ ev: 'mobile-event', kind: 'transcript-upsert', data: { sid: 'pushed-s1', data: tail } })

      // Async fire-and-forget writes — poll for the cache files.
      const { readSessionProjection, readSessionTranscript } = await import('../../../src/core/session-projection.js')
      const deadline = Date.now() + 5_000
      let projection = null
      while (!projection && Date.now() < deadline) {
        projection = await readSessionProjection()
        if (!projection) await new Promise((r) => setTimeout(r, 100))
      }
      expect(projection?.sessions[0]?.id).toBe('pushed-s1')
      expect((await readSessionTranscript('pushed-s1'))?.sessionId).toBe('pushed-s1')

      // Cache frames are NOT feed events — nothing new on the SSE stream.
      expect(sse.events.length).toBe(before)
    } finally {
      sse.close()
      bridge.close()
    }
  })

  it('drops unknown kinds and frames from non-primary bridges', async () => {
    const primary = connectFakeBridge('__local__', 'bridge-local')
    const remote = connectFakeBridge('devbox', 'bridge-devbox')
    const sse = await connectSse(apiUrl('/api/v1/events'))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      const before = sse.events.length

      // Unknown kind (event-name injection attempt) — allowlist drops it.
      primary.inbound({ ev: 'mobile-event', kind: 'evil-frame', data: { x: 1 } })
      // A remote exec host's daemon must not feed the task/session list.
      remote.inbound({ ev: 'mobile-event', kind: 'task-upsert', data: { id: 'spoofed' } })
      await new Promise((r) => setTimeout(r, 300))
      expect(sse.events.length).toBe(before)

      // Feed still healthy after the dropped frames.
      primary.inbound({ ev: 'mobile-event', kind: 'task-upsert', data: { id: 'real-task-1', title: 'ok' } })
      await sse.waitFor((e) => e.event === 'task-upsert' && e.data.id === 'real-task-1')
    } finally {
      sse.close()
      primary.close()
      remote.close()
    }
  })
})
