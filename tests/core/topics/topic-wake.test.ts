/**
 * Who a topic message wakes (src/core/topics/topic-wake.ts planDelivery), pure:
 *
 *   members: Acme VP (org, host), Marina (task), Orchard (task), Dana (person), Pat (pending person), Lee (left task)
 *
 *   1. the user, no @mention: every active task/org member wakes, persons are mailed now, a new round starts;
 *   2. the user @mentions one: only it wakes, the rest fold; a named person is mailed now, others later;
 *   3. a member's message with no @mention wakes nobody and folds to the others (not to itself);
 *   4. a member's @mentions wake within the round's 3 wakes; past them fold + "round budget used up" and one Walnut line a round;
 *   5. ping-pong: A wakes B once a round; B may answer A once; A again is refused as the pair limit;
 *   6. self mention never wakes the author; pending and left members get nothing;
 *   7. closing wakes every active task/org member outside the budget; a closed topic plans nothing.
 */
import { describe, expect, it } from 'vitest'
import { BUDGET_WHY, PAIR_LIMIT_WHY, planClosing, planDelivery } from '../../../src/core/topics/topic-wake.js'
import { freshRound, mentionsOf, parseMentions, type MemberId, type Topic, type TopicMember, type TopicMessage } from '../../../src/core/topics/topics-model.js'

const AT = '2026-11-20T10:00:00.000Z'
const member = (id: string, name: string, ref: TopicMember['ref'], extra: Partial<TopicMember> = {}): TopicMember => ({
  id: id as MemberId, name, ref, role: 'member', joinedAt: AT, addedBy: 'human', status: 'active', ...extra,
})
const VP = 'mb-0000000a' as MemberId
const MARINA = 'mb-0000000b' as MemberId
const ORCHARD = 'mb-0000000c' as MemberId
const DANA = 'mb-0000000d' as MemberId
const PAT = 'mb-0000000e' as MemberId
const LEE = 'mb-0000000f' as MemberId

function topic(round = freshRound(1, AT)): Topic {
  return {
    id: 'tp-aaaaaaaaaaaa', title: 'Launch plan', createdAt: AT, updatedAt: AT, createdBy: 'human', messages: [], round,
    members: [
      member(VP, 'Acme VP', { kind: 'org', node: 'project:acme' }, { role: 'host' }),
      member(MARINA, 'Marina', { kind: 'task', taskId: 't-marina' }),
      member(ORCHARD, 'Orchard', { kind: 'task', taskId: 't-orchard' }),
      member(DANA, 'Dana', { kind: 'person', name: 'Dana', email: 'dana@example.com' }),
      member(PAT, 'Pat', { kind: 'person', name: 'Pat', email: 'pat@example.com' }, { status: 'pending', addedBy: 'task:t-marina' }),
      member(LEE, 'Lee', { kind: 'task', taskId: 't-lee' }, { status: 'left' }),
    ],
  }
}

function msg(t: Topic, author: TopicMessage['author'], text: string): TopicMessage {
  return { id: 'tpm-000000000001', at: AT, author, text, via: author === 'human' ? 'ui' : 'agent', mentions: mentionsOf(text, [], t.members) }
}

describe('mentions', () => {
  it('match @Name case-insensitively, longest first, never a left member', () => {
    const t = topic()
    t.members.push(member('mb-00000010' as MemberId, 'Acme', { kind: 'task', taskId: 't-acme' }))
    expect(parseMentions('@acme vp and @ACME, also @Lee and @Marina.', t.members)).toEqual([VP, 'mb-00000010', MARINA])
    expect(parseMentions('mail@marina.example is no mention, @Marinas neither', t.members)).toEqual([])
  })
})

describe('the user writes', () => {
  it('with no @mention: every active task/org member wakes, persons are mailed now, a new round starts', () => {
    const t = topic({ n: 4, startedAt: AT, hops: 3, pairs: { [`${MARINA}>${ORCHARD}`]: 1 }, budgetTold: true })
    const plan = planDelivery(t, msg(t, 'human', 'Where are we on the launch?'))
    expect(plan.wake).toEqual([VP, MARINA, ORCHARD])
    expect(plan.fold).toEqual([])
    expect(plan.mail).toEqual([DANA])
    expect(plan.mailNow).toEqual([DANA])
    expect(plan.round).toEqual({ n: 5, startedAt: AT, hops: 0, pairs: {} })
  })

  it('with an @mention: only that member wakes, the others fold; only a named person is mailed now', () => {
    const t = topic()
    const plan = planDelivery(t, msg(t, 'human', '@Marina can you check the dates?'))
    expect(plan.wake).toEqual([MARINA])
    expect(plan.fold).toEqual([VP, ORCHARD])
    expect(plan.mail).toEqual([DANA])
    expect(plan.mailNow).toEqual([])
    const named = planDelivery(t, msg(t, 'human', '@Dana please confirm'))
    expect(named.wake).toEqual([])
    expect(named.mailNow).toEqual([DANA])
  })
})

