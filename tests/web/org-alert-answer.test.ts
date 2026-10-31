/**
 * The Org page's in-place Answer (web/src/components/org/OrgInlineAnswer.tsx): which form an ask
 * takes, read from the ask itself (org-answer-shape.ts); the letter that waits on the user; and
 * the hold that stops an answered row counting at once (org-answered.ts).
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import type { LetterEnvelope } from '../../web/src/api/human-inbox'
import { answerShape, openLetterFor } from '../../web/src/components/org/org-answer-shape'
import { phaseMark, promptAnswered, settleHolds, withAnswered, without, type AnsweredHold } from '../../web/src/components/org/org-answered'
import type { OrgAlertView } from '../../web/src/components/org/org-channels-model'

const alert = (over: Partial<OrgAlertView>): OrgAlertView => ({ taskId: 't1', title: 'Lease', kind: 'needs', ...over })

describe('the form an ask takes', () => {
  it('follows the ask, never the words', () => {
    expect(answerShape(alert({ kind: 'question' }))).toBe('prompt')
    expect(answerShape(alert({ kind: 'permission', tool: 'Bash' }))).toBe('prompt')
    expect(answerShape(alert({ source: 'prompt' }))).toBe('prompt')
    expect(answerShape(alert({ source: 'letter' }))).toBe('letter')
    expect(answerShape(alert({ source: 'choice' }))).toBe('choice')
    // No structure: the session's own words, a failed session.
    expect(answerShape(alert({ source: 'session', ask: 'Approve? yes or no' }))).toBe('words')
    expect(answerShape(alert({ kind: 'error' }))).toBe('words')
    expect(answerShape(alert({}))).toBe('words')
  })
})

describe('the letter that waits on the user', () => {
  const letter = (over: Partial<LetterEnvelope>): LetterEnvelope => ({
    id: 'lt-1', subject: 'Sign it?', type: 'action_required', bodyFormat: 'markdown', textPreview: '',
    sender: { sessionId: 's1', taskId: 't1', host: 'local' }, createdAt: 1000, read: false, pinned: false, archived: false,
    actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], ...over,
  })

  it('is the newest open decision from this task', () => {
    const older = letter({ id: 'lt-old', createdAt: 500 })
    const newer = letter({ id: 'lt-new', createdAt: 2000 })
    expect(openLetterFor([older, newer], 't1')?.id).toBe('lt-new')
    expect(openLetterFor([newer], 't2')).toBeNull()
  })

  it('skips one answered, archived, without actions, read long ago, or not a decision', () => {
    const now = 10 * 60_000
    for (const l of [
      letter({ answered: { actionId: 'yes', label: 'Yes', at: 1 } }),
      letter({ archived: true }),
      letter({ actions: [] }),
      letter({ read: true, readAt: 1 }),
      letter({ type: 'info', actions: undefined }),
    ]) expect(openLetterFor([l], 't1', now)).toBeNull()
    // Read a moment ago: still the user's to answer.
    expect(openLetterFor([letter({ read: true, readAt: now - 1000 })], 't1', now)?.id).toBe('lt-1')
  })
})

describe('an answered row stops counting at once', () => {
  const task = (over: Partial<Task>): Task => ({
    id: 't1', title: 'Lease', status: 'todo', phase: 'NEED_ACTION', phase_changed_at: '2026-10-26T01:00:00Z', priority: 'none', project: 'Marina',
    created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z',
    user_status: { state: 'needs', source: 'letter', ask: 'Sign it?', at: '2026-10-26T01:00:00Z' }, ...over,
  } as Task)
  const hold = (t: Task, over: Partial<AnsweredHold> = {}): Map<string, AnsweredHold> =>
    new Map([[t.id, { phase: phaseMark(t), source: t.user_status?.source ?? '', ask: t.user_status?.ask ?? '', probe: '', until: 5000, ...over }]])

  it('reads as working while the task has not moved', () => {
    const t = task({})
    const [held] = withAnswered([t], hold(t), 1000)
    expect(held!.user_status).toEqual({ state: 'working', at: '2026-10-26T01:00:00Z' })
    // Another task is untouched, and no holds is the same list.
    const other = task({ id: 't2' })
    expect(withAnswered([other], hold(t), 1000)[0]).toBe(other)
    const list = [t]
    expect(withAnswered(list, new Map(), 1000)).toBe(list)
  })

  it('stays hidden while only the words move, the answer not yet with the session', () => {
    const t = task({})
    const holds = hold(t)
    // The server re-derived the status before the answer reached the session: same phase, new words.
    const reworded = task({ user_status: { state: 'needs', source: 'session', ask: 'Its turn ended and handed the task back to you: read it and reply.', at: '2026-10-26T01:00:00Z' } })
    expect(withAnswered([reworded], holds, 1000)[0]!.user_status?.state).toBe('working')
    expect(settleHolds(holds, [reworded], () => '', 1000)).toBe(holds)
  })

  it('stays hidden while the session works on the answer, its status not yet caught up', () => {
    const t = task({})
    const holds = hold(t)
    // The session took the answer; the status was derived a moment before and still needs the user.
    const taken = task({ phase: 'IN_PROGRESS', phase_changed_at: '2026-10-26T01:00:05Z' })
    expect(withAnswered([taken], holds, 1000)[0]!.user_status?.state).toBe('working')
    expect(settleHolds(holds, [taken], () => '', 1000)).toBe(holds)
  })

  it('ends when the task asks again, a round trip included, or needs no one, or a minute passes', () => {
    const t = task({})
    const holds = hold(t)
    const working = task({ phase: 'IN_PROGRESS', phase_changed_at: '2026-10-26T01:00:05Z', user_status: { state: 'working', at: '2026-10-26T01:00:05Z' } })
    expect(settleHolds(holds, [working], () => '', 1000).size).toBe(0)
    // The session took the answer and handed the task back between two reads: a new ask.
    const back = task({ phase_changed_at: '2026-10-26T01:00:09Z', user_status: { state: 'needs', source: 'session', ask: 'Read my reply.', at: '2026-10-26T01:00:09Z' } })
    expect(withAnswered([back], holds, 1000)[0]).toBe(back)
    expect(settleHolds(holds, [back], () => '', 1000).size).toBe(0)
    // Its session failed on the answer: shown, unless the answer was a Retry of that failure.
    const failed = task({ phase: 'IN_PROGRESS', phase_changed_at: '2026-10-26T01:00:05Z', user_status: { state: 'needs', source: 'error', ask: 'Its session failed.', at: '2026-10-26T01:00:05Z' } })
    expect(withAnswered([failed], holds, 1000)[0]).toBe(failed)
    expect(settleHolds(holds, [failed], () => '', 1000).size).toBe(0)
    const retried = hold(failed)
    expect(withAnswered([failed], retried, 1000)[0]!.user_status?.state).toBe('working')
    // Another letter of its own waits, or a Board choice: a new ask in the same phase.
    const next = task({ user_status: { state: 'needs', source: 'letter', ask: 'Pay the deposit?', at: '2026-10-26T01:00:01Z' } })
    expect(withAnswered([next], holds, 1000)[0]).toBe(next)
    expect(settleHolds(holds, [next], () => '', 1000).size).toBe(0)
    const choice = task({ user_status: { state: 'needs', source: 'choice', ask: 'Sign it?', at: '2026-10-26T01:00:01Z' } })
    expect(withAnswered([choice], holds, 1000)[0]).toBe(choice)
    const waiting = task({ user_status: { state: 'waiting', at: '2026-10-26T01:00:00Z' } })
    expect(settleHolds(holds, [waiting], () => '', 1000).size).toBe(0)
    expect(withAnswered([t], holds, 6000)[0]).toBe(t)
    expect(settleHolds(holds, [t], () => '', 6000).size).toBe(0)
  })

  it('hides a task its status was never derived for, as the rows count it by its phase', () => {
    const bare = task({ user_status: undefined })
    const holds = hold(bare)
    expect(withAnswered([bare], holds, 1000)[0]!.user_status?.state).toBe('working')
    expect(settleHolds(holds, [bare], () => '', 1000)).toBe(holds)
  })

  it('hides the answered prompt until it goes, and shows the next one at once', () => {
    const t = task({ user_status: { state: 'needs', source: 'prompt', ask: 'Answer the prompt.', at: '2026-10-26T01:00:00Z' } })
    let holds: ReadonlyMap<string, AnsweredHold> = hold(t, { probe: 'permission:Bash' })
    // Still on screen a moment after the answer: hidden.
    expect(promptAnswered(holds, 't1', 'permission:Bash', 1000)).toBe(true)
    holds = settleHolds(holds, [t], () => 'permission:Bash', 1000)
    expect(holds.get('t1')?.cleared).toBeUndefined()
    // It went: the hold remembers, and keeps the status hidden while the server catches up.
    holds = settleHolds(holds, [t], () => '', 1000)
    expect(holds.get('t1')?.cleared).toBe(true)
    expect(withAnswered([t], holds, 1000)[0]!.user_status?.state).toBe('working')
    // The session asks again (same tool, the phase never left NEED_ACTION): a new ask, shown.
    expect(promptAnswered(holds, 't1', 'permission:Bash', 1000)).toBe(false)
    expect(settleHolds(holds, [t], () => 'permission:Bash', 1000).size).toBe(0)
  })

  it('keeps hiding an answered prompt the session still shows after the task moved', () => {
    const t = task({ user_status: { state: 'needs', source: 'prompt', ask: 'Answer the prompt.', at: '2026-10-26T01:00:00Z' } })
    const holds = hold(t, { probe: 'question:' })
    const moved = task({ phase: 'IN_PROGRESS', phase_changed_at: '2026-10-26T01:00:05Z', user_status: { state: 'working', at: '2026-10-26T01:00:05Z' } })
    expect(settleHolds(holds, [moved], () => 'question:', 1000)).toBe(holds)
    expect(settleHolds(holds, [moved], () => '', 1000).size).toBe(0)
  })

  it('ends for a letter or a line when a prompt appears', () => {
    const t = task({})
    expect(settleHolds(hold(t), [t], () => 'question:', 1000).size).toBe(0)
    // A different prompt from the one answered is new too.
    expect(settleHolds(hold(t, { probe: 'permission:Bash' }), [t], () => 'permission:Edit', 1000).size).toBe(0)
  })
})

describe('without', () => {
  it('drops one key, and is the same map when it has none', () => {
    const m = new Map([['a', 1], ['b', 2]])
    expect([...without(m, 'a')]).toEqual([['b', 2]])
    expect(without(m, 'z')).toBe(m)
    expect([...m]).toEqual([['a', 1], ['b', 2]])
  })
})
