/**
 * The chat send's message id on a CLOUD REPLICA, where a turn is relayed to the
 * primary (chat-send-once.ts, chat-turn-relay.ts).
 *
 * An id is remembered only once its turn started: the primary accepted the relay
 * (or the companion answered it itself). Every path where no turn PROVABLY started
 * gives the id back, so the retry the phone makes after the failure runs. The order
 * gate r6 (HIGH-3) found the opposite on the round before this: the id was
 * remembered before the relay, so a retry after a failed relay was answered
 * `duplicate: true`, the phone settled it as sent, and the message never ran for an
 * hour. Its probe is the first case here, kept as the regression test.
 *
 * A relay that MAY have reached the primary (no accept came back, the bridge died
 * after the send) keeps the id, unsure, and the retry is relayed again under the
 * same turnId and messageId: the primary is the authority, and answers a message it
 * already took once (send-once gate r1, MEDIUM-1; its G-C1 and G-C2 are ported
 * here). `EmulatedPrimary` answers the uplink the way handlePrimaryChatTurnRelay
 * does; the real handler's half is pinned in api-v1-chat-send-once.test.ts.
 *
 * Imports nothing the send-once change adds, so on a tree without it every case
 * fails by what the route does, not at import (send-once gate r1, LOW-6).
 *
 * Real startServer with CLOUD_MODE forced, and a real /bridge socket driven through
 * attachBridge/handleFrame (copied from api-v1-chat-turn-relay-cloud.test.ts); the
 * test process plays the primary's daemon and answers the uplink RPC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-send-once-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME, IMAGES_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'
import { resetChatTurnRelayState } from '../../../src/web/routes/chat-turn-relay.js'

/** The send-once memory's reset, when the tree has it (an older tree keeps none). */
let resetSendOnce: () => void = () => {}

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

interface UplinkFrame {
  id: number
  cmd: string
  action?: string
  params?: Record<string, unknown>
}

type ControlReply = Record<string, unknown>

/** The primary's daemon: answers `session.control`, pushes chat frames down. */
class FakePrimaryDaemon extends EventEmitter {
  received: UplinkFrame[] = []
  /** Per uplink: the reply, or a promise of it (a primary slow to answer), or
   *  'never' (the reply is lost), or 'close' (the bridge dies after the send). */
  onControl: ((frame: UplinkFrame) => ControlReply | Promise<ControlReply> | 'never' | 'close') | null = null

  send(payload: string): void {
    const frame = JSON.parse(payload) as UplinkFrame
    this.received.push(frame)
    // Other control asks (the companion's server.journal.due when the bridge connects)
    // are answered plainly: only a chat turn is the case's to answer, or to lose.
    if (frame.cmd === 'session.control' && frame.action !== 'server.chat.turn') {
      setTimeout(() => this.inbound({ id: frame.id, ok: true, result: {} }), 0)
      return
    }
    if (frame.cmd === 'session.control' && this.onControl) {
      const reply = this.onControl(frame)
      if (reply === 'never') return
      if (reply === 'close') { setTimeout(() => this.close(), 0); return }
      void Promise.resolve(reply).then((answer) => {
        setTimeout(() => this.inbound({ id: frame.id, ...answer }), 0)
      })
    }
  }

  close(): void { this.emit('close') }

  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  pushChatFrame(conversationId: string, turnId: string, event: string, data: unknown): void {
    this.inbound({ ev: 'mobile-event', kind: 'chat-turn-frame', data: { conversationId, turnId, event, data } })
  }

  turnUplinks(): UplinkFrame[] {
    return this.received.filter((f) => f.cmd === 'session.control' && f.action === 'server.chat.turn')
  }

  async waitForTurnUplinks(n: number, timeoutMs = 10_000): Promise<UplinkFrame[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.turnUplinks()
      if (found.length >= n) return found
      if (Date.now() > deadline) throw new Error(`expected ${n} turn uplinks, saw ${found.length}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

function connectFakePrimary(): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

interface SseEvt { event: string; data: Record<string, unknown> }

async function connectSse(url: string): Promise<{
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}> {
  const controller = new AbortController()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${deviceToken}` }, signal: controller.signal })
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

async function postWithId(
  conversationId: string, text: string, messageId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, messageId }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

