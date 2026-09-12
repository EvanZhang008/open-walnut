/**
 * GET /api/v1/activity/detail on a CLOUD REPLICA.
 *
 * The phone is often paired to the replica, and that is exactly where the drawer's
 * full-text read cannot be answered locally: the text the row's excerpt cut lives in
 * a CLI session's JSONL on the primary's disk, and a replica has neither the session
 * record nor a way to reach the file. Without the relay, every drawer opened away
 * from home would sit on a clipped excerpt with no way to see the rest.
 *
 * So the replica relays the read as the box-level control action
 * `server.activity.detail` (host '__local__', sessionId '__server__' — the same
 * shape `server.chat.messages` uses) and hands the primary's body straight back.
 *
 * What each case pins: the uplink carries the ref (and only the ref, plus paging
 * when asked); a primary that says the row is gone becomes a 404 the client can act
 * on; and both "no bridge" and "primary too old for this action" become a RETRYABLE
 * 503 rather than a 500 or a false 404 — the difference between a client retrying
 * and a client permanently dropping the fetch.
 *
 * Real: startServer with CLOUD_MODE forced, a real /bridge socket through the actual
 * attachBridge/handleFrame path, device auth. The test process plays the primary's
 * daemon. Mocked: constants (temp dirs + CLOUD_MODE).
 *
 * Sibling (primary box, real JSONL): api-v1-activity-detail.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-activity-detail-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { attachBridge, closeAllBridges } from '../../../src/web/ws/bridge-registry.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let deviceToken: string

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

const REF = '1~sess-cloud-abc~msg_01Zz~k'

async function getDetail(qs: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/api/v1/activity/detail${qs}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('activity-detail-cloud-test-phone')
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

describe('activity detail on a replica', () => {
  it("relays the ref and hands back the primary's body", async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({
      ok: true,
      result: {
        found: true,
        detail: {
          version: 1, kind: 'thinking', text: 'the whole reasoning block',
          textChars: 25, offset: 0, truncated: false,
        },
      },
    })
    try {
      const { status, body } = await getDetail(`?ref=${encodeURIComponent(REF)}`)
      expect(status).toBe(200)
      expect(body.text).toBe('the whole reasoning block')
      expect(body.kind).toBe('thinking')

      const frames = primary.controlFrames('server.activity.detail')
      expect(frames).toHaveLength(1)
      // The ref travels verbatim (the replica does not resolve it) and `offset`
      // defaults rather than being omitted, so the primary never has to guess.
      expect(frames[0].params).toEqual({ ref: REF, offset: 0 })

      // A paging read carries the part and the cursor through unchanged.
      await getDetail(`?ref=${encodeURIComponent(REF)}&part=reasoning&offset=200000`)
      expect(primary.controlFrames('server.activity.detail')[1].params)
        .toEqual({ ref: REF, part: 'reasoning', offset: 200_000 })
    } finally {
      primary.close()
    }
  }, 30_000)

  it('turns the primary\'s "row is gone" into the same 410 the primary would send', async () => {
    // Not a 404, for the reason the primary-side sibling spells out: on this URL a
    // 404 means "this box is older than the feature", and a replica must not blur
    // the two either.
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { found: false } })
    try {
      const { status, body } = await getDetail(`?ref=${encodeURIComponent(REF)}`)
      expect(status).toBe(410)
      expect((body.error as { code: string }).code).toBe('detail_gone')
    } finally {
      primary.close()
    }
  }, 30_000)

  it('answers 503 when the bridge is down or the primary is too old', async () => {
    // No bridge at all: nothing was delivered, so this is retryable, not "gone".
    const offline = await getDetail(`?ref=${encodeURIComponent(REF)}`)
    expect(offline.status).toBe(503)
    expect((offline.body.error as { code: string }).code).toBe('unavailable')

    // An older primary refuses the action verbatim like this. It must degrade the
    // same way rather than 500 — the client keeps its excerpt and may retry later.
    const primary = connectFakePrimary()
    primary.onControl = () => ({ error: 'Unknown control action: server.activity.detail' })
    try {
      const { status, body } = await getDetail(`?ref=${encodeURIComponent(REF)}`)
      expect(status).toBe(503)
      expect((body.error as { code: string }).code).toBe('unavailable')
      expect(primary.controlFrames('server.activity.detail')).toHaveLength(1)
    } finally {
      primary.close()
    }
  }, 30_000)

  it('rejects a malformed ref locally, without waking the bridge', async () => {
    const primary = connectFakePrimary()
    primary.onControl = () => ({ ok: true, result: { found: true, detail: {} } })
    try {
      const bad = await getDetail('?ref=nonsense')
      expect(bad.status).toBe(400)
      // The replica validates with the SAME parser the primary uses, so garbage
      // never costs a bridge round trip.
      expect(primary.controlFrames('server.activity.detail')).toHaveLength(0)
    } finally {
      primary.close()
    }
  }, 30_000)
})
