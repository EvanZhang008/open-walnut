/**
 * /api/v1 × engine selection (`config.agent.provider`) — the MOBILE surface's fork.
 *
 * The iOS client has exactly ONE channel per conversation (its SSE stream) and
 * unlocks the composer on `message-end`. So unlike the web chat RPC — which can
 * fire-and-forget a lane turn because the browser subscribes to the lane SESSION's
 * own stream — a lane turn fired from mobile must be AWAITED and translated back
 * onto the frozen SSE contract. What's asserted here is exactly that contract:
 *
 *   - flag OFF (default) → the in-process loop runs, no lane is touched
 *   - flag ON            → the lane receives the message, the loop is never called,
 *                          and the stream still carries message-start → text-delta
 *                          → message-end{turnId, fullText}
 *   - flag ON + failure  → SSE `error` (a client that never sees it stays locked)
 *   - GET /messages      → the answer is readable back (the phone's only history)
 *   - a second POST mid-turn → 409 turn_active (the lane turn holds the guard too)
 *
 * What's real: Express server, the api-v1 router + SSE channels, chat history,
 * session records, the lane modules. What's mocked: constants.js (temp dir), the
 * agent loop (spy), and the 'session-runner' bus subscriber — a fake that answers a
 * lane turn with synthetic session:text-delta + session:result and NEVER spawns a
 * `claude`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-lane-test'))

const runAgentLoop = vi.fn(async (userContent: string | unknown[], history: unknown[]) => ({
  messages: [
    ...(history as Array<{ role: string; content: unknown }>),
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'in-process response' }] },
  ],
  newMessages: [
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'in-process response' }] },
  ],
  response: 'in-process response',
  aborted: false,
}))

vi.mock('../../../src/agent/loop.js', () => ({ runAgentLoop }))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'

let server: HttpServer
let port: number
let started: SessionStartEvent[] = []
let sent: SessionSendEvent[] = []
/** How the fake CLI answers. 'result' = deltas + a result; 'error' = session:error;
 *  'silent' = never answers (nothing settles the turn — used for the 409 guard). */
let laneMode: 'result' | 'error' | 'silent' = 'result'
let laneReply = 'the lane answered'
/** Text the fake streams as session:text-delta before its result. */
let laneDeltas: string[] = ['lane ', 'delta']

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/**
 * Consume a session's queued messages, the way a real delivery would. Tracked in
 * `inFlightDrains` so teardown can await it — a drain still running when the test
 * ends leaves the message 'pending', which the daemon's reconnect redelivery would
 * then cold-`--resume` into a real `claude`.
 */
const inFlightDrains = new Set<Promise<void>>()

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId)
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id))
    } catch { /* the store may be torn down between tests */ }
  })()
  inFlightDrains.add(p)
  void p.finally(() => inFlightDrains.delete(p))
}

/**
 * Fake session-runner: records SESSION_START / SESSION_SEND, then answers the way
 * `laneMode` says — streaming deltas first so the relay path is exercised.
 *
 * It also DRAINS the session message queue, which the real runner does on delivery.
 * Skipping that leaves the send 'pending' forever, and the local daemon's
 * reconnect redelivery (claude-code-session.ts → redeliverPendingForHost) would
 * then take it as an undelivered message and cold-`--resume` it — a REAL `claude`
 * spawn out of a test that mocks the runner precisely to avoid one.
 */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      started.push(d)
      sid = d.preassignedSessionId
    } else if (event.name === EventNames.SESSION_SEND) {
      const d = event.data as SessionSendEvent
      sent.push(d)
      sid = d.sessionId
    }
    if (!sid) return
    drainQueue(sid)
    if (laneMode === 'silent') return
    const sessionId = sid
    setTimeout(() => {
      if (laneMode === 'error') {
        bus.emit(EventNames.SESSION_ERROR, { sessionId, error: 'CLI died', errorKind: 'crash' },
          ['main-ai', 'session-runner'], { source: 'session-runner' })
        return
      }
      for (const delta of laneDeltas) {
        bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId, delta },
          ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
      }
      bus.emit(EventNames.SESSION_RESULT, { sessionId, result: laneReply, isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 10)
  })
}

// ── Minimal SSE client over fetch (same shape as api-v1.test.ts's) ──

interface SseEvt { id?: number; event: string; data: Record<string, unknown> }
interface SseConn {
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}

async function connectSse(url: string): Promise<SseConn> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
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
            if (line.startsWith(':')) continue // comment / ping
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

async function writeConfig(agent: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    ...(Object.keys(agent).length ? { agent } : {}),
  }), 'utf-8')
}

