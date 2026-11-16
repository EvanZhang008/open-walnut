/**
 * oneDaemon (daemon-connection.ts): two host aliases reach one daemon process only on the daemon's
 * own word: both links up on the process their hellos named, or, with one link down, the pair it
 * confirmed before and Walnut recorded (same-daemon-record.ts). A session's call relayed over one
 * alias then counts as from the host the session runs on (src/core/hosts/session-host-origin.ts fromHost).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-one-daemon'))
const recorded = vi.hoisted(() => ({ pairs: {} as Record<string, string[]> }))
vi.mock('../../src/core/hosts/same-daemon-record.js', () => ({
  recordedSameDaemon: async (h: string) => recorded.pairs[h] ?? [],
  rememberSameDaemon: async () => {},
  forgetSameDaemon: async () => {},
}))

import { oneDaemon, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'

function link(host: string, instance: string | null): void {
  setPooledConnectionForTest(host, { host, connected: instance !== null, daemonInstanceId: instance, liveInstanceId: instance, fenceFileChanges: () => {}, helloTargetIdentity: async () => null } as never)
}

afterEach(() => {
  for (const h of ['clouddev', 'newdev', 'other']) setPooledConnectionForTest(h, null)
  recorded.pairs = {}
})

describe('oneDaemon', () => {
  it('an alias is its own daemon', async () => {
    expect(await oneDaemon('clouddev', 'clouddev')).toBe(true)
  })

  it('two links up on the same process are one daemon; on different processes they are not', async () => {
    link('newdev', 'p1'); link('clouddev', 'p1'); link('other', 'p2')
    expect(await oneDaemon('newdev', 'clouddev')).toBe(true)
    expect(await oneDaemon('newdev', 'other')).toBe(false)
  })

  it('with the other link down, only a pair the daemon confirmed before counts', async () => {
    link('newdev', 'p1'); link('clouddev', null)
    expect(await oneDaemon('newdev', 'clouddev')).toBe(false)
    recorded.pairs = { newdev: ['clouddev'], clouddev: ['newdev'] }
    expect(await oneDaemon('newdev', 'clouddev')).toBe(true)
  })

  it('a call over a link that is not up proves nothing', async () => {
    link('newdev', null); link('clouddev', 'p1')
    recorded.pairs = { newdev: ['clouddev'] }
    expect(await oneDaemon('newdev', 'clouddev')).toBe(false)
  })
})
