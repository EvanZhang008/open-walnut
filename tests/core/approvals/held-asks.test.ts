/**
 * A single-use ask refused for "not now" is held until the person is back, and its task is told then
 * to ask again, once (src/core/approvals/held-asks.ts; 2026-11-25, Walnut VP: a Git push and a
 * leak-gate approval were refused as user_away and told "do not ask again", nobody asked again, and
 * a fix waited five days). Real store on a temp data dir; the person's activity is a stub; the
 * task's session is a recorded tell. Nothing reaches a device.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-held-asks'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  APPROVAL_PENDING_MAX, ApprovalError, answerApproval, createApproval, heldSweepDeps, listApprovals, sweepExpired, _resetApprovalTimersForTesting,
} from '../../../src/core/approvals/store.js'
import { MAX_UNANSWERED, STEP_MEMORY_MS, _setFenceDepsForTest, type UserActivity } from '../../../src/core/approvals/single-use-fence.js'
import {
  HELD_MARK, HOLD_MS, MAX_HELD, MAX_HELD_PER_TASK, MAX_RELEASES, RELEASE_GRACE_MS, decideHeld, listHeld, setHeldSweepDeps, startHeldSweep, stopHeldSweep, sweepHeld,
  type HeldAsk, type HeldTell,
} from '../../../src/core/approvals/held-asks.js'
import { heldNoticeFor } from '../../../src/core/approvals/tell-asker.js'
import { APPROVE_EXIT, HELD_MARK as CLI_HELD_MARK, runApprove } from '../../../src/core/approvals/cli-core.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const ROOT = path.resolve(__dirname, '../../..')
const ctx = (n = 1) => JSON.stringify({ version: 'walnut-git-operation-v1', operation: 'push', remote: 'origin', repository: '/work/repo', n })
const who = (task: string) => ({ host: 'build-box', taskId: task, sessionId: `s-${task}`, command: 'git push origin main' })
const PUSH = 'Push commit abc1234 to origin main in repo'
const ask = (task: string, what = PUSH, over: Record<string, unknown> = {}) => createApproval({
  what, singleUse: true, timeoutMs: 60_000, requester: who(task), detail: ctx(), ...over,
})
async function refusal(p: Promise<unknown>): Promise<ApprovalError | null> {
  const err = await p.then(() => null, (e) => e)
  if (err !== null) expect(err).toBeInstanceOf(ApprovalError)
  return err as ApprovalError | null
}
const tap = (a: { approval: { id: string; digest: string } }, decision: 'approve' | 'deny') =>
  answerApproval(a.approval.id, { decision, digest: a.approval.digest, device: { name: 'Phone', kind: 'iphone' } })

let activity: UserActivity | null
let t = Date.parse('2026-11-25T08:00:00Z')
/** The clock moves only when a test moves it. */
const at = (ms: number) => { t += ms; vi.setSystemTime(t) }
const AWAY = (): UserActivity => ({ lastSeenAt: t - 60 * 60_000, streaming: false })
const HERE = (): UserActivity => ({ lastSeenAt: t, streaming: false })
let told: HeldTell[]
let reachable: boolean

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  t = Date.parse('2026-11-25T08:00:00Z')
  vi.setSystemTime(t)
  _resetApprovalTimersForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  activity = AWAY()
  _setFenceDepsForTest({ activity: async () => activity })
  told = []
  reachable = true
  setHeldSweepDeps(heldSweepDeps(async (x) => { told.push(x); return reachable }))
})
afterEach(() => { stopHeldSweep(); vi.useRealTimers() })

