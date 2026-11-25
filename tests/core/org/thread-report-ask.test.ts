/**
 * A task's own ask lives on its thread (src/core/org/thread-report-ask.ts; 2026-11-20, the user, on
 * a task with Threads on whose only thread read "Done" in the Threads pane while the chat above held
 * the task's ask card waiting for him: "the same thing shows twice, one says Done and the other
 * waits for him").
 *
 * The placement rule (the thread the status answer names, else the one his newest message was filed
 * to, else the only open thread, else none), once per decision; the read (the thread reads needs
 * with the ask's id while the task's Action needed item asks it, and its stored state again once it
 * asks no more or asks another decision); and the guard built from that case's shape, in invented
 * words: an answered thread holding his newest message, then a report ask written after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-report-ask'))

import { setOneCard } from '../../../src/core/org/one-card.js'
import { setReplyTag } from '../../../src/core/org/reply-card-switch.js'
import { askedOnThreads, askThreadFor, needsThreadOf, placeAsk, reportAskOf, taskAskNow, withHeldAsk, withoutOwnAsk } from '../../../src/core/org/thread-report-ask.js'
import { decisionsUpPart } from '../../../src/core/sessions/status-thread-asked.js'
import { readThreadLines, threadQuestionBlock, settleStateFromThreads, planThreadWrites } from '../../../src/core/sessions/status-threads.js'
import { readStatusReport } from '../../../src/core/session-hooks/builtins.js'
import { threadOverdue } from '../../../src/core/org/thread-view.js'
import { threadCounts } from '../../../src/core/org/thread-groups.js'
import { applyActions } from '../../../src/core/action-needed.js'
import { deriveUserStatus, type StatusReport, type UserStatus } from '../../../src/core/user-status.js'
import { normalizeThreads, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-20T02:40:00Z')
const T = (min: number) => new Date(Date.parse('2026-11-20T02:00:00Z') + min * 60_000).toISOString()

function thread(id: string, over: Partial<OrgThread> = {}): OrgThread {
  return {
    id, title: `Subject ${id}`, state: 'answered', createdAt: T(0), updatedAt: T(1),
    messages: [{ id: `tm-${id.slice(3)}`, at: T(0), text: 'A request', via: 'chat' }], ...over,
  }
}
const file = (...threads: OrgThread[]): ThreadsFile => ({ version: 1, taskId: 'task-a', threads })

/** A task with Threads on whose status asks `ask` (its Action needed item, as the sync derives it). */
function asking(id: string | null, ask = 'Pick the seed tray size', over: Partial<UserStatus> = {}) {
  const user_status: UserStatus = id
    ? { state: 'needs', source: 'session', ask, decision: { id, key: id }, actions: [{ kind: 'ask', id, summary: ask }], ...over }
    : { state: 'working', ...over }
  return { id: 'task-a', phase: 'NEED_ACTION' as const, status: 'todo' as const, threads_on: true, user_status }
}

// The held ask is the one-card experiment's (threads_one_card): on for this file, off in its own case.
beforeEach(() => setOneCard(true))
afterEach(() => { setOneCard(false); setReplyTag(false) })

describe('with the one-card setting off (threads_one_card)', () => {
  it('a placed ask is kept but never read: the thread reads as stored, and the question asks for no thread', () => {
    setOneCard(false)
    const placed = placeAsk(file(thread('th-aaaaaa01', { reply: 'The plan is written.' })), { id: 'ask-aaaa01', ask: 'Pick the seed tray size' }, T(10)).threads
    const [t] = withHeldAsk(asking('ask-aaaa01'), placed)
    expect(t).toMatchObject({ state: 'answered', reply: 'The plan is written.' })
    expect(t.heldAsk).toBeUndefined()
    expect((t as OrgThread).askId).toBeUndefined()
    const { block } = threadQuestionBlock([{ id: 'th-aaaaaa01', title: 'Seed trays', state: 'answered' }])
    expect(block).not.toContain('FOR_USER_ASK_THREAD')
    expect(block).toContain('What needs the user\'s decision stays on FOR_USER_ASK')
  })
})

