/**
 * `inFlight` on a CLOUD REPLICA: the primary's verdict, handed back untouched.
 *
 * The phone is paired to the replica, so the row marker that tells it "this turn is
 * still running" has to survive the relay. Only the primary can know: the turn runs
 * there (chat-turn-relay.ts) and the lane transcript is its file. So the replica
 * must not compute, drop, or re-page the field, and this pins that it does not.
 *
 * Real: startServer with CLOUD_MODE forced, a real /bridge socket through
 * attachBridge/handleFrame (hello handshake, `session.control` uplink framing), the
 * conversation registry and the chat-history store. The test process plays the
 * PRIMARY's daemon and answers the uplink RPC exactly as the real one does.
 *
 * Siblings: api-v1-lane-messages-inflight.test.ts (the primary that produces the
 * marker), api-v1-lane-messages-cloud.test.ts (the relay itself).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-inflight-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { createConversation } from '../../../src/core/conversations.js'

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
}

function connectFakePrimary(): FakePrimaryDaemon {
  const ws = new FakePrimaryDaemon()
  attachBridge(ws as never, 'bridge-local')
  ws.inbound({ ev: 'hello', hostAlias: '__local__', version: 'test', instanceId: 'i-test', sids: [] })
  return ws
}

interface V1Message {
  id: string
  role: string
  text: string
  kind?: string
  detail?: string
  inFlight?: true
}

async function getMessages(convId: string, qs = ''): Promise<V1Message[]> {
  const res = await fetch(apiUrl(`/api/v1/conversations/${convId}/messages${qs}`), {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  expect(res.status).toBe(200)
  return await res.json() as V1Message[]
}

/**
 * What the primary answers mid-turn: one finished turn, then the running turn's
 * user row and the two rows it has produced so far. The tool has not returned, so
 * it carries no `resultPreview` and `inFlight` is the only "wait" signal.
 */
const MID_TURN_ROWS: V1Message[] = [
  { id: 'm0', role: 'user', text: 'earlier question' },
  { id: 'm1', role: 'assistant', text: 'earlier answer' },
  { id: 'm2', role: 'user', text: 'run it' },
  { id: 'm3', role: 'assistant', text: 'I will run the first command...', inFlight: true },
  { id: 'm4', role: 'assistant', text: 'Bash', kind: 'tool', detail: 'sleep 45', inFlight: true },
]

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('inflight-cloud-test-phone')
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

describe('cloud replica', () => {
  it("returns the primary's inFlight rows verbatim, on the full page and on a tail page", async () => {
    const primary = connectFakePrimary()
    // The primary owns the cursor space, so the fake pages like it does.
    primary.onControl = (frame) => {
      const p = frame.params ?? {}
      const limit = Number(p.limit) || 50
      let rows = MID_TURN_ROWS
      if (typeof p.before === 'string') {
        rows = rows.slice(0, Math.max(0, Number(String(p.before).replace(/^m/, ''))))
      }
      return { ok: true, result: { messages: rows.slice(-limit), source: 'lane', known: true } }
    }
    const conv = await createConversation('general')
    try {
      const all = await getMessages(conv.id, '?limit=50')
      // Byte-identical: the replica neither strips the additive field nor adds one.
      expect(all).toEqual(MID_TURN_ROWS)
      expect(all.map((m) => m.inFlight)).toEqual([undefined, undefined, undefined, true, true])
      expect(Object.keys(all[2])).not.toContain('inFlight')

      // A tail page carries the same marks: paging happens on the primary, and the
      // replica must not re-derive the flag for the window it hands back.
      const tail = await getMessages(conv.id, '?limit=2')
      expect(tail).toEqual(MID_TURN_ROWS.slice(-2))
      expect(tail.every((m) => m.inFlight === true)).toBe(true)

      // An older page is entirely outside the running turn.
      const older = await getMessages(conv.id, '?limit=2&before=m3')
      expect(older.map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(older.every((m) => !('inFlight' in m))).toBe(true)
    } finally {
      primary.close()
    }
  }, 30_000)

  it('carries no marker once the primary reports the turn finished', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: {
        messages: MID_TURN_ROWS.map(({ inFlight: _drop, ...row }) => row),
        source: 'lane', known: true,
      },
    })
    const conv = await createConversation('general')
    try {
      const all = await getMessages(conv.id, '?limit=50')
      expect(all.every((m) => !('inFlight' in m))).toBe(true)
    } finally {
      primary.close()
    }
  }, 30_000)
})
