/**
 * The Org page's in-place Answer (web/src/components/org/OrgAlertAnswer.tsx): which form an ask
 * takes, read from the ask itself (org-answer-shape.ts); the letter that waits on the user; and
 * the hold that stops an answered row counting at once (org-answered.ts).
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import type { LetterEnvelope } from '../../web/src/api/human-inbox'
import { answerShape, openLetterFor } from '../../web/src/components/org/org-answer-shape'
import { promptAnswered, settleHolds, statusSig, withAnswered, type AnsweredHold } from '../../web/src/components/org/org-answered'
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
    id: 't1', title: 'Lease', status: 'todo', phase: 'NEED_ACTION', priority: 'none', project: 'Marina',
    created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z',
    user_status: { state: 'needs', source: 'letter', ask: 'Sign it?', at: '2026-10-26T01:00:00Z' }, ...over,
  } as Task)
  const hold = (t: Task, over: Partial<AnsweredHold> = {}): Map<string, AnsweredHold> =>
    new Map([[t.id, { sig: statusSig(t), probe: '', until: 5000, ...over }]])

  it('reads as working while the server has not moved its status', () => {
    const t = task({})
    const [held] = withAnswered([t], hold(t), 1000)
    expect(held!.user_status).toEqual({ state: 'working', at: '2026-10-26T01:00:00Z' })
    // Another task is untouched, and no holds is the same list.
    const other = task({ id: 't2' })
    expect(withAnswered([other], hold(t), 1000)[0]).toBe(other)
    const list = [t]
    expect(withAnswered(list, new Map(), 1000)).toBe(list)
  })

  it('ends when any part of the status moves, the same report time included', () => {
    const t = task({})
    const holds = hold(t)
    // The session's next ask keeps the report's time: the status still moved.
    const next = task({ user_status: { state: 'needs', source: 'letter', ask: 'Sign the other one?', at: '2026-10-26T01:00:00Z' } })
    expect(withAnswered([next], holds, 1000)[0]).toBe(next)
    expect(settleHolds(holds, [next], () => '', 1000).size).toBe(0)
    // Unmoved: the very same map.
    expect(settleHolds(holds, [t], () => '', 1000)).toBe(holds)
    // A minute on, an answer the server never saw lapses.
    expect(withAnswered([t], holds, 6000)[0]).toBe(t)
    expect(settleHolds(holds, [t], () => '', 6000).size).toBe(0)
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
    // The session asks again (same tool, the status never left needs): a new ask, shown.
    expect(promptAnswered(holds, 't1', 'permission:Bash', 1000)).toBe(false)
    expect(settleHolds(holds, [t], () => 'permission:Bash', 1000).size).toBe(0)
  })

  it('keeps hiding an answered prompt the session still shows after the server moved', () => {
    const t = task({ user_status: { state: 'needs', source: 'prompt', ask: 'Answer the prompt.', at: '2026-10-26T01:00:00Z' } })
    const holds = hold(t, { probe: 'question:' })
    const moved = task({ user_status: { state: 'working', at: '2026-10-26T01:00:05Z' } })
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