describe('which thread an ask goes on', () => {
  it('the thread the status answer names', () => {
    const threads = [thread('th-aaaaaa01'), thread('th-aaaaaa02', { messages: [{ id: 'tm-aaaaaa02', at: T(9), text: 'Newer', via: 'chat' }] })]
    expect(askThreadFor(threads, 'th-aaaaaa01')).toBe('th-aaaaaa01')
  })

  it('else the open thread his newest message was filed to', () => {
    const threads = [thread('th-aaaaaa01'), thread('th-aaaaaa02', { messages: [{ id: 'tm-aaaaaa02', at: T(9), text: 'Newer', via: 'chat' }] })]
    expect(askThreadFor(threads)).toBe('th-aaaaaa02')
    // A name that cannot take it (closed) falls to the rule.
    expect(askThreadFor([...threads, thread('th-aaaaaa03', { closed: { how: 'acked', at: T(2), by: 'human' } })], 'th-aaaaaa03')).toBe('th-aaaaaa02')
  })

  it('else the only open thread', () => {
    // His newest message is in a closed thread: not that one, the only open one.
    const threads = [thread('th-aaaaaa01'), thread('th-aaaaaa02', { closed: { how: 'acked', at: T(9), by: 'human' }, messages: [{ id: 'tm-aaaaaa02', at: T(9), text: 'Newer', via: 'chat' }] })]
    expect(askThreadFor(threads)).toBe('th-aaaaaa01')
    const opened = thread('th-aaaaaa04', { messages: [], opener: { text: 'I follow the rollout', at: T(3), from: 'node', by: 'task:task-a' } })
    expect(askThreadFor([opened])).toBe('th-aaaaaa04')
  })

  it('else none: the ask stays a plain ask', () => {
    const a = thread('th-aaaaaa01', { messages: [], opener: { text: 'One', at: T(3), from: 'node', by: 'task:task-a' } })
    const b = thread('th-aaaaaa02', { messages: [], opener: { text: 'Two', at: T(4), from: 'node', by: 'task:task-a' } })
    expect(askThreadFor([a, b])).toBeNull()
    expect(askThreadFor([])).toBeNull()
    // A thread already waiting on him for another ask never takes this one.
    expect(askThreadFor([thread('th-aaaaaa05', { state: 'needs' })])).toBeNull()
    const f = file(a, b)
    expect(placeAsk(f, { id: 'ask-aaaa01', ask: 'Pick one' }, T(10))).toBe(f)
  })
})

