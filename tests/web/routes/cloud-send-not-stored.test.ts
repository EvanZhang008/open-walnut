/**
 * r4c gate F2, companion half: the Mac answers a relay `not_stored` when its
 * queue write failed (the row is not on its disk, or may be there only from a
 * write that failed after it landed). The companion must neither report the
 * message "relayed" (it would forget it, and a Mac restart then loses it) nor
 * tell the phone it was refused: it keeps the message, relay-only, and asks
 * again with the same id until the Mac stores it, exactly once.
 *
 * The model: the host daemon forwards each relay frame to the Mac, whose queue
 * dedupes by id; `macFailsNext` answers that many relays `not_stored` first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const H = vi.hoisted(() => {
  class BridgeOfflineError extends Error { constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) } }
  return { bridgeRequestMock: vi.fn(), BridgeOfflineError }
})

vi.mock('../../../src/constants.js', async () => {
  const g = globalThis as unknown as { __notStored?: Record<string, unknown> }
  if (!g.__notStored) {
    const { createMockConstants } = await import('../../helpers/mock-constants.js')
    g.__notStored = createMockConstants('walnut-cloud-not-stored', { CLOUD_MODE: true })
  }
  return g.__notStored
})

vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: H.bridgeRequestMock,
  BridgeOfflineError: H.BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
  addPrimaryBridgeConnectedHandler: () => () => {},
  addBridgeConnectedHandler: () => () => {},
}))

const SID = 'not-stored-sid'
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/session-projection.js')>()
  return {
    ...mod,
    readSessionProjection: async () => ({
      version: 1 as const, exportedAt: new Date().toISOString(),
      sessions: [{
        id: 'not-stored-sid', host: 'devbox', host_label: 'Marina devbox', process_status: 'idle',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo', model: 'opus',
      }],
    }),
  }
})

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME, SEND_QUEUE_DIR } from '../../../src/constants.js'

let app: express.Express
async function restart(): Promise<void> {
  vi.resetModules()
  const { sessionStreamV1Router } = await import('../../../src/web/routes/session-stream-v1.js')
  app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/v1', sessionStreamV1Router)
}
const post = (text: string, messageId: string) => request(app).post(`/api/v1/sessions/${SID}/messages`).send({ text, messageId })
const flushOnce = async () => (await import('../../../src/core/send-queue-sweep.js')).flushOnce()
const outcome = async (mid: string) => JSON.parse(await fs.readFile(
  path.join(SEND_QUEUE_DIR, 'outcomes', `${createHash('sha256').update(JSON.stringify([SID, mid])).digest('hex')}.json`), 'utf-8')) as Record<string, unknown>
const banked = async () => (await fs.readdir(SEND_QUEUE_DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.json'))

let macQueue: string[] = []
let macFailsNext = 0
let hostUp = true

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  macQueue = []
  macFailsNext = 0
  hostUp = true
  H.bridgeRequestMock.mockReset()
  H.bridgeRequestMock.mockImplementation(async (host: string, cmd: string, p: Record<string, unknown> = {}) => {
    if (!hostUp) throw new H.BridgeOfflineError(host)
    if (cmd === 'session.message') {
      if (macFailsNext > 0) {
        macFailsNext--
        return { ok: false, error: 'the Mac could not store the message: ENOSPC: no space left on device', errorKind: 'not_stored' }
      }
      const id = String(p.messageId)
      if (!macQueue.includes(id)) macQueue.push(id)
      return { ok: true, result: { messageId: id } }
    }
    if (cmd === 'status') return { exists: true, alive: true }
    if (cmd === 'ping') return { ok: true }
    // Never the direct path: a message the Mac may hold is relay-only.
    throw new Error('unexpected command: ' + cmd)
  })
  await restart()
})

afterEach(async () => {
  H.bridgeRequestMock.mockReset()
  H.bridgeRequestMock.mockRejectedValue(new H.BridgeOfflineError('devbox'))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a relay the Mac could not store (r4c F2)', () => {
  it('the route holds it (202 queued, maybe-relayed), never "relayed"; a later pass stores it once', async () => {
    macFailsNext = 1_000
    const res = await post('keep me', 'qm-mobile-ns00000000001')
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ messageId: 'qm-mobile-ns00000000001', queued: true })
    expect((await outcome('qm-mobile-ns00000000001')).state).toBe('maybe-relayed')
    expect(await banked()).toHaveLength(1)
    expect(macQueue).toEqual([])
    // The companion restarts while the Mac still cannot store: the row is on its disk.
    await restart()
    await flushOnce()
    expect(await banked()).toHaveLength(1)
    macFailsNext = 0
    await flushOnce()
    expect(macQueue).toEqual(['qm-mobile-ns00000000001'])
    expect((await outcome('qm-mobile-ns00000000001')).state).toBe('relayed')
    expect(await banked()).toHaveLength(0)
    expect(H.bridgeRequestMock.mock.calls.some((c) => c[1] === 'send')).toBe(false)
  }, 30_000)

  it('the sweep keeps a banked row relay-only and retries; the phone is never told it was refused', async () => {
    hostUp = false
    expect((await post('banked first', 'qm-mobile-ns00000000002')).status).toBe(202)
    hostUp = true
    // Every relay fails until the Mac recovers below (a drain that another trigger starts meanwhile too).
    macFailsNext = 1_000
    const pass = await flushOnce()
    expect(pass.waitingSoon).toBe(true)
    expect((await outcome('qm-mobile-ns00000000002')).state).toBe('maybe-relayed')
    expect(await banked()).toHaveLength(1)
    const row = JSON.parse(await fs.readFile(path.join(SEND_QUEUE_DIR, (await banked())[0]), 'utf-8')) as Record<string, unknown>
    expect(row.provablyUnsent).toBeUndefined()
    macFailsNext = 0
    await flushOnce()
    expect(macQueue).toEqual(['qm-mobile-ns00000000002'])
    expect((await outcome('qm-mobile-ns00000000002')).state).toBe('relayed')
    expect(H.bridgeRequestMock.mock.calls.some((c) => c[1] === 'send')).toBe(false)
  }, 30_000)
})
