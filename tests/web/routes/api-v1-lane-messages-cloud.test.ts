/**
 * GET /api/v1/conversations/:id/messages on a CLOUD REPLICA.
 *
 * The user's phone is paired to the replica, so the lane-transcript read has to
 * work THERE — and it cannot be done locally: session records are machine-local
 * and the bridge transcript lane resolves a session's host through the session
 * projection, which excludes lane-bound records. So the replica relays the whole
 * read as the box-level control action `server.chat.messages` (host '__local__',
 * sessionId '__server__' — the same shape core/push/relay.ts and the human inbox
 * use), and hands the primary's already-paged body straight back.
 *
 * Real: startServer with CLOUD_MODE forced, a real /bridge socket through the
 * actual attachBridge/handleFrame path (hello handshake, `session.control`
 * uplink framing, __local__ trust gate), the conversation registry and the
 * chat-history store. The test process plays the PRIMARY's daemon, answering the
 * uplink RPC exactly as the real one does. Mocked: constants (temp dirs +
 * CLOUD_MODE) and the agent loop (no turn is posted; the mock only guarantees a
 * regression can't reach a live provider).
 *
 * Sibling (primary box, no bridge): api-v1-lane-messages.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-lane-messages-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME, conversationIndexFile } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'
import * as chatHistory from '../../../src/core/chat-history.js'

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

interface V1Message { id: string; role: string; text: string; kind?: string }

async function getMessages(convId: string, qs = ''): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages${qs}`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

async function getStatus(convId: string, qs = ''): Promise<{ status: number; code?: string; retry?: boolean }> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages${qs}`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  const body = await res.json().catch(() => ({})) as { error?: { code?: string }; retry?: boolean }
  return { status: res.status, code: body.error?.code, retry: body.retry }
}

/** What the primary would answer for a lane conversation: rows it already paged. */
const LANE_ROWS: V1Message[] = [
  { id: 'm0', role: 'user', text: 'lane question one' },
  { id: 'm1', role: 'assistant', text: 'lane answer one' },
  { id: 'm2', role: 'user', text: 'lane question two' },
  { id: 'm3', role: 'assistant', text: 'Bash', kind: 'tool' },
  { id: 'm4', role: 'assistant', text: 'lane answer two' },
]

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('lane-messages-cloud-test-phone')
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
  it("relays the read and returns the primary's already-paged lane rows", async () => {
    const primary = connectFakePrimary()
    // The primary applies the paging (it owns the cursor space), so the fake does
    // too — this is what proves the replica hands the body back untouched.
    primary.onControl = (frame) => {
      const p = frame.params ?? {}
      const limit = Number(p.limit) || 50
      let rows = LANE_ROWS
      if (typeof p.before === 'string') {
        rows = rows.slice(0, Math.max(0, Number(String(p.before).replace(/^m/, ''))))
      }
      return { ok: true, result: { messages: rows.slice(-limit), source: 'lane', known: true } }
    }
    const conv = await createConversation('general')
    try {
      const all = await getMessages(conv.id, '?limit=50')
      expect(all).toEqual(LANE_ROWS)

      // The uplink is the box-level control action, with the read's parameters.
      const frames = primary.controlFrames('server.chat.messages')
      expect(frames).toHaveLength(1)
      expect(frames[0].params).toEqual({ agentId: 'general', conversationId: conv.id, limit: 50 })

      // Paging travels to the primary and comes back verbatim — the replica must
      // not re-page a body that is already a page.
      const tail = await getMessages(conv.id, '?limit=2')
      expect(tail.map((m) => m.id)).toEqual(['m3', 'm4'])
      const older = await getMessages(conv.id, '?limit=2&before=m3')
      expect(older.map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(primary.controlFrames('server.chat.messages')[2].params).toEqual({
        agentId: 'general', conversationId: conv.id, limit: 2, before: 'm3',
      })

      // Read-only: the relay never writes the replica's own chat history.
      const { messages: entries } = await chatHistory.getDisplayEntries(1, 100, 'general', conv.id)
      expect(entries).toEqual([])
    } finally {
      primary.close()
    }
  }, 30_000)

  // Stage 4d of docs/plan/walnut-companion-unified-replica.md: a reply this box cannot use
  // is the bridge down. Without the Mac's copy of the conversation, the chat history git
  // sync wrote here is never read: a chat the list says has messages is 503, one with none
  // (made here) is this box's own turns.
  it("the primary does not know the conversation: git's chat history is never served", async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { messages: [], source: 'chat-history', known: false } })
    const conv = await createConversation('general')
    try {
      expect(await getMessages(conv.id, '?limit=50')).toEqual([])
      await chatHistory.addUserMessage('typed on the phone', {
        displayText: 'typed on the phone', agentId: 'general', conversationId: conv.id,
      })
      expect(await getStatus(conv.id, '?limit=50')).toEqual({ status: 503, code: 'primary_unreachable', retry: true })
    } finally {
      primary.close()
    }
  }, 30_000)

  it('the primary is too old to know the action: a 503, not a 500, and one uplink', async () => {
    const primary = connectFakePrimary()
    // Verbatim shape of an older daemon's refusal: this is what makes
    // callPrimaryControl report `needs_upgrade`, and it must degrade, not 500.
    primary.onControl = () => ({ error: 'Unknown control action: server.chat.messages' })
    const conv = await createConversation('general')
    try {
      await chatHistory.addUserMessage('question on an old primary', {
        displayText: 'question on an old primary', agentId: 'general', conversationId: conv.id,
      })
      expect(await getStatus(conv.id, '?limit=50')).toEqual({ status: 503, code: 'primary_unreachable', retry: true })
      expect(primary.controlFrames('server.chat.messages')).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 30_000)

  it('the reply is not the expected shape: never handed to the phone', async () => {
    const primary = connectFakePrimary()
    // `messages` is not an array: a truthy-but-wrong body must never be handed to
    // the phone, because res.json would ship it straight through the frozen v1
    // contract and iOS would fail the whole decode.
    primary.onControl = () => ({ ok: true, result: { messages: { rows: 3 }, known: true } })
    const conv = await createConversation('general')
    try {
      await chatHistory.addUserMessage('question with a broken reply', {
        displayText: 'question with a broken reply', agentId: 'general', conversationId: conv.id,
      })
      expect(await getStatus(conv.id, '?limit=50')).toEqual({ status: 503, code: 'primary_unreachable', retry: true })
    } finally {
      primary.close()
    }
  }, 30_000)
})

