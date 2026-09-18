/**
 * /api/v1 session launch on a REPLICA when the primary's bridge is NOT there.
 *
 * Reported bug: the phone could not create a session on a remote host while
 * sends to an already-running session kept working. The asymmetry was in the
 * error handling, not the transport: a send banks the message and answers 202,
 * while both launch endpoints answered a hard 503 the instant bridgeRequest
 * found no socket.
 *
 * Two populations of bridge hole were measured, and this route now treats them
 * differently: 9 of 11 observed holes were 0 to 3 seconds (routine teardown plus
 * the daemon's redial), and the 2 long ones were 24.7 and 19.0 minutes, caused by
 * the primary sleeping with its lid shut. So a FRESH loss is waited out once, and
 * a loss older than the flap window is answered immediately with a message that
 * says how long the box has been gone.
 *
 * What this file pins:
 *  1. A fresh loss that comes back inside the window produces a real 201, with
 *     the relay attempted exactly TWICE (one wait, one retry).
 *  2. A fresh loss that never comes back still answers 503 bridge_offline with
 *     the relay attempted exactly ONCE.
 *  3. A STALE or unknown loss never waits at all (the user's Mac was asleep for
 *     minutes: 8s of latency buys nothing) and never relays twice.
 *  4. THE DUPLICATE-SESSION GUARD: any failure that is NOT BridgeOfflineError
 *     (relay timeout, transport error mid-flight, a settled non-ok reply) is
 *     never retried, because the primary may already have run the launch.
 *  5. The 503 message names the outage duration when it is known, and never
 *     claims a wait that did not happen.
 *
 * Bridge mocked at its module seam (same shape as session-launch-v1-cloud.test.ts);
 * waitForBridge and lastBridgeLossAt are unit-tested against the real registry in
 * bridge-wait-for-bridge.test.ts and bridge-loss-clock.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-launch-flap-cloud', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.hoisted(() => vi.fn())
const waitForBridgeMock = vi.hoisted(() => vi.fn())
const lastBridgeLossAtMock = vi.hoisted(() => vi.fn())
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  waitForBridge: waitForBridgeMock,
  lastBridgeLossAt: lastBridgeLossAtMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
}))

import express from 'express'
import request from 'supertest'
import { sessionLaunchV1Router } from '../../../src/web/routes/session-launch-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionLaunchV1Router)
  app.use(errorHandler)
  return app
}

const BODY = { cwd: '/home/user/repo', host: 'marina', message: 'hi' }
const CREATED = { sessionId: 'sid-flap-1', taskId: 'task-flap-1', title: 'Session: repo' }
/** The relay timeout error bridgeRequest raises once a frame IS on the wire. */
const RELAY_TIMEOUT = new Error('bridge request timed out: session.launch → __local__')
/** Inside the 30s flap window: the daemon is plausibly mid-redial. */
const FRESH_LOSS = (): number => Date.now() - 2_000
/** Outside it: the box is asleep or off, and waiting is pure latency. */
const STALE_LOSS = (mins: number): number => Date.now() - mins * 60_000

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  waitForBridgeMock.mockReset()
  lastBridgeLossAtMock.mockReset()
  // Default: the link dropped seconds ago, i.e. the flap case.
  lastBridgeLossAtMock.mockReturnValue(FRESH_LOSS())
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /sessions when the primary bridge just dropped (flap)', () => {
  it('waits out the hole and retries once, so the launch succeeds', async () => {
    bridgeRequestMock
      .mockRejectedValueOnce(new BridgeOfflineError('__local__'))
      .mockResolvedValueOnce({ ok: true, result: CREATED })
    waitForBridgeMock.mockResolvedValue(true)

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(201)
    expect(res.body).toEqual(CREATED)
    // Exactly one wait and exactly one retry.
    expect(waitForBridgeMock).toHaveBeenCalledTimes(1)
    expect(waitForBridgeMock).toHaveBeenCalledWith('__local__', 8_000)
    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    // The retry carries the SAME relay payload, not a mutated one.
    expect(bridgeRequestMock.mock.calls[1]).toEqual(bridgeRequestMock.mock.calls[0])
    expect(bridgeRequestMock.mock.calls[1][2]).toEqual({ action: 'launch', params: BODY })
  })

  it('seeds id to host on the RETRIED launch, exactly like a first-try launch', async () => {
    bridgeRequestMock
      .mockRejectedValueOnce(new BridgeOfflineError('__local__'))
      .mockResolvedValueOnce({ ok: true, result: CREATED })
    waitForBridgeMock.mockResolvedValue(true)

    await request(createApp()).post('/api/v1/sessions').send(BODY)
    const { getLaunchSeed } = await import('../../../src/core/sessions/launch-seed.js')
    expect(getLaunchSeed(CREATED.sessionId)).toMatchObject({ host: 'marina', cwd: BODY.cwd })
  })

  it('503 bridge_offline when the wait expires with the bridge still gone', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    waitForBridgeMock.mockResolvedValue(false)

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    // The message says what actually happened, including the wait it did.
    expect(res.body.error.message).toMatch(/Waited 8s for it to reconnect/)
    // No retry storm: one wait, one relay attempt.
    expect(waitForBridgeMock).toHaveBeenCalledTimes(1)
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it('answers 503 once when the bridge returns and drops again mid-retry', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    waitForBridgeMock.mockResolvedValue(true)

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(res.body.error.message).toMatch(/dropped again/)
    // Two attempts total, never a third, and never a second wait.
    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    expect(waitForBridgeMock).toHaveBeenCalledTimes(1)
  })

  it('a wait that cannot run degrades to the honest 503, not a 500', async () => {
    // Defensive: the wait is the only thing between the offline error and the
    // answer, so a throw there must not turn a precise 503 into a crash.
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    waitForBridgeMock.mockRejectedValue(new Error('registry unavailable'))

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /sessions when the primary has been gone a while (asleep)', () => {
  // The reported incident: a MacBook asleep with the lid shut, unreachable in 8
  // to 15 minute stretches. Waiting 8s there is latency spent on an answer we
  // already have, so the wait must NOT fire.
  beforeEach(() => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    waitForBridgeMock.mockResolvedValue(true) // would succeed if it were called
  })

  it('answers immediately without waiting or relaying twice', async () => {
    lastBridgeLossAtMock.mockReturnValue(STALE_LOSS(41))
    const started = Date.now()

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    // The load-bearing assertions: the budget was never entered, and the relay
    // ran once. (Asserted, not eyeballed: the wait is mocked, so a test that
    // actually slept 8s would only prove the mock's timing.)
    expect(waitForBridgeMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(2_000)
    // And it never claims a wait it did not do.
    expect(res.body.error.message).not.toMatch(/Waited/)
    expect(res.body.error.message).toMatch(/unreachable for 41 minutes/)
  })

  it('answers immediately when the outage duration is unknown', async () => {
    // A cloud box that just restarted never saw the link drop, so it has no
    // duration and no reason to believe a redial is in flight.
    lastBridgeLossAtMock.mockReturnValue(null)

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(waitForBridgeMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    expect(res.body.error.message).toBe(
      'No live bridge to the primary box. Your primary box (Mac) is asleep or offline.',
    )
  })

  it('waits again once the box has just dropped, not because it was down before', async () => {
    // Same process, two requests: the stale outage answers instantly, and a
    // fresh drop later still gets its bounded wait.
    lastBridgeLossAtMock.mockReturnValue(STALE_LOSS(24))
    await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(waitForBridgeMock).not.toHaveBeenCalled()

    lastBridgeLossAtMock.mockReturnValue(FRESH_LOSS())
    bridgeRequestMock.mockReset()
    bridgeRequestMock
      .mockRejectedValueOnce(new BridgeOfflineError('__local__'))
      .mockResolvedValueOnce({ ok: true, result: CREATED })
    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(201)
    expect(waitForBridgeMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /sessions duplicate-session guard: only BridgeOfflineError is retryable', () => {
  // Every error here was raised AFTER the frame went out, so the primary may
  // already have created the session. Retrying would create a second one.
  const notRetryable: Array<[string, unknown]> = [
    ['relay timeout', RELAY_TIMEOUT],
    ['transport error mid-flight', new Error('WebSocket is not open: readyState 2 (CLOSING)')],
    ['a non-Error rejection', 'socket exploded'],
  ]

  for (const [label, failure] of notRetryable) {
    it(`does not retry after ${label}`, async () => {
      bridgeRequestMock.mockRejectedValue(failure)
      waitForBridgeMock.mockResolvedValue(true)

      const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('bridge_offline')
      // THE guard: one attempt, and the reconnect wait is never even entered.
      expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
      expect(waitForBridgeMock).not.toHaveBeenCalled()
    })
  }

  it('does not retry a settled non-ok reply from the primary', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Task "nope" not found', errorKind: 'not_found' })
    waitForBridgeMock.mockResolvedValue(true)

    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    expect(waitForBridgeMock).not.toHaveBeenCalled()
  })

  it('never waits or retries when the relay succeeds first time', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: CREATED })
    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(201)
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
    expect(waitForBridgeMock).not.toHaveBeenCalled()
  })
})