const ACCEPT: ControlReply = { ok: true, result: { accepted: true, engine: 'claude-code' } }
const PRIMARY_BUSY: ControlReply = { ok: true, result: { accepted: false, reason: 'turn_active', message: 'busy on the primary' } }

/**
 * The primary's half of a relay, as handlePrimaryChatTurnRelay answers it: one turn
 * per message id and per turnId, and a relay of either answered with the turn it
 * runs (or ran) and whether it still runs. `take` records what reached it, whether
 * or not its answer makes it back.
 */
class EmulatedPrimary {
  turns: Array<{ turnId: string; messageId?: string }> = []
  running = new Set<string>()
  take(frame: UplinkFrame): ControlReply {
    const params = frame.params ?? {}
    const turnId = String(params.turnId)
    const messageId = typeof params.messageId === 'string' ? params.messageId : undefined
    const prior = this.turns.find((t) => (messageId !== undefined && t.messageId === messageId) || t.turnId === turnId)
    if (prior) {
      return { ok: true, result: {
        accepted: true, duplicate: true, turnId: prior.turnId, running: this.running.has(prior.turnId), engine: 'claude-code',
      } }
    }
    this.turns.push({ turnId, messageId })
    this.running.add(turnId)
    return { ok: true, result: { accepted: true, turnId, engine: 'claude-code' } }
  }
}

function uplinkIds(primary: FakePrimaryDaemon): Array<{ turnId: unknown; messageId: unknown }> {
  return primary.turnUplinks().map((u) => ({ turnId: u.params?.turnId, messageId: u.params?.messageId ?? null }))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  deviceToken = (await createDevice('chat-send-once-cloud-phone')).token
  try {
    const mod = await import('../../../src/web/routes/chat-send-once.js') as { _resetChatSendOnceForTesting?: () => void }
    if (mod._resetChatSendOnceForTesting) resetSendOnce = mod._resetChatSendOnceForTesting
  } catch { /* a tree without the send-once memory: nothing to reset */ }
}, 60_000)

