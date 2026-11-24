/**
 * A host replica reads the switch from its leader's config copy only (switch.ts configNow): with no
 * copy yet it reads off, though the experiment's registry default is on, so a host whose leader
 * stored `host_runs_sessions: false` never starts a session side in the moments after its boot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-switch-host-copy', { CLOUD_MODE: false }))

let copy: Record<string, unknown> | null = null
vi.mock('../../../src/core/replication/kinds/config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/replication/kinds/config.js')>()),
  readConfigCopy: async () => copy,
}))

import { _resetServerRoleForTesting, isHostReplicaProgram } from '../../../src/core/server-role.js'
import { hostRunsSessionsAnyNow } from '../../../src/core/session-channel/switch.js'

const KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_HOST_KEY', 'WALNUT_HOST_RUNS_SESSIONS'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

beforeAll(() => {
  for (const k of KEYS) delete process.env[k]
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = 'devbox'
  _resetServerRoleForTesting()
})
afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
})
beforeEach(() => { copy = null })

describe('a host replica reads the switch from its leader\'s copy only', () => {
  it('no copy yet: off, whatever the registry default says', async () => {
    expect(isHostReplicaProgram()).toBe(true)
    expect(await hostRunsSessionsAnyNow()).toBe(false)
  })

  it('a copy with nothing stored: on by the default', async () => {
    copy = { version: 1, experimental: {} }
    expect(await hostRunsSessionsAnyNow()).toBe(true)
    copy = { version: 1 }
    expect(await hostRunsSessionsAnyNow()).toBe(true)
  })

  it('a copy that says the leader turned it off: off, unless the copy-only row names a host', async () => {
    copy = { version: 1, experimental: { host_runs_sessions: false } }
    expect(await hostRunsSessionsAnyNow()).toBe(false)
    copy = { version: 1, experimental: { host_runs_sessions: false }, hosts_run_sessions: ['devbox'] }
    expect(await hostRunsSessionsAnyNow()).toBe(true)
  })
})
