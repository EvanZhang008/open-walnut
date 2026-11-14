/**
 * A host's first connect, as the connection reports it (DaemonConnection.firstConnectRunning,
 * getDaemonConnectState().firstConnect): the web console's background card shows a host only
 * while this is true, so an established host's reconnect must never read as one.
 *
 *  - a probe that finds no daemon on a host whose link was never up: first connect, from the
 *    deploy on, until the link comes up;
 *  - a probe that finds the daemon running (a server restart re-attaching): not;
 *  - a link that was up before, its daemon gone (the host rebooted): not;
 *  - a server restart, then the daemon gone on a host whose link was up in the run before (the
 *    connected edge recorded it on the host profile): not.
 *
 * All transport is stubbed on the instance; no process, socket or tunnel is created.
 */
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-first-connect'))

import { DaemonConnection, getDaemonConnectState, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { HOST_PROFILES_DIR, __resetHostConnectedForTests, readHostProfile } from '../../src/core/hosts/host-profile.js'
import { TARGET, priv, state } from '../helpers/daemon-connection-update-stubs.js'

let conns: DaemonConnection[] = []
beforeEach(() => {
  fs.rmSync(HOST_PROFILES_DIR, { recursive: true, force: true })
  __resetHostConnectedForTests()
})
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  setPooledConnectionForTest('devbox', null)
  vi.restoreAllMocks()
})

/** A pooled connection whose connect() runs its real order over stubbed steps. */
function make(daemonRunning: boolean): { c: DaemonConnection; seenDuringDeploy: Array<boolean | undefined> } {
  const c = new DaemonConnection('devbox', TARGET)
  conns.push(c)
  setPooledConnectionForTest('devbox', c)
  const seenDuringDeploy: Array<boolean | undefined> = []
  const p = priv(c)
  vi.spyOn(p, 'ensureControlMaster').mockResolvedValue(undefined)
  vi.spyOn(p, 'resolveRemoteDir').mockResolvedValue(undefined)
  vi.spyOn(p, 'checkDaemonRunning').mockResolvedValue(daemonRunning ? 32100 : null)
  vi.spyOn(p, 'deployAndStart').mockImplementation(async () => {
    seenDuringDeploy.push(getDaemonConnectState('devbox').firstConnect)
    return 32100
  })
  vi.spyOn(p, 'createTunnel').mockResolvedValue(5555)
  vi.spyOn(p, 'connectWebSocket').mockResolvedValue(undefined)
  vi.spyOn(p, 'verifyCapabilities').mockResolvedValue(true)
  vi.spyOn(p, 'setConnected').mockImplementation((value: unknown) => {
    state(c)._connected = value
    if (value) state(c).linkUpAt = Date.now()
  })
  for (const name of ['startPing', 'startDeferredUpgrade']) vi.spyOn(p, name).mockImplementation(() => {})
  vi.spyOn(p, 'recoverDisconnectedSessions').mockResolvedValue(undefined)
  return { c, seenDuringDeploy }
}

describe('a host\'s first connect', () => {
  it('a host with no daemon whose link was never up: first connect from the deploy on, spent once connected', async () => {
    const { c, seenDuringDeploy } = make(false)
    expect(c.firstConnectRunning).toBe(false)
    await c.connect()
    expect(seenDuringDeploy).toEqual([true])
    expect(c.connected).toBe(true)
    expect(c.firstConnectRunning).toBe(false)
    expect(getDaemonConnectState('devbox').firstConnect).toBeUndefined()
  })

  it('a host whose daemon is running (a restart re-attaching) is not one', async () => {
    const { c } = make(true)
    const states: Array<boolean | undefined> = []
    vi.spyOn(priv(c), 'createTunnel').mockImplementation(async () => { states.push(getDaemonConnectState('devbox').firstConnect); return 5555 })
    await c.connect()
    expect(states).toEqual([undefined])
    expect(priv(c).deployAndStart).not.toHaveBeenCalled()
  })

  it('a server restart, then the daemon gone on a host that connected in the run before, is not one', async () => {
    // The run before: the link came up, and its connected edge recorded it on the host profile.
    const before = new DaemonConnection('devbox', TARGET)
    conns.push(before)
    priv(before).setConnected(true)
    await vi.waitFor(async () => { expect((await readHostProfile('devbox')).connectedAt).toBeTruthy() })
    state(before)._connected = false
    before.disconnect()
    // The restart: a new process remembers nothing but what is on disk.
    __resetHostConnectedForTests()
    const { c, seenDuringDeploy } = make(false)
    await c.connect()
    expect(seenDuringDeploy).toEqual([undefined])
  })

  it('a host whose link was up before, its daemon gone since, is not one', async () => {
    const { c, seenDuringDeploy } = make(false)
    state(c).linkUpAt = Date.now() - 60_000
    await c.connect()
    expect(seenDuringDeploy).toEqual([undefined])
  })
})
