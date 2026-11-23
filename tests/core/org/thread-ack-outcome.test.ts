/**
 * Where Walnut's rule says a card he acknowledged goes (src/core/org/thread-ack-outcome.ts
 * ackOutcome: the node's hint, and the placement when the node has not decided in time; 2026-11-20,
 * the user: "if I ack and ai should determine if it should go to closed or wait or wip", "If U know
 * why not close"). The rule: its own result delivered and he acknowledged it: Closed, unless a task
 * it lists still works on this thread's subject (Working) or waits on someone, something or a time
 * (Waiting). Fixtures: four real cards of 2026-11-20, in invented words, same shapes.
 */
import { describe, expect, it } from 'vitest'
import type { OrgThread } from '../../../src/core/org/threads-model.js'
import { ackOutcome, ackWhy, onSubject, subjectWords, taskStands, type AckTask } from '../../../src/core/org/thread-ack-outcome.js'
import { threadGroupOf } from '../../../src/core/org/thread-groups.js'
import { withAwaits } from '../../../src/core/org/thread-ack.js'

const AT = '2026-11-20T08:00:00.000Z'

function card(title: string, tasks: string[], extra: Partial<OrgThread> = {}): OrgThread {
  return {
    id: 'th-aaaaaaaaaaaa', title, state: 'answered', createdAt: AT, updatedAt: AT, tasks,
    messages: [{ id: 'tm-aaaaaaaaaaaa', at: AT, text: title, via: 'chat' }],
    ...extra,
  }
}
const byId = (...xs: AckTask[]) => new Map(xs.map((x) => [x.id, x] as const))

