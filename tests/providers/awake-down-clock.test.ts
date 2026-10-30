/**
 * A daemon link that is down while the Mac sleeps is not "5 minutes into an
 * outage" when the Mac wakes. 2026-10-30: the local daemon's link closed at
 * 03:20:47 UTC as the Mac went to sleep; at a 2-second dark wake at 03:36:58
 * every local session's liveness check read 16 minutes down, declared its live
 * CLI dead and handed nine working tasks back to the user. At 03:56 all of
 * them were running again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-awake-down'))

const { AwakeDownClock, AWAKE_STEP_CAP_MS } = await import('../../src/providers/awake-down-clock.js')
const { DaemonConnection } = await import('../../src/providers/daemon-connection.js')
const { RemoteSessionManager } = await import('../../src/providers/remote-session-manager.js')

const T0 = Date.parse('2026-10-30T03:20:47.000Z')
const MIN = 60_000

describe('AwakeDownClock', () => {
  it('follows the real time while checks come every few seconds', () => {
    const c = new AwakeDownClock()
    c.start(T0)
    let down = 0
    for (let t = T0 + 3000; t <= T0 + 6 * MIN; t += 3000) down = c.sample(t)
    expect(down).toBe(6 * MIN)
  })

  it('a sleep between two checks counts one capped step, however long', () => {
    const c = new AwakeDownClock()
    c.start(T0)
    expect(c.sample(T0 + 16 * MIN + 11_000)).toBe(AWAKE_STEP_CAP_MS)
    expect(c.sample(T0 + 16 * MIN + 14_000)).toBe(AWAKE_STEP_CAP_MS + 3000)
  })

  it('reads 0 before a start and after a reset, and never goes backwards on a clock step back', () => {
    const c = new AwakeDownClock()
    expect(c.sample(T0)).toBe(0)
    c.start(T0)
    c.sample(T0 + 10_000)
    expect(c.sample(T0 + 5_000)).toBe(10_000)
    c.reset()
    expect(c.sample(T0 + 20_000)).toBe(0)
  })
})

describe('a session behind a link that went down before a sleep', () => {
  afterEach(() => { vi.useRealTimers() })

  function setConnected(conn: unknown, v: boolean) {
    (conn as { setConnected(v: boolean): void }).setConnected(v)
  }

  it('the incident: down at 03:20:47, first look at the 03:36:58 wake, the CLI is still taken as alive', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    const conn = new DaemonConnection('__local__', null)
    setConnected(conn, true)
    setConnected(conn, false)
    const mgr = new RemoteSessionManager('sid-1', '__local__', null)
    Object.assign(mgr, { conn, _sid: 'sid-1' })
    vi.setSystemTime(Date.parse('2026-10-30T03:36:58.219Z'))
    expect(Date.now() - (conn.disconnectedSince ?? 0)).toBeGreaterThan(5 * MIN)
    await expect(mgr.isAlive()).resolves.toBe(true)
    expect(conn.disconnectedAwakeMs()).toBeLessThanOrEqual(AWAKE_STEP_CAP_MS)
  })

  it('five awake minutes down still give the session up, as before', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    const conn = new DaemonConnection('__local__', null)
    setConnected(conn, true)
    setConnected(conn, false)
    const mgr = new RemoteSessionManager('sid-1', '__local__', null)
    Object.assign(mgr, { conn, _sid: 'sid-1' })
    let alive = true
    for (let t = 3000; t <= 5 * MIN + 6000; t += 3000) {
      vi.setSystemTime(T0 + t)
      alive = await mgr.isAlive()
    }
    expect(alive).toBe(false)
    // The link back up starts over.
    setConnected(conn, true)
    expect(conn.disconnectedAwakeMs()).toBe(0)
  })
})
