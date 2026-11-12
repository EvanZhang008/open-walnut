/**
 * Only the leader manages hosts' servers. A host replica (either program on a
 * host) used to build a manager on its first route call, as the Mac does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-server-replica', { CLOUD_MODE: false }))

import { getHostServerManager, _resetHostServerManagerForTesting } from '../../src/core/host-server/index.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'

const saved = { host: process.env.WALNUT_HOST_SERVER, role: process.env.WALNUT_ROLE }

afterEach(() => {
  _resetHostServerManagerForTesting()
  if (saved.host === undefined) delete process.env.WALNUT_HOST_SERVER
  else process.env.WALNUT_HOST_SERVER = saved.host
  if (saved.role === undefined) delete process.env.WALNUT_ROLE
  else process.env.WALNUT_ROLE = saved.role
  _resetServerRoleForTesting()
})

describe('getHostServerManager', () => {
  it.each([
    ['the host replica program', { WALNUT_HOST_SERVER: '1', WALNUT_ROLE: 'replica' }],
    ['the plain host server', { WALNUT_HOST_SERVER: '1' }],
  ])('is null on %s', (_name, env) => {
    Object.assign(process.env, env)
    _resetServerRoleForTesting()
    expect(getHostServerManager()).toBeNull()
  })

  it('is a manager on the leader', () => {
    delete process.env.WALNUT_HOST_SERVER
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
    expect(getHostServerManager()).not.toBeNull()
  })
})