describe('the place, once per decision', () => {
  const ask = { id: 'ask-aaaa01', ask: 'Pick the seed tray size' }

  it('places once; the same decision again changes nothing', () => {
    const f = file(thread('th-aaaaaa01'))
    const once = placeAsk(f, ask, T(10))
    expect(once.threads[0].reportAsk).toEqual({ id: 'ask-aaaa01', at: T(10), ask: 'Pick the seed tray size' })
    // No clock moves: nothing he reads changed yet.
    expect(once.threads[0].updatedAt).toBe(T(1))
    expect(placeAsk(once, ask, T(11))).toBe(once)
    // A closed thread that held it keeps it closed: the ask is not put on another one.
    const closed = { ...once, threads: [{ ...once.threads[0], closed: { how: 'acked' as const, at: T(12), by: 'human' as const } }, thread('th-aaaaaa02')] }
    expect(placeAsk(closed, ask, T(13))).toBe(closed)
  })

  it('a different decision takes the place, and the older one goes', () => {
    const f = placeAsk(file(thread('th-aaaaaa01'), thread('th-aaaaaa02', { messages: [{ id: 'tm-x', at: T(9), text: 'Newer', via: 'chat' }] })), ask, T(10))
    expect(f.threads.find((t) => t.reportAsk)?.id).toBe('th-aaaaaa02')
    const next = placeAsk(f, { id: 'ask-bbbb02', ask: 'Order compost now?' }, T(20), 'th-aaaaaa01')
    expect(next.threads.map((t) => t.reportAsk?.id)).toEqual(['ask-bbbb02', undefined])
  })

  it('a report that asks nothing takes every place off; asked again, the rule places it again', () => {
    const f = placeAsk(file(thread('th-aaaaaa01')), ask, T(10))
    const cleared = placeAsk(f, null, T(20))
    expect(cleared.threads[0].reportAsk).toBeUndefined()
    expect(placeAsk(cleared, null, T(21))).toBe(cleared)
    expect(placeAsk(cleared, ask, T(30)).threads[0].reportAsk).toMatchObject({ id: 'ask-aaaa01', at: T(30) })
  })

  it('the task naming another thread moves it there', () => {
    const f = placeAsk(file(thread('th-aaaaaa01'), thread('th-aaaaaa02')), ask, T(10), 'th-aaaaaa01')
    const moved = placeAsk(f, ask, T(11), 'th-aaaaaa02')
    expect(moved.threads.map((t) => t.reportAsk?.id)).toEqual([undefined, 'ask-aaaa01'])
  })

  it('a stored place survives a read, and a broken one is dropped (an older build keeps it unread)', () => {
    const f = placeAsk(file(thread('th-aaaaaa01')), ask, T(10))
    expect(normalizeThreads(JSON.parse(JSON.stringify(f)), 'task-a').threads[0].reportAsk?.id).toBe('ask-aaaa01')
    const broken = { ...f, threads: [{ ...f.threads[0], reportAsk: { id: 7 } }] }
    expect(normalizeThreads(broken, 'task-a').threads[0].reportAsk).toBeUndefined()
  })

  it('only a real ask with its decision id is placed: none for another task\'s, or a kindless one', () => {
    const r: StatusReport = { state: 'needs', ask: 'Pick the seed tray size', ask_id: 'ask-aaaa01', at: T(10) }
    expect(reportAskOf(r)).toEqual({ id: 'ask-aaaa01', ask: 'Pick the seed tray size' })
    expect(reportAskOf({ ...r, same_as: 'task-b' })).toBeNull()
    expect(reportAskOf({ ...r, kindless_ask: true })).toBeNull()
    expect(reportAskOf({ ...r, ask_id: undefined })).toBeNull()
    expect(reportAskOf({ state: 'waiting', at: T(10) })).toBeNull()
  })
})

