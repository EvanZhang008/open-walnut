/**
 * Each question he asks is its own thread (experiment threads_each_question,
 * src/core/org/thread-question.ts; 2026-11-25, the user, after his second question on one subject
 * was merged into the thread of his first: "each question I ask needs to have one thread, otherwise
 * how can I track").
 *
 * The predicate by form (asksQuestion), the filing (threads-model.ts fileMessage: no join by timing
 * or as a reaction), the one merge function (mergeThreads, own_question) and its pure callers, the
 * status question's words (status-thread-title.ts, status-threads.ts), and every text that told a
 * node to merge a thread of his. Each part with the switch on and off: off is today's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-each-question'))

import {
  emptyThreads, fileMessage, mergeThreads, SAME_CONVERSATION_MS, setAnswers, splitMessageInto, ThreadError, updateThread,
  type OrgThread, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'
import { asksQuestion, isPlainReaction, ownQuestionOf, setEachQuestion } from '../../../src/core/org/thread-question.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { holdRepeatTitles, heldTitleOf, MERGE_UNTITLED_LINE, mergeQuestionPart, nearThreads, settleHeldTitles } from '../../../src/core/sessions/status-thread-title.js'
import { threadQuestionOf } from '../../../src/core/sessions/status-thread-question.js'
import { splitWhereItIs } from '../../../src/core/org/thread-join-check.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { relatedThreadsText } from '../../../src/core/org/thread-related.js'
import { answeredBeforeHimReason } from '../../../src/core/org/thread-summary-stop.js'
import { repeatCandidates, repeatFinding } from '../../../src/core/org/thread-audit-rules.js'

const TASK = 'fence-each-question'
const NODE = `task:${TASK}` as const
const T0 = Date.parse('2026-11-25T09:00:00.000Z')
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const chat = (f: ThreadsFile, text: string, sec: number) => fileMessage(f, { text, via: 'chat', at: at(sec), joinRecent: SAME_CONVERSATION_MS })

const Q_A = 'which paint holds best on the garden fence?'
const Q_B = 'how many coats does the fence need before winter'
const REMARK = 'the north side gets the most rain'

/** His question A, then 3.5 minutes later question B on the same subject (the reported case's timing). */
function twoQuestions(): { f: ThreadsFile; a: string; b: string } {
  const one = chat(emptyThreads(TASK), Q_A, 0)
  const a = one.thread.id
  let f = setAnswers(one.file, new Map([[one.message.id, { text: 'Looking at outdoor paints.', at: at(20) }]])).file
  f = updateThread(f, a, { title: 'Outdoor paint choice for the north garden fence', state: 'working' }, NODE, at(30)).file
  const two = chat(f, Q_B, 60)
  return { f: two.file, a, b: two.thread.id }
}

beforeEach(() => { setEachQuestion(true) })
afterEach(() => { setEachQuestion(false); setThreadsKept(false) })

describe('asksQuestion: a question of its own, by form', () => {
  const cases: Array<[string, string, boolean]> = [
    ['an English question with a mark', 'Which train leaves first on Saturday?', true],
    ['a voice question with no mark', 'why are they still on the old path they are on 2 or 3', true],
    ['a request phrased as a question', 'can you check the fence posts', true],
    ['an auxiliary before a determiner', 'is the bike chain still loose', true],
    ['when before an auxiliary', 'when will the train arrive', true],
    ['do before you', 'do you have the timetable', true],
    ['an interrogative after "so"', 'so how many plants need water today', true],
    ['an interrogative after a comma', 'and the second bike, does it need a new tyre', true],
    ['a full-width question mark', 'the plants on the left\uff1f all of them', true],
    ['a Chinese why', '\u4e3a\u4ec0\u4e48\u8fd8\u5728\u7528\u65e7\u8def\u5f84', true],
    ['a Chinese have-or-not', '\u8fd9\u4e2a\u6709\u6ca1\u6709\u4fee\u597d', true],
    ['a Chinese particle at the end', '\u706b\u8f66\u51e0\u70b9\u5f00\u5417', true],
    ['a statement', 'the fence is done', false],
    ['an instruction that asks nothing', 'check the second one too', false],
    ['an order that starts with do', 'do the dishes after lunch', false],
    ['when that opens an instruction', 'when it ends, tell me', false],
    ['a question mark inside a link only', 'see https://example.com/plan?week=2 for the plan', false],
    ['a Chinese instruction', '\u4f60\u53bb\u770b\u4e00\u4e0b\u6811\u7bf1\u7b06', false],
    ['a short why', 'why?', false],
    ['a short what', 'what?', false],
    ['a short really', 'really?', false],
    ['a short Chinese why', '\u4e3a\u5565\uff1f', false],
    ['a plain reaction', 'ok thanks', false],
    ['a Chinese plain reaction', '\u597d\u7684', false],
  ]
  for (const [name, text, want] of cases) it(name, () => { expect(asksQuestion(text)).toBe(want) })

  it('a plain reaction is never a question', () => {
    for (const r of ['done', 'ok', 'thanks', 'got it', 'sounds good', '\u6536\u5230', 'great, thanks']) {
      expect(isPlainReaction(r), r).toBe(true)
      expect(asksQuestion(r), r).toBe(false)
    }
  })
})

