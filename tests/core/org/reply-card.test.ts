/**
 * A reply's card lines land on their threads exactly as the status question's lines do (experiment
 * threads_reply_tag, src/core/org/reply-card.ts; 2026-11-25, the user, translated: "in what it
 * returns, it adds this tag. Then it is both its reply to me and its reply to the thread").
 *
 * The card line and the status line are two ways to say the same thing, so each state here is
 * written both ways and must come out as the same report fields (status-threads.ts readThreadLines)
 * and, through the one planner both use (planThreadWrites), as the same threads file. A decision
 * line becomes the thread_update it stands for; a line is fenced by what the reply saw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reply-card'))

import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { setReplyTag } from '../../../src/core/org/reply-card-switch.js'
import { cardLines, seenUpTo, tagsReplies, type ReplySaw } from '../../../src/core/org/reply-card.js'
import { askedAlready, CardLineLacks, needsKey, needsPatch, notOpenReason, upAlready } from '../../../src/core/org/reply-card-decision.js'
import { CARD_STOP_LINES, cardStopReason, owedMessage } from '../../../src/core/org/reply-card-stop.js'
import { readCardTags, type CardTag } from '../../../src/lib/card-tag.js'
import { listForQuestion, planThreadWrites, PROGRESS_MAX, readThreadLines, threadQuestionBlock } from '../../../src/core/sessions/status-threads.js'
import { emptyThreads, fileMessage, setAnswers, updateThread, ThreadError, THREAD_TITLE_MAX, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { openNotWaiting } from '../../../src/core/org/thread-view.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 25, 20, min)).toISOString()
const ALL: ReplySaw = { queued: new Set() }
afterEach(() => { setThreadsKept(false); setReplyTag(false) })

/** Run the planned writes the way threads-store.ts writeOwnThreads does: each in turn, a refused one left out. */
function apply(file: ThreadsFile, plan: ReturnType<typeof planThreadWrites>, when: string): ThreadsFile {
  for (const w of plan.writes) {
    for (const p of [w.patch, w.fallback]) {
      if (!p) continue
      try { file = updateThread(file, w.id, p, 'task:lead-1', when, undefined, { line: true }).file; break } catch (err) { if (!(err instanceof ThreadError)) throw err }
    }
  }
  return file
}

/** Two of his threads: "fence" answered at 1 and he wrote again at 5 (in another thread), "seeds" new and untitled. */
function twoThreads(): ThreadsFile {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'how tall should the orchard fence be?', via: 'chat', at: at(0) }).file
  const fence = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Two metres keeps the deer out.', at: at(1) }]])).file
  f = updateThread(f, fence, { title: 'Orchard fence', state: 'answered', reply: 'Two metres keeps the deer out.' }, 'task:lead-1', at(1)).file
  f = fileMessage(f, { text: 'ok, now order the seeds for spring', via: 'chat', at: at(5) }).file
  return f
}

/** The same lines as the status question reads them: the question lists the open threads, the answer names them by ref. */
function viaStatusQuestion(file: ThreadsFile, answer: (ref: (id: string) => string) => string[]) {
  const { listed, his } = listForQuestion(file, file.threads.filter(openNotWaiting))
  const { refs } = threadQuestionBlock(listed, undefined, { org: true, his })
  const ref = (id: string) => [...refs.entries()].find(([, r]) => r.id === id)![0]
  return readThreadLines(answer(ref).join('\n'), refs)
}

const viaReply = (file: ThreadsFile, lines: string[], saw = ALL) => {
  const read = readCardTags(['The fence is up and the seeds are picked.', '', ...lines].join('\n'))
  expect(read.errors).toEqual([])
  return cardLines(file, read.cards, saw)
}

const written = (file: ThreadsFile, f: { threads?: unknown; thread_titles?: unknown; threads_seen?: unknown }) => apply(
  file,
  planThreadWrites(file, (f.threads ?? []) as never, [], { ...(f.thread_titles ? { titles: f.thread_titles as never } : {}), ...(f.threads_seen ? { seen: f.threads_seen as never } : {}) }),
  at(6),
)

