/**
 * The follower's one view of the leader (src/core/server-role.ts) and the list
 * of followers the primary keeps copies on (src/core/replication/replica-targets.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { _resetLeaderPresenceForTesting, followerKind, isFollower, leaderAnswers, leaderPresence, onLeaderPresence, setLeaderPresence } from '../../src/core/server-role.js'
import { _resetReplicaTargetsForTesting, onReplicaTargetsChanged, registerReplicaTarget, replicaTargets, type ReplicaTarget } from '../../src/core/replication/replica-targets.js'

const saved = process.env.WALNUT_HOST_SERVER

beforeEach(() => {
  _resetLeaderPresenceForTesting()
  _resetReplicaTargetsForTesting()
})

afterEach(() => {
  if (saved === undefined) delete process.env.WALNUT_HOST_SERVER
  else process.env.WALNUT_HOST_SERVER = saved
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
