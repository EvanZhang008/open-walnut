/**
 * A Board choice held by a thread (experiment brief_off, src/core/org/choice-thread-model.ts): one
 * thread per choice whoever syncs it, its options and recommended one kept, a thread that says how
 * its choice ended, a field a hand edit cannot break, and the group rule his Threads and a Board
 * card read (thread-view.ts threadGroupOf / groupThreads / threadStateOf).
 */
import { describe, expect, it } from 'vitest'
import { choiceOutcome, choiceThreadId, holdsChoice, normalizeThreadChoice, openChoiceThread, settleChoiceThread } from '../../../src/core/org/choice-thread-model.js'
import { emptyThreads, normalizeThreads, THREAD_ID_RE, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { groupThreads, threadGroupOf, threadStateOf } from '../../../src/core/org/thread-groups.js'

const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 9, m)).toISOString()
const NOW = Date.parse(at(30))
const input = (id = 'plant-when') => ({
  choice: {
    board: 'task-lead', id, task: 'task-beds', title: 'Plant the beds this week or next?',
    options: [{ value: 'now', label: 'This week' }, { value: 'later', label: 'Next week' }], recommended: 'later',
  },
  by: 'task:task-lead' as const, at: at(1),
})
const open = (file: ThreadsFile = emptyThreads('task-lead')) => openChoiceThread(file, input())

describe('one thread per Board choice', () => {
  it('opens a needs thread with the title, its options and the recommended one, under an id of the Board and the choice', () => {
    const r = open()
    expect(r.changed).toBe('opened')
    expect(r.thread.id).toBe(choiceThreadId('task-lead', 'plant-when'))
    expect(r.thread.id).toMatch(THREAD_ID_RE)
    expect(r.thread).toMatchObject({
      state: 'needs', title: 'Plant the beds this week or next?', tasks: ['task-beds'],
      choice: { board: 'task-lead', id: 'plant-when', task: 'task-beds', recommended: 'later', options: [{ value: 'now', label: 'This week' }, { value: 'later', label: 'Next week' }] },
    })
    expect(holdsChoice(r.thread)).toBe(true)
  })

  it('run again, it changes nothing; another choice has another thread', () => {
    const first = open()
    expect(openChoiceThread(first.file, input()).changed).toBeNull()
    const other = openChoiceThread(first.file, input('water-how'))
    expect(other.changed).toBe('opened')
    expect(other.file.threads).toHaveLength(2)
    expect(choiceThreadId('task-lead', 'water-how')).not.toBe(choiceThreadId('task-other', 'water-how'))
  })

  it('survives the store\'s read; a broken field is dropped and the thread reads as an ordinary one', () => {
    const file = normalizeThreads(JSON.parse(JSON.stringify(open().file)), 'task-lead')
    expect(file.threads[0].choice?.recommended).toBe('later')
    const broken = normalizeThreads({ ...open().file, threads: [{ ...open().thread, choice: { board: 'task-lead' } }] }, 'task-lead')
    expect(broken.threads[0].choice).toBeUndefined()
    expect(normalizeThreadChoice({ board: 'b', id: 'c', options: [{ value: 'x', label: 'X' }], recommended: 'nope' })).toEqual({ board: 'b', id: 'c', options: [{ value: 'x', label: 'X' }] })
  })
})

