/**
 * A phone send of a session its host judges, the Mac away (POST /api/v1/sessions/:id/messages on the
 * companion; cloud-session-send.ts sendThroughHost). Review round 1 of land 5b, M1 and M2:
 *
 *   - the host path runs after the stop gate and the send ledger: a stop the Mac has not confirmed
 *     holds it, and a retry of a message a direct delivery may have run is never sent again
 *   - its outcome goes in the ledger: a retry after it, by either path, is answered, never sent twice
 *   - never the daemon's direct send: a link that is down gets a refusal the phone shows
 *   - pictures go with the words to the host (land 8): the route hands them to sendViaHost, which
 *     saves them on the host first (companion-host-ops.ts); before, they were refused 409 images_need_mac
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-send-host', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock, BridgeOfflineError, bridgeForHost: () => ({ connected: false }), bridgeHosts: () => [],
  bridgeAttachSession: async () => {}, bridgeDetachSession: () => {}, attachBridge: () => {}, closeAllBridges: () => {}, setMobileEventHandler: () => {},
}))

const SID = 'host-judged-sid-1'
const k = vi.hoisted(() => ({
  stopRequest: undefined as { id: string; state: string } | undefined,
  route: { kind: 'none' } as Record<string, unknown>,
  sends: [] as Array<{ text: string; messageId: string; images?: unknown[] }>,
  answer: { status: 202 } as { status: number; maybeTaken?: true },
}))
vi.mock('../../../src/core/session-projection.js', async (orig) => ({
  ...(await orig<object>()),
  readSessionProjection: async () => ({
    version: 1 as const, exportedAt: new Date().toISOString(),
    sessions: [{ id: SID, host: 'devbox', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1, cwd: '/w', model: 'opus', stopRequest: k.stopRequest }],
  }),
}))
vi.mock('../../../src/core/session-channel/companion-host-ops.js', async (orig) => ({
  ...(await orig<object>()),
  hostRoute: async () => k.route,
  // The same answer for a caller that asks only whether the host operates it.
  hostOperated: async () => (k.route.kind === 'operated' ? k.route.t : null),
  sendViaHost: async (_t: unknown, o: { text: string; messageId: string; images?: unknown[] }) => {
    k.sends.push({ text: o.text, messageId: o.messageId, ...(o.images ? { images: o.images } : {}) })
    return k.answer.status === 202 ? { status: 202, body: { messageId: o.messageId, viaHost: true } }
      : { status: k.answer.status, body: { error: { code: 'bridge_offline', message: 'no answer' } }, ...(k.answer.maybeTaken ? { maybeTaken: true } : {}) }
  },
}))

import express from 'express'
import request from 'supertest'
import { sessionStreamV1Router } from '../../../src/web/routes/session-stream-v1.js'
import { markSendOutcome, readSendOutcome } from '../../../src/core/send-outcomes.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const operated = { kind: 'operated', t: { alias: 'devbox', row: { claudeSessionId: SID, taskId: 't1', judge: 'host', host: 'devbox' }, live: null } }
const app = () => { const a = express(); a.use(express.json({ limit: '10mb' })); a.use('/api/v1', sessionStreamV1Router); return a }
const send = (body: Record<string, unknown>) => request(app()).post(`/api/v1/sessions/${SID}/messages`).send(body)
const directCalls = () => bridgeRequestMock.mock.calls.map((c) => c[1] as string).filter((cmd) => cmd !== 'ping')

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockResolvedValue({ ok: false, error: 'no primary server connected' })
  k.stopRequest = undefined
  k.route = operated
  k.sends.length = 0
  k.answer = { status: 202 }
})

describe('a send through the host keeps the gates of every other path (M1)', () => {
  it('a stop the Mac has not confirmed holds it: 409, nothing sent', async () => {
    k.stopRequest = { id: 'stop-1', state: 'pending' }
    const r = await send({ text: 'after the stop', messageId: 'qm-mobile-a1' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.error.code).toBe('stop_pending')
    expect(k.sends).toEqual([])
  })

  it('a retry of a message a direct delivery may have run is never sent again', async () => {
    await markSendOutcome(SID, 'qm-mobile-a2', 'maybe-direct')
    const r = await send({ text: 'hello', messageId: 'qm-mobile-a2' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('delivery_unknown')
    expect(k.sends).toEqual([])
  })

  it('records its outcome: a retry by the old path once the Mac is back is answered, not sent twice', async () => {
    expect((await send({ text: 'hello', messageId: 'qm-mobile-a3' })).status).toBe(202)
    expect(k.sends).toHaveLength(1)
    expect((await readSendOutcome(SID, 'qm-mobile-a3'))?.state).toBe('relayed')
    k.route = { kind: 'none' }
    const again = await send({ text: 'hello', messageId: 'qm-mobile-a3' })
    expect(again.status).toBe(202)
    expect(directCalls()).toEqual([])
    expect(k.sends).toHaveLength(1)
  })

  it('an answer that never came is maybe-relayed: never the direct path afterwards', async () => {
    k.answer = { status: 503, maybeTaken: true }
    expect((await send({ text: 'hello', messageId: 'qm-mobile-a4' })).status).toBe(503)
    expect((await readSendOutcome(SID, 'qm-mobile-a4'))?.state).toBe('maybe-relayed')
  })
})

describe('never the daemon\'s direct send (M2)', () => {
  it('pictures go with the words through the host, never the direct path (land 8)', async () => {
    const png = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mediaType: 'image/png' }
    const r = await send({ text: 'look', messageId: 'qm-mobile-b1', images: [png, png] })
    expect(r.status, JSON.stringify(r.body)).toBe(202)
    expect(r.body).toMatchObject({ messageId: 'qm-mobile-b1', viaHost: true })
    expect(k.sends).toEqual([{ text: 'look', messageId: 'qm-mobile-b1', images: [png, png] }])
    expect((await readSendOutcome(SID, 'qm-mobile-b1'))?.state).toBe('relayed')
    expect(directCalls()).toEqual([])
  })

  it('the host\'s link down: a 503 bridge_offline, no relay and no direct send', async () => {
    k.route = { kind: 'refuse', status: 503, code: 'bridge_offline', message: 'devbox can\'t be reached right now' }
    const r = await send({ text: 'hello', messageId: 'qm-mobile-b2' })
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe('bridge_offline')
    expect(directCalls()).toEqual([])
  })
})