describe('a refused "not now" ask is held, once per task', () => {
  it('away: refused with nothing sent, held, and the refusal says so (not "do not ask again")', async () => {
    const err = await refusal(ask('t-a'))
    expect(err?.code).toBe('user_away')
    expect(err?.message).toContain(HELD_MARK)
    expect(err?.message).not.toMatch(/Do not ask again by yourself/)
    // A closed task is never told: the asker keeps it open.
    expect(err?.message).toMatch(/Keep this task open/)
    expect(await listApprovals({ status: 'all' })).toEqual([])
    const held = await listHeld()
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ what: PUSH, state: 'held', reason: 'user_away', requester: { taskId: 't-a', sessionId: 's-t-a' } })
    expect(err?.message).toContain(held[0].id)
  })

  it('the task asking again finds its held ask; a new commit\'s line takes its place; another task is its own', async () => {
    const first = (await refusal(ask('t-a')))!.message
    at(1_000)
    expect((await refusal(ask('t-a')))!.message).toContain(/\((held-[\w-]+)\)/.exec(first)![1])
    await refusal(ask('t-a', 'Push commit def5678 to origin main in repo'))
    const held = await listHeld()
    expect(held.map((h) => [h.requester.taskId, h.what])).toEqual([['t-a', 'Push commit def5678 to origin main in repo']])
    // The line it replaced is kept by name, and its release names it (a label over several targets loses none).
    expect(held[0].earlier).toEqual([PUSH])
    expect(heldNoticeFor({ kind: 'release', held: held[0] }).body).toContain(`"${PUSH}"`)
    await refusal(ask('t-b'))
    expect((await listHeld()).map((h) => h.requester.taskId).sort()).toEqual(['t-a', 't-b'])
  })

  it('every "not now" refusal is held: away, cannot tell, another ask on his devices, unanswered retry, the pending cap', async () => {
    const codes: string[] = []
    activity = AWAY()
    codes.push((await refusal(ask('t-away')))!.code)
    activity = null
    codes.push((await refusal(ask('t-unknown')))!.code)
    activity = HERE()
    await ask('t-first')
    codes.push((await refusal(ask('t-busy')))!.code)
    at(61_000)
    await sweepExpired()
    codes.push((await refusal(ask('t-retry')))!.code)
    expect(codes).toEqual(['user_away', 'presence_unknown', 'biometric_pending', 'unanswered_retry'])
    // The pending cap full of plain asks: a single-use one is held, not dropped.
    activity = { lastSeenAt: t + 1, streaming: false }
    for (let i = 0; i < APPROVAL_PENDING_MAX; i++) await createApproval({ what: `Tap ${i}?`, requester: who(`t-plain-${i}`) })
    const capped = await refusal(ask('t-capped'))
    expect(capped?.code).toBe('too_many_pending')
    expect(capped?.status).toBe(429)
    expect(capped?.message).toContain(HELD_MARK)
    expect((await listHeld()).map((h) => h.reason).sort()).toEqual(['biometric_pending', 'presence_unknown', 'too_many_pending', 'unanswered_retry', 'user_away'])
  })

  it('never held: a step he denied (also after he did something since, also behind another pending ask)', async () => {
    activity = HERE()
    const a = await ask('t-a')
    const twice = await refusal(ask('t-a'))
    expect(twice?.code).toBe('biometric_pending')
    expect(twice?.message).not.toContain(HELD_MARK)
    at(1_000)
    await tap(a, 'deny')
    at(1_000)
    expect((await refusal(ask('t-a')))?.message).toMatch(/denied this same step/)
    // He did something since (an hour ago), then left: the same step asked again is still not held.
    at(3 * 60 * 60_000)
    activity = AWAY()
    const away = await refusal(ask('t-a'))
    expect(away?.code).toBe('user_away')
    expect(away?.message).not.toContain(HELD_MARK)
    expect(away?.message).toMatch(/denied this same step/)
    // Behind another task's pending ask: refused, not held.
    activity = HERE()
    await ask('t-other')
    expect((await refusal(ask('t-a')))?.message).not.toContain(HELD_MARK)
    expect(await listHeld()).toEqual([])
  })

  it('only lately, and since his last yes: a step he approved since, or denied long ago, is held again', async () => {
    // 2026-11-25 review: a "no" from weeks ago, approved since, kept a recurring deploy from ever being held.
    activity = HERE()
    const a = await ask('t-a')
    at(1_000)
    await tap(a, 'deny')
    at(1_000)
    activity = HERE()
    const b = await ask('t-a')
    at(1_000)
    await tap(b, 'approve')
    at(60 * 60_000)
    activity = AWAY()
    expect((await refusal(ask('t-a')))?.message).toContain(HELD_MARK)
    activity = HERE()
    const c = await ask('t-b')
    at(1_000)
    await tap(c, 'deny')
    at(STEP_MEMORY_MS + 1_000)
    activity = AWAY()
    expect((await refusal(ask('t-b')))?.message).toContain(HELD_MARK)
  })

  it(`never held: a step that reached him ${MAX_UNANSWERED} times and got no answer`, async () => {
    for (let i = 0; i < MAX_UNANSWERED; i++) {
      activity = HERE()
      await ask('t-a')
      at(61_000)
      await sweepExpired()
    }
    activity = AWAY()
    const err = await refusal(ask('t-a'))
    expect(err?.message).not.toContain(HELD_MARK)
    expect(err?.message).toMatch(/reached the user 2 times and got no answer/)
    expect(await listHeld()).toEqual([])
  })

  it(`bounded: at most ${MAX_HELD} held asks; past that the refusal says it is not held`, async () => {
    for (let i = 0; i < MAX_HELD; i++) await refusal(ask(`t-${i}`))
    const over = await refusal(ask('t-over'))
    expect(over?.code).toBe('user_away')
    expect(over?.message).not.toContain(HELD_MARK)
    expect(over?.message).toMatch(/could not hold it/)
    expect(await listHeld()).toHaveLength(MAX_HELD)
  })

  it('a hold the disk refuses answers the fence\'s own refusal (409), never a server error', async () => {
    await fsp.mkdir(path.join(WALNUT_HOME, 'approvals', 'held.json'), { recursive: true })
    const err = await refusal(ask('t-a'))
    expect(err?.status).toBe(409)
    expect(err?.code).toBe('user_away')
    expect(err?.message).toMatch(/could not hold it/)
  })
})

