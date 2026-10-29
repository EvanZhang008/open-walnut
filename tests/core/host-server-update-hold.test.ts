/**
 * When this Mac's newer build goes to a host whose server works
 * (src/core/host-server/update-hold.ts): a quiet window after this server
 * started, a cap after the host first fell behind, and the cases that skip the
 * wait. The manager's use of it is in host-server-manager.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { clockTime, heldNotice, minutesFromEnv, updateHold, type UpdateHoldInput } from '../../src/core/host-server/update-hold.js'

const MIN = 60_000
const T0 = new Date(2026, 9, 29, 9, 0).getTime()

function input(over: Partial<UpdateHoldInput> = {}): UpdateHoldInput {
  return {
    now: T0, servingSince: T0, quietMs: 30 * MIN, maxBehindMs: 360 * MIN,
    workingReports: true, retry: false, programChanged: false, tooOld: null,
    ...over,
  }
}

describe('updateHold', () => {
  it('a build that just started serving waits 30 quiet minutes; the cap is counted from now on the first hold', () => {
    expect(updateHold(input())).toEqual({ hold: true, until: T0 + 30 * MIN, latest: T0 + 360 * MIN, behindSince: T0 })
  })

  it('goes once it has served the quiet window', () => {
    expect(updateHold(input({ now: T0 + 29 * MIN })).hold).toBe(true)
    expect(updateHold(input({ now: T0 + 30 * MIN }))).toEqual({ hold: false, why: 'quiet' })
    // A server that has served for long (a host that connects late) sends it at once.
    expect(updateHold(input({ now: T0 + 5 * 3_600_000 }))).toEqual({ hold: false, why: 'quiet' })
  })

  it('a newer deploy starts the window again, but never past the cap from when the host first fell behind', () => {
    // Deploys every 20 minutes: each one waits again, up to 6 h after the first hold.
    for (let k = 1; k * 20 < 360; k++) {
      const now = T0 + k * 20 * MIN
      const d = updateHold(input({ now, servingSince: now, behindSince: T0 }))
      expect(d).toEqual({ hold: true, until: Math.min(now + 30 * MIN, T0 + 360 * MIN), latest: T0 + 360 * MIN, behindSince: T0 })
    }
    const at = T0 + 360 * MIN
    expect(updateHold(input({ now: at, servingSince: at - MIN, behindSince: T0 }))).toEqual({ hold: false, why: 'cap' })
  })

  it('goes at once: Retry, nothing working there, other settings, a program too old for the copies, the window turned off', () => {
    expect(updateHold(input({ retry: true }))).toEqual({ hold: false, why: 'retry' })
    expect(updateHold(input({ workingReports: false }))).toEqual({ hold: false, why: 'no-working-program' })
    expect(updateHold(input({ programChanged: true }))).toEqual({ hold: false, why: 'program-changed' })
    expect(updateHold(input({ tooOld: 'sessions: schema_newer' }))).toEqual({ hold: false, why: 'too-old' })
    expect(updateHold(input({ quietMs: 0 }))).toEqual({ hold: false, why: 'off' })
  })

  it('a behind time ahead of this clock counts from now', () => {
    expect(updateHold(input({ behindSince: T0 + 3_600_000 }))).toMatchObject({ hold: true, behindSince: T0, latest: T0 + 360 * MIN })
  })

  it('a cap of 0 never holds', () => {
    expect(updateHold(input({ maxBehindMs: 0 }))).toEqual({ hold: false, why: 'cap' })
  })
})

describe('the knobs and the words', () => {
  it('minutes from the environment, the default for anything else', () => {
    expect(minutesFromEnv(undefined, 30 * MIN)).toBe(30 * MIN)
    expect(minutesFromEnv('', 30 * MIN)).toBe(30 * MIN)
    expect(minutesFromEnv(' 45 ', 30 * MIN)).toBe(45 * MIN)
    expect(minutesFromEnv('0', 30 * MIN)).toBe(0)
    expect(minutesFromEnv('-5', 30 * MIN)).toBe(30 * MIN)
    expect(minutesFromEnv('soon', 30 * MIN)).toBe(30 * MIN)
  })

  it('the notice names both builds, the window and the latest time', () => {
    expect(clockTime(T0 + 360 * MIN)).toBe('15:00')
    expect(heldNotice('0.6.6-aaa1111', '0.6.7-abc1234', 30 * MIN, T0 + 360 * MIN))
      .toBe('It runs Walnut 0.6.6-aaa1111; this computer\'s 0.6.7-abc1234 goes out after 30 quiet minutes with no newer deploy here (at the latest by 15:00). Retry sends it now.')
    expect(heldNotice('a', 'b', 60 * MIN, T0)).toContain('after a quiet hour')
    expect(heldNotice('a', 'b', 120 * MIN, T0)).toContain('after 2 quiet hours')
  })
})

describe('restedAsOlder (the leader\'s word that a follower\'s build is too old for a kind)', () => {
  it('names a kind a host rested for an older build, while the rest lasts; other rests do not count', async () => {
    const { kindState, restedAsOlder, _resetReplicaStatusForTesting } = await import('../../src/core/replication/replica-status.js')
    _resetReplicaStatusForTesting()
    const target = { id: 'host:devbox', kind: 'host' as const, label: 'devbox' }
    expect(restedAsOlder('host:devbox', T0)).toBeNull()
    Object.assign(kindState(target, 'boards'), { restUntil: T0 + 10 * MIN, restWhy: 'other_leader' })
    expect(restedAsOlder('host:devbox', T0)).toBeNull()
    Object.assign(kindState(target, 'sessions'), { restUntil: T0 + 10 * MIN, restWhy: 'schema_newer' })
    expect(restedAsOlder('host:devbox', T0)).toBe('sessions: schema_newer')
    expect(restedAsOlder('host:other', T0)).toBeNull()
    expect(restedAsOlder('host:devbox', T0 + 11 * MIN)).toBeNull()
    _resetReplicaStatusForTesting()
  })
})