describe('the read: needs while the task asks it', () => {
  const placed = placeAsk(file(thread('th-aaaaaa01', { reply: 'The plan is written.' })), { id: 'ask-aaaa01', ask: 'Pick the seed tray size' }, T(10)).threads

  it('reads needs with the ask id, its summary leading with the question', () => {
    const [t] = withHeldAsk(asking('ask-aaaa01'), placed)
    expect(t).toMatchObject({ state: 'needs', askId: 'ask-aaaa01', reply: 'Pick the seed tray size\n\nThe plan is written.' })
    expect(t.heldAsk).toEqual({ id: 'ask-aaaa01', ask: 'Pick the seed tray size', reply: 'The plan is written.', was: 'answered' })
    // The task's status counts it: the thread's needs count leaves it out, and it keeps no overdue clock of its own.
    expect(threadCounts([t], NOW)).toMatchObject({ shown: 1, needs: 0 })
    expect(threadOverdue(t, NOW + 3 * 24 * 3600_000)).toBeNull()
    // Read above its owner (threads_pop_up), it is no thread waiting below: the owner's status carries it up.
    expect(threadCounts([{ ...t, owner: { task_id: 'task-a', title: 'A' } }], NOW).below).toBeUndefined()
  })

  // 2026-11-25, a live walk: the thread's stored ask of an older decision stayed beside the held
  // ask's new choices and id, so the card asked the old question over the new buttons.
  it('while it shows the held ask, its ask is that ask\'s words too; nothing stored changes, and a thread not holding it keeps its own', () => {
    const older = placed.map((t) => ({ ...t, ask: 'Clay pots or plastic trays?' }))
    const stored = JSON.stringify(older)
    const [t] = withHeldAsk(asking('ask-aaaa01'), older)
    expect(t).toMatchObject({ state: 'needs', askId: 'ask-aaaa01', ask: 'Pick the seed tray size' })
    expect(JSON.stringify(older)).toBe(stored)
    expect(withHeldAsk(asking(null), older)[0].ask).toBe('Clay pots or plastic trays?')
    expect(withHeldAsk(asking('ask-aaaa01'), [thread('th-aaaaaa02', { ask: 'Clay pots or plastic trays?' })])[0].ask).toBe('Clay pots or plastic trays?')
  })

  it('the next report without the ask: the thread reads its stored state again', () => {
    const [t] = withHeldAsk(asking(null), placed)
    expect(t.state).toBe('answered')
    expect(t.heldAsk).toBeUndefined()
    expect(t.reply).toBe('The plan is written.')
  })

  // 2026-11-20, the user, on a card he had answered that stayed in Needs you: "why this even keep
  // showing after I replied?". His reply on the thread after the task asked is his answer, waiting
  // for the task to read it: the thread reads as stored until the task asks again.
  it('his reply on the thread after the ask: not held, until the task asks again', () => {
    const asked = asking('ask-aaaa01', 'Pick the seed tray size', { at: T(10) })
    const reply = { id: 'tm-reply01', at: T(12), text: 'The 72-cell ones', via: 'follow-up' as const, delivery: { state: 'claimed' as const, at: T(12) } }
    const replied = placed.map((t) => ({ ...t, state: 'working' as const, messages: [...t.messages, reply] }))
    const [t] = withHeldAsk(asked, replied)
    expect(t.state).toBe('working')
    expect(t.heldAsk).toBeUndefined()
    // An agent's reply on his behalf, or one that never went, is not his answer.
    for (const delivery of [{ state: 'claimed' as const, at: T(12), by: 'task:task-b' }, { state: 'dropped' as const, at: T(13) }]) {
      expect(withHeldAsk(asked, placed.map((x) => ({ ...x, messages: [...x.messages, { ...reply, delivery }] })))[0].state).toBe('needs')
    }
    // His word before the ask was written is no answer to it.
    expect(withHeldAsk(asking('ask-aaaa01', 'Pick the seed tray size', { at: T(14) }), replied)[0].state).toBe('needs')
  })

  it('a different decision: not held', () => {
    expect(withHeldAsk(asking('ask-bbbb02'), placed)[0].state).toBe('answered')
  })

  it('an ask that sleeps, went to another task or was answered for him: not held', () => {
    const snoozed = asking('ask-aaaa01')
    snoozed.user_status.actions = [{ kind: 'ask', id: 'ask-aaaa01', summary: 'Pick', snoozedUntil: T(600) }]
    expect(withHeldAsk(snoozed, placed)[0].state).toBe('answered')
    expect(withHeldAsk(asking('ask-aaaa01', 'Pick', { sameAsk: { id: 'task-b' } as never }), placed)[0].state).toBe('answered')
    expect(withHeldAsk(asking('ask-aaaa01', 'Pick', { answeredFor: { by: 'x', byTitle: 'Lead', at: T(5), ask: 'Pick' } }), placed)[0].state).toBe('answered')
  })

  it('a thread he snoozed reads as stored, in its Snoozed section', () => {
    const snoozed = [{ ...placed[0], snoozed: { until: new Date(Date.now() + 3600_000).toISOString(), at: new Date().toISOString(), by: 'human' as const } }]
    expect(withHeldAsk(asking('ask-aaaa01'), snoozed)[0].state).toBe('answered')
  })

  it('a closed thread, a finished task, or a task without Threads: not held', () => {
    expect(withHeldAsk(asking('ask-aaaa01'), [{ ...placed[0], closed: { how: 'acked', at: T(12), by: 'human' } }])[0].state).toBe('answered')
    expect(withHeldAsk({ ...asking('ask-aaaa01'), phase: 'COMPLETE' }, placed)[0].state).toBe('answered')
    expect(withHeldAsk({ ...asking('ask-aaaa01'), threads_on: false }, placed)[0].state).toBe('answered')
    expect(withHeldAsk({ ...asking('ask-aaaa01'), org_role: 'lead' }, placed)[0].state).toBe('answered')
  })

  it('the ask its status shows is the one with no Action needed list yet too (an older status)', () => {
    const s = asking('ask-aaaa01')
    delete s.user_status.actions
    expect(taskAskNow(s)).toEqual({ id: 'ask-aaaa01', ask: 'Pick the seed tray size' })
  })
})

