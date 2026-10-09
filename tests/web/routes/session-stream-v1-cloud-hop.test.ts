/**
 * cloudSend when the Mac cannot reach the session's host (2026-10-01).
 *
 * The phone, through the companion, on a session whose host daemon is on the
 * companion's bridge while the Mac's link to that host is dead. The host daemon
 * answers a relay at once with "no primary server connected" (it forwarded
 * nothing), so the companion may deliver directly, but only when no other copy
 * of that message can exist: the Mac's durable queue and the direct path must
 * never both deliver one messageId. Everything else is held, in the host's name.
 *
 * Contract under test:
 *   1. A held send says who it waits for, by the host's label.
 *   2. A send behind a held one is held too (order), and the sweep delivers both in order.
 *   3. No primary: delivered directly once; a retry of that id is answered, never sent again.
 *   4. A direct send whose answer was lost: 409 delivery_unknown, now and on retry, nothing re-sent.
 *   5. A message whose relay went out once (its answer lost) never goes direct later.
 *   6. Two concurrent attempts at one id: one delivery.
 *   7. The sweep: a held row nothing carried goes direct; a relay-only row waits for
 *      the Mac without holding the other sessions on that host.
 *   8. Wording: names the label, never the alias, never the Mac.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-hop', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

const SID = 'hop-sid-a'
const SID2 = 'hop-sid-b'
const LABEL = 'New big devbox'
let stopRequest: { id: string; state: string } | undefined
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  const row = (id: string) => ({
    id, host: 'devbox', host_label: LABEL, process_status: 'stopped',
    started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
    message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest,
  })
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(), sessions: [row(SID), row(SID2)],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  enqueueSessionSend, flushSendQueue, listBankedSends, queuedSessionSendCount, readSendOutcome,
} from '../../../src/core/send-queue.js'

const NO_PRIMARY = 'session.message: no primary server connected (the last one went quiet 52s ago)'

function createApp() {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use('/api/v1', sessionStreamV1Router)
  return app
}

const post = (sid: string, body: Record<string, unknown>) =>
  request(createApp()).post(`/api/v1/sessions/${sid}/messages`).send(body)

/** The host on the bridge, no primary behind it, a live CLI that takes FIFO writes. */
function hostWithoutPrimary(over: Partial<Record<string, (p: Record<string, unknown>) => unknown>> = {}) {
  bridgeRequestMock.mockImplementation(async (_host: string, cmd: string, params: Record<string, unknown> = {}) => {
    if (over[cmd]) return over[cmd]!(params)
    switch (cmd) {
      case 'session.message': return { ok: false, error: NO_PRIMARY }
      case 'status': return { exists: true, alive: true }
      case 'send': return { ok: true }
      case 'appendUserMarker': return { ok: true }
      default: throw new Error('unexpected command: ' + cmd)
    }
  })
}

/** Text of every FIFO write (`send`) the host was asked for, per session. */
function directSends(sid: string): string[] {
  return bridgeRequestMock.mock.calls.filter((c) => c[1] === 'send' && c[2]?.sid === sid).map((c) => String(c[2].message))
}

function relayedIds(): string[] {
  return bridgeRequestMock.mock.calls.filter((c) => c[1] === 'session.message').map((c) => String(c[2].messageId))
}

/** Human sentences may name the label; never the bare alias, never the Mac. */
function expectHonest(message: string): void {
  expect(message.split(LABEL).join('')).not.toMatch(/\bdevbox\b/)
  expect(message).not.toMatch(/\bMac\b/)
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  stopRequest = undefined
})

afterEach(async () => {
  // Let fire-and-forget drains settle (the host gone, so nothing more is sent)
  // before the next case resets the mock.
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('held sends name the host', () => {
  it('the host off the companion: 202 held, waiting for the label', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await post(SID, { text: 'one', messageId: 'qm-mobile-hop000000001' })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({
      messageId: 'qm-mobile-hop000000001', queued: true, waitingFor: 'devbox', waitingForName: LABEL,
      heldNote: `Can't reach ${LABEL} right now.`,
    })
    const [row] = await listBankedSends()
    expect(row.provablyUnsent, 'nothing carried it anywhere').toBe(true)
  })

  it('a stop still pending names the host', async () => {
    stopRequest = { id: 'stop-1', state: 'pending' }
    const res = await post(SID, { text: 'x' })
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain(LABEL)
    expectHonest(res.body.error.message)
  })

  it('a relay that failed past the companion says so in the host\'s name', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session.message: primary server timed out' })
    const res = await post(SID, { text: 'x', messageId: 'qm-mobile-hop000000002' })
    expect(res.status).toBe(503)
    expect(res.body.error.message).toContain(LABEL)
    expect(directSends(SID)).toEqual([])
  })
})

describe('order: a send behind a held one is held too', () => {
  it('holds the second without relaying it, then the sweep delivers both in order', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post(SID, { text: 'first', messageId: 'qm-mobile-ord000000001' })).status).toBe(202)
    // The drain the answered send starts finds the host still away.
    await new Promise((r) => setTimeout(r, 100))
    await flushSendQueue()
    // The host is back, with no primary behind it. The second send must not
    // overtake the first, so it is held behind it, not relayed or sent now.
    hostWithoutPrimary()
    bridgeRequestMock.mockClear()
    const second = await post(SID, { text: 'second', messageId: 'qm-mobile-ord000000002' })
    expect(second.status).toBe(202)
    expect(second.body.waitingForName).toBe(LABEL)
    await flushSendQueue()
    expect(directSends(SID)).toEqual(['first', 'second'])
    expect(await queuedSessionSendCount()).toBe(0)
    expect((await readSendOutcome(SID, 'qm-mobile-ord000000002'))?.state).toBe('delivered-direct')
  })
})

