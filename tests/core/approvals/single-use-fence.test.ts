/**
 * One single-use ask at a time, only to a person who is there (src/core/approvals/single-use-fence.ts,
 * through createApproval in store.ts). Every single-use ask rings the same devices (any device the
 * person is signed in on), so any two collide. Real store on a temp data dir; the person's activity
 * is a stub. Nothing is sent to a device.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-single-use-fence'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { ApprovalError, cancelApproval, createApproval, listApprovals, sweepExpired, _resetApprovalTimersForTesting } from '../../../src/core/approvals/store.js'
import { _setFenceDepsForTest, _unfencedForFixture, type UserActivity } from '../../../src/core/approvals/single-use-fence.js'

// Neutral fixtures only.
const ctx = (remoteUrl?: string) => JSON.stringify({
  version: 'walnut-git-operation-v1', operation: 'push', remote: 'origin', remoteRef: 'refs/heads/main', repository: '/work/repo',
  ...(remoteUrl ? { remoteUrl } : {}),
})
const URL_A = 'ssh://git.example.com:2222/team/repo-one.git'
const URL_A_OTHER_REPO = 'ssh://git.example.com:2222/team/repo-two.git'
const URL_B = 'https://bob:token@git.example.org/x/y.git'
const who = (task: string) => ({ host: 'build-box', taskId: task, sessionId: `s-${task}` })
const ask = (task: string, remoteUrl?: string, over: Record<string, unknown> = {}) => createApproval({
  what: 'Push one commit?', singleUse: true, timeoutMs: 60_000,
  requester: who(task), detail: ctx(remoteUrl), ...over,
})
async function code(p: Promise<unknown>): Promise<string | null> {
  const err = await p.then(() => null, (e) => e)
  if (err === null) return null
  expect(err).toBeInstanceOf(ApprovalError)
  return (err as ApprovalError).code
}

let activity: UserActivity | null | 'throw'
beforeEach(async () => {
  vi.useRealTimers()
  _resetApprovalTimersForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  activity = { lastSeenAt: Date.now(), streaming: false }
  _setFenceDepsForTest({ activity: async () => { if (activity === 'throw') throw new Error('no store'); return activity } })
})

describe('single-use fence', () => {
  it('any two collide, whatever remote, user or repository each names', async () => {
    await ask('t-a', 'ssh://git.example.com/team/repo.git')
    expect(await code(ask('t-b', 'https://carol@git.example.com/team/other.git'))).toBe('biometric_pending')
    expect(await code(ask('t-c', URL_B))).toBe('biometric_pending')
    expect(await code(ask('t-d'))).toBe('biometric_pending')
  })

  it('a second task asking while one is pending is refused, naming the first; nothing is recorded, its ask is held', async () => {
    const a = await ask('t-a', URL_A)
    const err = await ask('t-b', URL_A_OTHER_REPO).then(() => null, (e: ApprovalError) => e)
    expect(err?.code).toBe('biometric_pending')
    expect(err?.message).toContain(a.approval.id)
    expect(err?.message).toContain('t-a')
    // Held until the first one ended (held-asks.ts), never "do not ask again" with nobody asking.
    expect(err?.message).toContain('Walnut holds this ask')
    expect((await listApprovals()).map((x) => x.id)).toEqual([a.approval.id])
  })

  it('the same task cannot have two pending either', async () => {
    await ask('t-a', URL_A)
    expect(await code(ask('t-a', URL_A))).toBe('biometric_pending')
    // An older asker that still names a device key or Face ID collides all the same.
    expect(await code(ask('t-b', URL_B, { signingKeyId: 'ak-other-device', mode: 'biometric' } as never))).toBe('biometric_pending')
  })

  it('concurrent asks on one account: exactly one is recorded', async () => {
    const out = await Promise.all(['t1', 't2', 't3', 't4', 't5'].map((t) => code(ask(t, URL_A))))
    expect(out.filter((c) => c === null)).toHaveLength(1)
    expect(out.filter((c) => c === 'biometric_pending')).toHaveLength(4)
    expect(await listApprovals()).toHaveLength(1)
  })

  it('fails closed on presence: away, and cannot tell, are refused with nothing recorded', async () => {
    activity = { lastSeenAt: Date.now() - 60 * 60_000, streaming: false }
    expect(await code(ask('t-a', URL_A))).toBe('user_away')
    activity = { lastSeenAt: null, streaming: false }
    expect(await code(ask('t-a', URL_A))).toBe('user_away')
    activity = null
    expect(await code(ask('t-a', URL_A))).toBe('presence_unknown')
    activity = 'throw'
    expect(await code(ask('t-a', URL_A))).toBe('presence_unknown')
    expect(await listApprovals()).toEqual([])
    // A phone streaming a session is the person there.
    activity = { lastSeenAt: null, streaming: true }
    expect(await code(ask('t-a', URL_A))).toBeNull()
  })

  it('after an ask expires unanswered, a retry waits for new activity of the person (streaming is not that)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    activity = { lastSeenAt: t0 - 1000, streaming: false }
    await ask('t-a', URL_A, { timeoutMs: 10_000 })
    vi.setSystemTime(t0 + 11_000)
    await sweepExpired()
    expect((await listApprovals({ status: 'all' }))[0].status).toBe('expired')
    // Seen just before the ask, and only streaming since: no automatic retry, by any task.
    expect(await code(ask('t-a', URL_A))).toBe('unanswered_retry')
    activity = { lastSeenAt: t0 - 1000, streaming: true }
    expect(await code(ask('t-b', URL_A_OTHER_REPO))).toBe('unanswered_retry')
    // Another remote rings the same devices: fenced by it too.
    expect(await code(ask('t-b', URL_B))).toBe('unanswered_retry')
    // He was active while it was pending but did not answer: still no automatic retry.
    activity = { lastSeenAt: t0 + 5_000, streaming: false }
    expect(await code(ask('t-a', URL_A))).toBe('unanswered_retry')
    // A day passing with a stale open stream is not a new invitation to send another prompt.
    vi.setSystemTime(t0 + 24 * 60 * 60_000)
    activity = { lastSeenAt: t0 + 5_000, streaming: true }
    expect(await code(ask('t-a', URL_A))).toBe('unanswered_retry')
    vi.setSystemTime(t0 + 11_000)
    // He did something after it expired: the retry goes.
    activity = { lastSeenAt: t0 + 10_500, streaming: false }
    expect(await code(ask('t-a', URL_A))).toBeNull()
  })

  it('a withdrawn ask frees the account, and a new ask then needs new activity of the person', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    activity = { lastSeenAt: t0 - 1000, streaming: false }
    const a = await ask('t-a', URL_A)
    vi.setSystemTime(t0 + 2_000)
    await cancelApproval(a.approval.id, a.waitToken, 'done')
    expect(await code(ask('t-b', URL_A))).toBe('unanswered_retry')
    activity = { lastSeenAt: t0 + 2_500, streaming: false }
    expect(await code(ask('t-b', URL_A))).toBeNull()
  })

  it('leaves tap asks, other test runs and the dialog fixture alone', async () => {
    activity = null
    expect(await code(createApproval({ what: 'Tap?', mode: 'tap', requester: who('t-a') }))).toBeNull()
    activity = { lastSeenAt: Date.now(), streaming: false }
    await ask('t-a', URL_A)
    expect(await code(ask('t-b', URL_A, { testRun: 'spec-1' }))).toBeNull()
    activity = null
    expect(await code(_unfencedForFixture(() => ask('t-c', URL_A)))).toBeNull()
  })
})

describe('single-use fence on the real activity of the person (org/user-away.ts)', () => {
  it('nobody seen: away; a message typed in any task chat now: the ask goes', async () => {
    _setFenceDepsForTest(null)
    expect(await code(ask('t-a', URL_A))).toBe('user_away')
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    await createSessionRecord('s-other-task', 't-other', '', WALNUT_HOME)
    await updateSessionRecord('s-other-task', { chatInputAt: new Date().toISOString() } as never)
    expect(await code(ask('t-a', URL_A))).toBeNull()
  })

  it('reads the newest heartbeat or typed message across every session', async () => {
    const { noteSeen, userActivityAnywhere, _resetUserAwayForTest } = await import('../../../src/core/org/user-away.js')
    _resetUserAwayForTest()
    expect(await userActivityAnywhere([], 5_000)).toEqual({ lastSeenAt: null, streaming: false })
    noteSeen('task:t-x', 3_000)
    expect((await userActivityAnywhere([{ claudeSessionId: 's1', chatInputAt: new Date(1_000).toISOString() }], 5_000)).lastSeenAt).toBe(3_000)
    expect((await userActivityAnywhere([{ claudeSessionId: 's1', chatInputAt: new Date(4_000).toISOString() }], 5_000)).lastSeenAt).toBe(4_000)
    _resetUserAwayForTest()
  })

  it('the phone app open on a tab with no task (Inbox, Home) is the person seen; no node\'s own chat counts it', async () => {
    const { startUserAway, stopUserAway, userActivityAnywhere, userInTaskChat } = await import('../../../src/core/org/user-away.js')
    const { bus, EventNames } = await import('../../../src/core/event-bus.js')
    startUserAway()
    try {
      const ts = new Date(Date.now() - 60_000).toISOString()
      bus.emit(EventNames.TIME_BANKED, { records: [{ ts, durationMs: 60_000, kind: 'triage', source: 'ios' }] }, [], { source: 'time-tracking' })
      const seen = await userActivityAnywhere([])
      expect(seen.lastSeenAt).toBe(Date.parse(ts) + 60_000)
      expect(await userInTaskChat('t-node', [], 10 * 60_000)).toBe(false)
    } finally { stopUserAway() }
  })
})