describe('the question names the thread its ask is about', () => {
  const open = [{ id: 'th-aaaaaa01', title: 'Seed trays', state: 'answered' as const }, { id: 'th-aaaaaa02', title: 'Compost', state: 'working' as const }]

  it('asks for it in one short sentence, and reads it back by its ref', () => {
    const { block, refs } = threadQuestionBlock(open)
    expect(block).toContain('FOR_USER_ASK_THREAD: <ref>')
    const answer = ['FOR_USER_STATE: needs-you', 'FOR_USER_ASK: Pick the seed tray size?', 'FOR_USER_ASK_THREAD: t2', 'FOR_USER_ASK_OWN: spending: it buys trays', 'FOR_USER_THREAD: t1 | answered | Sizes compared.'].join('\n')
    expect(readThreadLines(answer, refs).ask_thread).toBe('th-aaaaaa02')
    // The ask's own words end before the line (FOR_USER_ASK_THREAD is a label of its own).
    expect(readStatusReport(answer)?.ask).toBe('Pick the seed tray size?')
    expect(readThreadLines('FOR_USER_ASK_THREAD: t9', refs).ask_thread).toBeUndefined()
    expect(readThreadLines('FOR_USER_ASK_THREAD: none', refs).ask_thread).toBeUndefined()
    // The ref with its title after it, as a session may write it.
    expect(readThreadLines('FOR_USER_ASK_THREAD: t1 "Seed trays"', refs).ask_thread).toBe('th-aaaaaa01')
    expect(readThreadLines('FOR_USER_ASK_THREAD: **t2** (Compost)', refs).ask_thread).toBe('th-aaaaaa02')
  })
})

/**
 * The guard, from the case that showed it (invented words): an interview-practice task, Threads on,
 * one thread "System design practice 2" answered by the task, known through his second message, his
 * newest message filed there; then a report asking him to design the tables and API, written right
 * after the thread's reply. One card: the thread reads Needs you with the ask, nothing reads Done,
 * and the ask counts once.
 */
