/**
 * The Demo's remote hosts (src/providers/demo-remote-host.ts) belong to a Demo
 * server only. On an ephemeral server that is not a Demo, without the remote-host
 * opt-in, a Demo generation leaking into its env changes nothing: every remote host
 * stays read only and off, and its Connect is refused as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-demo-remote-off-test', { IS_EPHEMERAL: true, IS_DEMO: false }))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.test' } } }),
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { connectHostNow, hostStatusFrame, remoteHostsOff } from '../../src/core/hosts/host-connect-action.js'

const saved = process.env.WALNUT_DEMO_GENERATION
beforeEach(() => { process.env.WALNUT_DEMO_GENERATION = '7c0f9a52-3d4e-4b8a-9f10-2a6b5c8d1e3f' })
afterEach(() => {
  if (saved === undefined) delete process.env.WALNUT_DEMO_GENERATION
  else process.env.WALNUT_DEMO_GENERATION = saved
  vi.restoreAllMocks()
})

describe('an ephemeral server that is not a Demo', () => {
  it('keeps every remote host read only, with no daemon of its own', () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'marina', use_daemon: true })
    const priv = conn as unknown as { isReadOnlyRemote: boolean; ephemeralRemoteRefused: boolean; dirEnv: Record<string, string> }
    expect(priv.isReadOnlyRemote).toBe(true)
    expect(priv.ephemeralRemoteRefused).toBe(true)
    expect(priv.dirEnv).toEqual({})
    expect(conn.demoLifted).toBe(false)
  })

  it('says the host is off, and refuses its Connect', async () => {
    expect(remoteHostsOff('devbox', { transport: 'ssh' })).toBe(true)
    expect(hostStatusFrame('devbox', { hostname: 'devbox.example.test' }).phase).toBe('off')
    const r = await connectHostNow('devbox')
    expect(r.httpStatus).toBe(409)
    expect(r.body).toMatchObject({ code: 'host_off' })
  })
})
