/**
 * A decision letter held by a thread (experiment letters_as_threads,
 * src/core/org/letter-thread-model.ts and src/core/human-inbox/letter-threads.ts): one thread per
 * letter whoever opens it, a thread that says how its letter ended, a field an older build or a
 * hand edit cannot break, and the outcome words the thread gets for each way a letter ends.
 */
import { describe, expect, it } from 'vitest'
import { holdsLetter, letterThreadId, normalizeThreadLetter, openLetterThread, settleLetterThread } from '../../../src/core/org/letter-thread-model.js'
import { emptyThreads, normalizeThreads, THREAD_ID_RE, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { letterOutcome } from '../../../src/core/human-inbox/letter-threads.js'
import type { LetterRecord } from '../../../src/core/human-inbox/types.js'

const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 9, m)).toISOString()
const input = (id = 'lt-orchard-1') => ({
  letter: {
    id, task: 'task-orchard', subject: 'Buy the 72-cell trays or the 128-cell ones?', detail: 'The budget covers one of them.',
    preview: 'The budget covers one of them.', createdAt: Date.parse(at(0)),
    options: [{ id: 'a', label: '72 cells' }, { id: 'b', label: '128 cells', description: 'Denser' }],
  },
  by: 'task:task-orchard' as const, at: at(1),
})
const open = (file: ThreadsFile = emptyThreads('task-orchard')) => openLetterThread(file, input())

describe('one thread per letter', () => {
  it('opens a needs thread with the question, its options and the link, under an id of the letter', () => {
    const r = open()
    expect(r.changed).toBe('opened')
    expect(r.thread.id).toBe(letterThreadId('lt-orchard-1'))
    expect(r.thread.id).toMatch(THREAD_ID_RE)
    expect(r.thread).toMatchObject({
      state: 'needs', title: 'Buy the 72-cell trays or the 128-cell ones?', ask: 'Buy the 72-cell trays or the 128-cell ones?',
      reply: 'The budget covers one of them.', opener: { from: 'letter', ref: 'lt-orchard-1', by: 'task:task-orchard' },
      letter: { id: 'lt-orchard-1', task: 'task-orchard', options: [{ id: 'a', label: '72 cells' }, { id: 'b', label: '128 cells', description: 'Denser' }] },
    })
    expect(holdsLetter(r.thread)).toBe(true)
  })

  it('run again, it changes nothing; another letter has another thread', () => {
    const first = open()
    const again = openLetterThread(first.file, input())
    expect(again.changed).toBeNull()
    expect(again.file).toBe(first.file)
    expect(letterThreadId('lt-orchard-2')).not.toBe(first.thread.id)
  })

  it('a thread he closed, or one that moved on, is never opened again; one closed when the experiment went off is', () => {
    const first = open()
    const acked = { ...first.file, threads: first.file.threads.map((t) => ({ ...t, closed: { how: 'acked' as const, at: at(2), by: 'human' as const } })) }
    expect(openLetterThread(acked, input()).changed).toBeNull()
    const off = settleLetterThread(first.file, first.thread.id, { kind: 'off' }, at(2))!
    expect(off.thread).toMatchObject({ closed: { how: 'dropped', by: 'agent' }, letter: { off: true } })
    expect(holdsLetter(off.thread)).toBe(false)
    const back = openLetterThread(off.file, { ...input(), at: at(3) })
    expect(back.changed).toBe('reopened')
    expect(back.thread.closed).toBeUndefined()
    expect(back.thread.letter?.off).toBeUndefined()
    expect(back.file.threads).toHaveLength(1)
  })
})