describe('the 503 message says how long the primary has been unreachable', () => {
  // "Try again when it reconnects" reads identically for a 2 second redial hole
  // and a laptop shut for 40 minutes. The code stays frozen at `bridge_offline`;
  // only the sentence carries the new information.
  beforeEach(() => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    waitForBridgeMock.mockResolvedValue(false)
  })

  it('rounds to a unit a person reads, in both directions', async () => {
    const cases: Array<[number, RegExp]> = [
      [1_000, /unreachable for 1 second\b/],
      [12_000, /unreachable for 12 seconds/],
      [60_000, /unreachable for 1 minute\b/],
      [8 * 60_000, /unreachable for 8 minutes/],
      [61 * 60_000, /unreachable for 1 hour\b/],
      [95 * 60_000, /unreachable for 2 hours/],
    ]
    for (const [ago, expected] of cases) {
      lastBridgeLossAtMock.mockReturnValue(Date.now() - ago)
      const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
      expect(res.status).toBe(503)
      expect(res.body.error.message).toMatch(expected)
      // Never raw milliseconds.
      expect(res.body.error.message).not.toMatch(/\d{4,}\s*ms/)
    }
  })

  it('tells the user what to try: open the lid', async () => {
    lastBridgeLossAtMock.mockReturnValue(STALE_LOSS(41))
    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.body.error.message).toBe(
      'Your primary box (Mac) has been unreachable for 41 minutes. '
      + 'It may be asleep (open the lid) or offline.',
    )
    expect(lastBridgeLossAtMock).toHaveBeenCalledWith('__local__')
  })

  it('reports the CURRENT outage, so a reconnect in between is never summed', async () => {
    // First request: the primary has been asleep for 40 minutes.
    lastBridgeLossAtMock.mockReturnValue(STALE_LOSS(40))
    const first = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(first.body.error.message).toMatch(/unreachable for 40 minutes/)
    // It woke, reconnected (which clears the registry's clock), then dropped
    // again 12s ago. The message must describe THIS outage.
    lastBridgeLossAtMock.mockReturnValue(Date.now() - 12_000)
    const second = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(second.body.error.message).toMatch(/unreachable for 12 seconds/)
    expect(second.body.error.message).not.toMatch(/40 minutes/)
  })

  it('falls back to the vague wording on a nonsense duration', async () => {
    // A clock that ran backwards (a loss stamped in the future) must not produce
    // a negative or absurd duration.
    lastBridgeLossAtMock.mockReturnValue(Date.now() + 5_000)
    const res = await request(createApp()).post('/api/v1/sessions').send(BODY)
    expect(res.status).toBe(503)
    expect(res.body.error.message).toMatch(/asleep or offline/)
    expect(res.body.error.message).not.toMatch(/unreachable for/)
  })
})