describe('filing his chat message (fileMessage)', () => {
  it('fileMessage: his question right after another opens its own thread (the recent join)', () => {
    const { f, a, b } = twoQuestions()
    expect(b).not.toBe(a)
    expect(f.threads.find((t) => t.id === b)!.messages.map((m) => m.text)).toEqual([Q_B])
    expect(f.threads.find((t) => t.id === a)!.messages.map((m) => m.text)).toEqual([Q_A])
    // The remark that asks nothing still goes with the thread it came after.
    const r = chat(f, REMARK, 80)
    expect(r.thread.id).toBe(b)
    expect(r.joined).toBe('recent')
  })

  it('fileMessage: off, his second question joins the first by timing', () => {
    setEachQuestion(false)
    const { f, a, b } = twoQuestions()
    expect(b).toBe(a)
    expect(f.threads).toHaveLength(1)
    expect(f.threads[0].messages.at(-1)).toMatchObject({ text: Q_B, joined: 'recent' })
  })

  it('fileMessage: a question right after a decision waits on him opens its own thread', () => {
    let f = chat(emptyThreads(TASK), 'paint the fence green or brown', 0).file
    const ask = f.threads[0].id
    f = updateThread(f, ask, { state: 'needs', reply: 'Green or brown?', options: [{ label: 'Green', recommended: true }, { label: 'Brown' }], user_kind: 'single', user_kind_why: 'his taste' } as never, 'human', at(5)).file
    const q = chat(f, 'what does the brown look like in the rain?', 30)
    expect(q.created).toBe(true)
    expect(q.file.threads.find((t) => t.id === ask)!.state).toBe('needs')
    setEachQuestion(false)
    expect(chat(f, 'what does the brown look like in the rain?', 30).thread.id).toBe(ask)
  })

  it('fileMessage: a question never joins as a bare reaction (the reaction join)', () => {
    // A bare reaction still goes to the node's newest answer; a question is never one, so it opens its own.
    const { f, a } = twoQuestions()
    const later = 3 * 3600
    const ok = chat(f, 'ok thanks', later)
    expect(ok.joined).toBe('reaction')
    expect(ok.thread.id).toBe(a)
    const q = chat(f, 'does the paint need a primer first', later)
    expect(q.created).toBe(true)
    expect(q.joined).toBeUndefined()
  })

  it('a Follow up that names a thread keeps today\'s rules', () => {
    const { f, a } = twoQuestions()
    const r = fileMessage(f, { text: 'and how long does it take to dry?', via: 'follow-up', threadId: a, at: at(90) })
    expect(r.thread.id).toBe(a)
    expect(r.created).toBe(false)
  })

  it('a short question right after his last message keeps today\'s join', () => {
    const { f, b } = twoQuestions()
    expect(chat(f, 'why?', 70).thread.id).toBe(b)
  })
})

