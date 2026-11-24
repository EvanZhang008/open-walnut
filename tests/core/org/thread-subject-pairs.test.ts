/**
 * A task's result on the subject of its lead's own thread is listed on the lead, and the lead's
 * thread waits behind it (2026-11-24, the threads inspection, item 4: his VP held cards naming six
 * tasks below it, and 21 unread results on those tasks never reached the VP where he had asked,
 * since only Needs you popped up). src/core/org/thread-subject-pairs.ts subjectPairs, `carry`.
 */
import { describe, expect, it } from 'vitest'
import { subjectPairs } from '../../../src/core/org/thread-subject-pairs.js'
import { askPointerView } from '../../../src/core/org/thread-task-ask.js'
import { carriedAbove, forHimInList, listedAbove, listedForHim, shownToHim } from '../../../src/core/org/thread-view.js'
import { threadCounts } from '../../../src/core/org/thread-groups.js'
import { ackKnown } from '../../../src/core/org/thread-ack.js'
import { emptyThreads, type OrgThread } from '../../../src/core/org/threads-model.js'
import type { Task } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()
const LEAD = { id: 'lead-1' }
const FIX = 't-fix'
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, phase: 'IN_PROGRESS', status: 'todo', ...over }) as Task
const byId = (...ts: Task[]) => new Map(ts.map((t) => [t.id, t] as const))

/** His request to the lead, handed to the task: the lead's card, in progress. */
const asked = (over: Partial<OrgThread> = {}): OrgThread => ({
  id: 'th-lead01', title: 'Threads panel flashes when opened on the lead page', titled: true, state: 'working', tasks: [FIX],
  messages: [{ id: 'tm-lead0101', at: iso(30), text: 'the panel flashes every time I open it', via: 'chat' }],
  createdAt: iso(30), updatedAt: iso(29), by: 'task:lead-1', ...over,
}) as OrgThread
/** Another request of his handed to the same task. */
const other = (over: Partial<OrgThread> = {}): OrgThread => asked({ id: 'th-lead02', title: 'Spring seed budget for the orchard rows', state: 'pending', ...over })
/** The task's own card: its result, written two hours ago, not read yet. */
const fixed = (over: Partial<OrgThread> = {}): OrgThread => ({
  id: 'th-fix001', title: 'Threads panel flash when opened: fixed and live', titled: true, state: 'answered',
  reply: 'The panel keeps its place while it opens; it is live. Video: /tmp/panel/flash.mp4', replyAt: iso(2),
  messages: [], opener: { text: 'Working on the flash.', at: iso(20), from: 'node' },
  createdAt: iso(20), updatedAt: iso(2), by: `task:${FIX}`, ...over,
}) as OrgThread

const pairs = (own: OrgThread[], files: OrgThread[], opts: { carry?: boolean; tasks?: Task[] } = {}) =>
  subjectPairs(LEAD, own, byId(...(opts.tasks ?? [task(FIX)])), { nowMs: NOW, carry: opts.carry ?? true, threadsOf: (id) => (id === FIX ? files : undefined) })
const listed = (x: OrgThread, carries: string) => ({ ...x, owner: { task_id: FIX, title: `Task ${FIX}` }, carries })

