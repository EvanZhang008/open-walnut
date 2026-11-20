/**
 * His Acknowledge means he knows (experiment ack_means_known, src/core/org/thread-ack.ts; 2026-11-20,
 * the user: "a human acknowledge means I now know the situation; the thread is truly closed only
 * when the problem is really solved"). The pure steps: what is still open on a thread, the ack that
 * keeps it pending and known, the node's close it allows, the lines the node hears, and each step
 * Walnut takes on a Known thread (thread-known.ts knownStep).
 */
import { describe, it, expect } from 'vitest'
import { emptyThreads, fileMessage, normalizeThreads, setAnswers, ThreadError, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { ackDoneLine, ackKnown, ackLine, ackWaitsOf } from '../../../src/core/org/thread-ack.js'
import { backFromKnown, isKnown, KNOWN_CLOSE_MS, knownStep } from '../../../src/core/org/thread-known.js'
import { hasThreadNews, shownToHim, threadCounts } from '../../../src/core/org/thread-view.js'
import { THREADS_PENDING_RULE } from '../../../src/core/org/thread-rules.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 6, min)).toISOString()
const NODE = 'task:lead-1'

/** One thread of his the node handed to task t-oven, still at work on it (`state`: working by default). */
function running(state: 'working' | 'pending' | 'answered' = 'working'): { f: ThreadsFile; id: string } {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'Fix the oven timer', via: 'chat', at: at(0) }).file
  const id = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'On it, handed to the oven task.', at: at(1) }]])).file
  f = updateThread(f, id, { state, reply: 'The oven task is fixing the timer.', tasks: ['t-oven'] }, NODE, at(2)).file
  return { f, id }
}

describe('what is still open on a thread', () => {
  it('a card that holds the result (answered) holds nothing, whatever is open on it', () => {
    const t = running('answered').f.threads[0]
    expect(ackWaitsOf(t, new Map([['t-oven', 'Oven timer']]))).toBeNull()
  })

  it('an open task it lists, by title; none open and nothing else is null', () => {
    const { f } = running()
    const t = f.threads[0]
    expect(ackWaitsOf(t, new Map([['t-oven', 'Oven timer']]))).toEqual({ tasks: [{ id: 't-oven', title: 'Oven timer' }], replies: false, letter: false })
    expect(ackWaitsOf(t, new Map())).toBeNull()
    // A task open elsewhere that the thread does not list is not its work.
    expect(ackWaitsOf(t, new Map([['t-other', 'Other']]))).toBeNull()
  })

  it('his reply still on its way, or a live letter on it, is open work', () => {
    const { f } = running()
    const t = f.threads[0]
    const withReply = { ...t, messages: [...t.messages, { id: 'tm-aaaaaaaaaaaa', at: at(3), text: 'also the clock', via: 'chat' as const, delivery: { state: 'pending' as const, at: at(3) } }] }
    expect(ackWaitsOf(withReply as never, new Map())?.replies).toBe(true)
    const withLetter = { ...t, letter: { id: 'lt-1', task: 'lead-1', options: [] } }
    expect(ackWaitsOf(withLetter, new Map())?.letter).toBe(true)
    expect(ackWaitsOf({ ...t, letter: { id: 'lt-1', task: 'lead-1', options: [], done: true as const } }, new Map())).toBeNull()
  })
})

describe('the ack that keeps it open', () => {
  it('goes pending, every exchange known by him, the ack recorded: out of his sight, not closed', () => {
    const { f, id } = running()
    const pinned = updateThread(f, id, { pin: true }, 'human', at(3)).file
    const r = ackKnown(pinned, id, at(4))
    expect(r.thread.closed).toBeUndefined()
    expect(r.thread.state).toBe('pending')
    expect(r.thread.ackedAt).toBe(at(4))
    expect(r.thread.known).toMatchObject({ by: 'human', through: r.thread.messages[0].id })
    expect(r.thread.reactedAt).toBe(at(4))
    expect(r.thread.pinned).toBeUndefined()
    expect(hasThreadNews(r.thread)).toBe(false)
    expect(shownToHim(r.thread, undefined, Date.parse(at(5)))).toBe(false)
    expect(threadCounts(r.file.threads, Date.parse(at(5))).shown).toBe(0)
    expect(isKnown(r.thread)).toBe(true)
  })

  it('a thread the node opened, with no message of his, still goes pending', () => {
    const o = emptyThreads('lead-1')
    const f: ThreadsFile = { ...o, threads: [{ id: 'th-bbbbbbbbbbbb', title: 'Mail from the bakery', state: 'needs', messages: [], createdAt: at(0), updatedAt: at(0), opener: { text: 'The bakery asks for a date.', at: at(0), from: 'node', by: NODE }, tasks: ['t-oven'] }] }
    const r = ackKnown(f, 'th-bbbbbbbbbbbb', at(2))
    expect(r.thread.state).toBe('pending')
    expect(r.thread.known).toBeUndefined()
    expect(r.thread.ackedAt).toBe(at(2))
  })

  it('the node may close it after his ack without a new reaction of his; a word of its own after the ack needs one again', () => {
    const { f, id } = running()
    const acked = ackKnown(f, id, at(4)).file
    const closed = updateThread(acked, id, { close: 'acked' }, NODE, at(10)).thread
    expect(closed.closed).toMatchObject({ how: 'acked', by: NODE })
    // A later answered with the outcome is news on his card once.
    const outcome = updateThread(acked, id, { state: 'answered', reply: 'Timer fixed and tested.' }, NODE, at(8))
    expect(shownToHim(outcome.thread, undefined, Date.parse(at(9)))).toBe(true)
    // ... and then the node cannot close it before he reacts to that outcome.
    expect(() => updateThread(outcome.file, id, { close: 'acked' }, NODE, at(10))).toThrow(ThreadError)
  })

  it('once he wrote again after his ack, the node needs his reaction to its answer again', () => {
    const { f, id } = running()
    const acked = ackKnown(f, id, at(4)).file
    const again = fileMessage(acked, { text: 'and can you fix the grill timer too?', via: 'follow-up', threadId: id, at: at(6) })
    expect(again.thread.id).toBe(id)
    const quiet = updateThread(again.file, id, { state: 'pending' }, NODE, at(7)).file
    expect(() => updateThread(quiet, id, { close: 'acked' }, NODE, at(8))).toThrow(/Not closed/)
  })

  it('without his ack the node still cannot close an answer he never reacted to', () => {
    const { f, id } = running()
    expect(() => updateThread(f, id, { close: 'acked' }, NODE, at(10))).toThrow(/Not closed/)
    // pending alone, no ack: still refused.
    const pending = updateThread(f, id, { state: 'pending' }, NODE, at(5)).file
    expect(() => updateThread(pending, id, { close: 'acked' }, NODE, at(10))).toThrow(/Not closed/)
  })

  it('the ack fields survive a read from disk; a bad one is dropped', () => {
    const { f, id } = running()
    const acked = ackKnown(f, id, at(4)).file
    const back = normalizeThreads(JSON.parse(JSON.stringify(acked)), 'lead-1')
    expect(back.threads[0].ackedAt).toBe(at(4))
    const bad = normalizeThreads({ threads: [{ ...acked.threads[0], ackedAt: 'soon', ackDone: 42 }] }, 'lead-1')
    expect(bad.threads[0].ackedAt).toBeUndefined()
    expect(bad.threads[0].ackDone).toBeUndefined()
  })
})