afterAll(async () => {
  closeAllBridges()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(IMAGES_DIR, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  closeAllBridges()
  resetChatTurnRelayState()
  resetSendOnce()
})

describe('a chat retry on the companion runs when the first attempt\'s turn never started', () => {
  it('a retry after the relay failed (primary away) runs once the primary is back', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      const first = await postWithId(conv.id, 'retry hello', 'qm-cloud-away-1')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'error', 30_000)

      const primary = connectFakePrimary()
      primary.onControl = () => ACCEPT
      try {
        const retry = await postWithId(conv.id, 'retry hello', 'qm-cloud-away-1')
        expect(retry.status).toBe(202)
        expect(retry.body.duplicate).not.toBe(true)
        const [uplink] = await primary.waitForTurnUplinks(1, 8_000)
        expect(uplink.params).toMatchObject({ conversationId: conv.id, text: 'retry hello', turnId: retry.body.turnId })
      } finally {
        primary.close()
      }
    } finally {
      sse.close()
    }
  }, 60_000)

  it('a retry after the primary refused with its own turn running is relayed again', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    try {
      primary.onControl = () => PRIMARY_BUSY
      expect((await postWithId(conv.id, 'refused once', 'qm-cloud-busy-1')).status).toBe(202)
      await sse.waitFor((e) => e.event === 'error' && String(e.data.message).includes('busy on the primary'))

      primary.onControl = () => ACCEPT
      const retry = await postWithId(conv.id, 'refused once', 'qm-cloud-busy-1')
      expect(retry.status).toBe(202)
      expect(retry.body.duplicate).not.toBe(true)
      const uplinks = await primary.waitForTurnUplinks(2)
      expect(uplinks[1].params?.turnId).toBe(retry.body.turnId)
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)

  it('a repeat after the primary accepted is answered once and relays nothing', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    try {
      primary.onControl = () => ACCEPT
      const first = await postWithId(conv.id, 'taken', 'qm-cloud-taken-1')
      expect(first.status).toBe(202)
      await primary.waitForTurnUplinks(1)
      // The relay's accept reply rides the next tick: let it land.
      await new Promise((r) => setTimeout(r, 100))

      const repeat = await postWithId(conv.id, 'taken', 'qm-cloud-taken-1')
      expect(repeat).toEqual({ status: 202, body: { turnId: first.body.turnId, duplicate: true } })
      primary.pushChatFrame(conv.id, String(first.body.turnId), 'message-end', { text: 'ok' })
      await sse.waitFor((e) => e.event === 'message-end')
      await new Promise((r) => setTimeout(r, 200))
      expect(primary.turnUplinks()).toHaveLength(1)
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)

  it('a repeat while the relay is unanswered waits, and is answered by an accept as the same turn', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    let answer: (reply: ControlReply) => void = () => {}
    try {
      primary.onControl = () => new Promise<ControlReply>((resolve) => { answer = resolve })
      const first = await postWithId(conv.id, 'slow primary', 'qm-cloud-slow-1')
      expect(first.status).toBe(202)
      await primary.waitForTurnUplinks(1)

      let settled = false
      const repeat = postWithId(conv.id, 'slow primary', 'qm-cloud-slow-1').finally(() => { settled = true })
      await new Promise((r) => setTimeout(r, 300))
      expect(settled).toBe(false)
      answer(ACCEPT)
      expect(await repeat).toEqual({ status: 202, body: { turnId: first.body.turnId, duplicate: true } })
      expect(primary.turnUplinks()).toHaveLength(1)
      primary.pushChatFrame(conv.id, String(first.body.turnId), 'message-end', { text: 'ok' })
      await sse.waitFor((e) => e.event === 'message-end')
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)

  it('a repeat while the relay is unanswered becomes the next attempt when that relay is refused', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    let answer: (reply: ControlReply) => void = () => {}
    try {
      primary.onControl = () => new Promise<ControlReply>((resolve) => { answer = resolve })
      expect((await postWithId(conv.id, 'refused late', 'qm-cloud-late-1')).status).toBe(202)
      await primary.waitForTurnUplinks(1)

      const repeat = postWithId(conv.id, 'refused late', 'qm-cloud-late-1')
      await new Promise((r) => setTimeout(r, 300))
      const firstAnswer = answer
      primary.onControl = () => ACCEPT
      firstAnswer(PRIMARY_BUSY)
      const second = await repeat
      expect(second.status).toBe(202)
      expect(second.body.duplicate).not.toBe(true)
      const uplinks = await primary.waitForTurnUplinks(2)
      expect(uplinks[1].params?.turnId).toBe(second.body.turnId)
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)
})

describe('a relay that may have reached the primary: the primary decides (send-once gate r1, MEDIUM-1)', () => {
  it('G-C1: no accept came back, the retry is relayed again under the same ids, and the primary runs it once', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    const there = new EmulatedPrimary()
    try {
      // The primary takes the turn, and its accept never comes back.
      primary.onControl = (frame) => { there.take(frame); return 'never' }
      const first = await postWithId(conv.id, 'ambiguous hello', 'qm-cloud-unsure-1')
      expect(first.status).toBe(202)
      const turnId = first.body.turnId

      // A repeat while that relay is unanswered is answered before the phone's own
      // 30 s request timeout (send-once gate r1, LOW-2): busy, which is the truth.
      const t0 = Date.now()
      const waiting = await postWithId(conv.id, 'ambiguous hello', 'qm-cloud-unsure-1')
      const waitedMs = Date.now() - t0
      expect(waiting.status).toBe(409)
      expect((waiting.body.error as { code?: string })?.code).toBe('turn_active')
      expect(waitedMs).toBeGreaterThanOrEqual(15_000)
      expect(waitedMs).toBeLessThan(25_000)

      await sse.waitFor((e) => e.event === 'error', 45_000)
      // The turn ended over there meanwhile.
      there.running.clear()
      primary.onControl = (frame) => there.take(frame)
      const retry = await postWithId(conv.id, 'ambiguous hello', 'qm-cloud-unsure-1')
      expect(retry).toEqual({ status: 202, body: { turnId, duplicate: true } })
      expect(uplinkIds(primary)).toEqual([
        { turnId, messageId: 'qm-cloud-unsure-1' },
        { turnId, messageId: 'qm-cloud-unsure-1' },
      ])
      expect(there.turns).toHaveLength(1)

      // Now the id is started here too: a later repeat relays nothing.
      const again = await postWithId(conv.id, 'ambiguous hello', 'qm-cloud-unsure-1')
      expect(again).toEqual({ status: 202, body: { turnId, duplicate: true } })
      expect(primary.turnUplinks()).toHaveLength(2)
    } finally {
      primary.close()
      sse.close()
    }
  }, 120_000)

  it('G-C2: the bridge died right after the send, and the retry over a new bridge is answered once', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const there = new EmulatedPrimary()
    let primary = connectFakePrimary()
    try {
      primary.onControl = (frame) => { there.take(frame); return 'close' }
      const first = await postWithId(conv.id, 'died after send', 'qm-cloud-died-1')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'error', 45_000)
      const firstUplinks = uplinkIds(primary)
      expect(firstUplinks).toEqual([{ turnId: first.body.turnId, messageId: 'qm-cloud-died-1' }])

      primary = connectFakePrimary()
      primary.onControl = (frame) => there.take(frame)
      const retry = await postWithId(conv.id, 'died after send', 'qm-cloud-died-1')
      // Still running over there: the duplicate keeps the turn's frames coming here.
      expect(retry).toEqual({ status: 202, body: { turnId: first.body.turnId, duplicate: true } })
      expect(uplinkIds(primary)).toEqual([{ turnId: first.body.turnId, messageId: 'qm-cloud-died-1' }])
      expect(there.turns).toHaveLength(1)
      primary.pushChatFrame(conv.id, String(first.body.turnId), 'text-delta', { delta: 'late ' })
      primary.pushChatFrame(conv.id, String(first.body.turnId), 'message-end', { fullText: 'late answer' })
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.fullText).toBe('late answer')
    } finally {
      primary.close()
      sse.close()
    }
  }, 60_000)

  it('the gate\'s own G-C1 and G-C2 shape: a primary that accepts anything sees one turnId', async () => {
    // The gate's fake primary dedupes nothing; what it can assert is that the retry
    // is relayed under the first relay's turnId (the primary's turnId dedupe, which
    // an older primary has too) and with the message id.
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    let primary = connectFakePrimary()
    try {
      primary.onControl = () => 'close'
      const first = await postWithId(conv.id, 'gate shape', 'qm-cloud-gate-1')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'error', 45_000)
      primary = connectFakePrimary()
      primary.onControl = () => ACCEPT
      const retry = await postWithId(conv.id, 'gate shape', 'qm-cloud-gate-1')
      expect(retry.status).toBe(202)
      expect(retry.body.turnId).toBe(first.body.turnId)
      expect(uplinkIds(primary)).toEqual([{ turnId: first.body.turnId, messageId: 'qm-cloud-gate-1' }])
    } finally {
      primary.close()
      sse.close()
    }
  }, 60_000)

  it('an unsure relay the primary never got runs on the retry, once', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const there = new EmulatedPrimary()
    let primary = connectFakePrimary()
    try {
      // Lost on the way: the bridge dies with the frame, the primary never saw it.
      primary.onControl = () => 'close'
      const first = await postWithId(conv.id, 'lost on the way', 'qm-cloud-lost-1')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'error', 45_000)
      primary = connectFakePrimary()
      primary.onControl = (frame) => there.take(frame)
      const retry = await postWithId(conv.id, 'lost on the way', 'qm-cloud-lost-1')
      expect(retry).toEqual({ status: 202, body: { turnId: first.body.turnId } })
      expect(there.turns).toEqual([{ turnId: first.body.turnId, messageId: 'qm-cloud-lost-1' }])
      primary.pushChatFrame(conv.id, String(first.body.turnId), 'message-end', { fullText: 'ran once' })
      await sse.waitFor((e) => e.event === 'message-end')
    } finally {
      primary.close()
      sse.close()
    }
  }, 60_000)

  it('a retry of an unsure relay that cannot reach the primary is told so, and the id stays for the next one', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const there = new EmulatedPrimary()
    let primary = connectFakePrimary()
    try {
      primary.onControl = (frame) => { there.take(frame); return 'close' }
      const first = await postWithId(conv.id, 'still away', 'qm-cloud-away-2')
      expect(first.status).toBe(202)
      await sse.waitFor((e) => e.event === 'error', 45_000)
      // No bridge at all now: the retry is answered by what its relay did.
      const errorsBefore = sse.events.filter((e) => e.event === 'error').length
      const away = await postWithId(conv.id, 'still away', 'qm-cloud-away-2')
      expect(away.status).toBe(503)
      expect((away.body.error as { code?: string })?.code).toBe('primary_unreachable')
      await new Promise((r) => setTimeout(r, 200))
      expect(sse.events.filter((e) => e.event === 'error').length, 'the POST answered, so no stream error as well')
        .toBe(errorsBefore)
      primary = connectFakePrimary()
      primary.onControl = (frame) => there.take(frame)
      const back = await postWithId(conv.id, 'still away', 'qm-cloud-away-2')
      expect(back.status).toBe(202)
      expect(back.body.turnId).toBe(first.body.turnId)
      expect(back.body.duplicate).toBe(true)
      expect(there.turns).toHaveLength(1)
    } finally {
      primary.close()
      sse.close()
    }
  }, 60_000)

  it('a message the primary already took (sent to it directly) is not run again through the companion', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    const there = new EmulatedPrimary()
    // The phone posted it to the Mac first; that turn is over.
    there.turns.push({ turnId: 'turn-on-the-mac', messageId: 'qm-cloud-switch-1' })
    try {
      primary.onControl = (frame) => there.take(frame)
      const first = await postWithId(conv.id, 'switched boxes', 'qm-cloud-switch-1')
      expect(first.status).toBe(202)
      // Nothing comes from the primary for a finished turn: the companion ends it.
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.turnId).toBe(first.body.turnId)
      expect(there.turns).toHaveLength(1)
      const repeat = await postWithId(conv.id, 'switched boxes', 'qm-cloud-switch-1')
      expect(repeat).toEqual({ status: 202, body: { turnId: 'turn-on-the-mac', duplicate: true } })
      expect(primary.turnUplinks()).toHaveLength(1)
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)
})

