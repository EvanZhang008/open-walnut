/**
 * Which pending stops a daemon link's return sends again (session-stop.ts `pending`, read by
 * flush). On a host that runs its own sessions, its own rows name the host's key while their CLI's
 * link is '__local__' (session-row-owner.ts cliHostOf): the return of '__local__' sends their stops,
 * and a copied row (the leader's, or one of no judge) is never this host's to stop. Review round 1
 * of C8-16, S3: reading only the rows named '__local__' left an own row's stop unsent there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ replica: false, byHost: new Map<string, unknown[]>() }))

vi.mock('../../../src/core/server-role.js', async (orig) => ({ ...(await orig<object>()), isHostReplica: () => m.replica }))
vi.mock('../../../src/core/session-tracker.js', () => ({
  listPendingSessionStops: async (host?: string) => [...((host === undefined ? [...m.byHost.values()].flat() : m.byHost.get(host)) ?? [])],
}))

import { sessionStops } from '../../../src/core/sessions/session-stop.js'

const pending = { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'pending' }
const row = (sid: string, over: Record<string, unknown>) => ({ claudeSessionId: sid, stopRequest: pending, ...over })
const pendingOf = (host: string): Promise<Array<{ claudeSessionId: string }>> =>
  (sessionStops as unknown as { deps: { pending(h: string): Promise<Array<{ claudeSessionId: string }>> } }).deps.pending(host)

describe('the pending stops a link\'s return sends again', () => {
  beforeEach(() => {
    m.byHost.clear()
    m.byHost.set('devbox', [row('own', { judge: 'host', host: 'devbox' }), row('copy-of-devbox', { host: 'devbox' })])
    m.byHost.set('__local__', [row('copy-here', { host: '' })])
  })
  afterEach(() => { m.replica = false; delete process.env.WALNUT_HOST_KEY })

  it('on a host that runs its sessions: its own row\'s stop goes with \'__local__\', a copied row\'s never', async () => {
    m.replica = true
    process.env.WALNUT_HOST_KEY = 'devbox'
    expect((await pendingOf('__local__')).map((r) => r.claudeSessionId)).toEqual(['own'])
    // Its own key is no link of its own: nothing goes with it.
    expect(await pendingOf('devbox')).toEqual([])
  })

  it('on the leader: the rows of each link\'s own name, as before', async () => {
    expect((await pendingOf('__local__')).map((r) => r.claudeSessionId)).toEqual(['copy-here'])
    expect((await pendingOf('devbox')).map((r) => r.claudeSessionId)).toEqual(['copy-of-devbox'])
  })
})