describe('the case: a thread reading Done while its task waits on him', () => {
  const ASK = 'Design the donation record tables and the API for them, then send them here'
  const ID = 'ask-intv01'
  const before: OrgThread = {
    id: 'th-47aa12bb', title: 'System design practice 2', titled: true, state: 'answered',
    reply: 'Walked through the donation flow; next step: you design the tables and API', replyAt: '2026-11-20T02:33:50.000Z', reply_by: 'task:task-a',
    createdAt: '2026-11-20T01:40:00.000Z', updatedAt: '2026-11-20T02:33:50.000Z',
    messages: [
      { id: 'tm-aa000001', at: '2026-11-20T01:40:00.000Z', text: 'Let us do system design practice', via: 'chat', answer: { text: 'Sure, the topic is a donation site.', at: '2026-11-20T01:41:00.000Z' } },
      { id: 'tm-aa000002', at: '2026-11-20T02:00:00.000Z', text: 'What should the flow be?', via: 'chat', answer: { text: 'Pledge, pay, receipt.', at: '2026-11-20T02:01:00.000Z' } },
      { id: 'tm-aa000003', at: '2026-11-20T02:33:00.000Z', text: 'Ok what next', via: 'chat' },
    ],
    known: { through: 'tm-aa000002', by: 'task:task-a', at: '2026-11-20T02:02:00.000Z' },
  }

  it('the status answer places the ask on that thread, and the thread reads Needs you with it', () => {
    const { refs } = threadQuestionBlock([before])
    const answer = ['FOR_USER_STATE: needs-you', `FOR_USER_ASK: ${ASK}`, 'FOR_USER_ASK_OWN: user_own: it is his own practice design', 'FOR_USER_THREAD: t1 | answered | Walked through the donation flow; next step: you design the tables and API'].join('\n')
    const read = readStatusReport(answer)!
    const { threads, threads_new, ask_thread, ...report } = settleStateFromThreads({ ...read, ...readThreadLines(answer, refs) })
    const stored: StatusReport = { ...report, ask_id: ID, at: '2026-11-20T02:34:00.000Z' }
    // The same write the status answer makes: its lines first, then the ask on its thread.
    const { writes } = planThreadWrites(file(before), threads ?? [], threads_new ?? [])
    expect(writes).toEqual([])
    const ask = reportAskOf(stored)!
    const placed = placeAsk(file(before), ask, '2026-11-20T02:34:00.000Z', ask_thread)
    expect(placed.threads[0].reportAsk?.id).toBe(ID)

    // The task's status as the sync derives it, its counts read from the threads as he reads them.
    const derive = (threadsNow: OrgThread[]) => applyActions(deriveUserStatus({
      phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: stored, threads: threadCounts(threadsNow, NOW),
    }, NOW), [], undefined)
    const first = derive(placed.threads)
    const task = { id: 'task-a', phase: 'NEED_ACTION' as const, status: 'todo' as const, threads_on: true, user_status: first }
    const shown = withHeldAsk(task, placed.threads)
    const status = derive(shown)

    // The thread: Needs you with the ask, never Done (answered), the same decision id.
    expect(shown[0]).toMatchObject({ state: 'needs', askId: ID, heldAsk: { id: ID, ask: ASK } })
    expect(shown[0].reply?.startsWith(ASK)).toBe(true)
    // The task: one ask, its own (never a second "Answer the thread"), its one Action needed item
    // carrying the id the thread holds: one decision, one id, counted once.
    expect(status).toMatchObject({ state: 'needs', source: 'session' })
    expect(status.actions?.filter((i) => i.kind === 'ask').map((i) => i.id)).toEqual([ID])
    expect(threadCounts(shown, NOW).needs).toBe(0)
    expect(new Set(shown.filter((t) => t.heldAsk).map((t) => t.heldAsk!.id))).toEqual(new Set(status.actions!.map((i) => i.id)))

    // His answer: the turn runs, the status asks no more, the thread reads what its lines say.
    const after = withHeldAsk({ ...task, user_status: { state: 'working' } }, placed.threads)
    expect(after[0].state).toBe('answered')
  })
})