describe('the thread says how its choice ended', () => {
  it('his own answer closes it as known, with what he chose', () => {
    const r = open()
    const out = settleChoiceThread(r.file, r.thread.id, choiceOutcome({ option: 'later', label: 'Next week' }), at(5))!
    expect(out.thread).toMatchObject({ state: 'answered', reply: 'You answered: Next week', closed: { how: 'acked', by: 'human' }, choice: { done: true } })
    expect(holdsChoice(out.thread)).toBe(false)
  })

  it('an agent\'s answer for him stays open as news; words alone are quoted', () => {
    const r = open()
    const out = settleChoiceThread(r.file, r.thread.id, choiceOutcome({ option: '', text: 'Wait for rain', text_by: 'task:task-vp', text_by_name: 'the Garden VP' }), at(5))!
    expect(out.thread.closed).toBeUndefined()
    expect(out.thread.reply).toBe('Answered for you by the Garden VP: “Wait for rain”')
  })

  it('a choice gone from the Board drops it; the experiment off sets it aside and on again opens it', () => {
    const r = open()
    expect(settleChoiceThread(r.file, r.thread.id, { kind: 'moot', words: 'Gone' }, at(5))!.thread.closed?.how).toBe('dropped')
    const off = settleChoiceThread(r.file, r.thread.id, { kind: 'off' }, at(5))!
    expect(off.thread.choice?.off).toBe(true)
    const again = openChoiceThread(off.file, input())
    expect(again.changed).toBe('reopened')
    expect(again.thread.closed).toBeUndefined()
    expect(holdsChoice(again.thread)).toBe(true)
  })

  it('a thread its node moved on (no longer in needs) is left as it is', () => {
    const r = open()
    const moved: ThreadsFile = { ...r.file, threads: [{ ...r.thread, state: 'working' }] }
    expect(settleChoiceThread(moved, r.thread.id, { kind: 'moot', words: 'Gone' }, at(5))).toBeNull()
  })
})

const thread = (over: Partial<OrgThread> & { id: string }): OrgThread => ({
  title: over.id, state: 'working', messages: [], createdAt: at(0), updatedAt: at(1), ...over,
} as OrgThread)

describe('the state groups of his Threads (brief_off)', () => {
  const answeredNews = thread({ id: 'th-read', state: 'answered', reply: 'Done, see the beds.', replyAt: at(9), updatedAt: at(9) })
  const answeredSeen = thread({ id: 'th-seen', state: 'answered', reply: 'Old news.', replyAt: at(2), reactedAt: at(3), messages: [{ id: 'm1', text: 'ok', at: at(3), via: 'chat' } as never] })
  const all = [
    open().thread,
    answeredNews,
    answeredSeen,
    thread({ id: 'th-work', state: 'working' }),
    thread({ id: 'th-pend', state: 'pending' }),
    thread({ id: 'th-snooze', state: 'needs', snoozed: { until: at(600), at: at(2) } }),
    thread({ id: 'th-done', state: 'answered', closed: { how: 'acked', at: at(4), by: 'human' } as never }),
  ]

  it('puts each thread in one group: needs, read, working, waiting, done', () => {
    const g = groupThreads(all, NOW)
    expect(g.needs.map((t) => t.id)).toEqual([choiceThreadId('task-lead', 'plant-when')])
    expect(g.read.map((t) => t.id)).toEqual(['th-read'])
    expect(g.working.map((t) => t.id)).toEqual(['th-work'])
    expect(g.waiting.map((t) => t.id).sort()).toEqual(['th-pend', 'th-seen', 'th-snooze'])
    expect(g.done.map((t) => t.id)).toEqual(['th-done'])
    expect(Object.values(g).flat()).toHaveLength(all.length)
  })

  it('a thread asked in a task waits; a thread of a task below listed above it needs him', () => {
    expect(threadGroupOf(thread({ id: 'a', state: 'pending', askedIn: { task: 't', title: 'T', ask: 'Pick', via: 'owner' } }), false, NOW)).toBe('waiting')
    expect(threadGroupOf(thread({ id: 'b', state: 'needs', owner: { task_id: 't', title: 'T' } } as never), true, NOW)).toBe('needs')
  })

  it('a task\'s state is its first group that holds an open thread: needs > read > working > waiting', () => {
    expect(threadStateOf(all, NOW)).toMatchObject({ state: 'needs', title: 'Plant the beds this week or next?' })
    expect(threadStateOf(all.slice(1), NOW)?.state).toBe('read')
    expect(threadStateOf(all.slice(3), NOW)?.state).toBe('working')
    expect(threadStateOf([all[4]], NOW)?.state).toBe('waiting')
    // Only closed threads: history, no status now.
    expect(threadStateOf([all[6]], NOW)).toBeNull()
    expect(threadStateOf([], NOW)).toBeNull()
    // A pointer a moved thread left behind is the other node's.
    expect(threadStateOf([thread({ id: 'gone', state: 'needs', movedTo: { task: 'x', title: 'X', at: at(1) } as never })], NOW)).toBeNull()
  })
})
