/**
 * POST /api/v1/conversations/:id/messages with the client's `messageId`: a repeat
 * of a message the server already took is answered once (chat-send-once.ts).
 *
 * The phone's case (App Store gate r8, Q1chat-x): its POST reached the server, the
 * app went to the background before the answer, so the phone kept the message as
 * a failed bubble, and the person's retry used to be a second message, so the agent
 * got the instruction twice. Asserted here, against the real route and turn path:
 *
 *   - a repeat after the turn ended gets the first 202 (`duplicate: true`), and no
 *     second delivery reaches the lane; the conversation holds the message once;
 *   - a repeat WHILE the first turn runs gets the same 202, not a 409;
 *   - another message (another id, or none) mid-turn still gets the 409;
 *   - an id is per conversation, and a request without one, or with one the route
 *     does not take, behaves exactly as before (each POST a turn).
 *
 * Real: Express server, the api-v1 router + SSE channels, chat history, the lane
 * modules. Mocked: constants.js (temp dir) and the 'session-runner' bus subscriber
 * (copied from api-v1-lane-engine.test.ts), which answers a lane turn with synthetic
 * events and never spawns a `claude`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-chat-send-once'))

// The image save, held by the test when `imageSaveGate` is set: it is the await
// between the route's first checks and the id's claim (LOW-3 of the order gate r6).
const imageSave = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  failNext: false,
  calls: 0,
}))
vi.mock('../../../src/web/routes/images.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/web/routes/images.js')>()
  return {
    ...real,
    processAndSaveImages: async (images: Parameters<typeof real.processAndSaveImages>[0]) => {
      imageSave.calls++
      if (imageSave.gate) await imageSave.gate
      if (imageSave.failNext) {
        imageSave.failNext = false
        throw new Error('disk full')
      }
      return real.processAndSaveImages(images)
    },
  }
})

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import { handlePrimaryChatTurnRelay } from '../../../src/web/routes/chat-turn-relay.js'
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'

let server: HttpServer
let port: number
let started: SessionStartEvent[] = []
let sent: SessionSendEvent[] = []
/** How the fake CLI answers. 'result' = deltas + a result; 'error' = session:error;
 *  'silent' = never answers (nothing settles the turn; used for the 409 guard). */
let laneMode: 'result' | 'error' | 'silent' = 'result'
let laneReply = 'the lane answered'
/** Text the fake streams as session:text-delta before its result. */
let laneDeltas: string[] = ['lane ', 'delta']

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/**
 * Consume a session's queued messages, the way a real delivery would. Tracked in
 * `inFlightDrains` so teardown can await it: a drain still running when the test
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
 * `laneMode` says, streaming deltas first so the relay path is exercised.
 *
 * It also DRAINS the session message queue, which the real runner does on delivery.
 * Skipping that leaves the send 'pending' forever, and the local daemon's
 * reconnect redelivery (claude-code-session.ts → redeliverPendingForHost) would
 * then take it as an undelivered message and cold-`--resume` it: a REAL `claude`
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

async function postMessage(convId: string, text: string, messageId?: unknown, images?: unknown[]): Promise<Response> {
  return fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(messageId === undefined ? {} : { messageId }), ...(images ? { images } : {}) }),
  })
}

/** 1x1 PNG: real image bytes, small enough that compression returns at once. */
const TINY_PNG = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mediaType: 'image/png',
}

interface V1Message { role: string; text: string; kind?: string; source?: string; messageId?: string }

