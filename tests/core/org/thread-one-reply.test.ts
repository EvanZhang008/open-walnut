/**
 * One reply, one card (src/core/org/thread-one-reply.ts; experiment threads_each_question). Two
 * questions he typed seconds apart are two threads, and the node's one reply answers both. Marked
 * answered by the node's own lines with no summary, both cards would show that one reply, and his
 * view shows neither (2026-11-26, real use: 84 minutes with no card for two answered questions).
 * They become one thread in the write that leaves them so, in either order of the two writes.
 * Pure: the model, the view and the merge; the store's writes are in thread-one-reply-store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyThreads, fileMessage, normalizeThreads, openThread, setAnswers, splitThreadMessage, threadIdNow, updateThread, type OrgThread, type ThreadAnswer, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { mergeOneReply, titledForAll } from '../../../src/core/org/thread-one-reply.js'
import { setEachQuestion } from '../../../src/core/org/thread-question.js'
import { listedForHim } from '../../../src/core/org/thread-view.js'

const NODE = 'orchard-one-reply-node'
const BY = `task:${NODE}` as const
const T0 = Date.now() - 60 * 60_000
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()

const Q_PAINT = 'What paint does the shed door need, and how many coats?'
const Q_HINGE = 'Does the top hinge need oil as well?'
const Q_ORDER = 'Which goes on first, the primer or the gloss?'
const Q_DRY = 'How long should it dry between coats?'
const R_PAINT = 'The shed door takes exterior gloss over one coat of primer: two coats of gloss, sanded lightly in between.'
const R_BOTH = 'Yes, oil the top hinge before you start. The primer goes on first, and the gloss only once the primer is dry.'

beforeEach(() => { setEachQuestion(true) })
afterEach(() => { setEachQuestion(false) })

const ask = (f: ThreadsFile, text: string, sec: number) => fileMessage(f, { text, via: 'chat', at: at(sec) })
const line = (f: ThreadsFile, id: string, patch: Parameters<typeof updateThread>[2], sec: number) => updateThread(f, id, patch, BY, at(sec), undefined, { line: true }).file
const answered = (f: ThreadsFile, id: string, title: string, sec: number) => line(f, id, { state: 'answered', title }, sec)
const reply = (text: string, sec: number): ThreadAnswer => ({ text, at: at(sec) })
const thread = (f: ThreadsFile, id: string): OrgThread => f.threads.find((t) => t.id === id)!
const patched = (f: ThreadsFile, id: string, patch: Partial<OrgThread>): ThreadsFile => ({ ...f, threads: f.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
const listed = (f: ThreadsFile) => listedForHim(f.threads).map((t) => t.id)

/** His first question, answered; then two more within a minute, both still waiting. */
function three() {
  const a = ask(emptyThreads(NODE), Q_PAINT, 0)
  let f = setAnswers(a.file, new Map([[a.message.id, reply(R_PAINT, 26)]])).file
  f = answered(f, a.thread.id, 'Shed door: which paint, how many coats', 27)
  const b = ask(f, Q_HINGE, 53)
  const c = ask(b.file, Q_ORDER, 67)
  return { f: c.file, paint: a.thread.id, hinge: b.thread.id, order: c.thread.id, hingeMsg: b.message.id, orderMsg: c.message.id }
}
/** The node's lines: both read answered, titled, no summary. */
const lines = (s: ReturnType<typeof three>, f = s.f) => answered(answered(f, s.hinge, 'Top hinge needs oil first', 103), s.order, 'Paint order: primer, then gloss', 103)
/** The one reply, under both questions. */
const answers = (s: ReturnType<typeof three>, f = s.f) => setAnswers(f, new Map([[s.hingeMsg, reply(R_BOTH, 102)], [s.orderMsg, reply(R_BOTH, 102)]])).file

