/**
 * GET /api/v1/sessions/:id/queue on the cloud companion lists the sends the
 * companion itself holds for the session (iOS gate r1, B1).
 *
 * Held sends live on the companion, not in the Mac's queue. The phone kept them
 * only in memory, so after a relaunch the bubbles were gone and the Queued
 * Messages sheet said "No queued messages. Everything you sent has been
 * delivered." while the companion held two. The list is now the source of
 * truth the phone rebuilds them from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-held-queue', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: (host: string) => ({ connected: host !== 'offbox' }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

import express from 'express'
import request from 'supertest'
import { sessionExtrasV1Router } from '../../../src/web/routes/session-extras-v1.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { enqueueSessionSend } from '../../../src/core/send-queue.js'

const SID = 'held-queue-sid'
const LABEL = 'New big devbox'
const MAC_ROW = { id: 'qm-desk-0001', sessionId: SID, message: 'typed on the Mac', status: 'pending', enqueuedAt: '2026-10-01T10:00:00.000Z' }

const app = () => { const a = express(); a.use(express.json()); a.use('/api/v1', sessionExtrasV1Router); return a }
const list = () => request(app()).get(`/api/v1/sessions/${SID}/queue`)

function macAnswers(messages: unknown[]) {
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (host === '__local__' && cmd === 'session.control' && p.action === 'queue') return { ok: true, result: { messages } }
    throw new Error(`unexpected ${host} ${cmd}`)
  })
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
})
afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the companion lists what it holds', () => {
  it('held sends come after the Mac\'s own queue, marked held, with who they wait on', async () => {
    await enqueueSessionSend(SID, 'offbox', 'first held', 'qm-mobile-hq0000000001', null, { provablyUnsent: true, hostName: LABEL })
    await enqueueSessionSend(SID, 'offbox', 'second held', 'qm-mobile-hq0000000002', null, { provablyUnsent: true, hostName: LABEL })
    macAnswers([MAC_ROW])
    const res = await list()
    expect(res.status, res.text).toBe(200)
    expect(res.body.partial).toBeUndefined()
    expect(res.body.messages.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([
      ['qm-desk-0001', 'pending'],
      ['qm-mobile-hq0000000001', 'held'],
      ['qm-mobile-hq0000000002', 'held'],
    ])
    expect(res.body.messages[1]).toMatchObject({
      message: 'first held', held: true,
      waitingForName: LABEL, heldNote: `Can't reach ${LABEL} right now.`,
    })
  })

  it('a message both hold (a relay reached the Mac) is listed once, as the companion\'s', async () => {
    await enqueueSessionSend(SID, 'devbox', 'both', 'qm-mobile-hq0000000003', null, { hostName: LABEL })
    macAnswers([{ ...MAC_ROW, id: 'qm-mobile-hq0000000003', message: 'both' }])
    const res = await list()
    expect(res.body.messages).toHaveLength(1)
    expect(res.body.messages[0]).toMatchObject({ id: 'qm-mobile-hq0000000003', status: 'held', waitingForName: 'your Mac' })
  })

  it('a Mac that cannot be asked: the held sends still, and the list says it is partial', async () => {
    await enqueueSessionSend(SID, 'offbox', 'held', 'qm-mobile-hq0000000004', null, { provablyUnsent: true, hostName: LABEL })
    bridgeRequestMock.mockRejectedValue(new Error('socket hang up'))
    const res = await list()
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ partial: true })
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(['qm-mobile-hq0000000004'])
  })

  it('nothing held: the Mac\'s answer, unchanged', async () => {
    macAnswers([MAC_ROW])
    const res = await list()
    expect(res.status, res.text).toBe(200)
    expect(res.body).toEqual({ messages: [MAC_ROW] })
  })
})