describe('a card line is the status question\'s line, written in the reply', () => {
  it.each(['working', 'waiting', 'answered', 'done'] as const)('%s: the same fields, and the same thread after the write', (state) => {
    setThreadsKept(true)
    const f = twoThreads()
    const seeds = f.threads[1].id
    const asked = viaStatusQuestion(f, (ref) => [`FOR_USER_THREAD: ${ref(seeds)} | ${state} | Two suppliers compared; the order goes out Friday.`])
    const tagged = viaReply(f, [`<walnut-card thread="${seeds}" state="${state}" summary="Two suppliers compared; the order goes out Friday."/>`])
    expect(tagged.fields).toEqual(asked)
    expect(tagged.refused).toEqual([])
    expect(tagged.spoke).toEqual([{ id: seeds, upTo: f.threads[1].messages[0].id }])
    const after = written(f, tagged.fields)
    expect(after).toEqual(written(f, asked))
    // And it did write: the thread is no longer as it was.
    expect(after.threads[1]).not.toEqual(f.threads[1])
  })

  it('a state with no summary is the line with no words', () => {
    setThreadsKept(true)
    const f = twoThreads()
    const seeds = f.threads[1].id
    const asked = viaStatusQuestion(f, (ref) => [`FOR_USER_THREAD: ${ref(seeds)} | working`])
    const tagged = viaReply(f, [`<walnut-card thread="${seeds}" state="working"/>`])
    expect(tagged.fields).toEqual(asked)
    expect(written(f, tagged.fields)).toEqual(written(f, asked))
  })

  it('a title and a reaction ride it as the question\'s title and seen lines: named, known, closed', () => {
    setThreadsKept(true)
    const f = twoThreads()
    const [fence, seeds] = f.threads
    const asked = viaStatusQuestion(f, (ref) => [
      `FOR_USER_THREAD: ${ref(fence.id)} | done | Two metres, posts are set.`,
      `FOR_USER_THREAD: ${ref(seeds.id)} | working | Comparing two suppliers.`,
      `FOR_USER_THREAD_TITLE: ${ref(seeds.id)} | Spring seed order`,
      `FOR_USER_THREAD_SEEN: ${ref(fence.id)}`,
    ])
    const tagged = viaReply(f, [
      `<walnut-card thread="${fence.id}" state="done" summary="Two metres, posts are set." seen="yes"/>`,
      `<walnut-card thread="${seeds.id}" state="working" summary="Comparing two suppliers." title="Spring seed order"/>`,
    ])
    expect(tagged.fields).toEqual(asked)
    const after = new Map(written(f, tagged.fields).threads.map((t) => [t.id, t]))
    expect(written(f, tagged.fields)).toEqual(written(f, asked))
    expect(after.get(fence.id)?.closed?.how).toBe('acked')
    expect(after.get(fence.id)?.known).toBeTruthy()
    expect(after.get(seeds.id)).toMatchObject({ title: 'Spring seed order', titled: true, state: 'working', reply: 'Comparing two suppliers.' })
  })

  it('a title for a thread that has one and a reaction he never wrote are left out, as the question never asks them', () => {
    setThreadsKept(true)
    const f = twoThreads()
    const [fence, seeds] = f.threads
    const tagged = viaReply(f, [
      `<walnut-card thread="${fence.id}" state="answered" title="Another name"/>`,
      `<walnut-card thread="${seeds.id}" state="working" seen="yes"/>`,
    ])
    expect(tagged.fields.thread_titles).toBeUndefined()
    expect(tagged.fields.threads_seen).toBeUndefined()
    expect(tagged.fields.threads?.map((l) => l.id)).toEqual([fence.id, seeds.id])
  })

  it('a summary and a title are cut where the status line\'s are', () => {
    const f = twoThreads()
    const seeds = f.threads[1].id
    const tagged = viaReply(f, [`<walnut-card thread="${seeds}" state="working" summary="${'seed '.repeat(80)}" title="${'Spring '.repeat(40)}"/>`])
    expect(tagged.fields.threads?.[0].progress?.length).toBeLessThanOrEqual(PROGRESS_MAX)
    expect(tagged.fields.thread_titles?.[0].title?.length).toBeLessThanOrEqual(THREAD_TITLE_MAX)
  })
})