describe('released when he is back, one at a time; lapses on its deadline', () => {
  it('nothing goes while he is away; once back, the task is told to ask again, once, and its ask goes through', async () => {
    await refusal(ask('t-a'))
    expect(await sweepHeld()).toEqual([])
    activity = HERE()
    const out = await sweepHeld()
    expect(out.map((x) => [x.kind, x.held.requester.taskId])).toEqual([['release', 't-a']])
    expect(told).toHaveLength(1)
    expect((await listHeld())[0]).toMatchObject({ state: 'released', releases: 1 })
    expect(await sweepHeld()).toEqual([])
    const asked = await ask('t-a')
    expect(asked.approval.status).toBe('pending')
    expect((await listHeld({ all: true }))[0]).toMatchObject({ state: 'asked', askedAs: asked.approval.id })
    // Asked and approved: a later refusal of that task is a new held ask, with its own deadline.
    at(1_000)
    await tap(asked, 'approve')
    at(60 * 60_000)
    activity = AWAY()
    await refusal(ask('t-a', 'Deploy web to prod'))
    const now = await listHeld()
    expect(now).toHaveLength(1)
    expect(now[0]).toMatchObject({ what: 'Deploy web to prod', state: 'held', releases: 0 })
  })

  it('a release keeps his devices for its task: another task\'s fresh ask waits, held, until that ask went out', async () => {
    await refusal(ask('t-a'))
    activity = HERE()
    await sweepHeld()
    // t-b asks before t-a does: held behind the release.
    const b = await refusal(ask('t-b'))
    expect(b?.code).toBe('biometric_pending')
    expect(b?.message).toMatch(/kept for that one first/)
    expect(b?.message).toContain(HELD_MARK)
    const a = await ask('t-a')
    expect(a.approval.status).toBe('pending')
    expect(await sweepHeld()).toEqual([])
    at(1_000)
    await tap(a, 'approve')
    expect((await sweepHeld()).map((x) => x.held.requester.taskId)).toEqual(['t-b'])
  })

  it('a release its task never acts on holds the next back only for the grace, and ends quietly at its deadline', async () => {
    await refusal(ask('t-a'))
    at(1_000)
    await refusal(ask('t-b'))
    activity = HERE()
    await sweepHeld()
    expect(await sweepHeld()).toEqual([])
    at(RELEASE_GRACE_MS + 1_000)
    activity = HERE()
    expect((await sweepHeld()).map((x) => x.held.requester.taskId)).toEqual(['t-b'])
    told.length = 0
    at(HOLD_MS)
    const out = await sweepHeld()
    expect(out.filter((x) => x.kind === 'lapse').map((x) => x.held.requester.taskId).sort()).toEqual(['t-a', 't-b'])
    // Both were told to ask again already: their lapse wakes nobody.
    expect(told).toEqual([])
    // He did come back (it was released): not void, the step may be held again.
    activity = AWAY()
    expect((await refusal(ask('t-a')))?.message).toContain(HELD_MARK)
  })

  it('lapses at its deadline, void: its task is told to report it, and the same step is not held again for a while', async () => {
    await refusal(ask('t-a'))
    at(HOLD_MS + 1_000)
    const out = await sweepHeld()
    expect(out.map((x) => [x.kind, x.held.lapsedWhy])).toEqual([['lapse', 'deadline']])
    expect(told.map((x) => x.kind)).toEqual(['lapse'])
    expect(heldNoticeFor(told[0]).body).toMatch(/void/)
    expect(heldNoticeFor(told[0]).body).not.toMatch(/take it again/)
    // The task asks again anyway (a new commit, the same push): refused, not held, and it says why.
    const again = await refusal(ask('t-a', 'Push commit def5678 to origin main in repo'))
    expect(again?.message).not.toContain(HELD_MARK)
    expect(again?.message).toMatch(/is void/)
    expect(await listHeld()).toEqual([])
    // Another task's ask is its own; and a while later the step may be held again.
    expect((await refusal(ask('t-b')))?.message).toContain(HELD_MARK)
    at(HOLD_MS)
    expect((await refusal(ask('t-a')))?.message).toContain(HELD_MARK)
  })

  it('a task with no session to tell: its release lapses and the next one goes', async () => {
    await refusal(ask('t-a'))
    at(1_000)
    await refusal(ask('t-b'))
    reachable = false
    activity = HERE()
    const first = await sweepHeld()
    expect(first.map((x) => x.held.requester.taskId)).toEqual(['t-a'])
    expect((await listHeld({ all: true })).find((h) => h.id === first[0].held.id)).toMatchObject({ state: 'lapsed', lapsedWhy: 'no_session' })
    reachable = true
    expect((await sweepHeld()).map((x) => [x.kind, x.held.requester.taskId])).toEqual([['release', 't-b']])
  })

  it(`a note that did not go out (the send failed) waits again and goes next pass; after ${MAX_RELEASES} it ends`, async () => {
    await refusal(ask('t-a'))
    activity = HERE()
    setHeldSweepDeps(heldSweepDeps(async () => { throw new Error('send refused') }))
    for (let i = 1; i <= MAX_RELEASES; i++) {
      expect((await sweepHeld()).map((x) => x.kind)).toEqual(['release'])
      expect((await listHeld())[0]).toMatchObject({ state: 'held', releases: i })
    }
    expect((await sweepHeld()).map((x) => [x.kind, x.held.lapsedWhy])).toEqual([['lapse', 'not_reached']])
    expect(await listHeld()).toEqual([])
  })

  it('one held ask per step: a task\'s push and its other step wait apart, and one going through leaves the other', async () => {
    const gate = { ...who('t-a'), command: 'leak-gate-approve' }
    const askGate = () => createApproval({ what: 'Run the leak gate on main', singleUse: true, timeoutMs: 60_000, requester: gate, detail: ctx(2) })
    await refusal(ask('t-a'))
    await refusal(askGate())
    expect((await listHeld()).map((h) => h.what).sort()).toEqual([PUSH, 'Run the leak gate on main'])
    activity = HERE()
    const g = await askGate()
    expect((await listHeld()).map((h) => [h.what, h.state])).toEqual([[PUSH, 'held']])
    at(1_000)
    await tap(g, 'approve')
    expect((await sweepHeld()).map((x) => [x.kind, x.held.what])).toEqual([['release', PUSH]])
    // A task keeps at most three steps waiting.
    activity = AWAY()
    for (const c of ['step-2', 'step-3']) await refusal(createApproval({ what: c, singleUse: true, timeoutMs: 60_000, requester: { ...who('t-a'), command: c }, detail: ctx(3) }))
    const fourth = await refusal(createApproval({ what: 'step-4', singleUse: true, timeoutMs: 60_000, requester: { ...who('t-a'), command: 'step-4' }, detail: ctx(4) }))
    expect(fourth?.message).toMatch(/could not hold it/)
    expect(await listHeld()).toHaveLength(MAX_HELD_PER_TASK)
  })

  it('guard: the sweep releases a held ask exactly when createApproval would let its ask through', async () => {
    // Every state a release can meet. A new refusal in createApproval that the sweep does not make
    // shows here as a release whose ask is refused (2026-11-25 review: the pending cap was one, and
    // the task was told "ask again" every few seconds).
    const other = (what = 'Other step') => createApproval({ what, singleUse: true, timeoutMs: 60_000, requester: { ...who('t-other'), command: 'other' }, detail: ctx(5) })
    const scenarios: Array<{ name: string; before?: () => Promise<void>; setup: () => Promise<void> }> = [
      { name: 'he is back', setup: async () => { activity = HERE() } },
      { name: 'he is away', setup: async () => { activity = AWAY() } },
      { name: 'cannot tell', setup: async () => { activity = null } },
      { name: 'another single-use ask is on his devices', setup: async () => { activity = HERE(); await other() } },
      { name: 'the pending cap is full', setup: async () => {
        activity = HERE()
        for (let i = 0; i < APPROVAL_PENDING_MAX; i++) await createApproval({ what: `Tap ${i}?`, requester: who(`t-plain-${i}`) })
      } },
      { name: 'his last one ended unanswered, nothing since', setup: async () => { activity = HERE(); await other(); at(61_000); await sweepExpired() } },
      { name: 'his last one ended unanswered, he is back since', setup: async () => { activity = HERE(); await other(); at(61_000); await sweepExpired(); at(1_000); activity = HERE() } },
      { name: 'another task\'s release keeps his devices', before: async () => {
        activity = AWAY(); await refusal(other('Reserved step')); activity = HERE(); await sweepHeld()
      }, setup: async () => { activity = HERE() } },
      // Not here on purpose: a step he denied is never released, while its task may still ask it
      // itself once he did something since (it changed); "never held" above covers it.
    ]
    const results: Array<[string, boolean, boolean]> = []
    for (const s of scenarios) {
      _resetApprovalTimersForTesting()
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
      await s.before?.()
      activity = AWAY()
      await refusal(ask('t-x'))
      await s.setup()
      const released = (await sweepHeld()).some((x) => x.kind === 'release' && x.held.requester.taskId === 't-x')
      const passed = (await refusal(ask('t-x'))) === null
      results.push([s.name, released, passed])
      at(10 * 60_000)
    }
    expect(results.filter(([, released, passed]) => released !== passed), 'released, yet refused (or the reverse)').toEqual([])
    expect(results.filter(([, released]) => released).map(([n]) => n)).toEqual(['he is back', 'his last one ended unanswered, he is back since'])
  })

  it('a held ask whose step he denied, or left unanswered twice, meanwhile is dropped and its task told', () => {
    const now = Date.parse('2026-11-25T10:00:00Z')
    const h = (over: Partial<HeldAsk>): HeldAsk => ({
      id: 'held-x', what: PUSH, requester: { host: 'b', taskId: 't-a' }, reason: 'user_away', state: 'held',
      heldAt: '2026-11-25T09:00:00Z', until: '2026-11-26T09:00:00Z', releases: 0, ...over,
    })
    expect(decideHeld([h({})], now, () => 'go').map((x) => x.kind)).toEqual(['release'])
    expect(decideHeld([h({})], now, () => 'wait')).toEqual([])
    expect(decideHeld([h({})], now, () => 'denied').map((x) => [x.kind, x.held.lapsedWhy])).toEqual([['lapse', 'denied']])
    expect(decideHeld([h({})], now, () => 'unanswered').map((x) => [x.kind, x.held.lapsedWhy])).toEqual([['lapse', 'unanswered']])
    expect(decideHeld([h({ until: '2026-11-25T09:30:00Z' })], now, () => 'go').map((x) => [x.kind, x.held.lapsedWhy])).toEqual([['lapse', 'deadline']])
    expect(decideHeld([h({ releases: MAX_RELEASES })], now, () => 'go').map((x) => [x.kind, x.held.lapsedWhy])).toEqual([['lapse', 'not_reached']])
    // A release marked but never told (Walnut stopped in between) goes again after its grace; a told one waits for its task.
    expect(decideHeld([h({ state: 'released', releasedAt: '2026-11-25T09:40:00Z', releases: 1 })], now, () => 'go').map((x) => x.kind)).toEqual(['release'])
    expect(decideHeld([h({ state: 'released', releasedAt: '2026-11-25T09:40:00Z', toldAt: '2026-11-25T09:40:01Z', releases: 1 })], now, () => 'go')).toEqual([])
    // After a restart a release on disk in its grace still holds the next back.
    expect(decideHeld([h({ state: 'released', releasedAt: '2026-11-25T09:55:00Z' }), h({ id: 'held-y', requester: { host: 'b', taskId: 't-b' } })], now, () => 'go')).toEqual([])
  })
})

