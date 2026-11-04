/**
 * A host network machine's reconnect loop survives a failed attempt, and a machine
 * taken out leaves no loop behind.
 *
 * 2026-11-03 on the Mac: a machine was removed from the host network and a new one
 * joined under the same name. The old connection's reconnect failed at once ("is not
 * a member"); its failure handling read the SSH target, which throws for a machine
 * with no SSH, so no cause was recorded and no next attempt was scheduled. The host
 * read "Reaching devbox-clean through the host network" for good, the warmup took
 * that for a dial in flight, and nothing ever dialled the machine that joined.
 *
 * reconnect() is stubbed: no walnut-net, socket or ssh.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  DaemonConnection, dropDaemonConnection, getDaemonConnectState, peekDaemonConnection,
  pooledConnectionTargets, setPooledConnectionForTest,
} from '../../src/providers/daemon-connection.js'
import { CONNECT_IN_FLIGHT_PHASES } from '../../src/core/sessions/host-connect-hint.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

const HOST = 'devbox-clean'
const OLD = { hostname: 'devbox-clean.walnut-net.invalid', via: 'net' as const, endpoint: '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b' }
const NEW = { ...OLD, endpoint: 'e52bff6b6d387bb59475c13291cef96b4e6ec51065a85d20ba309edf8f9fe8ee' }

let conn: DaemonConnection | null = null
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  conn?.disconnect()
  setPooledConnectionForTest(HOST, null)
  conn = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function pooledNetHost(): { c: DaemonConnection; schedule: ReturnType<typeof vi.spyOn> } {
  conn = new DaemonConnection(HOST, OLD)
  setPooledConnectionForTest(HOST, conn)
  vi.spyOn(priv(conn), 'reconnect').mockImplementation(async () => {
    priv(conn!).setPhase('tunnel')
    throw new Error(`Host network: ${HOST} did not answer (net.forward failed: ${OLD.endpoint} is not a member)`)
  })
  return { c: conn, schedule: vi.spyOn(priv(conn), 'scheduleReconnect') }
}

describe('a host network machine whose reconnect fails', () => {
  it('keeps its loop: the next attempt is scheduled, and it no longer reads as mid-dial', async () => {
    const { c, schedule } = pooledNetHost()
    priv(c).scheduleReconnect(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(getDaemonConnectState(HOST).phase).toBe('reconnecting')
    // And the one after it, doubling.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(schedule).toHaveBeenCalledTimes(3)
    expect(schedule).toHaveBeenLastCalledWith(4_000)
  })

  it('a failure handler that itself fails still schedules the next attempt', async () => {
    const { c, schedule } = pooledNetHost()
    vi.spyOn(priv(c), 'handleReconnectFailure').mockRejectedValue(new Error('handler bug'))
    priv(c).scheduleReconnect(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(getDaemonConnectState(HOST).phase).toBe('reconnecting')
  })
})

describe('a machine taken out of the config', () => {
  it('drops its connection and loop: nothing reads as a dial for its name', async () => {
    const { c } = pooledNetHost()
    priv(c).scheduleReconnect(60_000)
    expect(dropDaemonConnection(HOST)).toBe(true)
    expect(peekDaemonConnection(HOST)).toBeNull()
    expect(CONNECT_IN_FLIGHT_PHASES.has(getDaemonConnectState(HOST).phase)).toBe(false)
    const reconnect = vi.mocked(priv(c).reconnect)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reconnect).not.toHaveBeenCalled()
    expect(dropDaemonConnection(HOST)).toBe(false)
  })

  it('a pooled dial of another machine under the name is not this machine\'s', () => {
    pooledNetHost()
    expect(pooledConnectionTargets(HOST, OLD)).toBe(true)
    expect(pooledConnectionTargets(HOST, NEW)).toBe(false)
    expect(pooledConnectionTargets('nothing-pooled', NEW)).toBe(true)
  })
})

describe('the cloud box keeps its own words', () => {
  it('a companion that belongs to another Mac is still probed slowly, not every minute', async () => {
    const c = new DaemonConnection('__cloudbox__', { hostname: 'box.example.test' })
    conn = c
    vi.spyOn(priv(c), 'reconnect').mockRejectedValue(new Error('Another Mac is connected to this cloud companion'))
    const schedule = vi.spyOn(priv(c), 'scheduleReconnect')
    priv(c).scheduleReconnect(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(schedule).toHaveBeenLastCalledWith(10 * 60_000)
  })
})
