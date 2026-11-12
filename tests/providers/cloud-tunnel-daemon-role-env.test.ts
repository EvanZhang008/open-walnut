/**
 * The tunnel daemon's CLIs work for the Mac, so none of the box's role facts may
 * reach them. Only WALNUT_CLOUD_MODE was cleared; once the box's unit sets
 * WALNUT_ROLE / WALNUT_PLACEMENT=cloud / WALNUT_CAPABILITIES, a `walnut` call in
 * those CLIs would read a cloud placement without the cloud flag and refuse to boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-tunnel-role-env'))

import { tunnelDaemonEnv } from '../../src/providers/cloud-tunnel-daemon.js'
import { LocalDaemon } from '../../src/providers/local-daemon.js'

const KEYS = ['WALNUT_CLOUD_MODE', 'WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_CAPABILITIES'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('the tunnel daemon spawn env', () => {
  it('drops every role fact of the box', async () => {
    Object.assign(process.env, {
      WALNUT_CLOUD_MODE: '1', WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'cloud', WALNUT_CAPABILITIES: 'public-door,cloud-exec',
    })
    const dir = '/tmp/walnut-tunnel-role-env'
    const env = await new LocalDaemon({ daemonDir: dir, persistent: true, envOverrides: tunnelDaemonEnv(dir) }).buildSpawnEnv()
    for (const k of KEYS) expect(env[k], k).toBeUndefined()
  })
})