describe('mergeThreads: a thread his question opened stays its own', () => {
  it('mergeThreads: a node\'s merge of his question is refused, and he may merge it himself', () => {
    const { f, a, b } = twoQuestions()
    let err: unknown
    try { mergeThreads(f, b, a, NODE, at(100)) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ThreadError)
    expect((err as ThreadError).code).toBe('own_question')
    expect((err as ThreadError).status).toBe(409)
    expect((err as ThreadError).message).toContain(b)
    expect((err as ThreadError).message).toContain('give it a title that says what this question asks')
    expect(() => mergeThreads(f, b, a, 'agent', at(100))).toThrow(/own question/)
    // His own merge goes through.
    expect(mergeThreads(f, b, a, 'human', at(100)).thread.messages.map((m) => m.text)).toEqual([Q_A, Q_B])
  })

  it('mergeThreads: the very same question asked twice may merge', () => {
    const { f, a } = twoQuestions()
    const again = fileMessage(f, { text: `  ${Q_A.toUpperCase()} `, via: 'chat', at: at(2 * 3600), joinRecent: SAME_CONVERSATION_MS })
    expect(again.created).toBe(true)
    expect(mergeThreads(again.file, again.thread.id, a, NODE, at(2 * 3600 + 5)).thread.id).toBe(a)
  })

  it('mergeThreads: a thread no question opened merges as before, and off nothing is refused', () => {
    const one = chat(emptyThreads(TASK), 'the fence needs paint', 0)
    const two = chat(one.file, 'the gate too', 2 * 3600)
    expect(mergeThreads(two.file, two.thread.id, one.thread.id, NODE, at(2 * 3600 + 5)).thread.messages).toHaveLength(2)
    setEachQuestion(false)
    const { f, a, b } = twoQuestions()
    // Off: B joined A at filing; a separate question thread merges as today.
    expect(b).toBe(a)
    const lone = chat(f, 'which brush is best?', 3 * 3600)
    expect(mergeThreads(lone.file, lone.thread.id, a, NODE, at(3 * 3600 + 5)).thread.id).toBe(a)
  })

  it('splitMessageInto: his question that opened its thread is not moved into another, a remark is', () => {
    const { f, a, b } = twoQuestions()
    const withRemark = chat(f, REMARK, 80).file
    const bThread = withRemark.threads.find((t) => t.id === b)!
    expect(() => splitMessageInto(withRemark, b, bThread.messages[0].id, a, NODE, at(100))).toThrow(/own question/)
    const moved = splitMessageInto(withRemark, b, bThread.messages[1].id, a, NODE, at(100))
    expect(moved.thread.messages.map((m) => m.text)).toEqual([Q_A, REMARK])
    // A question that joined by timing before the switch (it opened nothing) moves as today.
    setEachQuestion(false)
    const old = chat(chat(emptyThreads(TASK), 'paint the fence', 0).file, 'which colour though?', 30).file
    const src = old.threads[0]
    const other = chat(old, 'the gate hinge squeaks', 4 * 3600).file
    const into = other.threads.find((t) => t.id !== src.id)!.id
    setEachQuestion(true)
    expect(splitMessageInto(other, src.id, src.messages[1].id, into, NODE, at(4 * 3600 + 5)).thread.id).toBe(into)
  })

  it('splitWhereItIs: a split the check already did is not merged into another thread when it holds his question', () => {
    const { f, a, b } = twoQuestions()
    // As the check leaves it: his question alone at the head of its own thread, gone from the source it was asked from.
    const qId = f.threads.find((t) => t.id === b)!.messages[0].id
    // The node asks to move it from the thread it was asked from (`a` here) into `a`: it would go under that thread.
    expect(() => splitWhereItIs(f, a, qId, a, NODE, at(100))).toThrow(/own question/)
    expect(f.threads.find((t) => t.id === b)!.messages).toHaveLength(1)
    // Into the thread that holds it already: done, nothing moves.
    expect(splitWhereItIs(f, a, qId, b, NODE, at(100))?.thread.id).toBe(b)
    setEachQuestion(false)
    expect(splitWhereItIs(f, a, qId, a, NODE, at(100))?.thread.id).toBe(a)
  })

  it('ownQuestionOf: never a thread the node opened, never a letter\'s answer', () => {
    const t = (over: Partial<OrgThread>): OrgThread => ({ id: 'th-aaaaaa', title: 'x', state: 'new', createdAt: at(0), updatedAt: at(0), messages: [{ id: 'tm-aaaaaa', at: at(0), text: Q_A, via: 'chat' }], ...over })
    expect(ownQuestionOf(t({}))?.text).toBe(Q_A)
    expect(ownQuestionOf(t({ opener: { text: 'The vendor wrote.', at: at(0), from: 'mail', by: NODE } as never }))).toBeUndefined()
    expect(ownQuestionOf(t({ messages: [{ id: 'tm-aaaaaa', at: at(0), text: Q_A, via: 'letter' }] }))).toBeUndefined()
    // A message moved in later is not the one that opened it.
    expect(ownQuestionOf(t({ createdAt: at(5) }))).toBeUndefined()
  })
})