describe('a relayed repeat the primary is still running under its first turnId', () => {
  it('its frames, which ride that turnId, reach the phone', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    const there = new EmulatedPrimary()
    // A companion that restarted has forgotten its unsure relay: the retry comes
    // under a new turnId, while the primary still runs the first one.
    there.turns.push({ turnId: 'turn-first-relay', messageId: 'qm-cloud-rekey-1' })
    there.running.add('turn-first-relay')
    try {
      primary.onControl = (frame) => there.take(frame)
      const first = await postWithId(conv.id, 'still running there', 'qm-cloud-rekey-1')
      expect(first.status).toBe(202)
      await primary.waitForTurnUplinks(1)
      await new Promise((r) => setTimeout(r, 100))
      primary.pushChatFrame(conv.id, 'turn-first-relay', 'text-delta', { delta: 'from the first ' })
      primary.pushChatFrame(conv.id, 'turn-first-relay', 'message-end', { fullText: 'from the first relay' })
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.fullText).toBe('from the first relay')
      expect(there.turns).toHaveLength(1)
      const repeat = await postWithId(conv.id, 'still running there', 'qm-cloud-rekey-1')
      expect(repeat).toEqual({ status: 202, body: { turnId: 'turn-first-relay', duplicate: true } })
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)
})

describe('two repeats waiting on one claim (send-once gate r1, LOW-1)', () => {
  it('G-C3: the relay is refused, one repeat becomes the next attempt, and the other is answered by it', async () => {
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    const primary = connectFakePrimary()
    let answer: (reply: ControlReply) => void = () => {}
    try {
      primary.onControl = () => new Promise<ControlReply>((resolve) => { answer = resolve })
      expect((await postWithId(conv.id, 'two waiters', 'qm-cloud-two-1')).status).toBe(202)
      await primary.waitForTurnUplinks(1)
      const r1 = postWithId(conv.id, 'two waiters', 'qm-cloud-two-1')
      const r2 = postWithId(conv.id, 'two waiters', 'qm-cloud-two-1')
      await new Promise((r) => setTimeout(r, 300))
      const firstAnswer = answer
      primary.onControl = () => ACCEPT
      firstAnswer(PRIMARY_BUSY)
      const [a1, a2] = await Promise.all([r1, r2])
      await new Promise((r) => setTimeout(r, 300))
      expect([a1.status, a2.status]).toEqual([202, 202])
      expect(a1.body.turnId).toBe(a2.body.turnId)
      expect([a1, a2].filter((a) => a.body.duplicate === true)).toHaveLength(1)
      expect(primary.turnUplinks()).toHaveLength(2)
      primary.pushChatFrame(conv.id, String(a1.body.turnId), 'message-end', { fullText: 'once' })
      await sse.waitFor((e) => e.event === 'message-end')
    } finally {
      primary.close()
      sse.close()
    }
  }, 30_000)
})
