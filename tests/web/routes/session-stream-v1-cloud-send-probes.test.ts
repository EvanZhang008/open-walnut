/**
 * Regression probes for cloud phone sends (2026-10-01 hop fix, round 2). Each
 * one was a real defect a review reproduced against round 1:
 *  P1:  a send held behind an earlier held send was banked with no stop fence;
 *       on a session that was ever stopped the Mac refused it and the sweep
 *       dropped it, with the phone still told "queued".
 *  P1b: the same held-behind send, delivered by the host directly.
 *  P5:  a stop requested after a send was banked (the Mac could not deliver it
 *       to the host) did not hold the sweep's direct path back.
 *  P2:  a relay answered ok, the phone retried the same id (its 202 was lost),
 *       the host had no Mac behind it any more: the retry went direct, a second
 *       delivery.
 *  P3:  an image send whose relay timed out at the host daemon recorded nothing,
 *       so its retry went direct: a second delivery.
 *  P4:  a relay-only send held while the host answers "no primary" named the
 *       healthy host instead of the Mac it waits for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-send-probes', { CLOUD_MODE: true }))

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

const SID = 'probe-sid-a'
const LABEL = 'New big devbox'
let stopRequest: { id: string; state: string } | undefined
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  const row = (id: string) => ({
    id, host: 'devbox', host_label: LABEL, process_status: 'idle',
    started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
    message_count: 1, cwd: '/home/user/repo', model: 'opus', stopRequest,
  })
  return {
    ...mod,
    readSessionProjection: async () => ({ version: 1 as const, exportedAt: new Date().toISOString(), sessions: [row(SID)] }),
  }
})

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { flushSendQueue, queuedSessionSendCount } from '../../../src/core/send-queue.js'

const NO_PRIMARY = 'session.message: no primary server connected (the last one went quiet 52s ago)'
const app = () => { const a = express(); a.use(express.json({ limit: '5mb' })); a.use('/api/v1', sessionStreamV1Router); return a }
const post = (body: Record<string, unknown>) => request(app()).post(`/api/v1/sessions/${SID}/messages`).send(body)

/** Every delivery of a message text: a relay the primary accepted, or a direct FIFO write. */
let primaryEnqueued: string[] = []
const directSends = () => bridgeRequestMock.mock.calls.filter((c) => c[1] === 'send').map((c) => String(c[2].message))

/** The primary's real fence rule (session-message-queue enqueueMessage): fence must equal the record's stop id. */
function primaryBehindHost(currentFence: string | null) {
  bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (cmd === 'session.message') {
      if ((p.stopFence ?? null) !== currentFence) {
        return { ok: false, error: 'Message predates the latest stop; send a new message to continue', errorKind: 'session_stopped' }
      }
      primaryEnqueued.push(String(p.message))
      return { ok: true, result: { messageId: p.messageId } }
    }
    throw new Error('unexpected command: ' + cmd)
  })
}
function hostWithoutPrimary() {
  bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
    switch (cmd) {
      case 'session.message': return { ok: false, error: NO_PRIMARY }
      case 'status': return { exists: true, alive: true }
      case 'send': return { ok: true }
      case 'appendUserMarker': return { ok: true }
      case 'image.save': return { ok: true, path: '/tmp/img-1.png' }
      default: throw new Error('unexpected command: ' + cmd)
    }
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  primaryEnqueued = []
  stopRequest = undefined
})
afterEach(async () => {
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('P1 held-behind send on a session that was stopped once', () => {
  it('both held messages reach the primary when it returns', async () => {
    stopRequest = { id: 'stop-0', state: 'confirmed' }
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'first', messageId: 'qm-mobile-pf1000000001' })).status).toBe(202)
    expect((await post({ text: 'second', messageId: 'qm-mobile-pf1000000002' })).status).toBe(202)
    primaryBehindHost('stop-0')
    await flushSendQueue()
    const left = await queuedSessionSendCount()
    // Correct behavior: both delivered once. A drop of "second" is a silent loss after a 202.
    expect({ primaryEnqueued, left }).toEqual({ primaryEnqueued: ['first', 'second'], left: 0 })
  })
})