describe('what a line may not write', () => {
  it('a thread that waits on him gets no line, as the question asks none for it', () => {
    let f = twoThreads()
    const seeds = f.threads[1].id
    f = updateThread(f, seeds, { state: 'needs', ask: 'Which supplier?', reply: 'Two suppliers, one decision.', options: [{ label: 'Larch Seeds', recommended: true }, { label: 'Oak Seeds' }], user_kind: 'spending', user_kind_why: 'the dearer one is twice the budget' }, 'task:lead-1', at(6)).file
    const tagged = viaReply(f, [`<walnut-card thread="${seeds}" state="working" summary="Still comparing."/>`])
    expect(tagged.fields).toEqual({})
    expect(tagged.spoke).toEqual([])
  })

  it('a thread that is closed, moved or not the task\'s is refused with one reason', () => {
    let f = twoThreads()
    const [fence, seeds] = f.threads
    f = updateThread(f, fence.id, { close: 'acked' }, 'user', at(6)).file
    f = { ...f, threads: f.threads.map((t) => (t.id === seeds.id ? { ...t, movedTo: { task: 't-9', title: 'Seed team' } } as OrgThread : t)) }
    expect(notOpenReason(f, fence.id)).toMatch(/is closed: a new ask about it is a new thread/)
    expect(notOpenReason(f, seeds.id)).toMatch(/moved to Seed team \(t-9\) with its work/)
    expect(notOpenReason(f, 'th-0000000000ff')).toMatch(/is no thread of this task/)
    const tagged = viaReply(f, [`<walnut-card thread="${fence.id}" state="done"/>`, `<walnut-card thread="${seeds.id}" state="working"/>`, '<walnut-card thread="th-0000000000ff" state="working"/>'])
    expect(tagged.fields).toEqual({})
    expect(tagged.refused.map((r) => r.thread)).toEqual([fence.id, seeds.id, 'th-0000000000ff'])
  })

  it('a message of his the reply never saw fences the line out of its thread', () => {
    setThreadsKept(true)
    // He wrote in the seeds thread again, and that message has no answer yet.
    let f = twoThreads()
    const seeds = f.threads[1].id
    f = setAnswers(f, new Map([[f.threads[1].messages[0].id, { text: 'On it: I compare two suppliers.', at: at(6) }]])).file
    f = fileMessage(f, { text: 'make it the early variety', via: 'chat', at: at(7), threadId: seeds }).file
    const thread = f.threads.find((t) => t.id === seeds)!
    expect(thread.messages).toHaveLength(2)
    const line = [`<walnut-card thread="${seeds}" state="answered" summary="Ordered from the first supplier."/>`]
    // Nothing of it waits, and both were filed before the turn ended: the reply read both, and the line is written.
    expect(seenUpTo(thread, ALL)).toBe(thread.messages[1].id)
    expect(seenUpTo(thread, { queued: new Set(), endedAt: at(8) })).toBe(thread.messages[1].id)
    expect(written(f, viaReply(f, line).fields).threads.find((t) => t.id === seeds)?.reply).toBe('Ordered from the first supplier.')
    // It is still in the session's queue, or it was filed after the turn ended: the line saw only the first.
    for (const saw of [{ queued: new Set([seeds]) }, { queued: new Set<string>(), endedAt: at(6) }] as ReplySaw[]) {
      expect(seenUpTo(thread, saw)).toBe(thread.messages[0].id)
      const tagged = viaReply(f, line, saw)
      expect(tagged.spoke).toEqual([{ id: seeds, upTo: thread.messages[0].id }])
      expect(written(f, tagged.fields)).toEqual(f)
    }
  })
})

