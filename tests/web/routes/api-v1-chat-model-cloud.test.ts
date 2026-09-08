/**
 * The chat model pill on a CLOUD REPLICA.
 *
 * The phone is paired to the replica, and a chat turn there is RELAYED to the
 * primary — so "which engine answers, on which model, out of which catalog" are
 * facts about the primary, and so is the write that changes them. This file pins
 * both halves of that:
 *
 *   bridge up   → GET /chat/engine and PUT /chat/model cross the bridge as the
 *                 box-level control actions `server.chat.engine` /
 *                 `server.chat.model`, and the primary's body comes back verbatim.
 *   bridge down → 503 `primary_unreachable` + `retry: true`, NEVER this box's own
 *                 config. Answering locally is what put a read-only pill on the
 *                 phone reading "the model comes from the server's config": a
 *                 description of a fallback loop that answers almost no turns,
 *                 with the pill locked by its reason.
 *
 * Real: startServer with CLOUD_MODE forced, a real /bridge socket through the
 * actual attachBridge/handleFrame path, the conversation registry. The test process
 * plays the primary's daemon. Mocked: constants (temp dirs + CLOUD_MODE) and the
 * agent loop (no turn is posted; the mock only guarantees a regression cannot reach
 * a live provider).
 *
 * Sibling (primary box, no bridge): api-v1-chat-model.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-model-cloud', { CLOUD_MODE: true }))

vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async () => ({ messages: [], newMessages: [], response: '', aborted: false })),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation, getConversationModel } from '../../../src/core/conversations.js'

let server: HttpServer
let port: number
let deviceToken: string

const PRIMARY_MODEL = 'global.anthropic.claude-sonnet-4-6'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

interface UplinkFrame {
  id: number
  cmd: string
  action?: string
  params?: Record<string, unknown>
}

/** Stand-in for the primary's daemon: answers `session.control` uplinks. */
class FakePrimaryDaemon extends EventEmitter {
  received: UplinkFrame[] = []
  onControl: ((frame: UplinkFrame) => Record<string, unknown>) | null = null

  send(payload: string): void {
    const frame = JSON.parse(payload) as UplinkFrame
    this.received.push(frame)
    if (frame.cmd === 'session.control' && this.onControl) {
      const reply = this.onControl(frame)
      setTimeout(() => this.inbound({ id: frame.id, ...reply }), 0)
    }
  }

  close(): void { this.emit('close') }

  inbound(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  controlFrames(action: string): UplinkFrame[] {
    return this.received.filter((f) => f.cmd === 'session.control' && f.action === action)
  }
}

function connectFakePrimary(): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

async function getEngine(convId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl(`/api/v1/chat/engine?conversationId=${convId}`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function putModel(
  convId: string, body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl(`/api/v1/chat/model?conversationId=${convId}`), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('chat-model-cloud-test-phone')
  deviceToken = device.token
}, 60_000)

afterAll(async () => {
  closeAllBridges()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  closeAllBridges()
})

describe('bridge up', () => {
  it("GET returns the PRIMARY's engine answer, catalog and all", async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: {
        engine: 'in-process',
        sessionId: null,
        switchable: true,
        model: PRIMARY_MODEL,
        effort: null,
        models: [{ id: PRIMARY_MODEL, label: 'Sonnet 4.6', supportsEffort: false }],
      },
    })
    const conv = await createConversation('general')
    try {
      const got = await getEngine(conv.id)
      expect(got.status).toBe(200)
      // Verbatim: the replica has no say in the answer, including the catalog.
      expect(got.body.switchable).toBe(true)
      expect(got.body.model).toBe(PRIMARY_MODEL)
      expect(got.body.models).toEqual([{ id: PRIMARY_MODEL, label: 'Sonnet 4.6', supportsEffort: false }])
      expect(primary.controlFrames('server.chat.engine')).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 30_000)

  it('PUT relays server.chat.model and hands back the primary\'s body', async () => {
    const primary = connectFakePrimary()
    primary.onControl = (frame) => ({
      ok: true,
      result: { model: (frame.params ?? {}).model ?? null, effort: null },
    })
    const conv = await createConversation('general')
    try {
      const res = await putModel(conv.id, { model: PRIMARY_MODEL })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ model: PRIMARY_MODEL, effort: null })

      const frames = primary.controlFrames('server.chat.model')
      expect(frames).toHaveLength(1)
      expect(frames[0].params).toEqual({
        agentId: 'general', conversationId: conv.id, model: PRIMARY_MODEL,
      })

      // The pick lives on the box that runs the turn. Storing it here too would put
      // the user's choice on the one box that never answers.
      expect(await getConversationModel('general', conv.id)).toEqual({})
    } finally {
      primary.close()
    }
  }, 30_000)

