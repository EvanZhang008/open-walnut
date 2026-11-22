/**
 * Where a stop goes (session-stop.ts stopConnectionOf): a host's own session, the row naming this
 * host's key, is in no daemon pool under that name, so its stop goes over the session's own link,
 * else this host's follower link; every other host's stop reads the pool as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  here: '',
  pool: new Map<string, unknown>(),
  managers: new Map<string, unknown>(),
  self: null as unknown,
}))

vi.mock('../../../src/core/sessions/session-row-owner.js', async (orig) => ({ ...(await orig<object>()), thisHostKey: () => m.here }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getConnectedDaemonConnection: (h: string) => m.pool.get(h) ?? null }))
vi.mock('../../../src/providers/session-manager.js', () => ({ getRegisteredSessionManager: (sid: string) => m.managers.get(sid) }))
vi.mock('../../../src/replica/self-host.js', () => ({ selfHostConnection: (h: string) => (h === m.here ? m.self : null) }))

import { stopConnectionOf } from '../../../src/core/sessions/session-stop.js'

const conn = (name: string) => ({ name, connected: true, send: async () => ({ ok: true }) })

describe('stopConnectionOf', () => {
  beforeEach(() => {
    m.here = ''
    m.pool.clear()
    m.managers.clear()
    m.self = null
  })

  it('reads the pool for another host and on the leader', async () => {
    const devbox = conn('pool devbox')
    m.pool.set('devbox', devbox)
    m.managers.set('s1', { liveConnection: conn('session link') })
    expect(await stopConnectionOf('devbox', 's1')).toBe(devbox)
    m.here = 'other'
    expect(await stopConnectionOf('devbox', 's1')).toBe(devbox)
  })

  it('takes the session\'s own link for this host\'s own session', async () => {
    m.here = 'devbox'
    const link = conn('session link')
    m.managers.set('s1', { liveConnection: link })
    m.self = conn('follower link')
    expect(await stopConnectionOf('devbox', 's1')).toBe(link)
  })

  it('falls back to the follower link, then the pool, when the session has no live link', async () => {
    m.here = 'devbox'
    m.managers.set('s1', { liveConnection: null })
    const follower = conn('follower link')
    m.self = follower
    expect(await stopConnectionOf('devbox', 's1')).toBe(follower)
    m.self = null
    expect(await stopConnectionOf('devbox', 's1')).toBeNull()
    const pooled = conn('pool devbox')
    m.pool.set('devbox', pooled)
    expect(await stopConnectionOf('devbox', 's2')).toBe(pooled)
  })
})