describe('a decision line is the thread_update it stands for', () => {
  const card: CardTag = { thread: 'th-aaaaaa02', state: 'needs', ask: 'Which wood for the fence?', options: ['Larch', 'Oak'], kind: 'spending', why: 'oak is twice the budget' }

  it('the ask, the choices with the first recommended, his kind and why; the ask is the card\'s words unless a summary is given', () => {
    expect(needsPatch({ title: 'Orchard fence', titled: true, state: 'working' }, card)).toEqual({
      state: 'needs', ask: 'Which wood for the fence?', reply: 'Which wood for the fence?',
      options: [{ label: 'Larch', recommended: true }, { label: 'Oak' }], user_kind: 'spending', user_kind_why: 'oak is twice the budget',
    })
    expect(needsPatch({ title: 'Orchard fence', titled: true, state: 'working' }, { ...card, summary: 'Larch lasts 15 years, oak 30.' }).reply).toBe('Larch lasts 15 years, oak 30.')
  })

  it('a title goes on only an untitled thread', () => {
    expect(needsPatch({ title: 'how tall should', state: 'new' }, { ...card, title: 'Fence wood' }).title).toBe('Fence wood')
    expect(needsPatch({ title: 'Orchard fence', titled: true, state: 'working' }, { ...card, title: 'Fence wood' }).title).toBeUndefined()
  })

  it('the model\'s own checks hold: a decision with no choices is refused by name', () => {
    const f = twoThreads()
    const seeds = f.threads[1]
    expect(() => updateThread(f, seeds.id, needsPatch(seeds, { thread: seeds.id, state: 'needs', ask: 'Which supplier?' }), 'task:lead-1', at(6))).toThrow(ThreadError)
    const ok = updateThread(f, seeds.id, needsPatch(seeds, { ...card, thread: seeds.id }), 'task:lead-1', at(6)).thread
    expect(ok).toMatchObject({ state: 'needs', ask: 'Which wood for the fence?', reply: 'Which wood for the fence?' })
    expect(ok.options?.map((o) => o.label)).toEqual(['Larch', 'Oak'])
  })

  it('the same line again is the same write; any other word is another', () => {
    expect(needsKey(card)).toBe(needsKey({ ...card }))
    expect(needsKey(card)).not.toBe(needsKey({ ...card, ask: 'Which wood?' }))
    expect(needsKey(card)).not.toBe(needsKey({ ...card, options: ['Oak', 'Larch'] }))
  })

  it('a decision already up on its thread with these words and choices is not written again', () => {
    const up = { state: 'needs' as const, ask: 'Which wood for the fence?', options: [{ label: 'Larch', recommended: true }, { label: 'Oak' }] }
    expect(askedAlready(up, card)).toBe(true)
    // Another question, other choices, a thread that waits on him no more, or a closed one: another write.
    expect(askedAlready(up, { ...card, ask: 'Which wood?' })).toBe(false)
    expect(askedAlready(up, { ...card, options: ['Larch', 'Oak', 'Pine'] })).toBe(false)
    expect(askedAlready({ ...up, state: 'working' }, card)).toBe(false)
    expect(askedAlready({ ...up, closed: { how: 'acked', at: at(7), by: 'user' } }, card)).toBe(false)
    // A decision with no choices, asked the same way.
    expect(askedAlready({ state: 'needs', ask: 'Which supplier?' }, { thread: 'th-aaaaaa02', state: 'needs', ask: 'Which supplier?' })).toBe(true)
  })

  it('what a write after his words needs is passed on: since as since_you_wrote, decision as decision', () => {
    const p = needsPatch({ title: 'Orchard fence', titled: true, state: 'working' }, { ...card, since: 'Measured the gap again.', decision: 'same' })
    expect(p).toMatchObject({ since_you_wrote: 'Measured the gap again.', decision: 'same' })
    expect(needsPatch({ title: 'Orchard fence', titled: true, state: 'working' }, card)).not.toHaveProperty('since_you_wrote')
    expect(needsKey({ ...card, decision: 'same' })).not.toBe(needsKey({ ...card, decision: 'new' }))
    expect(needsKey({ ...card, since: 'Measured.' })).not.toBe(needsKey(card))
  })

  it('a new decision already up on the thread Walnut opened for it is not opened again; another line is judged on its own thread only', () => {
    const opened = { id: 'th-aaaaaa09', title: 'Fence wood', state: 'needs' as const, ask: 'Which wood for the fence?', options: [{ label: 'Larch', recommended: true }, { label: 'Oak' }] } as OrgThread
    const old = { id: 'th-aaaaaa02', title: 'Orchard fence', state: 'answered' as const } as OrgThread
    expect(upAlready([old, opened], { ...card, decision: 'new' })).toBe(true)
    expect(upAlready([old, opened], card)).toBe(false)
    expect(upAlready([old, opened], { ...card, decision: 'same' })).toBe(false)
  })

  // 2026-11-25, a live walk (turn d): the store's refusal named since_you_wrote and the op, the
  // session wrote that into its line, and the line was dropped. The send-back names the line's own
  // attributes, all it lacks at once: there is no second send-back.
  it('a decision refused as a return is sent back in the line\'s own attributes, all at once', () => {
    const both = cardStopReason([CARD_STOP_LINES.returned('th-aaaaaa02', ['since', 'decision'])])
    expect(both).toBe('Walnut: the decision on th-aaaaaa02 was not put to him: he wrote on it since it last waited on him. '
      + 'Its line again with since="what you did about his message" and decision="same" (this decision again) or "new" (another: Walnut answers this thread and opens it as its own card). '
      + 'Write only this line now, and no other words about it: anything else you add is shown to him as chat.')
    expect(CARD_STOP_LINES.returned('th-aaaaaa02', ['decision'])).toBe('the decision on th-aaaaaa02 was not put to him: it asked him a decision before. '
      + 'Its line again with decision="same" (this decision again) or "new" (another: Walnut answers this thread and opens it as its own card).')
    expect(CARD_STOP_LINES.returned('th-aaaaaa02', ['since'])).toMatch(/he wrote on it .* with since="what you did about his message"\.$/)
    // Every attribute it names is one a card line reads.
    for (const attr of [...both.matchAll(/\b([a-z_]+)="/g)].map((m) => m[1])) expect(readCardTags(`<walnut-card thread="th-aaaaaa02" state="needs" ask="Which wood?" ${attr}="same"/>`).errors, attr).toEqual([])
    expect(both).not.toMatch(/thread_update|thread_create|since_you_wrote|walnut tools/)
    expect(new CardLineLacks('th-aaaaaa02', ['since', 'decision']).lacks).toEqual(['since', 'decision'])
  })
})

describe('who writes card lines', () => {
  const task = { id: 't-1', threads_on: true }
  const lead = { id: 'lead-1', org_role: 'lead' as const }

  it('off: nobody', () => {
    setThreadsKept(true)
    expect(tagsReplies(task)).toBe(false)
    expect(tagsReplies(lead)).toBe(false)
  })

  it('on: a task with Threads on, and Main and a lead where Walnut keeps their threads; never a task without Threads', () => {
    setReplyTag(true)
    expect(tagsReplies(task)).toBe(true)
    expect(tagsReplies({ id: 't-2' })).toBe(false)
    expect(tagsReplies(lead)).toBe(false)
    setThreadsKept(true)
    expect(tagsReplies(lead)).toBe(true)
    expect(tagsReplies(null)).toBe(false)
  })
})

// 2026-11-25: on a server that kept no answers, the check before a turn's end took every older
// message as this turn's and sent a session back for a thread its turn never touched.
describe('the message a turn owes a line for', () => {
  const SID = 'sess-1'
  const now = Date.parse(at(10))
  const thread = (messages: Array<{ id: string; min: number; answered?: boolean; sid?: string }>): OrgThread => ({
    id: 'th-0wed0001', title: 'Orchard fence', state: 'working', createdAt: at(0), updatedAt: at(0),
    messages: messages.map((m) => ({ id: m.id, at: at(m.min), text: 'how tall?', via: 'chat' as const, sid: m.sid ?? SID, ...(m.answered ? { answer: { text: 'Two metres.', at: at(m.min + 1) } } : {}) })),
  } as OrgThread)

  it('his newest message this session read and has not answered', () => {
    expect(owedMessage(thread([{ id: 'tm-1', min: 1, answered: true }, { id: 'tm-2', min: 5 }]), SID, now)?.id).toBe('tm-2')
    expect(owedMessage(thread([{ id: 'tm-1', min: 1, answered: true }]), SID, now)).toBeNull()
    expect(owedMessage(thread([{ id: 'tm-1', min: 1, sid: 'sess-other' }]), SID, now)).toBeNull()
  })

  it('one filed before a turn that has ended is not this turn\'s, with no answer kept under it', () => {
    const t = thread([{ id: 'tm-1', min: 1 }, { id: 'tm-2', min: 5 }])
    // The last turn's end saw his messages up to minute 5: neither is owed.
    expect(owedMessage(t, SID, now, at(5))).toBeNull()
    // It saw them up to minute 1: the one of minute 5 is this turn's.
    expect(owedMessage(t, SID, now, at(1))?.id).toBe('tm-2')
    // Nothing known (a restart): as before, the newest with no answer.
    expect(owedMessage(t, SID, now, undefined)?.id).toBe('tm-2')
  })
})
