/**
 * /api/v1 session talk endpoints — real startServer({ port: 0 }) with an
 * isolated temp OPEN_WALNUT_HOME. Covers:
 *   POST /sessions/:id/messages: 202 + queue persistence, 404, 400
 *   GET  /sessions/:id/stream: snapshot event, live bus → SSE mapping,
 *     turn-start reset (incl. daemon-reconnect guard), subagent-lane filtering,
 *     Last-Event-ID replay, 404
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-session-talk'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

// ── Minimal SSE client over fetch (same shape as api-v1.test.ts) ──

interface SseEvt { id?: number; event: string; data: Record<string, unknown> }

interface SseConn {
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}

async function connectSse(url: string, headers?: Record<string, string>): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, { headers, signal: controller.signal })
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
          let id: number | undefined
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue
            if (line.startsWith('id: ')) id = Number(line.slice(4))
            else if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue
          const evt: SseEvt = { id, event, data: data ? JSON.parse(data) : {} }
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

const SID = 'talk-test-session-0001'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await createSessionRecord(SID, 'task-talk-1', 'test-project', '/tmp', { title: 'talk test' })
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/v1/sessions/:id/messages', () => {
  it('202 + messageId for a known session, and the message is enqueued', async () => {
    const res = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello from the phone' }),
    })
    expect(res.status).toBe(202)
    const body = await res.json() as { messageId: string }
    expect(typeof body.messageId).toBe('string')
    expect(body.messageId.length).toBeGreaterThan(0)

    const { getQueue } = await import('../../../src/core/session-message-queue.js')
    const queue = await getQueue(SID)
    expect(queue.some((m) => m.id === body.messageId && m.message === 'hello from the phone')).toBe(true)
  })

  it('404 for an unknown session', async () => {
    const res = await fetch(apiUrl('/api/v1/sessions/does-not-exist/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('not_found')
  })

  it('400 for empty text', async () => {
    const res = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/sessions/:id/stream', () => {
  it('404 for an unknown session', async () => {
    const res = await fetch(apiUrl('/api/v1/sessions/does-not-exist/stream'))
    expect(res.status).toBe(404)
    await res.body?.cancel()
  })

  it('sends a snapshot on attach, then maps bus events to SSE', async () => {
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    try {
      const snap = await sse.waitFor((e) => e.event === 'snapshot')
      expect(Array.isArray(snap.data.blocks)).toBe(true)
      expect(typeof snap.data.isStreaming).toBe('boolean')

      // Turn start (real turn from session-runner) → turn-start + status.
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: SID, process_status: 'running',
      }, ['*'], { source: 'session-runner' })
      await sse.waitFor((e) => e.event === 'turn-start')
      await sse.waitFor((e) => e.event === 'status' && e.data.processStatus === 'running')

      // Main-lane delta arrives; subagent-lane delta is filtered out.
      bus.emit(EventNames.SESSION_TEXT_DELTA, {
        sessionId: SID, delta: 'Hello ', msgId: 'm1',
      }, ['main-ai'], { source: 'session-runner' })
      bus.emit(EventNames.SESSION_TEXT_DELTA, {
        sessionId: SID, delta: 'SUBAGENT', msgId: 'm2', parentToolUseId: 'tu-1',
      }, ['main-ai'], { source: 'session-runner' })
      bus.emit(EventNames.SESSION_TEXT_DELTA, {
        sessionId: SID, delta: 'world', msgId: 'm1',
      }, ['main-ai'], { source: 'session-runner' })
      await sse.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'world')
      const deltas = sse.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
      expect(deltas).toEqual(['Hello ', 'world'])

      // Tool events (main lane only).
      bus.emit(EventNames.SESSION_TOOL_USE, {
        sessionId: SID, toolName: 'Bash', toolUseId: 'tu-9',
      }, ['main-ai'], { source: 'session-runner' })
      const tool = await sse.waitFor((e) => e.event === 'tool')
      expect(tool.data.name).toBe('Bash')
      bus.emit(EventNames.SESSION_TOOL_RESULT, {
        sessionId: SID, toolUseId: 'tu-9', result: 'ok',
      }, ['main-ai'], { source: 'session-runner' })
      await sse.waitFor((e) => e.event === 'tool-result' && e.data.toolUseId === 'tu-9')

      // Turn end.
      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: SID, result: 'done',
      }, ['*'], { source: 'session-runner' })
      await sse.waitFor((e) => e.event === 'turn-end')
    } finally {
      sse.close()
    }
  })

  it('daemon-reconnect running does NOT produce a turn-start (no phantom turns)', async () => {
    // Fresh session id → fresh SSE channel (no replay from earlier tests).
    const sid2 = 'talk-test-session-0002'
    await createSessionRecord(sid2, 'task-talk-2', 'test-project', '/tmp', { title: 'talk test 2' })
    const sse = await connectSse(apiUrl(`/api/v1/sessions/${sid2}/stream`))
    try {
      await sse.waitFor((e) => e.event === 'snapshot')
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: sid2, process_status: 'running',
      }, ['*'], { source: 'daemon-reconnect' })
      // Status still flows (useful signal), but no turn-start reset.
      await sse.waitFor((e) => e.event === 'status' && e.data.processStatus === 'running')
      expect(sse.events.some((e) => e.event === 'turn-start')).toBe(false)
    } finally {
      sse.close()
    }
  })

  it('turn-start resets the replay window; Last-Event-ID replays only later events', async () => {
    // Seed a turn: turn-start + two deltas.
    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: SID, process_status: 'running',
    }, ['*'], { source: 'session-runner' })
    bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: SID, delta: 'A', msgId: 'm3' }, ['main-ai'], { source: 'session-runner' })
    bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: SID, delta: 'B', msgId: 'm3' }, ['main-ai'], { source: 'session-runner' })

    // Late joiner (no Last-Event-ID) replays the whole current window.
    const sse1 = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`))
    let lastSeq: number
    try {
      const b = await sse1.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'B')
      const replayed = sse1.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
      expect(replayed).toEqual(['A', 'B'])
      lastSeq = b.id!
    } finally {
      sse1.close()
    }

    // Reconnect with Last-Event-ID → only events after it.
    bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: SID, delta: 'C', msgId: 'm3' }, ['main-ai'], { source: 'session-runner' })
    const sse2 = await connectSse(apiUrl(`/api/v1/sessions/${SID}/stream`), {
      'Last-Event-ID': String(lastSeq),
    })
    try {
      await sse2.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'C')
      const replayed = sse2.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
      expect(replayed).toEqual(['C'])
    } finally {
      sse2.close()
    }
  })
})