// 2026-11-25: a card line put a decision on a thread (stored needs), the status answer named the
// same decision as the task's ask, and the place rule put it on the other open thread.
describe('a decision a thread already carries in needs is that thread\'s (threads_reply_tag)', () => {
  const ASK = 'Raised bed or planting straight in the ground for the tomatoes?'
  const needs = thread('th-aaaaaa01', { state: 'needs', ask: ASK, reply: 'Pick one; the raised bed warms sooner.', options: [{ label: 'Raised bed', recommended: true }, { label: 'In the ground' }] })
  const other = thread('th-aaaaaa02', { title: 'Compost heap', messages: [{ id: 'tm-aaaaaa02', at: T(-5), text: 'When do I start it?', via: 'chat' }] })
  const OPTIONS = [{ label: 'Raised bed', recommended: true }, { label: 'In the ground' }]
  /** The status answer's ask: the same decision reworded, offering the same choices. */
  const reworded = { id: 'ask-aaaa01', ask: 'Pick where the tomatoes go: in a raised bed, or planted straight in the ground?', options: OPTIONS }
  /** The same as the threads compare it (its choices' words). */
  const words = { ...reworded, options: OPTIONS.map((o) => o.label) }

  it('off: the ask is placed on the other open thread, as today', () => {
    expect(needsThreadOf([needs, other], words)).toBeNull()
    expect(placeAsk(file(needs, other), reworded, T(10)).threads.find((t) => t.reportAsk)?.id).toBe('th-aaaaaa02')
    expect(askedOnThreads({ threads_on: true }, [needs, other])).toEqual([])
  })

  it('on: the same question reworded with the same choices finds the thread, and no place is made beside it', () => {
    setReplyTag(true)
    expect(needsThreadOf([needs, other], words)?.id).toBe('th-aaaaaa01')
    const f = file(needs, other)
    expect(placeAsk(f, reworded, T(10))).toBe(f)
    // A place an earlier answer made for it goes.
    const placed = file(needs, { ...other, reportAsk: { id: 'ask-aaaa01', at: T(8) } })
    expect(placeAsk(placed, reworded, T(10)).threads.some((t) => t.reportAsk)).toBe(false)
  })

  it('on: the decision id the thread stores decides, whatever the words', () => {
    setReplyTag(true)
    const named = { ...needs, askId: 'ask-aaaa01' }
    expect(needsThreadOf([named, other], { id: 'ask-aaaa01', ask: 'Where do the tomatoes go?' })?.id).toBe('th-aaaaaa01')
    // Within one task two ids are not yet two decisions (each place mints its own until linked): the words rule still reads.
    expect(needsThreadOf([named, other], { id: 'ask-bbbb02', ask: ASK })?.id).toBe('th-aaaaaa01')
    expect(needsThreadOf([named, other], { id: 'ask-bbbb02', ask: 'Where do the tomatoes go?' })).toBeNull()
    // A thread's own stamp (threads_pop_up) is no decision id: the words decide.
    expect(needsThreadOf([{ ...needs, askId: 'ak-0123456789' }, other], { id: 'ask-bbbb02', ask: ASK })?.id).toBe('th-aaaaaa01')
  })

  it('on: shared words alone are no evidence (review 2026-11-25, B2): reworded with no choices, or two decisions of one subject', () => {
    setReplyTag(true)
    expect(needsThreadOf([needs, other], { id: 'ask-aaaa01', ask: reworded.ask })).toBeNull()
    const PAIRS: Array<[string, string]> = [
      ['Should the orchard fence be two metres tall or three?', 'Should the orchard fence gate be painted green or brown?'],
      ['Turn the sync toggle on by default?', 'Shorten the sync toggle description?'],
      // Chinese: turn the sync toggle on by default? / shorten the sync toggle's description?
      ['\u8981\u4e0d\u8981\u628a\u540c\u6b65\u5f00\u5173\u9ed8\u8ba4\u6253\u5f00\uff1f', '\u8981\u4e0d\u8981\u628a\u540c\u6b65\u5f00\u5173\u7684\u8bf4\u660e\u6539\u77ed\uff1f'],
    ]
    for (const [a, b] of PAIRS) {
      expect(needsThreadOf([thread('th-aaaaaa03', { state: 'needs', ask: a })], { id: 'ask-cccc03', ask: b }), b).toBeNull()
      // Yes and no are no choices of their own.
      expect(needsThreadOf([thread('th-aaaaaa03', { state: 'needs', ask: a, options: [{ label: 'Yes' }, { label: 'No' }] })], { id: 'ask-cccc03', ask: b, options: ['Yes', 'No'] }), b).toBeNull()
    }
  })

  it('on: another decision is still placed by the rule (another target, another number, a "not")', () => {
    setReplyTag(true)
    for (const ask of ['Order 40 or 60 bags of soil for the compost heap?', 'Raised bed or planting straight in the ground for the beans?', 'Do not use a raised bed for the tomatoes?']) {
      expect(needsThreadOf([needs, other], { ask, options: words.options }), ask).toBeNull()
      expect(placeAsk(file(needs, other), { id: 'ask-bbbb02', ask }, T(10)).threads.find((t) => t.reportAsk)?.id, ask).toBe('th-aaaaaa02')
    }
  })

  it('on: only an open thread that waits on him for its own decision counts', () => {
    setReplyTag(true)
    expect(needsThreadOf([{ ...needs, state: 'answered' }], { ask: ASK })).toBeNull()
    expect(needsThreadOf([{ ...needs, closed: { how: 'acked', at: T(2), by: 'human' } }], { ask: ASK })).toBeNull()
    expect(needsThreadOf([{ ...needs, askOwner: { task: 'task-b', at: T(2), by: 'task:task-a' } }], { ask: ASK })).toBeNull()
    // With no ask of its own, its summary's first sentence is what it asks.
    expect(needsThreadOf([{ ...needs, ask: undefined, reply: `${ASK} I recommend the raised bed.` }], { ask: ASK })?.id).toBe('th-aaaaaa01')
  })

  it('the report without its ask keeps its state and words, and every field of the ask goes', () => {
    const report: StatusReport = { state: 'needs', at: T(10), now: 'The choice is laid out.', next: 'He picks.', ask: ASK, ask_kind: 'single', ask_options: [{ label: 'Raised bed' }, { label: 'In the ground' }], ask_own: { kind: 'spending', why: 'it costs twice the budget' }, ask_id: 'ask-aaaa01', ask_rev: 1, ask_new: 'a new price', ask_said: true, ask_since: T(5), needs_since: T(5) }
    expect(withoutOwnAsk(report)).toEqual({ state: 'needs', at: T(10), now: 'The choice is laid out.', next: 'He picks.', needs_since: T(5) })
  })

  it('the question names the decisions that are up, for a task only, at most three, each cut, with the decision id a card stores', () => {
    setReplyTag(true)
    expect(askedOnThreads({ threads_on: true }, [needs, other])).toEqual([{ ask: ASK }])
    expect(askedOnThreads({ threads_on: true }, [{ ...needs, askId: 'ask-aaaa01' }, other])).toEqual([{ ask: ASK, id: 'ask-aaaa01' }])
    expect(askedOnThreads({ threads_on: true, org_role: 'lead' }, [needs, other])).toEqual([])
    const TAIL = ' A decision up there stays out of FOR_USER_ASK, which is for another decision only (your earlier ask too, once a card asks it); named there anyway, FOR_USER_ASK_ID is that card\'s id. FOR_USER_STATE is needs-you while one waits on him.'
    expect(decisionsUpPart([])).toBe('')
    expect(decisionsUpPart([{ ask: ASK }])).toBe(`\nYour threads' cards already ask him: "${ASK}".${TAIL}`)
    // Review 2026-11-25, N2: the card's id, so the same decision said again in other words is joined by it.
    expect(decisionsUpPart([{ ask: ASK, id: 'ask-aaaa01' }])).toBe(`\nYour threads' cards already ask him: "${ASK}" (ask-aaaa01).${TAIL}`)
    const many = decisionsUpPart(['One?', 'Two?', 'Three?', 'Four?', 'x'.repeat(400)].map((ask) => ({ ask })))
    expect(many).toContain('"One?"; "Two?"; "Three?".')
    expect(many).not.toContain('Four?')
    expect(Buffer.byteLength(decisionsUpPart([{ ask: 'x'.repeat(400), id: 'ask-aaaaaaaaaaaa' }]))).toBeLessThanOrEqual(275 + 160 + 19)
  })

  it('N2: a status answer naming a card\'s id asks no decision of its own, whatever its words; with no id the strict rule stays', () => {
    setReplyTag(true)
    const card = thread('th-aaaaaa05', { state: 'needs', ask: 'Wood or plastic for the compost bin?', askId: 'ask-b1ab1a' })
    expect(needsThreadOf([card], { id: 'ask-b1ab1a', ask: 'Should the compost bin be wood or plastic?' })?.id).toBe('th-aaaaaa05')
    expect(needsThreadOf([card], { ask: 'Should the compost bin be wood or plastic?' })).toBeNull()
  })
})