  it('a clear relays null rather than dropping the field', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { model: null, effort: null } })
    const conv = await createConversation('general')
    try {
      const res = await putModel(conv.id, { model: null })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ model: null, effort: null })
      expect(primary.controlFrames('server.chat.model')[0].params).toEqual({
        agentId: 'general', conversationId: conv.id, model: null,
      })
    } finally {
      primary.close()
    }
  }, 30_000)

  it("passes a primary REFUSAL through with its own code (it ran the action)", async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: false, error: 'This conversation answers on a lane session', errorKind: 'conflict', errorCode: 'lane_engine',
    })
    const conv = await createConversation('general')
    try {
      const res = await putModel(conv.id, { model: PRIMARY_MODEL })
      expect(res.status).toBe(409)
      expect((res.body.error as { code: string }).code).toBe('lane_engine')
    } finally {
      primary.close()
    }
  }, 30_000)

  it('an old primary that never heard of the action is a retryable 503, not a local answer', async () => {
    const primary = connectFakePrimary()
    // Verbatim shape of an older primary's refusal. It self-heals on the next
    // deploy/reconnect, which is exactly what `retry: true` tells the phone.
    primary.onControl = () => ({ error: 'Unknown control action: server.chat.model' })
    const conv = await createConversation('general')
    try {
      const res = await putModel(conv.id, { model: PRIMARY_MODEL })
      expect(res.status).toBe(503)
      expect((res.body.error as { code: string }).code).toBe('primary_unreachable')
      expect(res.body.retry).toBe(true)
    } finally {
      primary.close()
    }
  }, 30_000)

  it('rejects a malformed body locally, without spending a bridge round trip', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { model: null, effort: null } })
    const conv = await createConversation('general')
    try {
      expect((await putModel(conv.id, { model: 5 })).status).toBe(400)
      expect((await putModel(conv.id, {})).status).toBe(400)
      expect(primary.controlFrames('server.chat.model')).toHaveLength(0)
    } finally {
      primary.close()
    }
  }, 30_000)
})

describe('bridge down', () => {
  it('GET says the primary is unreachable instead of describing THIS box', async () => {
    const conv = await createConversation('general')
    const got = await getEngine(conv.id)
    expect(got.status).toBe(503)
    expect((got.body.error as { code: string }).code).toBe('primary_unreachable')
    expect(got.body.retry).toBe(true)
    // The old body is the regression to watch for: `engine: 'in-process'` from this
    // replica's own config, which locked the phone's pill with the wrong reason.
    expect(got.body.engine).toBeUndefined()
    expect(got.body.models).toBeUndefined()
  }, 30_000)

  it('PUT refuses instead of writing the pick on the box that never answers', async () => {
    const conv = await createConversation('general')
    const res = await putModel(conv.id, { model: PRIMARY_MODEL })
    expect(res.status).toBe(503)
    expect((res.body.error as { code: string }).code).toBe('primary_unreachable')
    expect(res.body.retry).toBe(true)
    expect(await getConversationModel('general', conv.id)).toEqual({})
  }, 30_000)

  it('the lane-minting POST degrades the same way', async () => {
    const conv = await createConversation('general')
    const res = await fetch(apiUrl(`/api/v1/chat/engine/session?conversationId=${conv.id}`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string }; retry?: boolean }
    expect(body.error.code).toBe('primary_unreachable')
    expect(body.retry).toBe(true)
  }, 30_000)
})