describe('the status question and its answer (status-thread-title.ts)', () => {
  it('settleHeldTitles: the status answer\'s merge of his question is refused and its title stays held', () => {
    const { f, a, b } = twoQuestions()
    const held = holdRepeatTitles(f, [{ id: b, title: 'Outdoor paint choice for the north garden fence' }], at(100))
    expect([...held.held]).toEqual([b])
    const s = settleHeldTitles(held.file, [{ id: b, into: a }], [{ id: b, into: a }], NODE, at(110))
    expect(s.merged).toEqual([])
    expect(s.titled).toEqual([])
    const bt = s.file.threads.find((t) => t.id === b)!
    expect(bt.titleHeld).toMatchObject({ title: 'Outdoor paint choice for the north garden fence', like: a })
    expect(bt.titled).toBeFalsy()
    // Off: the same answer merges it.
    setEachQuestion(false)
    expect(settleHeldTitles(held.file, [{ id: b, into: a }], [{ id: b, into: a }], NODE, at(110)).merged.map((m) => m.from)).toEqual([b])
  })

  it('the next question asks his question a title of its own and offers no merge', () => {
    setThreadsKept(true)
    const { f, a, b } = twoQuestions()
    const file = holdRepeatTitles(f, [{ id: b, title: 'Outdoor paint choice for the north garden fence' }], at(100)).file
    const bt = file.threads.find((t) => t.id === b)!
    expect(heldTitleOf(file, bt)).toMatchObject({ like: a, own: true })
    expect(nearThreads(file, bt, T0 + 120_000)).toEqual([])
    const q = threadQuestionOf(file, { org_role: undefined } as never, { carded: new Set(), dropped: new Set(), last: new Map() }, undefined, T0 + 120_000)
    const ref = [...q.refs].find(([, r]) => r.id === b)![0]
    expect(q.refs.get(ref)).toMatchObject({ untitled: true, own: true })
    expect(q.refs.get(ref)!.mergeInto).toBeUndefined()
    expect(q.block).toContain(`His own questions whose title repeats another listed thread: ${ref}, which you titled "Outdoor paint choice for the north garden fence"`)
    expect(q.block).toContain('give it a title that says what this question asks, and answer it there (FOR_USER_THREAD_TITLE: <ref> | <title>)')
    expect(q.block).not.toContain('FOR_USER_THREAD_MERGE')
    expect(q.block).not.toContain(MERGE_UNTITLED_LINE)
  })

  it('off, the held title is offered as a merge, as before', () => {
    setThreadsKept(true)
    const one = chat(emptyThreads(TASK), Q_A, 0)
    let f = updateThread(one.file, one.thread.id, { title: 'Outdoor paint choice for the north garden fence', state: 'working' }, NODE, at(30)).file
    f = chat(f, Q_B, 2 * 3600).file
    const b = f.threads.find((t) => t.id !== one.thread.id)!.id
    setEachQuestion(false)
    const file = holdRepeatTitles(f, [{ id: b, title: 'Outdoor paint choice for the north garden fence' }], at(2 * 3600 + 100)).file
    expect(heldTitleOf(file, file.threads.find((t) => t.id === b)!)?.own).toBeUndefined()
    const q = threadQuestionOf(file, { org_role: undefined } as never, { carded: new Set(), dropped: new Set(), last: new Map() }, undefined, T0 + 2 * 3600_000 + 120_000)
    expect(q.block).toContain('The same subject: FOR_USER_THREAD_MERGE: <ref> | <that ref>')
    expect(mergeQuestionPart([{ ref: 't2', likeRef: 't1', held: { title: 'x', like: one.thread.id, likeTitle: 'y' } }])).toMatch(/^Threads whose title repeats another listed one/)
  })

  it('an untitled thread of his that asks nothing is still offered for a merge beside his question', () => {
    setThreadsKept(true)
    let f = chat(emptyThreads(TASK), Q_A, 0).file
    f = chat(f, 'the gate hinge squeaks', 2 * 3600).file
    const q = threadQuestionOf(f, { org_role: undefined } as never, { carded: new Set(), dropped: new Set(), last: new Map() }, undefined, T0 + 2 * 3600_000 + 60_000)
    expect(q.block).toContain(MERGE_UNTITLED_LINE)
    const only = chat(emptyThreads(TASK), Q_A, 0).file
    const q2 = threadQuestionOf(chat(only, Q_B, 2 * 3600).file, { org_role: undefined } as never, { carded: new Set(), dropped: new Set(), last: new Map() }, undefined, T0 + 2 * 3600_000 + 60_000)
    expect(q2.block).not.toContain(MERGE_UNTITLED_LINE)
  })
})