describe('P1b the same held-behind send, delivered by the host directly (no primary behind it)', () => {
  it('the host daemon, which recorded the stop (cron store), takes both', async () => {
    stopRequest = { id: 'stop-0', state: 'confirmed' }
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'first', messageId: 'qm-mobile-pfb000000001' })).status).toBe(202)
    expect((await post({ text: 'second', messageId: 'qm-mobile-pfb000000002' })).status).toBe(202)
    const delivered: string[] = []
    // daemon-cron-runtime deliveryAllowed: a recorded stop id must equal the fence.
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string, p: Record<string, unknown> = {}) => {
      switch (cmd) {
        case 'session.message': return { ok: false, error: NO_PRIMARY }
        case 'status': return { exists: true, alive: true }
        case 'send':
          if ((p.stopFence ?? null) !== 'stop-0') return { ok: false, reason: 'session_stopped' }
          delivered.push(String(p.message)); return { ok: true }
        case 'appendUserMarker': return { ok: true }
        default: throw new Error('unexpected command: ' + cmd)
      }
    })
    await flushSendQueue()
    expect({ delivered, left: await queuedSessionSendCount() }).toEqual({ delivered: ['first', 'second'], left: 0 })
  })
})

describe('P5 a stop requested after a send was banked (the Mac cannot deliver it to the host)', () => {
  it('the sweep does not run the pre-stop message directly', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    expect((await post({ text: 'before-stop', messageId: 'qm-mobile-pf5000000001' })).status).toBe(202)
    // The user pressed Stop; the Mac saved it pending (it cannot reach the host).
    stopRequest = { id: 'stop-1', state: 'pending' }
    hostWithoutPrimary()
    await flushSendQueue()
    expect(directSends()).toEqual([])
  })
})

describe('P2 relay ok, then a retry of the same id when no primary is behind the host', () => {
  it('the retry is never a second delivery', async () => {
    primaryBehindHost(null)
    const first = await post({ text: 'once', messageId: 'qm-mobile-pf2000000001' })
    expect(first.status).toBe(202)
    hostWithoutPrimary()
    const retry = await post({ text: 'once', messageId: 'qm-mobile-pf2000000001' })
    expect(retry.status).toBe(202)
    expect({ viaPrimary: primaryEnqueued.length, direct: directSends().length }).toEqual({ viaPrimary: 1, direct: 0 })
  })
})

describe('P3 image send whose relay timed out at the host daemon', () => {
  it('a retry when no primary is behind the host is never a second delivery', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'image.save') return { ok: true, path: '/tmp/img-0.png' }
      if (cmd === 'session.message') return { ok: false, error: 'session.message: primary server timed out' }
      throw new Error('unexpected command: ' + cmd)
    })
    const img = { data: Buffer.from('x').toString('base64'), mediaType: 'image/png' }
    const first = await post({ text: 'pic', images: [img], messageId: 'qm-mobile-pf3000000001' })
    expect(first.status).toBe(503)
    hostWithoutPrimary()
    const retry = await post({ text: 'pic', images: [img], messageId: 'qm-mobile-pf3000000001' })
    // The first relay was handed to a primary that did not answer in time: it may
    // hold it, so the retry is held for the Mac (round 3: images like text).
    expect({ status: retry.status, direct: directSends().length }).toEqual({ status: 202, direct: 0 })
    // The host answered; the wait is for the Mac, and the sentence says so.
    expect(retry.body).toMatchObject({ queued: true, waitingForName: 'your Mac', heldNote: `Your Mac can't reach ${LABEL} right now.` })
  })
})

describe('P4 wording of a relay-only hold while the host is up with no primary', () => {
  it('names the hop it waits for (the Mac), not the healthy host', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') throw new Error('socket hang up')
      throw new Error('unexpected command: ' + cmd)
    })
    expect((await post({ text: 'maybe', messageId: 'qm-mobile-pf4000000001' })).status).toBe(503)
    hostWithoutPrimary()
    const retry = await post({ text: 'maybe', messageId: 'qm-mobile-pf4000000001' })
    expect(retry.status).toBe(202)
    expect(retry.body.waitingForName).not.toBe(LABEL)
    expect(retry.body).toMatchObject({ queued: true, waitingFor: '', waitingForName: 'your Mac', heldNote: `Your Mac can't reach ${LABEL} right now.` })
    expect(directSends()).toEqual([])
  })
})