describe('bridge down', () => {
  it("never answers from this box's git-synced chat history", async () => {
    // No bridge attached at all: callPrimaryControl fails fast (bridge_offline).
    const conv = await createConversation('general')
    await chatHistory.addUserMessage('offline question', {
      displayText: 'offline question', agentId: 'general', conversationId: conv.id,
    })
    await chatHistory.addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text: 'offline answer' }] }] as never,
      { agentId: 'general', conversationId: conv.id },
    )
    expect(await getStatus(conv.id, '?limit=50')).toEqual({ status: 503, code: 'primary_unreachable', retry: true })
  }, 30_000)

  it('says so instead of answering an empty conversation the index says has messages', async () => {
    // The index proves this conversation HAS turns; this box holds none of them,
    // and 200 [] would tell the phone "this chat is empty", which is what it paints,
    // wiping whatever it had. A thrown error leaves its rows alone and retries.
    const conv = await createConversation('general')
    const indexPath = conversationIndexFile('general')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as {
      conversations: Array<{ id: string; messageCount: number }>
    }
    index.conversations.find((c) => c.id === conv.id)!.messageCount = 11
    await fs.writeFile(indexPath, JSON.stringify(index))
    expect(await getStatus(conv.id, '?limit=50')).toEqual({ status: 503, code: 'primary_unreachable', retry: true })
    // An older page too: [] would tell the phone it reached the start (the Mac's copy
    // answers a page past what it holds the same way, stage 3e).
    expect(await getStatus(conv.id, '?limit=50&before=m4')).toEqual({ status: 503, code: 'primary_unreachable', retry: true })
  }, 30_000)
})