describe('GET /sessions/launch-options shares the same wait and retry', () => {
  const options = {
    hosts: [{ alias: '', label: 'Primary box' }, { alias: 'marina', label: 'Marina' }],
    dirs: [{ cwd: '/home/user/repo', host: 'marina', lastUsed: '2026-09-01T00:00:00Z', count: 2 }],
  }

  it('serves the primary\'s real answer after the bridge comes back', async () => {
    bridgeRequestMock
      .mockRejectedValueOnce(new BridgeOfflineError('__local__'))
      .mockResolvedValueOnce({ ok: true, result: options })
    waitForBridgeMock.mockResolvedValue(true)

    const res = await request(createApp()).get('/api/v1/sessions/launch-options')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(options)
    expect(bridgeRequestMock).toHaveBeenCalledTimes(2)
    expect(waitForBridgeMock).toHaveBeenCalledWith('__local__', 8_000)
  })

  it('keeps the existing 503 ladder when the bridge stays down', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    waitForBridgeMock.mockResolvedValue(false)

    const res = await request(createApp()).get('/api/v1/sessions/launch-options')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it('does not spend the wait budget on a long outage', async () => {
    lastBridgeLossAtMock.mockReturnValue(STALE_LOSS(19))
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))

    const res = await request(createApp()).get('/api/v1/sessions/launch-options')
    expect(res.status).toBe(503)
    expect(res.body.error.message).toMatch(/unreachable for 19 minutes/)
    expect(waitForBridgeMock).not.toHaveBeenCalled()
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })
})