describe('what nodes are told', () => {
  const hint = (over: Partial<ThreadHintState>): ThreadHintState => ({
    threadId: 'th-bbbbbb', title: Q_B, created: true, followUp: false, duplicate: false, closed: [],
    open: [{ id: 'th-aaaaaa', title: 'Outdoor paint choice for the north garden fence', state: 'working' }], ...over,
  })

  it('the filing hint offers no merge for a thread his question opened', () => {
    const on = threadHintText(hint({ question: true }))
    expect(on).toContain('His own question: its own thread')
    expect(on).not.toContain('merge')
    expect(threadHintText(hint({}))).toContain('Same subject as one: thread_update merge_into')
    const card = threadHintText(hint({ question: true, card: true, untitled: true }))
    expect(card).not.toContain('merge=')
    expect(threadHintText(hint({ card: true, untitled: true }))).toContain('merge="th-..."')
  })

  it('the related threads are context, not a merge, for his question', () => {
    const related = [{ id: 'th-cccccc', title: 'Fence stain samples', state: 'answered' as const }]
    expect(relatedThreadsText(related as never, 'th-bbbbbb', new Set(), 'own')).toContain('his question stays its own thread')
    expect(relatedThreadsText(related as never, 'th-bbbbbb', new Set(), 'own')).not.toContain('merge')
    expect(relatedThreadsText(related as never, 'th-bbbbbb')).toContain('merge_into')
  })

  it('the turn-end check about answers before his message does not ask to merge his question', () => {
    const { f, a, b } = twoQuestions()
    const his = { at: at(60), thread: f.threads.find((t) => t.id === b)! }
    const answered = [f.threads.find((t) => t.id === a)!]
    expect(answeredBeforeHimReason(answered, his)).toContain('his question stays its own thread')
    expect(answeredBeforeHimReason(answered, his)).not.toContain('merge_into')
    setEachQuestion(false)
    expect(answeredBeforeHimReason(answered, his)).toContain('merge his message into it (thread_update merge_into)')
  })

  it('the thread check pairs no two of his questions, and keeps his question as the card that stays', () => {
    const { f, a, b } = twoQuestions()
    const tree = (file: ThreadsFile) => [{ task: { id: TASK, title: 'Fence work' }, threads: file.threads }] as never
    const named = updateThread(f, b, { reply: `Same as ${a}.` }, NODE, at(100)).file
    expect(repeatCandidates(TASK, tree(named), T0 + 200_000)).toEqual([])
    // His question beside a thread that asks nothing: that one goes into his.
    const remark = chat(named, 'the gate hinge squeaks', 4 * 3600)
    const withLink = updateThread(remark.file, remark.thread.id, { reply: `See ${b}.` }, NODE, at(4 * 3600 + 10)).file
    const pairs = repeatCandidates(TASK, tree(withLink), T0 + 4 * 3600_000 + 60_000)
    const pair = pairs.find((p) => [p.a.thread.id, p.b.thread.id].includes(remark.thread.id))!
    expect(pair).toBeDefined()
    expect(repeatFinding(pair, 'one subject').other!.id).toBe(b)
    setEachQuestion(false)
    expect(repeatCandidates(TASK, tree(named), T0 + 200_000).length).toBeGreaterThan(0)
  })
})
