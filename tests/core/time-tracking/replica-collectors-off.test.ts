/**
 * The Mac-local time collectors (outside activity, Screen Time snapshots, calls)
 * run on the leader only. A host replica on a Mac host carries the owner's
 * `time.*.enabled` switches in its config copy, and used to start all three
 * against that host Mac's own data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-replica-collectors'))

const getConfig = vi.hoisted(() => vi.fn(async () => ({ time: { outside: { enabled: true }, screentime: { enabled: true }, calls: { enabled: true } } })))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig }))

import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import { startOutsideCollector, stopOutsideCollector } from '../../../src/core/time-tracking/outside-collector.js'
import { startScreenTimeSnapshots, stopScreenTimeSnapshots } from '../../../src/core/time-tracking/screentime-snapshot.js'
import { startCallsCollector, stopCallsCollector } from '../../../src/core/time-tracking/calls-collector.js'

const realPlatform = process.platform
const saved = { host: process.env.WALNUT_HOST_SERVER, role: process.env.WALNUT_ROLE }

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  getConfig.mockClear()
  setPlatform('darwin')
})

afterEach(() => {
  stopOutsideCollector()
  stopScreenTimeSnapshots()
  stopCallsCollector()
  vi.useRealTimers()
  setPlatform(realPlatform)
  if (saved.host === undefined) delete process.env.WALNUT_HOST_SERVER
  else process.env.WALNUT_HOST_SERVER = saved.host
  if (saved.role === undefined) delete process.env.WALNUT_ROLE
  else process.env.WALNUT_ROLE = saved.role
  _resetServerRoleForTesting()
})

describe.each([
  ['the host replica program', { WALNUT_HOST_SERVER: '1', WALNUT_ROLE: 'replica' }],
  ['the plain host server', { WALNUT_HOST_SERVER: '1' }],
])('time collectors on %s', (_name, env) => {
  beforeEach(() => {
    delete process.env.WALNUT_ROLE
    Object.assign(process.env, env)
    _resetServerRoleForTesting()
  })

  it('arms no Screen Time snapshot', () => {
    startScreenTimeSnapshots()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('arms no calls collector', () => {
    startCallsCollector()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never reads the outside switch, so never starts the helper', async () => {
    await startOutsideCollector()
    expect(getConfig).not.toHaveBeenCalled()
  })
})

describe('time collectors on the leader', () => {
  beforeEach(() => {
    delete process.env.WALNUT_HOST_SERVER
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
  })

  it('still arms the Screen Time snapshot and the calls collector on a Mac', () => {
    startScreenTimeSnapshots()
    expect(vi.getTimerCount()).toBe(1)
    startCallsCollector()
    expect(vi.getTimerCount()).toBe(3) // live tick + backfill
  })
})
