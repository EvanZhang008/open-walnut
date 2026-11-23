/**
 * The launcher's facts after hello (review point 2): a daemon whose good version's roles became known
 * after its hello sends `launcher-facts` (daemon-standalone.ts tellLauncherFacts), and the connection
 * takes them in place, with no reconnect: host_get shows launcher.goodRoles at once. Facts that do
 * not hold together change nothing. MACHINE SAFETY: no socket, no process; constants mocked to a temp home.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-launcher-facts'))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { fleetLauncher } from '../../src/core/hosts/host-launcher.js'

const frame = (conn: DaemonConnection, msg: Record<string, unknown>) =>
  (conn as unknown as { handleFrame: (m: Record<string, unknown>) => void }).handleFrame(msg)

describe('launcher-facts after hello', () => {
  it('replaces the facts hello gave, goodRoles included; a broken frame changes nothing', () => {
    const conn = new DaemonConnection('devbox', null)
    const facts = { current: '/v/cur/walnut', good: '/v/good/walnut', phase: 'committed', since: 1 }
    frame(conn, { ev: 'launcher-facts', launcher: facts })
    expect(conn.launcher).toMatchObject(facts)
    expect(conn.launcher).not.toHaveProperty('goodRoles')
    frame(conn, { ev: 'launcher-facts', launcher: { ...facts, goodRoles: ['replica', 'leader'] } })
    expect(conn.launcher?.goodRoles).toEqual(['replica', 'leader'])
    expect(fleetLauncher(conn.launcher)?.goodRoles).toEqual(['replica', 'leader'])
    frame(conn, { ev: 'launcher-facts', launcher: { phase: 'nonsense' } })
    expect(conn.launcher?.goodRoles).toEqual(['replica', 'leader'])
  })
})
