/**
 * The reconnect loop's cause and next step (daemon-reconnect-cause.ts) and how
 * DaemonConnection uses it: C10 (standing kind -> failed + exactly one slow
 * probe = retryAt), C50 (network kinds right after a wake stay reconnecting),
 * C11 (Connect now cancels the backoff), C12 (a concurrent getDaemonConnection
 * joins the running reconnect, never a second connect()), C12b (the same during
 * the backoff WAIT, and a timer never fires under a running connect), the
 * per-attempt clock, and retryAt surviving an old failure-cache entry. No ssh:
 * reconnect(), connect() and the ControlMaster are stubbed and the connection
 * is pooled through the test seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/providers/ssh-credential-evidence.js', async (orig) => ({
  ...(await orig<typeof import('../../src/providers/ssh-credential-evidence.js')>()),
  annotateCredentialFailure: async (err: unknown) => err,
}))

import {
  DaemonConnection, cancelReconnectBackoff, clearDaemonFailureCache, getDaemonConnectState, getDaemonConnection, setPooledConnectionForTest,
} from '../../src/providers/daemon-connection.js'
import {
  WAKE_GRACE_MS, clearReconnectCause, decideReconnectStep, noteHostSignal, resetHostSignalForTest,
} from '../../src/providers/daemon-reconnect-cause.js'
import { credentialRetryDelayMs } from '../../src/core/sessions/host-connect-hint.js'

const SLOW = 10 * 60_000
const T0 = new Date('2026-09-14T09:00:00Z').getTime()
const base = { now: T0, delayMs: 2_000, credentialAttempt: 0, lastSignalAt: 0, standingDelayMs: SLOW, maxDelayMs: 30_000, credentialDelayMs: credentialRetryDelayMs }

describe('decideReconnectStep', () => {
  it('auth / host_key / dns are standing: one slow probe whose time is retryAt', () => {
    for (const kind of ['auth', 'host_key', 'dns']) {
      expect(decideReconnectStep({ ...base, kind })).toEqual({ standing: true, credentialWait: false, nextDelayMs: SLOW, retryAt: T0 + SLOW })
    }
  })
  it('credential kinds follow the credential schedule', () => {
    expect(decideReconnectStep({ ...base, kind: 'cert_expired', credentialAttempt: 2 })).toEqual({ standing: true, credentialWait: true, nextDelayMs: 5 * 60_000, retryAt: T0 + 5 * 60_000 })
  })
  it('C50: dns within 90s of a wake is the network waking up; after 90s it is standing again', () => {
    expect(decideReconnectStep({ ...base, kind: 'dns', lastSignalAt: T0 - 10_000 }).standing).toBe(false)
    expect(decideReconnectStep({ ...base, kind: 'dns', lastSignalAt: T0 - WAKE_GRACE_MS - 1 }).standing).toBe(true)
  })
  it('other kinds back off with no promise of a time', () => {
    const s = decideReconnectStep({ ...base, kind: 'unreachable' })
    expect(s).toEqual({ standing: false, credentialWait: false, nextDelayMs: 4_000 })
  })
})

type Internals = { _connected: boolean; _connecting: boolean; reconnect: () => Promise<void>; scheduleReconnect: (d: number) => void; _disconnectedSince: number | null }
const TARGET = { hostname: 'devbox.example.com', user: 'alice' }

describe('DaemonConnection reconnect loop', () => {
  let conn: DaemonConnection
  let schedule: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetHostSignalForTest()
    conn = new DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'alice' })
    setPooledConnectionForTest('devbox', conn)
    const c = conn as unknown as Internals
    c._disconnectedSince = T0
    // As after handleConnectionLost: the host dropped and the loop is about to run.
    conn.setPhaseForTest('reconnecting')
    schedule = vi.spyOn(conn as never, 'scheduleReconnect' as never)
  })
  afterEach(() => {
    cancelReconnectBackoff('devbox')
    clearDaemonFailureCache('devbox')
    setPooledConnectionForTest('devbox', null)
    clearReconnectCause('devbox')
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** connect() must never run in these tests: a regression would ssh devbox.example.com for real. */
  function forbidConnect() {
    return vi.spyOn(conn, 'connect').mockImplementation(async () => { throw new Error('connect() must not run here') })
  }

  function failWith(message: string) {
    return vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((async () => { throw new Error(message) }) as never)
  }

  it('C10: an auth failure mid-reconnect flips to failed with exactly one slow probe, and retryAt is that probe', async () => {
    failWith('Permission denied (publickey).')
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    await vi.advanceTimersByTimeAsync(2_001)
    const slowCalls = schedule.mock.calls.filter((c) => c[0] === SLOW)
    expect(slowCalls).toHaveLength(1)
    expect(conn.reconnectPending).toBe(true)
    const st = getDaemonConnectState('devbox')
    expect(st.phase).toBe('failed')
    expect(st.kind).toBe('auth')
    expect(st.error).toMatch(/Permission denied/)
    expect(st.retryAt).toBe(T0 + 2_000 + SLOW)
    // No fast retry follows: nothing else is scheduled before the slow probe.
    await vi.advanceTimersByTimeAsync(SLOW - 10)
    expect(schedule.mock.calls).toHaveLength(2)
  })

  it('a transient failure keeps the phase reconnecting and exposes the cause as lastError/lastKind', async () => {
    failWith('ssh: connect to host devbox.example.com port 22: Operation timed out')
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    await vi.advanceTimersByTimeAsync(2_001)
    const st = getDaemonConnectState('devbox')
    expect(st.phase).toBe('reconnecting')
    expect(st.lastKind).toBe('timeout')
    expect(st.lastError).toMatch(/timed out/)
    expect(st.reconnectSince).toBe(T0)
    expect(st.retryAt).toBeUndefined()
  })

  it('C50: dns right after a wake signal stays reconnecting; dns 90s later turns failed with a slow probe', async () => {
    failWith('ssh: Could not resolve hostname devbox.example.com: nodename nor servname provided')
    noteHostSignal(Date.now())
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(getDaemonConnectState('devbox').phase).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS)
    const st = getDaemonConnectState('devbox')
    expect(st.phase).toBe('failed')
    expect(st.kind).toBe('dns')
    expect(typeof st.retryAt).toBe('number')
  })

  it('C11: cancelReconnectBackoff drops the pending timer', async () => {
    failWith('Permission denied (publickey).')
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    expect(conn.reconnectPending).toBe(true)
    expect(cancelReconnectBackoff('devbox')).toBe(true)
    expect(conn.reconnectPending).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(schedule.mock.calls).toHaveLength(1)
  })

  it('C12: getDaemonConnection during a running reconnect joins it; connect() is never called', async () => {
    let finish!: () => void
    vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((() => new Promise<void>((r) => { finish = () => { (conn as unknown as Internals)._connected = true; r() } })) as never)
    const connectSpy = forbidConnect()
    ;(conn as unknown as Internals).scheduleReconnect(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(conn.reconnectInFlight).not.toBeNull()
    const joined = getDaemonConnection('devbox', TARGET)
    finish()
    await expect(joined).resolves.toBe(conn)
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('C12b: getDaemonConnection during the backoff WAIT joins one reconnect attempt; connect() never runs, twice or once', async () => {
    let finish!: () => void
    const reconnect = vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((() => new Promise<void>((r) => { finish = () => { (conn as unknown as Internals)._connected = true; r() } })) as never)
    const connectSpy = forbidConnect()
    const stopMaster = vi.spyOn(conn as never, 'stopControlMaster' as never).mockImplementation((async () => {}) as never)
    ;(conn as unknown as Internals).scheduleReconnect(30_000)
    expect(conn.reconnectPending).toBe(true)
    expect(conn.reconnectInFlight).toBeNull()
    const a = getDaemonConnection('devbox', TARGET)
    const b = getDaemonConnection('devbox', TARGET)
    expect(conn.reconnectPending).toBe(false)
    finish()
    await expect(a).resolves.toBe(conn)
    await expect(b).resolves.toBe(conn)
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(connectSpy).not.toHaveBeenCalled()
    expect(stopMaster).not.toHaveBeenCalled()
  })

  it('C12b: during a standing wait an automatic getDaemonConnection fails fast with the cause instead of dialling', async () => {
    const reconnect = failWith('Permission denied (publickey).')
    forbidConnect()
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(reconnect).toHaveBeenCalledTimes(1)
    await expect(getDaemonConnection('devbox', TARGET)).rejects.toThrow(/Permission denied/)
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(conn.reconnectPending).toBe(true)
  })

  it('C12b: a connect() cancels a pending reconnect timer on entry, so the timer never stops its ControlMaster; a failure resumes the loop', async () => {
    const reconnect = vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((async () => { throw new Error('reconnect must not run under connect') }) as never)
    const stopMaster = vi.spyOn(conn as never, 'stopControlMaster' as never).mockImplementation((async () => {}) as never)
    let failMaster!: (e: Error) => void
    vi.spyOn(conn as never, 'ensureControlMaster' as never).mockImplementation((() => new Promise<void>((_r, rej) => { failMaster = rej })) as never)
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    const connecting = conn.connect()
    expect(conn.reconnectPending).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reconnect).not.toHaveBeenCalled()
    expect(stopMaster).not.toHaveBeenCalled()
    failMaster(new Error('Permission denied (publickey).'))
    await expect(connecting).rejects.toThrow(/Permission denied/)
    // Recovery goes on: the slow probe is armed and its time is on screen.
    expect(conn.reconnectPending).toBe(true)
    const st = getDaemonConnectState('devbox')
    expect(st).toMatchObject({ phase: 'failed', kind: 'auth' })
    expect(st.retryAt).toBe(Date.now() + SLOW)
  })

  it('C12b: a timer that fires while a connect() is running reschedules instead of running reconnect()', async () => {
    const reconnect = vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((async () => {}) as never)
    ;(conn as unknown as Internals)._connecting = true
    ;(conn as unknown as Internals).scheduleReconnect(1)
    await vi.advanceTimersByTimeAsync(5)
    expect(reconnect).not.toHaveBeenCalled()
    expect(conn.reconnectPending).toBe(true)
    ;(conn as unknown as Internals)._connecting = false
  })

  it('attemptStartedAt is each reconnect attempt\'s own start, not the first dial\'s', async () => {
    failWith('ssh: connect to host devbox.example.com port 22: Operation timed out')
    ;(conn as unknown as Internals).scheduleReconnect(2_000)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(getDaemonConnectState('devbox').attemptStartedAt).toBe(T0 + 2_000)
    // The transient backoff doubles: the next attempt starts 4s later.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(getDaemonConnectState('devbox').attemptStartedAt).toBe(T0 + 6_000)
  })

  it.each([['expired (61s)', 61_000], ['still fresh (10s)', 10_000]])(
    'retryAt comes back after one connect() failure whose cache entry is %s',
    async (_label, gapMs) => {
      // A connect() through the pool fails once: a failure-cache entry that is never evicted.
      const connectSpy = vi.spyOn(conn, 'connect').mockImplementation(async () => { throw new Error('Permission denied (publickey).') })
      setPooledConnectionForTest('devbox', conn)
      cancelReconnectBackoff('devbox')
      await expect(getDaemonConnection('devbox', TARGET)).rejects.toThrow(/Permission denied/)
      expect(connectSpy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(gapMs)
      // Later the reconnect loop meets the same standing cause and arms its slow probe.
      conn.setPhaseForTest('reconnecting')
      failWith('Permission denied (publickey).')
      ;(conn as unknown as Internals).scheduleReconnect(2_000)
      await vi.advanceTimersByTimeAsync(2_001)
      const st = getDaemonConnectState('devbox')
      expect(st.phase).toBe('failed')
      expect(st.kind).toBe('auth')
      expect(st.retryAt).toBe(T0 + gapMs + 2_000 + SLOW)
    },
  )
})
