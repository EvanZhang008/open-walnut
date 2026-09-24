/**
 * The two /api/v1 CONTROL relay entry points on a REPLICA when the primary's
 * bridge is not there: session-control-v1.ts (model/effort/fork, its own reply
 * translation over the shared driveControlRelay hop) and the shared
 * relayControlAction behind every Wave-1 route, exercised here through
 * session-lifecycle-v1.ts's terminate.
 *
 * Both used to answer "No live bridge to the primary box, try again when it
 * reconnects", which reads identically for a 2 second redial hole and a MacBook
 * shut for 40 minutes. They now share the launch route's sentence, so a user can
 * tell the two apart and act on it.
 *
 * What this file pins:
 *  1. 503 bridge_offline naming the outage duration when it is known.
 *  2. The plain wording, with no invented number, when it is not.
 *  3. A loss-clock reader that THROWS still produces the normal 503, never a 500:
 *     the duration is strictly diagnostic and may never change the outcome.
 *  4. Every path rides out a FRESH loss with ONE bounded wait before its single
 *     delivery (the wait follows BridgeOfflineError, i.e. precedes any socket
 *     write, so nothing can run twice), and an unknown or stale loss is never
 *     waited for. The timing itself, and "one fork during a hole = one frame on
 *     the primary", are pinned against the real registry in
 *     v1-control-relay-blip-grace.test.ts; here only "one wait, and no claimed
 *     wait when it came back at once".
 *
 * Bridge mocked at its module seam (same shape as api-v1-session-control-cloud.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-control-offline-copy', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.hoisted(() => vi.fn())
const lastBridgeLossAtMock = vi.hoisted(() => vi.fn())
const waitForBridgeMock = vi.hoisted(() => vi.fn())
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  lastBridgeLossAt: lastBridgeLossAtMock,
  // Present so the "never waits" assertions can be made at all: a control route
  // that started waiting would light this up instead of failing silently.
  waitForBridge: waitForBridgeMock,
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

const SID = 'cloud-offline-copy-1'
const PLAIN = 'No live bridge to the primary box. Your primary box (Mac) is asleep or offline.'

type RelayResponse = { status: number; body: { error: { code: string; message: string } } }

/** One request per relay path under test, each reaching a BridgeOfflineError. */
const PATHS: Array<[string, () => Promise<RelayResponse>]> = [
  [
    'session-control-v1 POST /sessions/:id/model',
    async () => await request(createApp()).post(`/api/v1/sessions/${SID}/model`).send({ model: 'opus' }),
  ],
  [
    'session-control-v1 POST /sessions/:id/fork',
    async () => await request(createApp()).post(`/api/v1/sessions/${SID}/fork`).send({}),
  ],
  [
    'v1-control-relay POST /sessions/:id/terminate',
    async () => await request(createApp()).post(`/api/v1/sessions/${SID}/terminate`).send({}),
  ],
]

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  lastBridgeLossAtMock.mockReset()
  waitForBridgeMock.mockReset()
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
  // Would resolve true if a route ever called it, so a wait that sneaks in shows
  // up as a changed outcome rather than as a timeout.
  waitForBridgeMock.mockResolvedValue(true)
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

for (const [label, send] of PATHS) {
  describe(`${label} when the primary bridge is gone`, () => {
    it('names how long the primary has been unreachable', async () => {
      lastBridgeLossAtMock.mockReturnValue(Date.now() - 41 * 60_000)

      const res = await send()
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('bridge_offline')
      expect(res.body.error.message).toBe(
        'Your primary box (Mac) has been unreachable for 41 minutes. '
        + 'It may be asleep (open the lid) or offline.',
      )
      expect(lastBridgeLossAtMock).toHaveBeenCalledWith('__local__')
    })

    it('keeps the plain wording when the duration is unknown', async () => {
      // A replica that just restarted never saw the link drop.
      lastBridgeLossAtMock.mockReturnValue(null)

      const res = await send()
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('bridge_offline')
      expect(res.body.error.message).toBe(PLAIN)
      // An unknown loss is never waited for, on either relay: nothing says the
      // link is mid-redial rather than gone for good.
      expect(waitForBridgeMock).not.toHaveBeenCalled()
      expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    })

    it('degrades to the plain wording when the loss clock THROWS, never a 500', async () => {
      // The duration is diagnostic only. A registry that cannot answer must not
      // turn a precise 503 into a crash.
      lastBridgeLossAtMock.mockImplementation(() => { throw new Error('registry unavailable') })

      const res = await send()
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('bridge_offline')
      expect(res.body.error.message).toBe(PLAIN)
    })

    it('waits out a fresh loss once, and claims no wait when the link came straight back', async () => {
      lastBridgeLossAtMock.mockReturnValue(Date.now() - 2_000)

      const res = await send()
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('bridge_offline')
      // One wait, bounded by the blip grace (5s, well under half the 30s relay
      // budget). Both bridgeRequest calls were refused before any socket write
      // (BridgeOfflineError), so the primary saw nothing either time.
      expect(waitForBridgeMock).toHaveBeenCalledTimes(1)
      expect(waitForBridgeMock).toHaveBeenCalledWith('__local__', 5_000)
      expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
      // Every call is the same session.control frame with the 30s budget; the
      // second only carries what is left of it.
      for (const call of bridgeRequestMock.mock.calls) {
        expect(call[0]).toBe('__local__')
        expect(call[1]).toBe('session.control')
        expect(call[3]).toBeLessThanOrEqual(30_000)
      }
      expect(bridgeRequestMock.mock.calls[0][3]).toBe(30_000)
      // The wait answered "back" at once, so no wait budget was spent.
      expect(res.body.error.message).not.toMatch(/Waited/)
    })

    it('answers immediately rather than spending a wait budget', async () => {
      lastBridgeLossAtMock.mockReturnValue(Date.now() - 19 * 60_000)
      const started = Date.now()

      const res = await send()
      expect(res.status).toBe(503)
      expect(res.body.error.message).toMatch(/unreachable for 19 minutes/)
      expect(Date.now() - started).toBeLessThan(2_000)
      // A stale loss is a sleeping Mac, not a redial: no relay waits for it.
      expect(waitForBridgeMock).not.toHaveBeenCalled()
    })
  })
}

describe('the control routes still answer every other failure exactly as before', () => {
  it('a relay error that is not BridgeOfflineError keeps its own message', async () => {
    // Only the BridgeOfflineError branch changed. A timeout still surfaces
    // verbatim, and it must not pick up the outage sentence.
    lastBridgeLossAtMock.mockReturnValue(Date.now() - 41 * 60_000)
    bridgeRequestMock.mockRejectedValue(new Error('bridge request timed out: session.control → __local__'))

    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/model`).send({ model: 'opus' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(res.body.error.message).toMatch(/timed out/)
    expect(res.body.error.message).not.toMatch(/unreachable for/)
  })

  it('a successful relay is untouched by the copy change', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { model: 'opus', appliedLive: true } })

    const res = await request(createApp()).post(`/api/v1/sessions/${SID}/model`).send({ model: 'opus' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ model: 'opus', appliedLive: true })
    expect(lastBridgeLossAtMock).not.toHaveBeenCalled()
  })
})
