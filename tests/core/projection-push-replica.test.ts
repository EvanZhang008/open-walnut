/**
 * Only the leader pushes projections to the companion. The gate read the cloud
 * flag alone, so a host replica (either program on a host) pushed its own lists
 * to the companion as if it were the Mac.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-push-replica'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ getConnectedDaemonConnection: () => null }))
const ingestSpy = vi.fn(async (_kind: string, _wire: string): Promise<'sent' | 'failed' | 'unsupported'> => 'sent')
vi.mock('../../src/core/cloud-ingest.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/cloud-ingest.js')>()),
  postToCloudIngest: (kind: string, wire: string) => ingestSpy(kind, wire),
  cloudIngestResting: () => false,
}))

import { pushProjectionToCloudNow, _resetProjectionCacheForTesting } from '../../src/core/projection-cache.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'

const saved = { host: process.env.WALNUT_HOST_SERVER, role: process.env.WALNUT_ROLE }

afterEach(() => {
  ingestSpy.mockClear()
  _resetProjectionCacheForTesting()
  if (saved.host === undefined) delete process.env.WALNUT_HOST_SERVER
  else process.env.WALNUT_HOST_SERVER = saved.host
  if (saved.role === undefined) delete process.env.WALNUT_ROLE
  else process.env.WALNUT_ROLE = saved.role
  _resetServerRoleForTesting()
})

const payload = { which: 'tasks', rows: [{ id: 't1' }] }

describe('pushProjectionToCloudNow on a host replica', () => {
  it.each([
    ['the host replica program', { WALNUT_HOST_SERVER: '1', WALNUT_ROLE: 'replica' }],
    ['the plain host server', { WALNUT_HOST_SERVER: '1' }],
  ])('sends nothing on %s', async (_name, env) => {
    Object.assign(process.env, env)
    _resetServerRoleForTesting()
    expect(await pushProjectionToCloudNow('projection-upsert', payload)).toBe('skipped')
    expect(ingestSpy).not.toHaveBeenCalled()
  })

  it('still pushes on the leader', async () => {
    delete process.env.WALNUT_HOST_SERVER
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
    expect(await pushProjectionToCloudNow('projection-upsert', payload)).toBe('sent')
    expect(ingestSpy).toHaveBeenCalledTimes(1)
  })
})
