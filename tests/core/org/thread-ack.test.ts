/**
 * His Acknowledge means he knows (experiment ack_means_known, src/core/org/thread-ack.ts; 2026-11-20,
 * the user: "a human acknowledge means I now know the situation; the thread is truly closed only
 * when the problem is really solved"). The pure steps: what is still open on a thread, the ack that
 * sends it to Acknowledged (pending and known), the node's place and close it allows, the card's
 * line, the lines the node hears, and each step Walnut takes on one (thread-known.ts knownStep).
 */
import { describe, it, expect } from 'vitest'
import { emptyThreads, fileMessage, normalizeThreads, setAnswers, ThreadError, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { ackDoneLine, ackKnown, ackLine, ackPlace, ackWaitsOf, checkPlace, nodePlaced, type AckTask } from '../../../src/core/org/thread-ack.js'
import { ACK_DECIDING_LINE, ackCardLine, backFromKnown, inAcknowledged, isKnown, KNOWN_CLOSE_MS, knownStep } from '../../../src/core/org/thread-known.js'
import { hasThreadNews, shownToHim } from '../../../src/core/org/thread-view.js'
import { threadCounts } from '../../../src/core/org/thread-groups.js'
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

/** The oven task as the store holds it, still at work unless told otherwise. */
const oven = (over: Partial<AckTask> = {}): Map<string, AckTask> => new Map([['t-oven', { id: 't-oven', title: 'Oven timer', phase: 'IN_PROGRESS', ...over }]])

describe('what still holds a thread at his Acknowledge', () => {
  it('a card that holds the result (answered) closes unless a task it lists still works on its subject', () => {
    const t = running('answered').f.threads[0]
    expect(ackWaitsOf(t, oven())).toEqual({ tasks: [{ id: 't-oven', title: 'Oven timer' }], replies: false, letter: false })
    expect(ackWaitsOf(t, oven({ phase: 'NEED_ACTION' }))).toBeNull()
    expect(ackWaitsOf(t, oven({ title: 'Paint the garden shed' }))).toBeNull()
  })

  it('a task it lists on its subject, by title; none and nothing else is null', () => {
    const { f } = running()
    const t = f.threads[0]
    expect(ackWaitsOf(t, oven())).toEqual({ tasks: [{ id: 't-oven', title: 'Oven timer' }], replies: false, letter: false })
    expect(ackWaitsOf(t, new Map())).toBeNull()
    // A task open elsewhere that the thread does not list is not its work.
    expect(ackWaitsOf(t, new Map([['t-other', { id: 't-other', title: 'Oven timer too', phase: 'IN_PROGRESS' }]]))).toBeNull()
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
    const bad = normalizeThreads({ threads: [{ ...acked.threads[0], ackedAt: 'soon', ackDone: 42, ackPlaced: { to: 'somewhere', by: 'node', at: at(5) } }] }, 'lead-1')
    expect(bad.threads[0].ackedAt).toBeUndefined()
    expect(bad.threads[0].ackDone).toBeUndefined()
    expect(bad.threads[0].ackPlaced).toBeUndefined()
    // A placement survives the round trip; a new Acknowledge drops the old one: it is deciding again.
    const placed = { ...acked, threads: [ackPlace(acked.threads[0], 'waiting', 'node', 'waits on the simulator', at(5))] }
    expect(normalizeThreads(JSON.parse(JSON.stringify(placed)), 'lead-1').threads[0].ackPlaced).toEqual({ to: 'waiting', by: 'node', at: at(5), why: 'waits on the simulator' })
    expect(ackKnown(placed, id, at(9)).thread.ackPlaced).toBeUndefined()
  })
})

describe('what the node hears', () => {
  it('the ack line asks the node to place it, with Walnut\'s reading and its deadline', () => {
    const line = ackLine({ id: 'th-cccccccccccc', title: 'Oven timer' }, { outcome: 'waiting', waits: { tasks: [{ id: 't-oven', title: 'Fix the timer' }], replies: true, letter: false } })
    expect(line).toContain('He acknowledged thread th-cccccccccccc "Oven timer": he knows where it stands, and his card reads "AI is deciding where this goes".')
    expect(line).toContain('thread_update place (closed when it is over, waiting with what it waits on, working while work on it runs) and place_why')
    expect(line).toContain('Walnut reads it as waiting: it waits ("Fix the timer" (t-oven), his reply on its way to you)')
    expect(line).toContain(`Walnut places it there in ${KNOWN_CLOSE_MS / 60_000} minutes.`)
    expect(ackLine({ id: 'th-cccccccccccc', title: 'Oven timer' }, { outcome: 'closed', waits: null })).toContain('Walnut reads it as closed: nothing on it is still open, so it closes;')
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

  it('in Acknowledged until placed: Walnut waits KNOWN_CLOSE_MS for the node, then places it; one the node placed is the node\'s', () => {
    const { f, id } = running()
    const t = ackKnown(f, id, at(4)).thread
    const due = Date.parse(at(4)) + KNOWN_CLOSE_MS
    expect(inAcknowledged(t)).toBe(true)
    expect(knownStep(t, true, due - 1)).toBe('wait')
    expect(knownStep(t, false, due - 1)).toBe('wait')
    expect(knownStep(t, true, due)).toBe('place')
    expect(knownStep(t, false, due)).toBe('place')
    const byNode = ackPlace(t, 'waiting', 'node', 'waits on the simulator until 22:00', at(6))
    expect(inAcknowledged(byNode)).toBe(false)
    expect(knownStep(byNode, false, due + KNOWN_CLOSE_MS * 9)).toBe('none')
  })

  it('the card says the AI is deciding, then where it went and why', () => {
    const { f, id } = running()
    const t = ackKnown(f, id, at(4)).thread
    expect(ackCardLine(t)).toBe(ACK_DECIDING_LINE)
    expect(ACK_DECIDING_LINE).toBe('AI is deciding where this goes.')
    expect(ackCardLine(ackPlace(t, 'waiting', 'node', 'waits on the Mac simulator until 22:00', at(6)))).toBe('Moved to Waiting: waits on the Mac simulator until 22:00')
    expect(ackCardLine(ackPlace(t, 'working', 'walnut', '"Oven timer" still at work on it', at(14)))).toBe('Moved to Working by Walnut: "Oven timer" still at work on it')
    const shut = ackPlace(t, 'closed', 'node', 'the timer is fixed and he saw it', at(6))
    expect(shut.closed).toMatchObject({ how: 'acked', by: 'agent', reacted: true })
    expect(ackCardLine(shut)).toBe('Moved to Closed: the timer is fixed and he saw it')
    // He wrote in it since: no line, it is working again.
    expect(ackCardLine(fileMessage({ ...f, threads: [ackPlace(t, 'waiting', 'node', 'x', at(6))] }, { text: 'and the grill?', via: 'follow-up', threadId: id, at: at(8) }).thread)).toBeNull()
    expect(ackCardLine(f.threads[0])).toBeNull()
  })

  it("the node's place: only its own, only on one he acknowledged, with a why", () => {
    const { f, id } = running()
    const t = ackKnown(f, id, at(4)).thread
    expect(() => checkPlace('human', 'closed', 'done', {})).toThrow(ThreadError)
    expect(() => checkPlace(NODE, 'later', 'x', {})).toThrow(/place must be one of/)
    expect(() => checkPlace(NODE, 'waiting', '  ', {})).toThrow(/place needs place_why/)
    expect(() => checkPlace(NODE, 'waiting', 'x', { state: 'pending' })).toThrow(/not with state/)
    // A reply or options would say something else than where it goes.
    expect(() => checkPlace(NODE, 'waiting', 'x', { reply: 'Timer fixed.' })).toThrow(/not with reply/)
    expect(checkPlace(NODE, 'working', 'x', { title: 'Oven timer', known: 'all' })).toEqual({ to: 'working', why: 'x' })
    const p = checkPlace(NODE, 'waiting', '  waits on\n the simulator ', {})
    expect(p).toEqual({ to: 'waiting', why: 'waits on the simulator' })
    expect(nodePlaced(t, t, p, at(6)).ackPlaced).toEqual({ to: 'waiting', by: 'node', at: at(6), why: 'waits on the simulator' })
    // He pinned it since his ack: a place in Closed is its close (threads-store.ts), which his pin refuses.
    const pinnedT = { ...t, pinned: { at: at(5), by: 'human' } }
    expect(() => updateThread({ ...f, threads: [pinnedT] }, id, { close: 'acked' }, NODE, at(6))).toThrow(/pinned/)
    expect(nodePlaced(pinnedT, pinnedT, { to: 'waiting', why: 'x' }, at(6)).pinned).toBeTruthy()
    // Placed in Closed: its close records where it went and why.
    const shutByNode = updateThread({ ...f, threads: [t] }, id, { close: 'acked' }, NODE, at(7)).thread
    expect(nodePlaced(t, shutByNode, { to: 'closed', why: 'the timer is fixed' }, at(7)).ackPlaced).toEqual({ to: 'closed', by: 'node', at: at(7), why: 'the timer is fixed' })
    // Not acknowledged: refused, the node sets its state instead.
    expect(() => nodePlaced(f.threads[0], f.threads[0], p, at(6))).toThrow(/only for a thread he acknowledged/)
    // A plain close of its own on one he acknowledged is its decision too.
    const closed = updateThread({ ...f, threads: [t] }, id, { close: 'acked' }, NODE, at(7)).thread
    expect(nodePlaced(t, closed, null, at(7)).ackPlaced).toEqual({ to: 'closed', by: 'node', at: at(7) })
    expect(ackCardLine(nodePlaced(t, closed, null, at(7)))).toBe('Moved to Closed.')
  })

  it("Walnut's steps on one it placed: wait while open, tell once when it ends, then close with nothing new or show what is new", () => {
    const { f, id } = running()
    const t = ackPlace(ackKnown(f, id, at(4)).thread, 'working', 'walnut', 'x', at(14))
    const now = Date.parse(at(20))
    expect(knownStep(f.threads[0], false, now)).toBe('none')
    expect(knownStep(t, true, now)).toBe('wait')
    expect(knownStep(t, false, now)).toBe('tell')
    const told = { ...t, ackDone: at(15) }
    expect(knownStep(told, false, Date.parse(at(15)) + KNOWN_CLOSE_MS - 1)).toBe('wait')
    expect(knownStep(told, false, Date.parse(at(15)) + KNOWN_CLOSE_MS)).toBe('close')
    // New work opened on it after it ended: the clock starts again.
    expect(knownStep(told, true, now)).toBe('rewait')
    // He pinned or snoozed it since: it stays in his hands, Walnut neither shows nor closes it.
    const late = Date.parse(at(15)) + KNOWN_CLOSE_MS
    expect(knownStep({ ...told, pinned: { at: at(16), by: 'human' } }, false, late)).toBe('wait')
    expect(knownStep({ ...told, snoozed: { until: new Date(late + 60_000).toISOString(), at: at(16) } }, false, late)).toBe('wait')
    // The node wrote a new summary after his ack but left it pending: shown, never closed unseen.
    const wrote = updateThread({ ...f, threads: [t] }, id, { state: 'pending', reply: 'Timer fixed and tested.' }, NODE, at(16)).thread
    expect(knownStep({ ...wrote, ackDone: at(15) }, false, Date.parse(at(15)) + KNOWN_CLOSE_MS)).toBe('show')
  })

  it('every node reads that his Acknowledge means he knows and an open thread stays pending', () => {
    expect(THREADS_PENDING_RULE).toContain('His Acknowledge means he knows')
    expect(THREADS_PENDING_RULE).toContain('it closes, or stays pending while its work runs')
  })
})