describe('a member writes', () => {
  it('with no @mention: wakes nobody and folds to every other active task/org member', () => {
    const t = topic()
    const plan = planDelivery(t, msg(t, MARINA, 'Dates look fine to me.'))
    expect(plan.wake).toEqual([])
    expect(plan.fold).toEqual([VP, ORCHARD])
    expect(plan.mail).toEqual([DANA])
    expect(plan.mailNow).toEqual([])
    expect(plan.round.hops).toBe(0)
  })

  it('its @mentions wake within the round budget of 3, past it fold and refuse, with one Walnut line a round', () => {
    const t = topic({ n: 1, startedAt: AT, hops: 2, pairs: {} })
    const plan = planDelivery(t, msg(t, MARINA, '@Acme VP and @Orchard please look'), { userName: 'Robin' })
    expect(plan.wake).toEqual([VP])
    expect(plan.fold).toEqual([ORCHARD])
    expect(plan.refused).toEqual([{ member: ORCHARD, why: BUDGET_WHY }])
    expect(plan.round.hops).toBe(3)
    expect(plan.budgetLine).toBe("This round's 3 member wakes are used up; the rest wait for Robin.")
    expect(plan.round.budgetTold).toBe(true)
    // The next over-budget message this round says nothing again.
    const next = planDelivery({ ...t, round: plan.round }, msg(t, ORCHARD, '@Marina answer me'))
    expect(next.wake).toEqual([])
    expect(next.refused).toEqual([{ member: MARINA, why: BUDGET_WHY }])
    expect(next.budgetLine).toBeUndefined()
  })

  it('ping-pong: A wakes B once a round, B answers A once, then the pair is refused', () => {
    const t = topic()
    const one = planDelivery(t, msg(t, MARINA, '@Orchard?'))
    expect(one.wake).toEqual([ORCHARD])
    const t2 = { ...t, round: one.round }
    const back = planDelivery(t2, msg(t2, ORCHARD, '@Marina yes'))
    expect(back.wake).toEqual([MARINA])
    const t3 = { ...t, round: back.round }
    const again = planDelivery(t3, msg(t3, MARINA, '@Orchard and?'))
    expect(again.wake).toEqual([])
    expect(again.fold).toContain(ORCHARD)
    expect(again.refused).toEqual([{ member: ORCHARD, why: PAIR_LIMIT_WHY }])
    const again2 = planDelivery(t3, msg(t3, ORCHARD, '@Marina more'))
    expect(again2.refused).toEqual([{ member: MARINA, why: PAIR_LIMIT_WHY }])
    expect(back.round.hops).toBe(2)
  })

  it('never wakes itself; pending and left members get nothing', () => {
    const t = topic()
    const plan = planDelivery(t, msg(t, MARINA, '@Marina @Lee @Pat note to self'))
    expect(plan.wake).toEqual([])
    expect(plan.fold).toEqual([VP, ORCHARD])
    expect([...plan.wake, ...plan.fold, ...plan.mail]).not.toContain(PAT)
    expect([...plan.wake, ...plan.fold, ...plan.mail]).not.toContain(LEE)
    expect(plan.round.hops).toBe(0)
  })
})

describe('closing', () => {
  it('wakes every active task/org member once, outside the round budget', () => {
    const t = topic({ n: 2, startedAt: AT, hops: 3, pairs: {} })
    const plan = planClosing(t)
    expect(plan.wake).toEqual([VP, MARINA, ORCHARD])
    expect(plan.mail).toEqual([DANA])
    expect(plan.round.hops).toBe(3)
  })

  it('a closed topic plans nothing for a late message', () => {
    const t = { ...topic(), closed: { at: AT, by: 'human' as const } }
    const plan = planDelivery(t, msg(t, MARINA, '@Orchard one more'))
    expect(plan.wake).toEqual([])
    expect(plan.fold).toEqual([])
  })
})