describe('the thread says how its letter ended', () => {
  it('his own answer closes it as known; one for him stays as news; a moot one drops', () => {
    const { file, thread } = open()
    const his = settleLetterThread(file, thread.id, { kind: 'his', words: 'You answered: 72 cells' }, at(5))!.thread
    expect(his).toMatchObject({ state: 'answered', reply: 'You answered: 72 cells', closed: { how: 'acked', by: 'human', reacted: true } })
    const forHim = settleLetterThread(file, thread.id, { kind: 'for_him', words: 'Answered for you by Orchard VP: 72 cells' }, at(5))!.thread
    expect(forHim).toMatchObject({ state: 'answered', by: 'agent' })
    expect(forHim.closed).toBeUndefined()
    const moot = settleLetterThread(file, thread.id, { kind: 'moot', words: 'Settled: ordered already', byHim: false }, at(5))!.thread
    expect(moot).toMatchObject({ closed: { how: 'dropped', by: 'agent' } })
  })

  it('an ended letter is never held again, even when its node asks something new on the thread', () => {
    const { file, thread } = open()
    const ended = settleLetterThread(file, thread.id, { kind: 'for_him', words: 'Answered for you by Orchard VP: 72 cells' }, at(5))!
    expect(ended.thread.letter?.done).toBe(true)
    const askedAgain = { ...ended.thread, state: 'needs' as const }
    expect(holdsLetter(askedAgain)).toBe(false)
    // Nor opened again for the letter, nor settled a second time.
    const again = { ...ended.file, threads: [askedAgain] }
    expect(openLetterThread(again, input()).changed).toBeNull()
    expect(settleLetterThread(again, thread.id, { kind: 'his', words: 'x' }, at(6))).toBeNull()
  })

  it('one set aside when the experiment went off and reopened by him holds the letter again, as it is', () => {
    const { file, thread } = open()
    const off = settleLetterThread(file, thread.id, { kind: 'off' }, at(2))!
    const { closed: _c, ...reopenedByHim } = off.thread
    expect(holdsLetter(reopenedByHim)).toBe(false)
    const back = openLetterThread({ ...off.file, threads: [reopenedByHim] }, { ...input(), at: at(3) })
    expect(back.changed).toBe('reopened')
    expect(holdsLetter(back.thread)).toBe(true)
  })

  it('a thread that left needs (his words made it working) is its own conversation: left as it is', () => {
    const { file, thread } = open()
    const working = { ...file, threads: file.threads.map((t) => ({ ...t, state: 'working' as const })) }
    expect(settleLetterThread(working, thread.id, { kind: 'his', words: 'x' }, at(5))).toBeNull()
  })

  it('the words for each way a letter ends', () => {
    const base = { id: 'lt-orchard-1', type: 'action_required', thread: [], archived: false } as unknown as LetterRecord
    expect(letterOutcome(base, 'withdrawn')).toBeNull()
    expect(letterOutcome({ ...base, answered: { actionId: 'a', label: '72 cells', at: 1 } }, 'withdrawn')).toEqual({ kind: 'his', words: 'You answered: 72 cells' })
    expect(letterOutcome({ ...base, answered: { actionId: 'a', label: '72 cells', at: 1, by: { sessionId: 's-vp', name: 'Orchard VP' } } }, 'withdrawn'))
      .toEqual({ kind: 'for_him', words: 'Answered for you by Orchard VP: 72 cells' })
    expect(letterOutcome({ ...base, answered: { actionId: 'withdrawn', label: 'Withdrawn', at: 1 } }, 'withdrawn')?.kind).toBe('moot')
    expect(letterOutcome({ ...base, thread: [{ from: 'human', text: 'Go with the small ones', at: 2 }] }, 'withdrawn'))
      .toEqual({ kind: 'his', words: 'You wrote back: “Go with the small ones”' })
    expect(letterOutcome({ ...base, settled: { reason: 'Ordered already', at: 3 } }, 'withdrawn')).toEqual({ kind: 'moot', words: 'Settled: Ordered already' })
    expect(letterOutcome({ ...base, archived: true }, 'withdrawn')).toMatchObject({ kind: 'moot', byHim: true })
    expect(letterOutcome({ ...base, archived: true, archivedReason: 'settled' }, 'withdrawn')).toMatchObject({ kind: 'moot', byHim: false })
  })
})

describe('the field on disk', () => {
  it('survives a read, is dropped when broken, and an older file without it reads the same', () => {
    const { file, thread } = open()
    const back = normalizeThreads(JSON.parse(JSON.stringify(file)), 'task-orchard').threads[0]
    expect(back.letter).toEqual(thread.letter)
    const broken = normalizeThreads({ threads: [{ ...thread, letter: { id: 7 } }] }, 'task-orchard').threads[0]
    expect(broken.letter).toBeUndefined()
    const { letter: _l, ...older } = thread
    expect(normalizeThreads({ threads: [older] }, 'task-orchard').threads[0].letter).toBeUndefined()
    expect(normalizeThreadLetter({ id: 'lt-x', task: 't', options: [{ id: 'a', label: 'A' }, { id: 1 }], off: 'yes' })).toEqual({ id: 'lt-x', task: 't', options: [{ id: 'a', label: 'A' }] })
  })
})
