/**
 * POST /api/v1/conversations/:id/messages on a CLOUD REPLICA — the chat turn is
 * relayed to the primary so it runs on the PRIMARY's engine (claude-code),
 * instead of the replica's in-process walnut-agent loop.
 *
 * Real startServer with CLOUD_MODE forced, and a real /bridge socket driven
 * through the actual attachBridge/handleFrame path — so the hello handshake,
 * the `session.control` uplink framing, the reverse `mobile-event` downlink, the
 * __local__ trust gate and the kind allowlist are all exercised for real. The
 * test process plays the PRIMARY's daemon: it answers the uplink RPC and pushes
 * frames back, which is exactly the contract the real primary implements.
 *
 * What each case pins down:
 *  - the uplink carries (agentId, conversationId, text, turnId) to the primary;
 *  - downlink deltas + message-end reach THIS conversation's SSE stream, with
 *    the answering engine stamped on the terminal frame;
 *  - the replica writes NO chat history for a relayed turn (the primary is the
 *    single writer — two writers would double every message under git-sync);
 *  - bridge down degrades to the local loop and marks the terminal frame.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-relay-cloud', { CLOUD_MODE: true }))

// The ONLY mock: the model call itself (project rule — mock the engine, never
// the plumbing). Everything the feature owns (HTTP, bridge protocol, relay,
// SSE, persistence) is real. Without this the fallback case makes a live Bedrock
// call whose latency under machine load, not the code, decides pass/fail.
vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (
    userContent: string | unknown[],
    _history: unknown,
    callbacks: { onTextDelta?: (d: string) => void },
  ) => {
    callbacks.onTextDelta?.('local ')
    callbacks.onTextDelta?.('fallback answer')
    return {
      response: 'local fallback answer',
      newMessages: [
        { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
        { role: 'assistant', content: [{ type: 'text', text: 'local fallback answer' }] },
      ],
    }
  }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'
import { resetChatTurnRelayState } from '../../../src/web/routes/chat-turn-relay.js'

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// ── Fake bridge socket standing in for the PRIMARY's daemon ──

interface UplinkFrame { id: number; cmd: string; action?: string; params?: Record<string, unknown> }

class FakePrimaryDaemon extends EventEmitter {
  /** Uplink RPCs the cloud sent us. */
  received: UplinkFrame[] = []
  /** Reply factory for `session.control` — set per test. */
  onControl: ((frame: UplinkFrame) => Record<string, unknown>) | null = null

  send(payload: string): void {
    const frame = JSON.parse(payload) as UplinkFrame
    this.received.push(frame)
    if (frame.cmd === 'session.control' && this.onControl) {
      const reply = this.onControl(frame)
      // Answer on the next tick, like a real round trip.
      setTimeout(() => this.inbound({ id: frame.id, ...reply }), 0)
    }
  }

  close(): void { this.emit('close') }

  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  /** Push one chat-turn SSE frame down the reverse `mobile-event` lane. */
  pushChatFrame(conversationId: string, turnId: string, event: string, data: unknown): void {
    this.inbound({
      ev: 'mobile-event',
      kind: 'chat-turn-frame',
      data: { conversationId, turnId, event, data },
    })
  }

  /** Wait for the uplink relay RPC for a given action. */
  async waitForControl(action: string, timeoutMs = 10_000): Promise<UplinkFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.received.find((f) => f.cmd === 'session.control' && f.action === action)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`uplink ${action} never arrived`)
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

// ── Minimal SSE client ──

interface SseEvt { event: string; data: Record<string, unknown> }

async function connectSse(url: string): Promise<{
  events: SseEvt[]
  waitFor: (pred: (e: SseEvt) => boolean, timeoutMs?: number) => Promise<SseEvt>
  close: () => void
}> {
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

async function postMessage(conversationId: string, text: string): Promise<{ status: number; turnId: string }> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, turnId: (body as { turnId?: string }).turnId ?? '' }
}

/** The replica's own copy of a conversation's chat history (must stay empty
 *  for a relayed turn — the primary is the single writer). */
async function readReplicaHistory(conversationId: string): Promise<unknown[]> {
  const file = path.join(WALNUT_HOME, 'conversations', 'general', `${conversationId}.json`)
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as { entries?: unknown[] }
    return raw.entries ?? []
  } catch {
    return []
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
  const device = await createDevice('chat-relay-cloud-test-phone')
  deviceToken = device.token
}, 60_000)

afterAll(async () => {
  closeAllBridges()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  closeAllBridges()
  resetChatTurnRelayState()
})