async function getMessages(convId: string): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages?limit=50`))
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

/** Wait for the lane spawn this turn triggers (SESSION_START recorded by the fake runner). */
async function waitForLaneStart(timeoutMs = 10_000): Promise<SessionStartEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (started.length > 0) return started[0]
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('the lane never started')
}

beforeEach(() => {
  imageSave.gate = null
  imageSave.failNext = false
  imageSave.calls = 0
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


describe('a chat send carries its message id, and a repeat is answered once', () => {
  it('a repeat after the turn ended gets the first 202 and runs nothing', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const first = await postMessage(convId, 'water the fern', 'qm-mobile-fern-1')
      expect(first.status).toBe(202)
      const { turnId } = await first.json() as { turnId: string }
      await sse.waitFor((e) => e.event === 'message-end')

      const again = await postMessage(convId, 'water the fern', 'qm-mobile-fern-1')
      expect(again.status).toBe(202)
      expect(await again.json()).toEqual({ turnId, duplicate: true })
      // Give a wrongly started second turn the time to show itself.
      await new Promise((r) => setTimeout(r, 300))
      expect(started).toHaveLength(1)
      expect(sent).toHaveLength(0)
      expect(sse.events.filter((e) => e.event === 'message-start')).toHaveLength(1)
      const rows = (await getMessages(convId)).filter((m) => !m.kind && m.role === 'user')
      expect(rows.filter((m) => m.text === 'water the fern')).toHaveLength(1)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('a repeat while the first turn runs gets its 202, another message the 409', async () => {
    laneMode = 'silent'
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const first = await postMessage(convId, 'first', 'qm-mobile-a')
      expect(first.status).toBe(202)
      const { turnId } = await first.json() as { turnId: string }
      await sse.waitFor((e) => e.event === 'message-start')

      const repeat = await postMessage(convId, 'first', 'qm-mobile-a')
      expect(repeat.status).toBe(202)
      expect(await repeat.json()).toEqual({ turnId, duplicate: true })
      const other = await postMessage(convId, 'second', 'qm-mobile-b')
      expect(other.status).toBe(409)
      expect((await other.json() as { error: { code: string } }).error.code).toBe('turn_active')
      const bare = await postMessage(convId, 'third')
      expect(bare.status).toBe(409)

      const sid = (await waitForLaneStart()).preassignedSessionId!
      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, result: 'done', isError: false },
        ['main-ai', 'session-runner'], { source: 'test' })
      await sse.waitFor((e) => e.event === 'message-end')
      expect(started).toHaveLength(1)
      expect(sent).toHaveLength(0)
    } finally {
      sse.close()
    }
  }, 25_000)

  it('an id is per conversation, and no id (or one the route does not take) is a new turn each time', async () => {
    await boot({ provider: 'claude-code' })
    const a = await createConv()
    const b = await createConv()
    const sseA = await connectSse(apiUrl(`/api/v1/conversations/${a}/stream`))
    const sseB = await connectSse(apiUrl(`/api/v1/conversations/${b}/stream`))
    const ends = (sse: SseConn, n: number) => sse.waitFor((e) => e.event === 'message-end'
      && sse.events.filter((x) => x.event === 'message-end').length >= n)
    try {
      // The same id in another conversation is another message.
      expect((await postMessage(a, 'same words', 'qm-mobile-shared')).status).toBe(202)
      await ends(sseA, 1)
      const inB = await postMessage(b, 'same words', 'qm-mobile-shared')
      expect(inB.status).toBe(202)
      expect((await inB.json() as { duplicate?: boolean }).duplicate).toBeUndefined()
      await ends(sseB, 1)
      // No id: each POST is a turn, as before.
      expect((await postMessage(a, 'again')).status).toBe(202)
      await ends(sseA, 2)
      expect((await postMessage(a, 'again')).status).toBe(202)
      await ends(sseA, 3)
      // An id the route does not take counts as none.
      for (const bad of ['../etc/passwd', 'x'.repeat(129), 42, '']) {
        const res = await postMessage(a, 'odd id', bad)
        expect(res.status).toBe(202)
        expect((await res.json() as { duplicate?: boolean }).duplicate).toBeUndefined()
        await ends(sseA, 4 + ['../etc/passwd', 'x'.repeat(129), 42, ''].indexOf(bad))
      }
      // Two lanes (one per conversation); every later turn is a delivery to one.
      expect(started).toHaveLength(2)
      expect(sent).toHaveLength(6)
    } finally {
      sseA.close()
      sseB.close()
    }
  }, 40_000)
})

describe('the message id is claimed after the image save', () => {
  it('two POSTs of one photo message racing through the save start one turn', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    let release: () => void = () => {}
    imageSave.gate = new Promise<void>((resolve) => { release = resolve })
    try {
      const a = postMessage(convId, 'look at this', 'qm-mobile-photo-1', [TINY_PNG])
      const b = postMessage(convId, 'look at this', 'qm-mobile-photo-1', [TINY_PNG])
      // Both are inside the save before either claims the id.
      const deadline = Date.now() + 5_000
      while (imageSave.calls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
      expect(imageSave.calls).toBe(2)
      release()
      const answers = await Promise.all([a, b].map(async (p) => {
        const res = await p
        return { status: res.status, body: await res.json() as { turnId: string; duplicate?: boolean } }
      }))
      expect(answers.map((x) => x.status)).toEqual([202, 202])
      expect(answers.filter((x) => x.body.duplicate === true)).toHaveLength(1)
      expect(new Set(answers.map((x) => x.body.turnId)).size).toBe(1)
      await sse.waitFor((e) => e.event === 'message-end')
      await new Promise((r) => setTimeout(r, 300))
      expect(started).toHaveLength(1)
      expect(sse.events.filter((e) => e.event === 'message-start')).toHaveLength(1)
    } finally {
      release()
      sse.close()
    }
  }, 20_000)

  it('a save that throws claims nothing, so the retry runs', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      imageSave.failNext = true
      const failed = await postMessage(convId, 'photo again', 'qm-mobile-photo-2', [TINY_PNG])
      expect(failed.status).toBe(500)
      const retry = await postMessage(convId, 'photo again', 'qm-mobile-photo-2', [TINY_PNG])
      expect(retry.status).toBe(202)
      expect((await retry.json() as { duplicate?: boolean }).duplicate).toBeUndefined()
      await sse.waitFor((e) => e.event === 'message-end')
      expect(started).toHaveLength(1)
    } finally {
      sse.close()
    }
  }, 20_000)
})

describe('the primary is the authority on a relayed message (send-once gate r1, MEDIUM-1)', () => {
  it('a relay of a message posted here directly is answered once, with that turn', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const first = await postMessage(convId, 'feed the cat', 'qm-mobile-cat-1')
      expect(first.status).toBe(202)
      const { turnId } = await first.json() as { turnId: string }
      await sse.waitFor((e) => e.event === 'message-end')

      // The phone switched to the cloud companion and retried there: a new turnId,
      // the same message id.
      const relayed = await handlePrimaryChatTurnRelay({
        agentId: 'general', conversationId: convId, text: 'feed the cat',
        turnId: 'turn-from-the-companion', messageId: 'qm-mobile-cat-1',
      })
      expect(relayed).toMatchObject({ accepted: true, duplicate: true, turnId, running: false })
      await new Promise((r) => setTimeout(r, 300))
      expect(started).toHaveLength(1)
      expect(sent).toHaveLength(0)
      const rows = (await getMessages(convId)).filter((m) => !m.kind && m.role === 'user')
      expect(rows.filter((m) => m.text === 'feed the cat')).toHaveLength(1)
    } finally {
      sse.close()
    }
  }, 20_000)

  it('two relays of one message under two turnIds run one turn, and a direct POST of it is answered once', async () => {
    laneMode = 'silent'
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    try {
      const a = await handlePrimaryChatTurnRelay({
        agentId: 'general', conversationId: convId, text: 'walk the dog',
        turnId: 'turn-relay-a', messageId: 'qm-mobile-dog-1',
      })
      expect(a).toMatchObject({ accepted: true, turnId: 'turn-relay-a' })
      expect(a.duplicate).toBeUndefined()
      const sid = (await waitForLaneStart()).preassignedSessionId!

      // A companion that lost its memory of the first relay (a restart) relays the
      // retry under a new turnId. Still running here: its frames are still mirrored.
      const b = await handlePrimaryChatTurnRelay({
        agentId: 'general', conversationId: convId, text: 'walk the dog',
        turnId: 'turn-relay-b', messageId: 'qm-mobile-dog-1',
      })
      expect(b).toMatchObject({ accepted: true, duplicate: true, turnId: 'turn-relay-a', running: true })
      // The same turnId again (the companion's retry of an unsure relay) too.
      const again = await handlePrimaryChatTurnRelay({
        agentId: 'general', conversationId: convId, text: 'walk the dog',
        turnId: 'turn-relay-a', messageId: 'qm-mobile-dog-1',
      })
      expect(again).toMatchObject({ accepted: true, duplicate: true, turnId: 'turn-relay-a', running: true })

      const direct = await postMessage(convId, 'walk the dog', 'qm-mobile-dog-1')
      expect(direct.status).toBe(202)
      expect(await direct.json()).toEqual({ turnId: 'turn-relay-a', duplicate: true })

      bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, result: 'walked', isError: false },
        ['main-ai', 'session-runner'], { source: 'test' })
      await sse.waitFor((e) => e.event === 'message-end')
      await new Promise((r) => setTimeout(r, 300))
      expect(started).toHaveLength(1)
      expect(sent).toHaveLength(0)
      const rows = (await getMessages(convId)).filter((m) => !m.kind && m.role === 'user')
      expect(rows.map((m) => [m.text, m.messageId])).toEqual([['walk the dog', 'qm-mobile-dog-1']])
    } finally {
      sse.close()
    }
  }, 25_000)
})

describe('a chat row names the message id it was sent under (send-once gate r1, MEDIUM-2)', () => {
  it('the user row carries its message id, and one sent without an id carries none', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${convId}/stream`))
    const ends = (n: number) => sse.waitFor((e) => e.event === 'message-end'
      && sse.events.filter((x) => x.event === 'message-end').length >= n)
    try {
      expect((await postMessage(convId, 'with an id', 'qm-mobile-row-1')).status).toBe(202)
      await ends(1)
      expect((await postMessage(convId, 'without an id')).status).toBe(202)
      await ends(2)
      const rows = (await getMessages(convId)).filter((m) => !m.kind && m.role === 'user')
      expect(rows.map((m) => [m.text, m.messageId ?? null])).toEqual([
        ['with an id', 'qm-mobile-row-1'],
        ['without an id', null],
      ])
      const answers = (await getMessages(convId)).filter((m) => m.role === 'assistant')
      expect(answers.every((m) => m.messageId === undefined), 'an assistant row named a message id').toBe(true)
    } finally {
      sse.close()
    }
  }, 25_000)
})