describe('a task\'s result on the subject of its lead\'s own thread', () => {
  it('is listed above the lead, and the lead\'s card waits behind it on every view', () => {
    const r = pairs([asked(), other()], [fixed()])
    expect(r.carried.map((c) => [c.thread.id, c.carries])).toEqual([['th-fix001', 'th-lead01']])
    expect(r.held.get('th-lead01')).toEqual({ task: FIX, title: `Task ${FIX}`, ask: fixed().title, via: 'thread', thread: 'th-fix001', result: true })
    expect(r.held.has('th-lead02')).toBe(false)
    // As the lead reads its threads: its card pending with the pointer, the other as stored.
    const view = askPointerView(LEAD, [asked(), other()], [task(FIX)], { nowMs: NOW, carry: true, threadsOf: (id) => (id === FIX ? [fixed()] : undefined) })
    expect(view.threads.map((t) => [t.id, t.state])).toEqual([['th-lead01', 'pending'], ['th-lead02', 'pending']])
    expect(view.threads[1].askedIn).toBeUndefined()
    expect(view.carried).toHaveLength(1)
    // The result as listed above the lead: in his sight there, counted as one from below, never Needs you.
    const above = listed(fixed(), 'th-lead01')
    expect(carriedAbove(above, undefined, NOW)).toBe(true)
    expect(listedAbove(above, undefined, NOW)).toBe(true)
    expect(listedForHim([...view.threads, above], NOW).map((t) => t.id)).toEqual(['th-fix001'])
    expect(forHimInList([above], NOW)).toHaveLength(1)
    expect(threadCounts([...view.threads, above], NOW)).toMatchObject({ shown: 1, needs: 0, below: 1 })
    // Without the mark, a result below is not listed above (only Needs you and a reply on its way are).
    expect(listedAbove({ ...above, carries: undefined }, undefined, NOW)).toBe(false)
  })

  it('a completed task\'s result is carried too: that is when most results come', () => {
    expect(pairs([asked()], [fixed()], { tasks: [task(FIX, { phase: 'COMPLETE', status: 'done' })] }).carried).toHaveLength(1)
  })

  it('nothing is carried with the experiment off, nor for a card the lead wrote after the result', () => {
    expect(pairs([asked()], [fixed()], { carry: false })).toEqual({ held: new Map(), carried: [] })
    // The lead's own card is the newer word: it shows, the older result stays on its task.
    const later = asked({ state: 'answered', reply: 'Fixed and live; the panel no longer moves.', replyAt: iso(1), updatedAt: iso(1) })
    expect(pairs([later], [fixed()])).toEqual({ held: new Map(), carried: [] })
  })

  it('words decide which card: a tie, fewer than three shared words, or one place pairs none', () => {
    const twin = asked({ id: 'th-lead03' })
    expect(pairs([asked(), twin], [fixed()]).carried).toEqual([])
    expect(pairs([asked({ title: 'Threads panel colour' })], [fixed()]).carried).toEqual([])
    // A four-character area name is three pairs in one place ("the model proxy: pay for one more
    // machine?" is not "the model proxy's usage table is live, one row per account").
    const area = asked({ title: '\u6a21\u578b\u4ee3\u7406\uff1a\u8981\u4e0d\u8981\u82b1\u94b1\u52a0\u4e00\u53f0\u673a\u5668' })
    expect(pairs([area], [fixed({ title: '\u6a21\u578b\u4ee3\u7406\u7528\u91cf\u8868\u5df2\u4e0a\u7ebf\uff0c\u6309\u8d26\u53f7\u4e00\u884c' })]).carried).toEqual([])
    // Not linked to the task: not read for it.
    expect(pairs([asked({ tasks: ['t-else'] })], [fixed()]).carried).toEqual([])
  })

  it('a card of the lead that asks him itself keeps its place: nothing is carried over it', () => {
    expect(pairs([asked({ state: 'needs', needsAt: iso(25) })], [fixed()]).carried).toEqual([])
  })

  it('once he read the result there, it leaves the lead and the lead\'s older card stays quiet, whatever state his Acknowledge left it in', () => {
    const acked = fixed({ closed: { how: 'acked', at: iso(1), by: 'human' } as never })
    // His Acknowledge as it is written with ack_means_known on (thread-ack.ts ackKnown): pending,
    // reactedAt and ackedAt; later closed by Walnut's placement, still pending.
    const known = ackKnown({ ...emptyThreads(FIX), threads: [fixed()] }, 'th-fix001', iso(1)).thread
    expect(known.state).toBe('pending')
    const placed = { ...known, closed: { how: 'acked', at: iso(0.8), by: 'walnut' } } as OrgThread
    expect(shownToHim(known, undefined, NOW)).toBe(false)
    // The lead's card set aside while the task works (his VP's four such cards on 11-24 were all pending).
    const older = asked({ state: 'pending', reply: 'Handed to the panel fix.', replyAt: iso(10), updatedAt: iso(10) })
    for (const x of [acked, known, placed]) {
      const r = pairs([older], [x])
      expect(r.carried).toEqual([])
      expect(r.held.get('th-lead01')).toMatchObject({ via: 'thread', thread: 'th-fix001', result: true, answered: true })
      // An overdue card in progress (shown as having no reply) waits too: the result was its reply.
      const overdue = asked()
      expect(shownToHim(overdue, undefined, NOW)).toBe(true)
      expect(pairs([overdue], [x]).held.get('th-lead01')).toMatchObject({ result: true, answered: true })
    }
    // The lead writing its card again after he read it is news: it shows.
    expect(pairs([{ ...older, replyAt: iso(0.5), updatedAt: iso(0.5) }], [acked]).held.size).toBe(0)
    // A result he never saw, closed by the node, holds nothing.
    expect(pairs([older], [fixed({ state: 'pending' })]).held.size).toBe(0)
  })

  it('a lead card with news of its own he has not read, or his newer word on it, is never hidden: the result is listed beside it', () => {
    // "mark the margins live + revert the status icon" (answered, unread) paired with the task's "status icon: reverted".
    const news = asked({ state: 'answered', reply: 'The margins are live; the icon goes back next.', replyAt: iso(10), updatedAt: iso(10) })
    expect(shownToHim(news, undefined, NOW)).toBe(true)
    const r = pairs([news], [fixed()])
    expect(r.carried.map((c) => c.carries)).toEqual(['th-lead01'])
    expect(r.held.size).toBe(0)
    // Nor after he read the result: the margins stay on his card.
    expect(pairs([news], [fixed({ closed: { how: 'acked', at: iso(1), by: 'human' } as never })]).held.size).toBe(0)
    // His word on the lead card after the task's result is a new ask: it stays.
    const asksAgain = asked({ messages: [{ id: 'tm-lead0102', at: iso(1), text: 'it still flashes on the phone', via: 'chat' }] as never })
    expect(pairs([asksAgain], [fixed()]).held.size).toBe(0)
    expect(pairs([asksAgain], [fixed()]).carried).toHaveLength(1)
  })

  it('a task\'s ask outranks its result for the same card, and a result after his answer there is carried', () => {
    const card = asked({ state: 'answered', reply: 'The task is on it.', replyAt: iso(3), updatedAt: iso(3) })
    const askHim = fixed({ id: 'th-fix002', title: 'Threads panel flash when opened: which fix do you want', state: 'needs', needsAt: iso(4), reply: 'Two fixes are possible.', replyAt: iso(4) })
    const r = pairs([card], [fixed(), askHim], { tasks: [task(FIX, { user_status: { state: 'needs', source: 'thread', ask: 'Answer the thread' } as never })] })
    expect(r.held.get('th-lead01')).toEqual({ task: FIX, title: `Task ${FIX}`, ask: askHim.title, via: 'thread', thread: 'th-fix002' })
    expect(r.carried.map((c) => c.thread.id)).toEqual(['th-fix001'])
    // He answered the task's ask there; its result came after: the result is news, carried.
    const answeredThen = fixed({ needsAt: iso(6), messages: [{ id: 'tm-fix00201', at: iso(5), text: 'take the first fix', via: 'thread' }] as never })
    expect(pairs([asked()], [answeredThen]).carried).toHaveLength(1)
  })

  it('a moved thread of the task, or one closed by the node with nothing for him, is never carried', () => {
    expect(pairs([asked()], [fixed({ movedTo: { task: 't-else', at: iso(1) } as never })]).carried).toEqual([])
    expect(pairs([asked()], [fixed({ closed: { how: 'done', at: iso(1), by: `task:${FIX}` } as never })]).carried).toEqual([])
  })
})