describe('his Acknowledge sends the card where its work stands', () => {
  it('(1) "Avatars: version 6 is live", its avatars task still in progress on the phone part: Working', () => {
    const t = card('Avatars: version 6 is live', ['t-avatars'])
    const task: AckTask = { id: 't-avatars', title: 'Agent avatars on web and phone', phase: 'IN_PROGRESS', user_status: { state: 'working' } }
    const r = ackOutcome(t, byId(task))
    expect(r.outcome).toBe('working')
    expect(r.waits).toEqual({ tasks: [{ id: 't-avatars', title: 'Agent avatars on web and phone' }], replies: false, letter: false })
  })

  it('(2) "Director: web live, phone waits for a Mac simulator", its task WAITING with what and until when: Waiting', () => {
    const t = card('Director: web live, phone waits for a Mac simulator', ['t-director'])
    const task: AckTask = { id: 't-director', title: 'Add a Director layer to the org', phase: 'WAITING', user_status: { state: 'waiting', waitingOn: 'a Mac simulator in the morning', until: '2026-11-21T16:00:00.000Z' } }
    const r = ackOutcome(t, byId(task))
    expect(r.outcome).toBe('waiting')
    expect(r.waits?.tasks).toEqual([{ id: 't-director', title: 'Add a Director layer to the org', waitingOn: 'a Mac simulator in the morning', until: '2026-11-21T16:00:00.000Z' }])
  })

  it('(3) "Drawing as a tab: live", its task NEED_ACTION (it answered his question, the result read): Closed', () => {
    const t = card('Drawing as a tab: live', ['t-drawing'])
    const task: AckTask = { id: 't-drawing', title: 'Drawing app plugin', phase: 'NEED_ACTION', user_status: { state: 'read' } }
    expect(ackOutcome(t, byId(task))).toEqual({ outcome: 'closed', waits: null })
  })

  it('(4) "Notes and artifacts in one tree: live", its task now in progress on another subject: Closed', () => {
    const t = card('Notes and artifacts in one tree: live', ['t-vp'])
    const task: AckTask = { id: 't-vp', title: 'Reflection v2 over the sessions a lead manages', phase: 'IN_PROGRESS', user_status: { state: 'working' } }
    expect(onSubject(t, task)).toBe(false)
    expect(ackOutcome(t, byId(task)).outcome).toBe('closed')
    // The same task back on this subject keeps it: Working.
    expect(ackOutcome(t, byId({ ...task, title: 'Notes and artifacts: move the old notes' })).outcome).toBe('working')
  })

  it('working outranks waiting; his reply on its way or a live letter waits; a COMPLETE or missing task holds nothing', () => {
    const t = card('Oven timer: fixed', ['t-a', 't-b', 't-gone'])
    const a: AckTask = { id: 't-a', title: 'Oven timer board', phase: 'WAITING', user_status: { state: 'waiting' } }
    const b: AckTask = { id: 't-b', title: 'Oven timer test', phase: 'IN_PROGRESS', user_status: { state: 'working' } }
    expect(ackOutcome(t, byId(a, b)).outcome).toBe('working')
    expect(ackOutcome(t, byId(a)).outcome).toBe('waiting')
    expect(ackOutcome(t, byId({ ...b, phase: 'COMPLETE' })).outcome).toBe('closed')
    expect(ackOutcome(t, new Map()).outcome).toBe('closed')
    const reply = { ...t, messages: [...t.messages, { id: 'tm-bbbbbbbbbbbb', at: AT, text: 'and the clock', via: 'chat' as const, delivery: { state: 'pending' as const, at: AT } }] }
    expect(ackOutcome(reply, new Map())).toEqual({ outcome: 'waiting', waits: { tasks: [], replies: true, letter: false } })
    expect(ackOutcome({ ...t, letter: { id: 'lt-1', task: 'lead-1', options: [] } }, new Map()).outcome).toBe('waiting')
  })

  it('what a task says of itself: its stored status, never its phase; an open task with none is in work', () => {
    expect(taskStands({ id: 'x', title: 'x', phase: 'IN_PROGRESS', user_status: { state: 'waiting' } })).toBe('waiting')
    expect(taskStands({ id: 'x', title: 'x', phase: 'IN_PROGRESS', user_status: { state: 'needs' } })).toBe('waiting')
    expect(taskStands({ id: 'x', title: 'x', phase: 'IN_PROGRESS', user_status: { state: 'read' } })).toBeNull()
    // Not started yet: its status says it waits.
    expect(taskStands({ id: 'x', title: 'x', phase: 'TODO', user_status: { state: 'waiting' } })).toBe('waiting')
    // No stored status (an older row): open, so in work, whatever its phase.
    expect(taskStands({ id: 'x', title: 'x', phase: 'TODO' })).toBe('working')
    expect(taskStands({ id: 'x', title: 'x', phase: 'WAITING' })).toBe('working')
    // A To read an older server stored as Waiting with toRead: its result is in.
    expect(taskStands({ id: 'x', title: 'x', phase: 'NEED_ACTION', user_status: { state: 'waiting', toRead: true } })).toBeNull()
    expect(taskStands({ id: 'x', title: 'x', phase: 'WAITING', user_status: { state: 'waiting', toRead: true, snoozed: true } })).toBe('waiting')
    expect(taskStands({ id: 'x', title: 'x', phase: 'NEED_ACTION', user_status: { state: 'read' } })).toBeNull()
    expect(taskStands({ id: 'x', title: 'x', phase: 'COMPLETE' })).toBeNull()
    expect(taskStands({ id: 'x', title: 'x', phase: 'COMPLETE', user_status: { state: 'working' } })).toBeNull()
  })

  it('subject words: plurals fold, status and surface words name nothing, CJK reads by pairs', () => {
    expect([...subjectWords('Avatars: version 6 is live on the web')]).toEqual(['avatar'])
    // CJK test data as escapes: "drawing tool", "drawing", "drawing: fixed", "drawing app".
    expect(subjectWords('\u753b\u56fe\u5de5\u5177').has('\u753b\u56fe')).toBe(true)
    expect(onSubject({ title: '\u753b\u56fe\uff1a\u4fee\u597d\u4e86' }, { id: 'x', title: '\u753b\u56fe app' })).toBe(true)
    expect(onSubject({ title: '\u753b\u56fe\uff1a\u4fee\u597d\u4e86' }, { id: 'x', title: '\u5408\u5e76\u7b14\u8bb0' })).toBe(false)
  })

  it('words that cannot tell keep the card: no subject word on a side, or no script in common', () => {
    const running: AckTask = { id: 't-1', title: 'Fix login flow', phase: 'IN_PROGRESS' }
    // Every word of the title is a status or surface word.
    expect(onSubject({ title: 'Phone app fix' }, running)).toBe(true)
    // A CJK title ("fix the login") over an English task.
    expect(onSubject({ title: '\u4fee\u590d\u767b\u5f55' }, running)).toBe(true)
    expect(ackOutcome(card('\u4fee\u590d\u767b\u5f55', ['t-1']), byId(running)).outcome).toBe('working')
  })

  it('the read says what holds a card he acknowledged, and the rule says why in a few words', () => {
    const held = card('Avatars: version 6 is live', ['t-avatars'], { state: 'pending', ackedAt: AT })
    const [t] = withAwaits([held], [{ id: 't-avatars', title: 'Agent avatars on web and phone', phase: 'IN_PROGRESS' }])
    expect(t.awaits?.tasks.map((x) => x.id)).toEqual(['t-avatars'])
    // Not placed yet: Acknowledged, whatever its work does.
    expect(threadGroupOf(t, false, Date.parse(AT))).toBe('known')
    expect(ackWhy(ackOutcome(held, byId({ id: 't-avatars', title: 'Agent avatars on web and phone', phase: 'IN_PROGRESS' }))))
      .toBe('\u201cAgent avatars on web and phone\u201d still at work on it')
    expect(ackWhy(ackOutcome(held, byId({ id: 't-avatars', title: 'Agent avatars on web and phone', phase: 'WAITING', user_status: { state: 'waiting' } }))))
      .toBe('waits on \u201cAgent avatars on web and phone\u201d')
    expect(ackWhy(ackOutcome(held, new Map()))).toBe('nothing on it was still open')
  })
})