describe('the sweep runs by itself on the leader', () => {
  it('the person\'s attention (a window or the phone app banking time) releases a held ask within seconds', async () => {
    vi.useRealTimers()
    activity = { lastSeenAt: Date.now() - 60 * 60_000, streaming: false }
    await refusal(ask('t-a'))
    const base = heldSweepDeps(async (x) => { told.push(x); return true })
    let passes = 0
    startHeldSweep({ verdict: async () => { const v = await base.verdict(); passes++; return v }, tell: base.tell })
    // The pass on start: he is away, so it waits.
    await vi.waitFor(() => { expect(passes).toBe(1) })
    expect(told).toEqual([])
    activity = { lastSeenAt: Date.now(), streaming: false }
    bus.emit(EventNames.TIME_BANKED, { records: [] }, [], { source: 'time-tracking' })
    await vi.waitFor(() => { expect(told.map((x) => x.kind)).toEqual(['release']) }, { timeout: 6_000, interval: 100 })
    // The attention's kick released it, not the minute clock.
    expect(passes).toBe(2)
  })
})

describe('what the asker reads', () => {
  it('a newer walnut approve exits 4 on a held refusal (asked, not answered), and 3 on any other', async () => {
    expect(CLI_HELD_MARK).toBe(HELD_MARK)
    const said: string[] = []
    const io = (message: string, code: string) => ({
      call: async () => ({ ok: false, status: 409, code, message }),
      say: (l: string) => { said.push(l) }, out: () => undefined, onInterrupt: () => () => undefined,
      tokenDir: path.join(WALNUT_HOME, 'tok'),
    })
    const args = { what: PUSH, detail: ctx(), timeoutMs: 60_000, json: false, singleUse: true }
    expect(await runApprove(args, io(`The user has not been in any Walnut chat. ${HELD_MARK} (held-1) until ...`, 'user_away'))).toBe(APPROVE_EXIT.pending)
    expect(said.at(-1)).toMatch(/not asked yet/)
    const printed: string[] = []
    expect(await runApprove({ ...args, json: true }, { ...io(`Away. ${HELD_MARK} (held-Ab_1) until ...`, 'user_away'), out: (l: string) => { printed.push(l) } })).toBe(APPROVE_EXIT.pending)
    expect(printed.map((l) => JSON.parse(l))).toEqual([{ status: 'held', held: 'held-Ab_1' }])
    expect(await runApprove(args, io('The user denied this same step.', 'unanswered_retry'))).toBe(APPROVE_EXIT.error)
  })

  it('the task hears "ask again" once he is back, and "lapsed" with why', () => {
    const held: HeldAsk = { id: 'held-1', what: PUSH, requester: { host: 'b', taskId: 't-a', command: 'git push origin main' }, reason: 'user_away', state: 'released', heldAt: 'a', until: 'b', releases: 1 }
    const again = heldNoticeFor({ kind: 'release', held })
    expect(again.outcome).toBe('ask_again')
    expect(again.body).toMatch(/back in Walnut/)
    expect(again.body).toMatch(/git push origin main/)
    for (const why of ['deadline', 'denied', 'unanswered', 'not_reached'] as const) {
      const lapsed = heldNoticeFor({ kind: 'lapse', held: { ...held, state: 'lapsed', lapsedWhy: why } })
      expect(lapsed.outcome).toBe('lapsed')
      expect(lapsed.body).toMatch(/did not run/)
      // Every end is an end: none tells the task to ask again on its own.
      expect(lapsed.body).not.toMatch(/take it again|ask again now/i)
    }
    expect(heldNoticeFor({ kind: 'lapse', held: { ...held, lapsedWhy: 'denied' } }).body).toMatch(/denied/)
  })
})