describe('direct delivery when no primary is behind the host', () => {
  it('delivers once; a retry of the same id is answered from the ledger, not sent again', async () => {
    hostWithoutPrimary()
    const first = await post(SID, { text: 'direct', messageId: 'qm-mobile-dir000000001' })
    expect(first.status).toBe(202)
    expect(first.body.queued).toBeUndefined()
    expect(directSends(SID)).toEqual(['direct'])
    const retry = await post(SID, { text: 'direct', messageId: 'qm-mobile-dir000000001' })
    expect(retry.status).toBe(202)
    expect(retry.body).toEqual({ messageId: 'qm-mobile-dir000000001' })
    expect(directSends(SID)).toEqual(['direct'])
  })

  it('two concurrent attempts at one id deliver once', async () => {
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((r) => { releaseStatus = r })
    hostWithoutPrimary({ status: async () => { await statusGate; return { exists: true, alive: true } } })
    const a = post(SID, { text: 'twice', messageId: 'qm-mobile-dup000000001' }).then((r) => r)
    const b = post(SID, { text: 'twice', messageId: 'qm-mobile-dup000000001' }).then((r) => r)
    await new Promise((r) => setTimeout(r, 100))
    releaseStatus()
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.status, rb.status]).toEqual([202, 202])
    expect(directSends(SID)).toEqual(['twice'])
  })

  it('a direct send whose answer was lost: delivery_unknown, now and on retry, never re-sent', async () => {
    hostWithoutPrimary({ send: async () => { throw new Error('bridge request timed out: send → devbox') } })
    const first = await post(SID, { text: 'lost', messageId: 'qm-mobile-lost00000001' })
    expect(first.status).toBe(409)
    expect(first.body.error.code).toBe('delivery_unknown')
    expect(first.body.error.message).toContain(LABEL)
    expectHonest(first.body.error.message)
    hostWithoutPrimary()
    const retry = await post(SID, { text: 'lost', messageId: 'qm-mobile-lost00000001' })
    expect(retry.status).toBe(409)
    expect(retry.body.error.code).toBe('delivery_unknown')
    expect(directSends(SID)).toEqual(['lost'])
  })

  it('a message whose relay went out once never goes direct, even when the host later has no primary', async () => {
    // The relay's answer was lost mid-flight: the Mac may hold it.
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') throw new Error('socket hang up')
      throw new Error('unexpected command: ' + cmd)
    })
    const first = await post(SID, { text: 'maybe', messageId: 'qm-mobile-may000000001' })
    expect(first.status).toBe(503)
    expect(first.body.error.message).toContain(LABEL)
    hostWithoutPrimary()
    const retry = await post(SID, { text: 'maybe', messageId: 'qm-mobile-may000000001' })
    expect(retry.status).toBe(202)
    expect(retry.body.queued, 'held for the Mac, whose queue dedupes it').toBe(true)
    // The host answered; the wait is for the Mac, named as such (round 2).
    expect(retry.body.waitingForName).toBe('your Mac')
    expect(retry.body.heldNote).toBe(`Your Mac can't reach ${LABEL} right now.`)
    await flushSendQueue()
    expect(directSends(SID), 'never sent another way').toEqual([])
    expect(await queuedSessionSendCount()).toBe(1)
  })
})

describe('the sweep', () => {
  it('delivers a row nothing carried directly, and a relay-only row waits without holding another session', async () => {
    await enqueueSessionSend(SID, 'devbox', 'relayed once', 'qm-mobile-swp000000001')
    await enqueueSessionSend(SID2, 'devbox', 'never carried', 'qm-mobile-swp000000002', null, { provablyUnsent: true })
    hostWithoutPrimary()
    await flushSendQueue()
    expect(directSends(SID)).toEqual([])
    expect(directSends(SID2)).toEqual(['never carried'])
    expect(relayedIds()).toEqual(['qm-mobile-swp000000001', 'qm-mobile-swp000000002'])
    const left = await listBankedSends()
    expect(left.map((r) => r.messageId)).toEqual(['qm-mobile-swp000000001'])

    // The Mac is back behind the host: the relay-only row goes to its queue.
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown>) => {
      if (cmd === 'session.message') return { ok: true, result: { messageId: p.messageId } }
      throw new Error('unexpected command: ' + cmd)
    })
    await flushSendQueue()
    expect(await queuedSessionSendCount()).toBe(0)
    expect(directSends(SID)).toEqual([])
  })

  it('banking the same messageId twice keeps one row', async () => {
    const a = await enqueueSessionSend(SID, 'devbox', 'same', 'qm-mobile-one000000001')
    const b = await enqueueSessionSend(SID, 'devbox', 'same', 'qm-mobile-one000000001')
    expect(a).toBe(b)
    expect(await queuedSessionSendCount()).toBe(1)
  })
})
