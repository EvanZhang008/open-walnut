/**
 * A host replica dials no host (docs/plan/walnut-replica-servers-impl.md, WP5):
 * its config is a copy of the Mac's, which names every host's ssh target, so a
 * read that reaches getDaemonConnection for another host (or for its own host
 * before the follower link is up) must fail as a link failure that needs the
 * Mac, never open ssh or a daemon connection from here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-no-dial', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetServerRoleForTesting, isHostReplicaProgram } from '../../src/core/server-role.js'
import { getDaemonConnection, getDaemonPoolStatus } from '../../src/providers/daemon-connection.js'
import { linkFailureKind } from '../../src/providers/link-failure.js'
import { isNeedsLeaderError } from '../../src/core/replication/needs-leader.js'

let env: HostReplicaEnv

beforeAll(() => {
  env = useHostReplicaEnv(WALNUT_HOME)
  _resetServerRoleForTesting()
})

afterAll(() => {
  env.restore()
  _resetServerRoleForTesting()
})

describe('a host replica reaches no host of its own', () => {
  it('another host from the copied config is refused before any connection exists', async () => {
    expect(isHostReplicaProgram()).toBe(true)
    let err: unknown
    try {
      await getDaemonConnection('marina-box', { hostname: 'marina.example.test', user: 'acme', port: 2222 } as never)
    } catch (e) { err = e }
    expect(isNeedsLeaderError(err)).toBe(true)
    expect((err as { why: string }).why).toBe('other_hosts_need_mac')
    expect(linkFailureKind(err)).toBe('no-link')
    expect(JSON.stringify(getDaemonPoolStatus())).not.toContain('marina')
  })

  it('its own host with no follower link installed is refused too (never ssh)', async () => {
    await expect(getDaemonConnection('acme-self', { hostname: 'acme-self' } as never)).rejects.toMatchObject({ code: 'needs_leader' })
    expect(JSON.stringify(getDaemonPoolStatus())).not.toContain('acme-self')
  })
})