describe('two questions one reply answered become one thread', () => {
  it('each question opens its own thread (the rule this builds on)', () => {
    const s = three()
    expect(new Set([s.paint, s.hinge, s.order]).size).toBe(3)
  })

  it('the lines first, then the answers (a reply\'s card lines): merged in the answers\' write, and the card shows', () => {
    const s = three()
    const lined = lines(s)
    // No answer on the questions yet: nothing says one reply.
    expect(mergeOneReply(lined, at(104), s.f).merged).toEqual([])
    const both = answers(s, lined)
    // As it stood in real use: neither answered question has a card.
    expect(listed(both)).toEqual([s.paint])
    const one = mergeOneReply(both, at(105), lined)
    expect(one.merged).toEqual([{ into: s.hinge, from: [s.order] }])
    const kept = thread(one.file, s.hinge)
    expect(kept.state).toBe('answered')
    expect(kept.messages.map((m) => [m.text, m.answer?.text])).toEqual([[Q_HINGE, R_BOTH], [Q_ORDER, R_BOTH]])
    expect(kept.was).toEqual([s.order])
    expect(threadIdNow(one.file, s.order)).toBe(s.hinge)
    expect(kept.title).toBe('Top hinge needs oil first \u00b7 Paint order: primer, then gloss')
    expect(kept.titled).toBe(true)
    expect(one.file.threads.some((t) => t.id === s.order)).toBe(false)
    expect(listed(one.file).sort()).toEqual([s.paint, s.hinge].sort())
  })

  it('the answers first, then the lines (the status question\'s lines): merged in the lines\' write', () => {
    const s = three()
    const both = answers(s)
    // Still working: his questions wait in the node's hands, each its own thread.
    expect(mergeOneReply(both, at(103), s.f).merged).toEqual([])
    const one = mergeOneReply(lines(s, both), at(104), both)
    expect(one.merged).toEqual([{ into: s.hinge, from: [s.order] }])
    expect(thread(one.file, s.hinge)).toMatchObject({ state: 'answered', was: [s.order] })
  })

  it('three questions on one reply are one thread; one of them still working stays its own', () => {
    const s = three()
    const d = ask(s.f, Q_DRY, 80)
    const all = setAnswers(answers(s, d.file), new Map([[d.message.id, reply(R_BOTH, 102)]])).file
    const two = lines(s, all)
    const partly = mergeOneReply(two, at(105), all)
    expect(partly.merged).toEqual([{ into: s.hinge, from: [s.order] }])
    expect(thread(partly.file, d.thread.id).state).not.toBe('answered')
    const third = answered(two, d.thread.id, 'Drying time between coats', 104)
    const one = mergeOneReply(third, at(105), all)
    expect(one.merged).toEqual([{ into: s.hinge, from: [s.order, d.thread.id] }])
    expect(thread(one.file, s.hinge).messages).toHaveLength(3)
    expect(thread(one.file, s.hinge).was).toEqual([d.thread.id, s.order])
  })

  it('a second run changes nothing, with or without the file before', () => {
    const s = three()
    const lined = lines(s)
    const one = mergeOneReply(answers(s, lined), at(105), lined)
    expect(mergeOneReply(one.file, at(106), one.file).file).toBe(one.file)
    expect(mergeOneReply(one.file, at(106)).file).toBe(one.file)
  })
})

