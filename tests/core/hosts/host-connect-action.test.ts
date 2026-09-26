/**
 * connectHostNow is the ONE server side of Connect / Retry (C28): both HTTP
 * routes call it, it checks `enabled`, clears the failure cache, resets the
 * autofix attempts, and dials exactly once (C11): a host in its reconnect loop
 * runs the loop's attempt now (reconnectHostNow) and keeps the loop.
 * The daemon pool and the config are stubs; nothing dials.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

const dc = vi.hoisted(() => ({
  phase: 'reconnecting' as string,
  clearDaemonFailureCache: vi.fn(),
  cancelReconnectBackoff: vi.fn(() => true),
  joined: null as Promise<void> | null,
  reconnectHostNow: vi.fn(() => dc.joined),
  getDaemonConnection: vi.fn(async () => ({ connected: true })),
  getDaemonConnectState: vi.fn(() => ({ host: 'devbox', connected: false, phase: dc.phase, phaseElapsedMs: 0, connectElapsedMs: 0 })),
  expediteReconnect: vi.fn(() => false),
}))
vi.mock('../../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  clearDaemonFailureCache: dc.clearDaemonFailureCache,
  cancelReconnectBackoff: dc.cancelReconnectBackoff,
  reconnectHostNow: dc.reconnectHostNow,
  getDaemonConnection: dc.getDaemonConnection,
  getDaemonConnectState: dc.getDaemonConnectState,
  expediteReconnect: dc.expediteReconnect,
}))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.com', user: 'alice', label: 'Dev box' }, offbox: { hostname: 'off.example.com', enabled: false } } }),
}))
const reset = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/hosts/host-readiness.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resetHostAutofixAttempts: reset,
  refreshHostReadiness: vi.fn(async () => null),
}))

const action = await import('../../../src/core/hosts/host-connect-action.js')

beforeEach(() => {
  dc.phase = 'reconnecting'
  dc.joined = null
  for (const f of [dc.clearDaemonFailureCache, dc.cancelReconnectBackoff, dc.reconnectHostNow, dc.getDaemonConnection, reset]) f.mockClear()
  dc.expediteReconnect.mockReset().mockReturnValue(false)
})

describe('connectHostNow', () => {
  it('C11: during a reconnect it runs the loop\'s attempt now, after clearing the failure cache and autofix attempts, and dials nothing else', async () => {
    dc.joined = Promise.resolve()
    const r = await action.connectHostNow('devbox')
    expect(r.httpStatus).toBe(200)
    expect(dc.clearDaemonFailureCache).toHaveBeenCalledWith('devbox')
    expect(reset).toHaveBeenCalledWith('devbox')
    expect(dc.reconnectHostNow).toHaveBeenCalledWith('devbox', { hostname: 'devbox.example.com', user: 'alice', port: undefined })
    // Never cancel the loop: a failed dial after a cancel ended recovery for good.
    expect(dc.cancelReconnectBackoff).not.toHaveBeenCalled()
    expect(dc.getDaemonConnection).not.toHaveBeenCalled()
  })

  it('with no reconnect loop to join it dials through the pool exactly once', async () => {
    const r = await action.connectHostNow('devbox')
    expect(r.httpStatus).toBe(200)
    expect(dc.getDaemonConnection).toHaveBeenCalledTimes(1)
  })

  it('a disabled host is refused with host_disabled and never dialled; an unknown host is a 404', async () => {
    const off = await action.connectHostNow('offbox')
    expect(off).toMatchObject({ httpStatus: 409, body: { code: 'host_disabled' } })
    expect((await action.connectHostNow('nosuch')).httpStatus).toBe(404)
    expect(dc.getDaemonConnection).not.toHaveBeenCalled()
    expect(dc.clearDaemonFailureCache).not.toHaveBeenCalled()
  })

  it('with a deadline it waits for the attempt and reports the outcome', async () => {
    dc.phase = 'failed'
    dc.getDaemonConnection.mockImplementationOnce(async () => { throw new Error('Permission denied (publickey).') })
    const r = await action.connectHostNow('devbox', { deadlineMs: 1_000 })
    expect(r.outcome).toBe('failed')
  })
})

describe('C28: both Retry routes run the same server function', () => {
  it('POST /api/hosts/:host/connect and POST /api/sessions/host-retry answer identically', async () => {
    const spy = vi.spyOn(action, 'connectHostNow')
    const { hostsRouter } = await import('../../../src/web/routes/hosts.js')
    const app = express().use(express.json()).use('/api/hosts', hostsRouter)
    const a = await request(app).post('/api/hosts/offbox/connect').send({})
    expect(a.status).toBe(409)
    expect(a.body.code).toBe('host_disabled')
    // The picker's route: same function, same body.
    const { sessionsRouter } = await import('../../../src/web/routes/sessions.js')
    const app2 = express().use(express.json()).use('/api/sessions', sessionsRouter)
    const b = await request(app2).post('/api/sessions/host-retry').send({ host: 'offbox' })
    expect(b.status).toBe(409)
    expect(b.body).toEqual(a.body)
    spy.mockRestore()
  })
})

describe('redialAfterWake', () => {
  it('a host in its reconnect loop runs the loop\'s attempt now and touches nothing else', async () => {
    const { setHostWarmup } = await import('../../../src/core/hosts/host-warmup-registry.js')
    const kick = vi.fn(async () => {})
    setHostWarmup({ kick } as never)
    dc.expediteReconnect.mockReturnValue(true)
    action.redialAfterWake('devbox')
    expect(dc.expediteReconnect).toHaveBeenCalledWith('devbox')
    expect(kick).not.toHaveBeenCalled()
    expect(dc.clearDaemonFailureCache).not.toHaveBeenCalled()
    setHostWarmup(null)
  })

  it('a failed host with no loop gets one warmup dial after the cache is cleared', async () => {
    const { setHostWarmup } = await import('../../../src/core/hosts/host-warmup-registry.js')
    const kick = vi.fn(async () => {})
    setHostWarmup({ kick } as never)
    action.redialAfterWake('devbox')
    expect(dc.clearDaemonFailureCache).toHaveBeenCalledWith('devbox')
    expect(kick).toHaveBeenCalledWith('devbox')
    setHostWarmup(null)
  })

  it('with warmup disabled the failure cache is kept: clearing it alone hid the failure while nothing redialled', () => {
    action.redialAfterWake('devbox')
    expect(dc.clearDaemonFailureCache).not.toHaveBeenCalled()
  })
})
