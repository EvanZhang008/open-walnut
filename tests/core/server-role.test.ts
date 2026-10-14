/**
 * The follower's one view of the leader (src/core/server-role.ts) and the list
 * of followers the primary keeps copies on (src/core/replication/replica-targets.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetLeaderPresenceForTesting, _resetServerRoleForTesting, canStandIn, followerKind, hasLocalDaemon, isFollower, isHostReplica, leaderAnswers,
  leaderPresence, onLeaderPresence, placement, resolveServerRole, role, runsSessions, setLeaderPresence,
} from '../../src/core/server-role.js'
import { _resetReplicaTargetsForTesting, onReplicaTargetsChanged, registerReplicaTarget, replicaTargets, type ReplicaTarget } from '../../src/core/replication/replica-targets.js'

const ROLE_ENV = ['WALNUT_HOST_SERVER', 'WALNUT_ROLE', 'WALNUT_PLACEMENT'] as const
const saved = Object.fromEntries(ROLE_ENV.map((k) => [k, process.env[k]]))

beforeEach(() => {
  _resetLeaderPresenceForTesting()
  _resetReplicaTargetsForTesting()
  _resetServerRoleForTesting()
})

afterEach(() => {
  for (const k of ROLE_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetServerRoleForTesting()
})

describe('server role', () => {
  it('the leader always answers itself', () => {
    delete process.env.WALNUT_HOST_SERVER
    expect(followerKind()).toBeNull()
    expect(isFollower()).toBe(false)
    setLeaderPresence(false, 'whatever')
    expect(leaderAnswers()).toBe(true)
    expect(leaderPresence()).toEqual({ answers: true, why: 'leader', since: 0 })
  })

  it('a host server starts unheard and follows what its link reports', () => {
    process.env.WALNUT_HOST_SERVER = '1'
    expect(followerKind()).toBe('host')
    expect(leaderAnswers()).toBe(false)
    expect(leaderPresence().why).toBe('not-heard')
    const seen: boolean[] = []
    const off = onLeaderPresence((a) => seen.push(a))
    setLeaderPresence(true, 'answers', 1_000)
    setLeaderPresence(true, 'answers', 2_000)
    expect(leaderPresence()).toEqual({ answers: true, why: 'answers', since: 1_000 })
    setLeaderPresence(false, 'mac-away', 3_000)
    expect(leaderPresence()).toEqual({ answers: false, why: 'mac-away', since: 3_000 })
    // A new reason with no change moves neither the clock nor the listeners.
    setLeaderPresence(false, 'no-daemon', 4_000)
    expect(leaderPresence()).toEqual({ answers: false, why: 'no-daemon', since: 3_000 })
    expect(seen).toEqual([true, false])
    off()
    setLeaderPresence(true, 'answers')
    expect(seen).toEqual([true, false])
  })

  it('a listener that throws does not stop the next one', () => {
    process.env.WALNUT_HOST_SERVER = '1'
    const next = vi.fn()
    onLeaderPresence(() => { throw new Error('boom') })
    onLeaderPresence(next)
    setLeaderPresence(true, 'answers')
    expect(next).toHaveBeenCalledWith(true)
  })
})

describe('replica targets', () => {
  const host = (id: string): ReplicaTarget => ({
    id, kind: 'host', label: id, post: async () => ({ ok: true, status: 200 } as never), available: async () => true,
  })

  it('the companion comes first, then each host server once', () => {
    const changes = vi.fn()
    onReplicaTargetsChanged(changes)
    const offA = registerReplicaTarget(host('host:a'))
    registerReplicaTarget(host('host:b'))
    expect(replicaTargets().map((t) => t.id)).toEqual(['companion', 'host:a', 'host:b'])
    offA()
    expect(replicaTargets().map((t) => t.id)).toEqual(['companion', 'host:b'])
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it('an old registration\'s unregister leaves its replacement alone', () => {
    const offOld = registerReplicaTarget(host('host:a'))
    const fresh = host('host:a')
    registerReplicaTarget(fresh)
    offOld()
    expect(replicaTargets().at(-1)).toBe(fresh)
  })
})

describe('role and placement (env matrix)', () => {
  const cases: Array<[string, Record<string, string>, boolean, { role: string; placement: string } | RegExp]> = [
    ['the Mac: nothing set', {}, false, { role: 'leader', placement: 'mac' }],
    ['the Mac, said outright', { WALNUT_ROLE: 'leader', WALNUT_PLACEMENT: 'mac' }, false, { role: 'leader', placement: 'mac' }],
    ['the companion: CLOUD_MODE alone', {}, true, { role: 'replica', placement: 'cloud' }],
    ['the companion, said outright', { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'cloud' }, true, { role: 'replica', placement: 'cloud' }],
    ['a host server (old program)', { WALNUT_HOST_SERVER: '1' }, false, { role: 'replica', placement: 'host' }],
    ['a host replica', { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' }, false, { role: 'replica', placement: 'host' }],
    ['a host replica without the old flag', { WALNUT_ROLE: 'replica' }, false, { role: 'replica', placement: 'host' }],
    ['a leader that says cloud', { WALNUT_ROLE: 'leader' }, true, /contradicts/],
    ['a leader on a host server', { WALNUT_ROLE: 'leader', WALNUT_HOST_SERVER: '1' }, false, /contradicts/],
    ['a leader placed on a host', { WALNUT_PLACEMENT: 'host', WALNUT_ROLE: 'leader' }, false, /runs on the Mac/],
    ['a replica on the Mac', { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'mac' }, false, /never runs with placement mac/],
    ['cloud placement without CLOUD_MODE', { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'cloud' }, false, /needs WALNUT_CLOUD_MODE/],
    ['CLOUD_MODE placed on a host', { WALNUT_PLACEMENT: 'host' }, true, /is placement cloud/],
    ['an unknown role', { WALNUT_ROLE: 'boss' }, false, /leader or replica/],
    ['an unknown placement', { WALNUT_PLACEMENT: 'moon' }, false, /mac, host or cloud/],
  ]
  it.each(cases)('%s', (_name, env, cloud, want) => {
    if (want instanceof RegExp) expect(() => resolveServerRole(env, cloud)).toThrow(want)
    else expect(resolveServerRole(env, cloud)).toEqual(want)
  })

  it('role() is read once and kept until the test reset', () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env.WALNUT_PLACEMENT = 'host'
    expect([role(), placement(), isHostReplica()]).toEqual(['replica', 'host', true])
    expect(hasLocalDaemon()).toBe(false)
    expect(runsSessions()).toBe(true)
    expect(canStandIn(true)).toBe(false)
    expect(followerKind()).toBe('host')
    delete process.env.WALNUT_ROLE
    delete process.env.WALNUT_PLACEMENT
    expect(role()).toBe('replica')
    _resetServerRoleForTesting()
    expect([role(), placement(), isHostReplica(), hasLocalDaemon()]).toEqual(['leader', 'mac', false, true])
  })

  it.each([' replica', 'replica ', '\treplica\n'])('WALNUT_ROLE=%j: role() and isFollower() agree (both trim it)', (raw) => {
    delete process.env.WALNUT_HOST_SERVER
    delete process.env.WALNUT_PLACEMENT
    process.env.WALNUT_ROLE = raw
    expect([role(), placement()]).toEqual(['replica', 'host'])
    expect(followerKind()).toBe('host')
    expect(isFollower()).toBe(true)
    expect(leaderAnswers()).toBe(false)
  })
})