describe('a relayed chat turn runs on the primary\'s engine', () => {
  it('uplinks the turn and streams the primary\'s answer onto this conversation\'s SSE', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { accepted: true, engine: 'claude-code' } })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      const posted = await postMessage(conv.id, 'what engine are you?')
      expect(posted.status).toBe(202)

      // ── Uplink: the primary got the whole turn, on the box-level relay sid ──
      const uplink = await primary.waitForControl('server.chat.turn')
      expect(uplink.params).toEqual({
        agentId: 'general',
        conversationId: conv.id,
        text: 'what engine are you?',
        turnId: posted.turnId,
      })

      // ── Downlink: the primary's frames reach the phone's SSE stream ──
      primary.pushChatFrame(conv.id, posted.turnId, 'message-start', { turnId: posted.turnId })
      await sse.waitFor((e) => e.event === 'message-start')

      primary.pushChatFrame(conv.id, posted.turnId, 'text-delta', { delta: 'Claude ' })
      primary.pushChatFrame(conv.id, posted.turnId, 'text-delta', { delta: 'Code.' })
      await sse.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'Code.')

      primary.pushChatFrame(conv.id, posted.turnId, 'tool', { name: 'Read', detail: 'notes.md' })
      const tool = await sse.waitFor((e) => e.event === 'tool')
      expect(tool.data.name).toBe('Read')

      primary.pushChatFrame(conv.id, posted.turnId, 'message-end', {
        turnId: posted.turnId, fullText: 'Claude Code.',
      })
      const end = await sse.waitFor((e) => e.event === 'message-end')
      expect(end.data.fullText).toBe('Claude Code.')
      // The whole point: the answer came from the primary's claude-code engine.
      expect(end.data.engine).toBe('claude-code')

      // ── Single writer: the replica persisted NOTHING for this turn ──
      // (the primary owns chat-history for a relayed turn; both writing would
      // double every message once git-sync converged)
      expect(await readReplicaHistory(conv.id)).toEqual([])
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)

  it('the primary\'s 409 rides through as an SSE error, and does NOT run a second turn locally', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: { accepted: false, reason: 'turn_active', message: 'A turn is already active on this conversation' },
    })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      expect((await postMessage(conv.id, 'hi')).status).toBe(202)
      const err = await sse.waitFor((e) => e.event === 'error')
      expect(String(err.data.message)).toContain('already active')
      // No local fallback turn: nothing was persisted here.
      expect(await readReplicaHistory(conv.id)).toEqual([])
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)

  it('drops a downlink frame that names an event outside the allowlist', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { accepted: true, engine: 'claude-code' } })

    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      const posted = await postMessage(conv.id, 'hi')
      await primary.waitForControl('server.chat.turn')
      const before = sse.events.length

      primary.pushChatFrame(conv.id, posted.turnId, 'evil-event', { x: 1 })
      await new Promise((r) => setTimeout(r, 300))
      expect(sse.events.length).toBe(before)

      // Stream still healthy for a legitimate frame afterwards.
      primary.pushChatFrame(conv.id, posted.turnId, 'text-delta', { delta: 'ok' })
      await sse.waitFor((e) => e.event === 'text-delta' && e.data.delta === 'ok')
    } finally {
      sse.close()
      primary.close()
    }
  }, 40_000)
})

describe('degradation: no bridge → the replica answers locally, and says so', () => {
  it('falls back to the in-process loop and marks the terminal frame', async () => {
    // No bridge connected at all: callPrimaryControl fails with BridgeOfflineError.
    const conv = await createConversation('general')
    const sse = await connectSse(apiUrl(`/api/v1/conversations/${conv.id}/stream`))
    try {
      expect((await postMessage(conv.id, 'hello with no bridge')).status).toBe(202)

      // The user still gets a real answer — the degradation is never an error.
      const end = await sse.waitFor((e) => e.event === 'message-end', 30_000)
      expect(end.data.fullText).toBe('local fallback answer')
      // …and it is marked, so a degraded box is observable without a client change.
      expect(end.data.engine).toBe('walnut-agent-fallback')

      // The local loop IS the writer on the fallback path — both the user's
      // message and the answer must be on THIS box's disk, or a phone reload
      // would lose the turn (the relayed path is the opposite: zero writes here).
      const entries = await readReplicaHistory(conv.id) as Array<{ role?: string }>
      expect(entries.filter((e) => e.role === 'user').length).toBe(1)
      expect(entries.filter((e) => e.role === 'assistant').length).toBe(1)
    } finally {
      sse.close()
    }
  }, 60_000)
})