async function boot(agent: Record<string, unknown>): Promise<void> {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeConfig(agent)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // startServer registers the real runner; replacing the subscriber by NAME
  // displaces it, so nothing in this file can reach a real spawn.
  installFakeRunner()
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function postMessage(convId: string, text: string): Promise<Response> {
  return fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

interface V1Message { role: string; text: string; kind?: string; source?: string }

async function getMessages(convId: string): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages?limit=50`))
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

beforeEach(() => {
  runAgentLoop.mockClear()
  started = []
  sent = []
  laneMode = 'result'
  laneReply = 'the lane answered'
  laneDeltas = ['lane ', 'delta']
})

afterEach(async () => {
  // Let every fake delivery finish draining BEFORE the server goes down (see
  // drainQueue): a message left 'pending' is exactly what triggers a real spawn.
  await Promise.all([...inFlightDrains]).catch(() => {})
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('agent.provider unset (default) → in-process loop', () => {
  it('runs runAgentLoop and never creates a lane session', async () => {
    await boot({})
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const res = await postMessage(convId, 'hi walnut')
      expect(res.status).toBe(202)

      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.fullText).toBe('in-process response')
      expect(runAgentLoop).toHaveBeenCalledTimes(1)
      expect(started).toHaveLength(0)

      const { getSessionByLane } = await import('../../../src/core/session-tracker.js')
      expect(await getSessionByLane(`chat:general:${convId}`)).toBeNull()
    } finally {
      sse.close()
    }
  }, 20_000)
})

describe("agent.provider = 'claude-code' → lane session", () => {
  it('keeps the SSE contract: message-start → text-delta → message-end{fullText}', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const res = await postMessage(convId, 'plan my week')
      expect(res.status).toBe(202)
      const { turnId } = await res.json() as { turnId: string }

      const end = await sse.waitFor((e) => e.event === 'message-end')
      // The frozen payload the phone unlocks its composer on.
      expect(end.data.turnId).toBe(turnId)
      expect(end.data.fullText).toBe('the lane answered')

      const start = sse.events.find((e) => e.event === 'message-start')
      expect(start?.data.turnId).toBe(turnId)
      // Live relay: the lane's own deltas reach the phone's channel, which is what
      // keeps its 30s inactivity watchdog fed through a long turn.
      const deltas = sse.events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta)
      expect(deltas).toEqual(['lane ', 'delta'])
      // Event order matters: a delta before message-start would be dropped by the client.
      const order = sse.events.map((e) => e.event)
      expect(order.indexOf('message-start')).toBeLessThan(order.indexOf('text-delta'))
      expect(order.indexOf('text-delta')).toBeLessThan(order.indexOf('message-end'))

      // The turn ran on the lane, not in-process.
      expect(runAgentLoop).not.toHaveBeenCalled()
      expect(started).toHaveLength(1)
      expect(started[0].lane).toBe(`chat:general:${convId}`)
      expect(started[0].message).toContain('plan my week')
      const { getSessionByLane } = await import('../../../src/core/session-tracker.js')
      expect((await getSessionByLane(`chat:general:${convId}`))?.claudeSessionId)
        .toBe(started[0].preassignedSessionId)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('a second turn reuses the lane and delivers through the session queue', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'one')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-end')
      expect((await postMessage(convId, 'two')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-end'
        && sse.events.filter((x) => x.event === 'message-end').length >= 2)

      expect(started).toHaveLength(1)
      expect(sent.map((s) => s.message)).toEqual(['two'])
      expect(runAgentLoop).not.toHaveBeenCalled()
    } finally {
      sse.close()
    }
  }, 20_000)

  it("GET /messages returns the lane's answer (the phone's only history surface)", async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'remember this')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'message-end')

      const msgs = await getMessages(convId)
      const plain = msgs.filter((m) => !m.kind)
      expect(plain.some((m) => m.role === 'user' && m.text === 'remember this')).toBe(true)
      // Not filtered by normalizeEntries' notification/hidden-source rules.
      expect(plain.some((m) => m.role === 'assistant' && m.text === 'the lane answered')).toBe(true)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('a session:error becomes an SSE error (or the composer stays locked forever)', async () => {
    laneMode = 'error'
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'this will fail')).status).toBe(202)

      const err = await sse.waitFor((e) => e.event === 'error')
      expect(typeof err.data.message).toBe('string')
      expect(err.data.message as string).toMatch(/did not answer/i)
      expect(sse.events.some((e) => e.event === 'message-end')).toBe(false)
      expect(runAgentLoop).not.toHaveBeenCalled()

      // The failure is persisted the same way the in-process catch persists it, so
      // it lands in Notifications and NOT in the mobile feed.
      const msgs = await getMessages(convId)
      expect(msgs.some((m) => m.text.includes('[Error:'))).toBe(false)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('409 turn_active while a lane turn is in flight, and frees up after', async () => {
    laneMode = 'silent' // nothing settles the turn → it stays in flight
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      expect((await postMessage(convId, 'first')).status).toBe(202)
      // message-start proves the turn reached the engine branch (past the queue).
      await sse.waitFor((e) => e.event === 'message-start')

      const second = await postMessage(convId, 'second')
      expect(second.status).toBe(409)
      const body = await second.json() as { error: { code: string } }
      expect(body.error.code).toBe('turn_active')

      // Release the first turn by answering it, then the slot frees up.
      const sid = started[0].preassignedSessionId!
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, result: 'late answer', isError: false },
        ['main-ai', 'session-runner'], { source: 'test' })
      await sse.waitFor((e) => e.event === 'message-end')

      laneMode = 'result'
      expect((await postMessage(convId, 'third')).status).toBe(202)
      // Awaited, not fire-and-forget: a turn still in flight at teardown leaves its
      // message pending, which the daemon would redeliver as a real `claude` resume.
      await sse.waitFor((e) => e.event === 'message-end'
        && sse.events.filter((x) => x.event === 'message-end').length >= 2)
    } finally {
      sse.close()
    }
  }, 25_000)
})