describe('guard: no fence refusal leaves an ask that nobody asks again', () => {
  const fence = fs.readFileSync(path.join(ROOT, 'src/core/approvals/single-use-fence.ts'), 'utf8')
  const store = fs.readFileSync(path.join(ROOT, 'src/core/approvals/store.ts'), 'utf8')

  it('every refusal code is one the held tests above cover', () => {
    const union = /readonly code: ([^,\n]+),/.exec(fence)?.[1] ?? ''
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(codes, 'a new refusal code: add it to "every not-now refusal is held" above').toEqual(['biometric_pending', 'presence_unknown', 'too_many_pending', 'unanswered_retry', 'user_away'])
  })

  it('every refusal passes its not-held reason, so none is "not now" by leaving it out', () => {
    const calls = [...fence.matchAll(/new FenceRefusal\(([\s\S]*?)\)\s*\n/g)].map((m) => m[1].trim())
    expect(calls.length).toBeGreaterThanOrEqual(6)
    const fourth = calls.map((c) => /,\s*(\{[^}]*\}|undefined)\s*,\s*([^,]+?)\s*$/.exec(c)?.[2])
    expect(fourth.filter((x) => !x), 'each new FenceRefusal names its notHeld (undefined when it is only "not now")').toEqual([])
  })

  it('createApproval holds every holdable refusal, and every refusal of a single-use ask in its locked write is the fence\'s', () => {
    const body = store.slice(store.indexOf('export async function createApproval('), store.indexOf('export async function getApproval('))
    expect(body).toContain('if (!r || !r.holdable) throw err')
    expect(body).toContain('holdAsk(')
    // A new refusal in the write: make it a FenceRefusal for a fenced ask (held), as the pending cap is.
    const throwsInWrite = [...body.slice(body.indexOf('updateJsonFile<ApprovalsFile>'), body.indexOf('.catch(async (err)')).matchAll(/throw (new ApprovalError|fenceError)\(/g)].map((m) => m[1])
    expect(throwsInWrite).toEqual(['fenceError', 'fenceError', 'new ApprovalError'])
  })
})
