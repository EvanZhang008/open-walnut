/**
 * Action needed (src/core/action-needed.ts): the items a task asks of the user, the state they give
 * it, and a snooze of one item.
 */
import { describe, expect, it } from 'vitest'
import { applyActions, itemSnoozeEndedMs, markSnoozes, ownLineIsItem, writeSnooze, type ActionItem } from '../../src/core/action-needed.js'
import { approvalItemsByTask, letterItem, promptItem } from '../../src/core/action-needed-facts.js'
import type { UserStatus } from '../../src/core/user-status.js'
import { USER_KIND_LEAD_WORDS } from '../../src/core/human-inbox/walnut-letters/thread-words.js'
import type { ApprovalView } from '../../src/core/approvals/types.js'

const NOW = Date.parse('2026-11-19T20:00:00Z')
const LATER = '2026-11-19T21:00:00.000Z'
const EARLIER = '2026-11-19T19:00:00.000Z'

const approval: ActionItem = { kind: 'approval', id: 'apr-1', summary: 'Push commit d0f4f51 to origin main', at: EARLIER }
const letter: ActionItem = { kind: 'letter', id: 'lt-1', summary: 'Pick the bucket policy', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }

describe('applyActions: the state an open item gives a task', () => {
  it('a working task with an approval reads Needs you, still Working', () => {
    const s = applyActions({ state: 'working', now: 'building' }, [approval], [], { nowMs: NOW })
    expect(s).toMatchObject({ state: 'needs', source: 'approval', ask: approval.summary, working: true, category: 'decide', now: 'building' })
    expect(s.actions?.map((a) => a.id)).toEqual(['apr-1'])
  })

  it('a waiting task with an open letter reads Needs you, and its wait words go', () => {
    const s = applyActions({ state: 'waiting', kind: 'outside', waitingOn: 'CI' }, [letter], [], { nowMs: NOW })
    expect(s).toMatchObject({ state: 'needs', source: 'letter', ask: letter.summary })
    expect(s.kind).toBeUndefined()
    expect(s.waitingOn).toBeUndefined()
    expect(s.working).toBeUndefined()
  })

  it('its own ask stays the ask, and is one of its items', () => {
    const own: UserStatus = { state: 'needs', source: 'session', ask: 'Which bucket?', decision: { id: 'ask-abc123', key: 'k' } }
    const s = applyActions(own, [approval], [], { nowMs: NOW })
    expect(s).toMatchObject({ state: 'needs', source: 'session', ask: 'Which bucket?' })
    expect(s.actions?.map((a) => `${a.kind}:${a.id}`)).toEqual(['approval:apr-1', 'ask:ask-abc123'])
  })

  it('a snoozed item leaves the state as derived; it rides along marked', () => {
    const s = applyActions({ state: 'working' }, [approval], [{ id: 'apr-1', until: LATER, at: EARLIER }], { nowMs: NOW })
    expect(s.state).toBe('working')
    expect(s.actions?.[0]?.snoozedUntil).toBe(LATER)
  })

  it('every item that made it Needs you snoozed: Waiting / snoozed until the first comes back', () => {
    const own: UserStatus = { state: 'needs', source: 'letter', ask: letter.summary }
    const s = applyActions(own, [letter, approval], [{ id: 'lt-1', until: LATER, at: EARLIER }, { id: 'apr-1', until: '2026-11-20T09:00:00.000Z', at: EARLIER }], { nowMs: NOW })
    expect(s).toMatchObject({ state: 'waiting', kind: 'time', until: LATER, snoozed: { until: LATER, ask: letter.summary } })
    expect(s.actions).toHaveLength(2)
  })

  it('one of two snoozed: the other is the ask', () => {
    const own: UserStatus = { state: 'needs', source: 'letter', ask: letter.summary }
    const s = applyActions(own, [letter, approval], [{ id: 'lt-1', until: LATER, at: EARLIER }], { nowMs: NOW })
    expect(s).toMatchObject({ state: 'needs', source: 'approval', ask: approval.summary })
  })

  it('a snooze that ran out counts for nothing: the item is back', () => {
    const s = applyActions({ state: 'working' }, [approval], [{ id: 'apr-1', until: EARLIER, at: EARLIER }], { nowMs: NOW })
    expect(s.state).toBe('needs')
    expect(s.actions?.[0]?.snoozedUntil).toBeUndefined()
  })

  it('a live prompt snoozed: the task is snoozed, and the item says its session waits', () => {
    const prompt = promptItem('sid-1', { requestId: 'req-1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which sections?', options: [{ label: 'Fixes' }, { label: 'Both' }] }] }, receivedAt: EARLIER })
    const s = applyActions({ state: 'needs', source: 'prompt', ask: 'Answer the AskUserQuestion prompt in its session.' }, [prompt], [{ id: 'req-1', until: LATER, at: EARLIER }], { nowMs: NOW })
    expect(s.state).toBe('waiting')
    expect(s.snoozed?.until).toBe(LATER)
    expect(s.actions?.[0]).toMatchObject({ kind: 'question', blocking: true, snoozedUntil: LATER })
  })

  it('a task snoozed by its start date, an org node, a failure and a finished task keep their state', () => {
    expect(applyActions({ state: 'waiting', kind: 'time', snoozed: { until: LATER } }, [approval], [], { nowMs: NOW }).state).toBe('waiting')
    expect(applyActions({ state: 'working' }, [approval], [], { nowMs: NOW, orgNode: true }).state).toBe('working')
    expect(applyActions({ state: 'needs', source: 'error', ask: 'Its session failed.' }, [approval], [], { nowMs: NOW })).toMatchObject({ source: 'error', ask: 'Its session failed.' })
    expect(applyActions({ state: 'done' }, [approval], [], { nowMs: NOW })).toEqual({ state: 'done' })
  })

  it('a fold, an answer above and a held task keep their state: one decision shows once', () => {
    const folded: UserStatus = { state: 'waiting', kind: 'task', waitingOn: 'Its lead', sameAsk: { id: 't2', title: 'Lead', ask: 'Which?' } as never }
    expect(applyActions(folded, [letter], [], { nowMs: NOW })).toMatchObject({ state: 'waiting', kind: 'task' })
    const answered: UserStatus = { state: 'waiting', kind: 'task', answeredFor: { by: 'lead', byTitle: 'Lead', at: EARLIER, ask: 'Which?' } }
    expect(applyActions(answered, [letter], [], { nowMs: NOW }).state).toBe('waiting')
    expect(applyActions({ state: 'working' }, [letter], [], { nowMs: NOW, held: true }).state).toBe('working')
    expect(applyActions({ state: 'working' }, [letter], [], { nowMs: NOW, held: true }).actions).toHaveLength(1)
  })

  it('an approval beside another ask: the other ask names the status (an approval has its own rows)', () => {
    expect(applyActions({ state: 'working' }, [approval, letter], [], { nowMs: NOW })).toMatchObject({ source: 'letter', ask: letter.summary })
    expect(applyActions({ state: 'working' }, [approval], [], { nowMs: NOW }).source).toBe('approval')
  })

  it('a needs line no item holds is kept, and its line stays on the row', () => {
    // A prompt Walnut holds no item of (no request id): never put to sleep by other items' snoozes.
    const s = applyActions({ state: 'needs', source: 'prompt', ask: 'Answer it' }, [letter], [{ id: 'lt-1', until: LATER, at: EARLIER }], { nowMs: NOW })
    expect(s.state).toBe('needs')
    expect(ownLineIsItem(s)).toBe(false)
    const failed = applyActions({ state: 'needs', source: 'error', ask: 'Its session failed.' }, [approval], [], { nowMs: NOW })
    expect(ownLineIsItem(failed)).toBe(false)
    expect(ownLineIsItem(applyActions({ state: 'working' }, [approval], [], { nowMs: NOW }))).toBe(true)
  })

  it('a snooze of one item that ran out is when it was last looked at', () => {
    expect(itemSnoozeEndedMs([{ id: 'lt-1', until: EARLIER, at: EARLIER }], 'lt-1', NOW)).toBe(Date.parse(EARLIER))
    expect(itemSnoozeEndedMs([{ id: 'lt-1', until: LATER, at: EARLIER }], 'lt-1', NOW)).toBeNaN()
    expect(itemSnoozeEndedMs([], 'lt-1', NOW)).toBeNaN()
  })

  it('no items: the status is returned as it is', () => {
    const s: UserStatus = { state: 'working' }
    expect(applyActions(s, [], [], { nowMs: NOW })).toBe(s)
  })
})