describe('which cards join', () => {
  /** Both answered by the one reply, no summary: they would join. */
  function ready() {
    const s = three()
    const lined = lines(s)
    return { s, before: lined, f: answers(s, lined) }
  }
  const none = (f: ThreadsFile, before: ThreadsFile, why: string) => expect(mergeOneReply(f, at(105), before).merged, why).toEqual([])

  it('a card with its own summary shows that, and stays its own card (his real threads: each of 25 such groups has one per card)', () => {
    const { s, before, f } = ready()
    none(line(f, s.order, { reply: 'Primer first; the gloss goes on once the primer is dry.' }, 104), before, 'one summary')
    const each = line(line(f, s.order, { reply: 'Primer first, then gloss.' }, 104), s.hinge, { reply: 'Yes, oil the top hinge before painting.' }, 104)
    none(each, before, 'a summary on each')
    // Each shows its own words: both are in his view, nothing to join.
    expect(listed(each).sort()).toEqual([s.paint, s.hinge, s.order].sort())
  })

  it('never a card he read, acknowledged, reacted to or put aside, or one holding more than his words', () => {
    const { s, before, f } = ready()
    const cases: Array<[string, Partial<OrgThread>]> = [
      ['acknowledged', { ackedAt: at(110), ackedResult: true }],
      ['known', { known: { at: at(110), by: 'human' } } as Partial<OrgThread>],
      ['reacted after the answer', { reactedAt: at(110) }],
      ['put aside', { snoozed: { until: at(4000), at: at(110) } } as Partial<OrgThread>],
      ['closed', { closed: { at: at(110), by: 'human' } } as Partial<OrgThread>],
      ['moved to another node', { movedTo: { task: 'orchard-other-node', title: 'Other' } } as Partial<OrgThread>],
      ['holds a letter', { letter: { id: 'lt-0000aaaa' } } as Partial<OrgThread>],
      ['holds a choice', { choice: { id: 'ch-1' } } as Partial<OrgThread>],
      ['holds the task\'s ask', { reportAsk: { id: 'ask-1' } } as Partial<OrgThread>],
      ['watched', { watched: { by: 'human', at: at(110) } } as Partial<OrgThread>],
      ['asks him to decide', { state: 'needs' }],
      ['set waiting', { state: 'pending' }],
    ]
    for (const [why, patch] of cases) none(patched(f, s.order, patch), before, why)
    // A message of his there he has read.
    none(patched(f, s.order, { messages: thread(f, s.order).messages.map((m) => ({ ...m, readAt: at(120) })) }), before, 'read')
    // A reaction before the answer came is no reaction to it.
    expect(mergeOneReply(patched(f, s.order, { reactedAt: at(90) }), at(105), before).merged).toHaveLength(1)
  })

  it('never one with a word of his still waiting, a remark, or a thread the node opened', () => {
    const { s, before, f } = ready()
    const more = fileMessage(f, { text: 'And the handle?', via: 'follow-up', at: at(104), threadId: s.order }).file
    none(patched(more, s.order, { state: 'answered' }), before, 'a later word of his has no answer')
    const remark = ask(s.f, 'The brushes are on the top shelf', 70)
    const r = setAnswers(answers(s, remark.file), new Map([[remark.message.id, reply(R_BOTH, 102)]])).file
    const marked = answered(answered(r, s.hinge, 'Hinge oil', 103), remark.thread.id, 'The brushes', 103)
    none(marked, r, 'a remark asks nothing')
    const opened = openThread(f, { title: 'Paint list moved', text: R_BOTH, from: 'node', state: 'answered' }, BY, at(104)).file
    expect(mergeOneReply(opened, at(105), before).merged).toEqual([{ into: s.hinge, from: [s.order] }])
    expect(opened.threads.filter((t) => t.opener)).toHaveLength(1)
  })

  it('never a thread a split took out of another: the split stands (review 2026-11-27)', () => {
    // Two questions in one thread (the second a follow-up there), both under the one reply; then the second is split out.
    const a = ask(emptyThreads(NODE), Q_HINGE, 53)
    const b = fileMessage(a.file, { text: Q_ORDER, via: 'follow-up', at: at(67), threadId: a.thread.id })
    expect(b.thread.id).toBe(a.thread.id)
    let f = setAnswers(b.file, new Map([[a.message.id, reply(R_BOTH, 102)], [b.message.id, reply(R_BOTH, 102)]])).file
    f = answered(f, a.thread.id, 'Top hinge needs oil first', 103)
    const split = splitThreadMessage(f, a.thread.id, b.message.id, 'human', at(200), undefined, 'en', { keepOpen: true })
    expect(split.thread.splitOut).toBe(at(200))
    expect(split.thread.state).toBe('new')
    // The node's line marks the new thread answered, with no summary: both would say the one reply.
    const lined = answered(split.file, split.thread.id, 'Paint order: primer, then gloss', 210)
    expect(lined.threads.filter((t) => t.state === 'answered' && !t.reply)).toHaveLength(2)
    none(lined, split.file, 'in the write that marks it')
    expect(mergeOneReply(lined, at(211)).merged).toEqual([])
    // The mark is kept when the file is read back, and a value that is no time is dropped.
    expect(normalizeThreads(JSON.parse(JSON.stringify(lined)), NODE).threads.find((t) => t.id === split.thread.id)!.splitOut).toBe(at(200))
    const odd = { ...lined, threads: lined.threads.map((t) => (t.id === split.thread.id ? { ...t, splitOut: 7 } : t)) }
    expect(normalizeThreads(JSON.parse(JSON.stringify(odd)), NODE).threads.find((t) => t.id === split.thread.id)!.splitOut).toBeUndefined()
  })

  it('never two replies: other words, or the same words at another time', () => {
    const s = three()
    const lined = lines(s)
    none(setAnswers(lined, new Map([[s.hingeMsg, reply(R_BOTH, 102)], [s.orderMsg, reply(`${R_BOTH} Two coats.`, 102)]])).file, lined, 'other words')
    none(setAnswers(lined, new Map([[s.hingeMsg, reply(R_BOTH, 102)], [s.orderMsg, reply(R_BOTH, 140)]])).file, lined, 'another time')
  })

  it('cards that stood side by side before the write stay as they are; with no file before, they join (the thread check)', () => {
    const { s, f } = ready()
    // A write that only touches something else: a title on the first card.
    const other = line(f, s.paint, { title: 'Shed door paint' }, 130)
    expect(mergeOneReply(other, at(131), f).merged).toEqual([])
    expect(mergeOneReply(other, at(131)).merged).toEqual([{ into: s.hinge, from: [s.order] }])
  })

  it('nothing with the switch off', () => {
    const { before, f } = ready()
    setEachQuestion(false)
    expect(mergeOneReply(f, at(105), before)).toEqual({ file: f, merged: [] })
    expect(mergeOneReply(f, at(105)).file).toBe(f)
  })
})

describe('the kept thread\'s title', () => {
  it('names every question, the node\'s own only when it wrote each; one title for two that say the same', () => {
    const s = three()
    const f = lines(s)
    const a = thread(f, s.hinge)
    const b = thread(f, s.order)
    expect(thread(titledForAll(f, [a, { ...b, titled: undefined }]), s.hinge).titled).toBeUndefined()
    expect(titledForAll(f, [a, { ...b, title: ` ${a.title.toUpperCase()} ` }])).toBe(f)
    expect(titledForAll(f, [a])).toBe(f)
  })
})