describe('what the node hears', () => {
  it('the ack line names the thread and what it waits on, and what to do when it is over', () => {
    const line = ackLine({ id: 'th-cccccccccccc', title: 'Oven timer' }, { tasks: [{ id: 't-oven', title: 'Fix the timer' }], replies: true, letter: false })
    expect(line).toContain('He acknowledged thread th-cccccccccccc "Oven timer": he knows where it stands; it waits on "Fix the timer" (t-oven), his reply on its way to you.')
    expect(line).toContain('set it answered with the outcome only if there is something he has not seen (he closes it); otherwise close it yourself.')
    const done = ackDoneLine({ id: 'th-cccccccccccc', title: 'Oven timer' })
    expect(done).toContain('nothing on it is open now. If the outcome holds something he has not seen, set it answered with it once; otherwise close it.')
    expect(done).toContain(`Walnut closes it in ${KNOWN_CLOSE_MS / 60_000} minutes`)
  })

  it('Known: pending since his ack with no word of his after it; he writes and it is working, not Known', () => {
    const { f, id } = running()
    const acked = ackKnown(f, id, at(4))
    expect(isKnown(acked.thread)).toBe(true)
    expect(isKnown(f.threads[0])).toBe(false)
    const again = fileMessage(acked.file, { text: 'and the grill timer?', via: 'follow-up', threadId: id, at: at(6) })
    expect(again.thread.state).toBe('working')
    expect(isKnown(again.thread)).toBe(false)
    // The node brings it back with the outcome: back from Known, until he writes or closes it.
    const outcome = updateThread(acked.file, id, { state: 'answered', reply: 'Timer fixed.' }, NODE, at(8)).thread
    expect(isKnown(outcome)).toBe(false)
    expect(backFromKnown(outcome)).toBe(true)
    expect(backFromKnown(again.thread)).toBe(false)
  })

  it("Walnut's steps on a Known thread: wait while open, tell once when it ends, then close with nothing new or show what is new", () => {
    const { f, id } = running()
    const t = ackKnown(f, id, at(4)).thread
    const now = Date.parse(at(20))
    expect(knownStep(f.threads[0], false, now)).toBe('none')
    expect(knownStep(t, true, now)).toBe('wait')
    expect(knownStep(t, false, now)).toBe('tell')
    const told = { ...t, ackDone: at(15) }
    expect(knownStep(told, false, Date.parse(at(15)) + KNOWN_CLOSE_MS - 1)).toBe('wait')
    expect(knownStep(told, false, Date.parse(at(15)) + KNOWN_CLOSE_MS)).toBe('close')
    // New work opened on it after it ended: the clock starts again.
    expect(knownStep(told, true, now)).toBe('rewait')
    // The node wrote a new summary after his ack but left it pending: shown, never closed unseen.
    const wrote = updateThread(ackKnown(f, id, at(4)).file, id, { state: 'pending', reply: 'Timer fixed and tested.' }, NODE, at(12)).thread
    expect(knownStep({ ...wrote, ackDone: at(15) }, false, Date.parse(at(15)) + KNOWN_CLOSE_MS)).toBe('show')
  })

  it('every node reads that his Acknowledge means he knows and an open thread stays pending', () => {
    expect(THREADS_PENDING_RULE).toContain('His Acknowledge means he knows')
    expect(THREADS_PENDING_RULE).toContain('it closes, or stays pending while its work runs')
  })
})