describe('the items, from their facts', () => {
  it('an AskUserQuestion with one question carries its options; several say how many more', () => {
    const one = promptItem('sid', { requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Keep which?', multiSelect: true, options: [{ label: 'Fixes' }, { label: 'Features' }] }] }, receivedAt: EARLIER })
    expect(one).toMatchObject({ kind: 'question', summary: 'Keep which?', multi: true, options: [{ id: '0', label: 'Fixes' }, { id: '1', label: 'Features' }] })
    const two = promptItem('sid', { requestId: 'r2', toolName: 'AskUserQuestion', input: { questions: [{ question: 'A?' }, { question: 'B?' }] }, receivedAt: EARLIER })
    expect(two.summary).toBe('A? (+1 more)')
    expect(two.options).toBeUndefined()
  })

  it('another tool reads as a permission with what it would run', () => {
    expect(promptItem('sid', { requestId: 'r', toolName: 'Bash', input: { command: 'git push origin main' }, receivedAt: EARLIER }))
      .toMatchObject({ kind: 'permission', summary: 'Allow Bash: git push origin main', blocking: true })
  })

  it('a letter carries its actions as options', () => {
    expect(letterItem({ id: 'lt-9', subject: 'Go?', createdAt: NOW, actions: [{ id: 'go', label: 'Go' }] }))
      .toMatchObject({ kind: 'letter', id: 'lt-9', summary: 'Go?', options: [{ id: 'go', label: 'Go' }] })
  })

  it('a letter\'s line of why drops the kind words Walnut leads it with, in every language, and keeps the reason', () => {
    for (const lang of Object.keys(USER_KIND_LEAD_WORDS) as Array<keyof typeof USER_KIND_LEAD_WORDS>) {
      for (const kind of ['user_own', 'spending', 'a_new_kind']) {
        const textPreview = `${USER_KIND_LEAD_WORDS[lang](kind, 'Only you can sign it.')} The landlord sent the final terms.`
        const item = letterItem({ id: 'lt-1', subject: 'Sign the lease?', createdAt: NOW, textPreview })
        expect(item.detail, `${lang} ${kind}`).toBe('Only you can sign it. The landlord sent the final terms.')
      }
    }
  })

  it('approvals group by their asking task: only pending ones of a task, never a test run\'s', () => {
    const base = { what: 'Push', mode: 'tap', createdAt: EARLIER, expiresAt: LATER, digest: 'd' } as const
    const list = [
      { ...base, id: 'apr-a', status: 'pending', requester: { host: 'h', taskId: 't1' } },
      { ...base, id: 'apr-b', status: 'approved', requester: { host: 'h', taskId: 't1' } },
      { ...base, id: 'apr-c', status: 'pending', requester: { host: 'h' } },
      { ...base, id: 'apr-d', status: 'pending', requester: { host: 'h', taskId: 't2' }, testRun: 'tr' },
      { ...base, id: 'apr-e', status: 'pending', mode: 'biometric', requester: { host: 'h', taskId: 't1' } },
    ] as unknown as ApprovalView[]
    const by = approvalItemsByTask(list)
    expect([...by.keys()]).toEqual(['t1'])
    expect(by.get('t1')!.map((i) => `${i.id}${i.proof ? '!' : ''}`)).toEqual(['apr-a', 'apr-e!'])
  })
})

describe('a snooze of one item', () => {
  it('writes, replaces, takes off and drops what ran out', () => {
    let list = writeSnooze([], 'apr-1', LATER, NOW, 'human')
    expect(list).toEqual([{ id: 'apr-1', until: LATER, at: new Date(NOW).toISOString(), by: 'human' }])
    list = writeSnooze([...list, { id: 'old', until: EARLIER, at: EARLIER }], 'lt-1', LATER, NOW)
    expect(list.map((s) => s.id)).toEqual(['apr-1', 'lt-1'])
    expect(writeSnooze(list, 'apr-1', null, NOW).map((s) => s.id)).toEqual(['lt-1'])
  })

  it('items are drawn blocking first, then by when they were asked', () => {
    const q = promptItem('sid', { requestId: 'r', toolName: 'AskUserQuestion', input: {}, receivedAt: LATER })
    expect(markSnoozes([letter, approval, q], [], NOW).map((i) => i.kind)).toEqual(['question', 'approval', 'letter'])
  })
})
