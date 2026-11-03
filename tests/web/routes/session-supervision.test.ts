import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-supervision-api'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionsRouter } from '../../../src/web/routes/sessions.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import * as daemonConnections from '../../../src/providers/daemon-connection.js'
import { sessionStops } from '../../../src/core/sessions/session-stop.js'
import { enqueueMessage, getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { bus } from '../../../src/core/event-bus.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import { _resetSupervisionLastKnownForTesting } from '../../../src/core/sessions/session-supervision.js'

const SID = '10000000-0000-4000-8000-000000000202'
const HOST = 'supervision-test-host'

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/sessions', sessionsRouter)
  server.use(errorHandler)
  return server
}

function daemon() {
  const send = vi.fn(async (command: string, args: Record<string, unknown>, _timeout?: number): Promise<Record<string, unknown>> => {
    if (command === 'stop') return { ok: true, stopped: true }
    return {
      ok: true,
      cronSupervision: { enabled: args.enabled ?? true, state: args.enabled === false ? 'disabled' : 'checking', reason: 'scheduler-unconfirmed', generation: 2, updatedAt: 42, retryAt: null },
    }
  })
  const connection = { connected: true, capabilitiesKnown: true, hasCapability: () => true, daemonStartup: 'service', send }
  vi.spyOn(daemonConnections, 'getConnectedDaemonConnection').mockReturnValue(connection as never)
  return { connection, send }
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetCache()
  bus.clear()
  _resetSupervisionLastKnownForTesting()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await createSessionRecord(SID, 'supervision-api-task', 'test', WALNUT_HOME, { host: HOST, initialProcessStatus: 'idle' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  bus.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  resetCache()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('session supervision API with real stop persistence', () => {
  it('reads and changes only supervision, never stops the process or sends input', async () => {
    const { send } = daemon()
    const first = await request(app()).get(`/api/sessions/${SID}/supervision`)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ available: true, startup: 'service', stopRequest: null, supervision: { enabled: true, state: 'checking' } })
    for (const enabled of [false, true, false, true]) {
      const response = await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled })
      expect(response.status).toBe(200)
      expect(response.body.supervision.enabled).toBe(enabled)
    }
    expect(send.mock.calls.map(([command]) => command)).toEqual(Array(5).fill('cron.supervision'))
    expect((await getSessionByClaudeId(SID))?.process_status).toBe('idle')
  })

  it('keeps offline stop pending on disk, parks old messages, and confirms only after reconnect ACK', async () => {
    const { connection, send } = daemon()
    await enqueueMessage(SID, 'Keep this message and do not auto-continue')
    connection.connected = false
    const first = await request(app()).post(`/api/sessions/${SID}/terminate`).send({ force: true })
    expect(first.status).toBe(200)
    expect(first.body.status).toBe('pending')
    const before = await getSessionByClaudeId(SID)
    expect(before?.stopRequest?.state).toBe('pending')
    expect(before?.process_status).toBe('idle')
    closeDb()
    _resetSessionTrackerForTesting()
    resetCache()
    const read = await request(app()).get(`/api/sessions/${SID}/supervision`)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ available: false, startup: 'unavailable', stopRequest: { id: before!.stopRequest!.id, state: 'pending' } })
    expect(await getQueue(SID)).toEqual([expect.objectContaining({ message: 'Keep this message and do not auto-continue', status: 'parked' })])
    connection.connected = true
    const locked = await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: true })
    expect(locked.status).toBe(409)
    expect(send).not.toHaveBeenCalled()
    await sessionStops.flush(HOST, connection)
    const after = await getSessionByClaudeId(SID)
    expect(after?.stopRequest).toMatchObject({ id: before!.stopRequest!.id, state: 'confirmed' })
    expect(after?.process_status).toBe('stopped')
    // A person's stop names this Walnut to a daemon that checks ownership (owner-home-v1).
    expect(send).toHaveBeenCalledExactlyOnceWith('stop', { sid: SID, reason: 'user', stopRequestId: before!.stopRequest!.id, home: WALNUT_HOME, initiator: 'human' }, 10_000)
  })

  it('rejects malformed input, unknown records, archived enable, and unsupported daemons', async () => {
    const { connection, send } = daemon()
    expect((await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: 'true' })).status).toBe(400)
    expect((await request(app()).get('/api/sessions/missing/supervision')).status).toBe(404)
    await updateSessionRecord(SID, { archived: true })
    expect((await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: true })).status).toBe(409)
    connection.hasCapability = () => false
    expect((await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: false })).status).toBe(409)
    const old = await request(app()).get(`/api/sessions/${SID}/supervision`)
    expect(old.body).toMatchObject({ available: false, startup: 'on-demand', supervision: null })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a mutation without a positive host acknowledgement', async () => {
    const { send } = daemon()
    send.mockResolvedValueOnce({ cronSupervision: { enabled: false } })
    const response = await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: false })
    expect(response.status).toBe(503)
    expect(response.body.error).toContain('did not confirm')
  })

  it.each([undefined, {}, { enabled: true }, { enabled: true, state: 'invented', generation: 1, updatedAt: 1, retryAt: null, reason: null }])('refuses malformed host state %j', async (cronSupervision) => {
    const { send } = daemon()
    send.mockResolvedValueOnce({ ok: true, cronSupervision })
    const response = await request(app()).get(`/api/sessions/${SID}/supervision`)
    expect(response.status).toBe(503)
    expect(response.body.error).toContain('invalid automatic recovery state')
  })

  it('does not report a mutation applied when the host acknowledges the old setting', async () => {
    const { send } = daemon()
    send.mockResolvedValueOnce({ ok: true, cronSupervision: { enabled: true, state: 'checking', generation: 1, updatedAt: 42, retryAt: null, reason: null } })
    const response = await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: false })
    expect(response.status).toBe(503)
    expect(response.body.error).toContain('did not apply')
  })

  it('includes a stop persisted while the earlier supervision read was in flight', async () => {
    const { connection, send } = daemon()
    let enter!: () => void
    let release!: (value: Record<string, unknown>) => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const delayed = new Promise<Record<string, unknown>>((resolve) => { release = resolve })
    send.mockImplementationOnce(async () => { enter(); return delayed })
    const reading = request(app()).get(`/api/sessions/${SID}/supervision`).then((result) => result)
    try {
      await entered
      connection.connected = false
      await sessionStops.request(SID)
    } finally { release({ ok: true, cronSupervision: null }) }
    const response = await reading
    expect(response.status).toBe(200)
    expect(response.body.stopRequest?.state).toBe('pending')
  })

  it('restores expected-exit suppression when the stop is not confirmed', async () => {
    const { connection } = daemon()
    connection.connected = false
    const undo = vi.fn()
    const markExpectedTeardown = vi.fn(() => undo)
    vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockReturnValue({ markExpectedTeardown } as never)
    const response = await request(app()).post(`/api/sessions/${SID}/terminate`).send({ force: true })
    expect(response.body.status).toBe('pending')
    expect(markExpectedTeardown).toHaveBeenCalledWith('user_terminated')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  // 2026-11-03: a daemon swap and tunnel drops on the host timed these reads out, and each was a 500 card.
  describe('a host that does not answer', () => {
    const timeout = () => markLinkFailure(new Error('daemon command timeout: cron.supervision (5000ms) [traceId=t1]'), 'no-answer')
    const lost = () => markLinkFailure(new Error('daemon command lost: cron.supervision: connection closed before host answered'), 'lost')

    it('a read with nothing kept answers the host unavailable, never a 500', async () => {
      const { send } = daemon()
      for (const failure of [timeout, lost]) {
        send.mockRejectedValueOnce(failure())
        const response = await request(app()).get(`/api/sessions/${SID}/supervision`)
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ stopRequest: null, available: false, startup: 'unavailable', supervision: null })
      }
    })

    it('a read after a good one answers the last confirmed state marked stale, then the live one again', async () => {
      const { send } = daemon()
      const good = await request(app()).get(`/api/sessions/${SID}/supervision`)
      expect(good.body.supervision.state).toBe('checking')
      for (let round = 0; round < 3; round++) {
        send.mockRejectedValueOnce(round % 2 ? lost() : timeout())
        const stale = await request(app()).get(`/api/sessions/${SID}/supervision`)
        expect(stale.status).toBe(200)
        expect(stale.body).toEqual({ ...good.body, stale: true })
      }
      const back = await request(app()).get(`/api/sessions/${SID}/supervision`)
      expect(back.status).toBe(200)
      expect(back.body.stale).toBeUndefined()
    })

    it('a stale read still carries a stop persisted since', async () => {
      const { connection, send } = daemon()
      await request(app()).get(`/api/sessions/${SID}/supervision`)
      connection.connected = false
      await sessionStops.request(SID)
      connection.connected = true
      send.mockRejectedValueOnce(timeout())
      const response = await request(app()).get(`/api/sessions/${SID}/supervision`)
      expect(response.status).toBe(200)
      expect(response.body.stopRequest?.state).toBe('pending')
    })

    it('a change the host did not answer is a 504 that says it may have applied; one never sent is a 503', async () => {
      const { send } = daemon()
      send.mockRejectedValueOnce(timeout())
      const response = await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: false })
      expect(response.status).toBe(504)
      expect(response.body.error).toMatch(/did not answer.*may have changed/)
      send.mockRejectedValueOnce(markLinkFailure(new Error('not connected'), 'no-link'))
      const refused = await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: false })
      expect(refused.status).toBe(503)
      expect(refused.body.error).toMatch(/was not changed/)
    })

    it('a change the host did not answer forgets the kept state, so a later failed read claims nothing', async () => {
      const { send } = daemon()
      await request(app()).get(`/api/sessions/${SID}/supervision`)
      send.mockRejectedValueOnce(timeout())
      expect((await request(app()).put(`/api/sessions/${SID}/supervision`).send({ enabled: false })).status).toBe(504)
      send.mockRejectedValueOnce(timeout())
      const read = await request(app()).get(`/api/sessions/${SID}/supervision`)
      expect(read.status).toBe(200)
      expect(read.body).toMatchObject({ available: false, startup: 'unavailable', supervision: null })
    })

    it('an error of the host\'s own is not hidden', async () => {
      const { send } = daemon()
      send.mockRejectedValueOnce(new Error('a real bug'))
      expect((await request(app()).get(`/api/sessions/${SID}/supervision`)).status).toBe(500)
    })
  })
})
