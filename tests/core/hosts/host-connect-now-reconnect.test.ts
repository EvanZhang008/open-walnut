/**
 * P1 regression: Connect now / Retry / a Start's redial on a host whose
 * reconnect loop is waiting must not kill the loop. connectHostNow used to
 * cancel the backoff and call connect(); a failed connect() never rescheduled,
 * so the host stopped recovering and its retryAt vanished for good. Now the
 * loop's own attempt runs (DaemonConnection.reconnectNow) and a failure puts it
 * back on its schedule. The REAL pool and connectHostNow run; only reconnect()
 * and connect() are stubbed (connect() throws: it must never be reached).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())
vi.mock('../../../src/providers/ssh-credential-evidence.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/providers/ssh-credential-evidence.js')>()),
  annotateCredentialFailure: async (err: unknown) => err,
}))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.com', user: 'alice', label: 'Dev box' } } }),
}))

const dc = await import('../../../src/providers/daemon-connection.js')
const { connectHostNow } = await import('../../../src/core/hosts/host-connect-action.js')
const { clearReconnectCause } = await import('../../../src/providers/daemon-reconnect-cause.js')

const SLOW = 10 * 60_000
const T0 = new Date('2026-09-25T09:00:00Z').getTime()
type Internals = { _disconnectedSince: number | null; scheduleReconnect: (d: number) => void }

let conn: InstanceType<typeof dc.DaemonConnection>
let reconnect: ReturnType<typeof vi.spyOn>
let connect: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  conn = new dc.DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'alice' })
  dc.setPooledConnectionForTest('devbox', conn)
  ;(conn as unknown as Internals)._disconnectedSince = T0
  conn.setPhaseForTest('reconnecting')
  reconnect = vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((async () => { throw new Error('Permission denied (publickey).') }) as never)
  connect = vi.spyOn(conn, 'connect').mockImplementation(async () => { throw new Error('connect() must not run: it would ssh for real') })
  // The loop met a standing cause: failed on screen, one slow probe armed.
  ;(conn as unknown as Internals).scheduleReconnect(2_000)
  await vi.advanceTimersByTimeAsync(2_001)
  expect(conn.reconnectPending).toBe(true)
  expect(dc.getDaemonConnectState('devbox').retryAt).toBe(T0 + 2_000 + SLOW)
})

afterEach(() => {
  dc.cancelReconnectBackoff('devbox')
  dc.clearDaemonFailureCache('devbox')
  dc.setPooledConnectionForTest('devbox', null)
  clearReconnectCause('devbox')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Connect now during a reconnect loop', () => {
  it('a Connect now that fails leaves the loop pending with a real retryAt', async () => {
    const r = await connectHostNow('devbox')
    expect(r.httpStatus).toBe(200)
    await vi.advanceTimersByTimeAsync(0)
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(connect).not.toHaveBeenCalled()
    expect(conn.reconnectPending).toBe(true)
    const st = dc.getDaemonConnectState('devbox')
    expect(st.phase).toBe('failed')
    expect(st.kind).toBe('auth')
    expect(st.retryAt).toBe(Date.now() + SLOW)
  })

  it('the Start gate\'s awaited redial reports the failure and still leaves the loop and its retryAt', async () => {
    const r = await connectHostNow('devbox', { deadlineMs: 1_000 })
    expect(r.outcome).toBe('failed')
    expect(r.status).toMatchObject({ phase: 'failed' })
    expect(connect).not.toHaveBeenCalled()
    expect(conn.reconnectPending).toBe(true)
    expect(dc.getDaemonConnectState('devbox').retryAt).toBe(Date.now() + SLOW)
  })

  it('a Connect now that succeeds ends the loop', async () => {
    reconnect.mockImplementation((async () => { (conn as unknown as { _connected: boolean })._connected = true }) as never)
    const r = await connectHostNow('devbox', { deadlineMs: 1_000 })
    expect(r.outcome).toBe('connected')
    expect(conn.reconnectPending).toBe(false)
  })
})
