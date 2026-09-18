/**
 * The defensive half of the shared bridge-offline copy: a bridge registry that
 * does not expose the loss clock AT ALL must still produce the ordinary 503.
 *
 * This is not hypothetical. Reading an export a mocked ESM module never defined
 * THROWS in vitest (it is a proxy, not a plain object), so optional chaining does
 * not help, and every already-existing cloud test mocks bridge-registry with its
 * own hand-written export list. If the routes read the clock unguarded, those
 * tests would flip from 503 to 500 and the phone would see "Internal server
 * error" instead of "your Mac is asleep" the moment a real registry changed shape.
 *
 * Kept in its own file because the missing export has to be missing from the
 * whole module mock, which is per file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-control-offline-noclock', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.hoisted(() => vi.fn())
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
// Deliberately NO lastBridgeLossAt export: this is the shape of every cloud test
// mock written before the duration was reported.
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

import express from 'express'
import request from 'supertest'
import { sessionControlV1Router } from '../../../src/web/routes/session-control-v1.js'
import { sessionLifecycleV1Router } from '../../../src/web/routes/session-lifecycle-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionControlV1Router)
  app.use('/api/v1', sessionLifecycleV1Router)
  app.use(errorHandler)
  return app
}

const SID = 'cloud-offline-noclock-1'
const PLAIN = 'No live bridge to the primary box. Your primary box (Mac) is asleep or offline.'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a bridge registry with no loss clock', () => {
  it('throws on the missing export, which is why the read is wrapped', async () => {
    // Pinning the gotcha itself: if this ever stops throwing, the guard in the
    // routes can be simplified, and until then it cannot.
    const registry = await import('../../../src/web/ws/bridge-registry.js')
    expect(() => registry.lastBridgeLossAt('__local__')).toThrow()
  })

  it('session-control-v1 still answers 503 bridge_offline with the plain wording', async () => {
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/effort`).send({ effort: 'high' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(res.body.error.message).toBe(PLAIN)
  })

  it('v1-control-relay still answers 503 bridge_offline with the plain wording', async () => {
    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/terminate`).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(res.body.error.message).toBe(PLAIN)
  })
})
