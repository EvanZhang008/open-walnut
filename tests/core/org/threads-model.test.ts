/**
 * An Org node's Threads (src/core/org/threads-model.ts): the user's own requests, one thread per
 * subject. Pure steps: filing a message, the node's updates, merge and split, close and reopen.
 */
import { describe, it, expect } from 'vitest'
import {
  CLOSED_KEEP_MS, CLOSED_KEPT, emptyThreads, fallbackTitle, fileMessage, mergeThreads, normalizeThreads, openThread,
  setAnswers, sortedThreads, splitThreadMessage, sweepClosed, ThreadError, updateThread, type ThreadAnswer, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString()

function file(...texts: string[]): ThreadsFile {
  let f = emptyThreads('lead-1')
  texts.forEach((text, i) => { f = fileMessage(f, { text, via: 'chat', at: at(i * 10) }).file })
  return f
}

describe('filing the user\'s messages', () => {
  it('a message opens a new thread titled by its first line, and nothing is lost', () => {
    const r = fileMessage(emptyThreads('lead-1'), { text: '\n\n# Website: merge 1 and 10\nmore words', images: ['/tmp/a.png'], via: 'chat', at: at(0) })
    expect(r.created).toBe(true)
    expect(r.thread.title).toBe('Website: merge 1 and 10')
    expect(r.thread.state).toBe('new')
    expect(r.thread.messages).toHaveLength(1)
    expect(r.message.images).toEqual(['/tmp/a.png'])
    expect(r.file.threads).toHaveLength(1)
  })

  it('a picture alone is still a request', () => {
    expect(fallbackTitle('')).toBe('A picture')
  })

  it('a long first line is cut to a readable title', () => {
    const t = fallbackTitle('x'.repeat(300))
    expect(t.length).toBeLessThanOrEqual(80)
    expect(t.endsWith('…')).toBe(true)
  })

  it('a follow-up goes under its open thread, and an answered one is the node\'s turn again', () => {
    const f0 = file('Org page needs Threads')
    const id = f0.threads[0].id
    const answered = updateThread(f0, id, { state: 'answered', reply: 'Design sent' }, 'task:lead-1', at(5)).file
    const r = fileMessage(answered, { text: 'and group asks about one thing', via: 'follow-up', threadId: id, at: at(20) })
    expect(r.created).toBe(false)
    expect(r.thread.id).toBe(id)
    expect(r.thread.messages.map((m) => m.text)).toEqual(['Org page needs Threads', 'and group asks about one thing'])
    expect(r.thread.state).toBe('working')
    expect(r.file.threads).toHaveLength(1)
  })

  it('a follow-up on a closed thread opens a new thread that follows it (asked again after an acknowledge)', () => {
    const f0 = file('Fix the hint labels')
    const id = f0.threads[0].id
    const closed = updateThread(f0, id, { close: 'acked' }, 'human', at(5)).file
    const r = fileMessage(closed, { text: 'the labels are wrong again', via: 'follow-up', threadId: id, at: at(30) })
    expect(r.created).toBe(true)
    expect(r.thread.follows).toBe(id)
    expect(r.file.threads).toHaveLength(2)
  })

  it('a follow-up naming a thread that is gone still files the message', () => {
    const r = fileMessage(file('one'), { text: 'two', via: 'follow-up', threadId: 'th-000000000000', at: at(40) })
    expect(r.created).toBe(true)
    expect(r.file.threads).toHaveLength(2)
  })

  it('a retry of one send (its key) is one message; the same words in two sends are two', () => {
    const f0 = fileMessage(emptyThreads('n'), { text: 'Ship it', via: 'chat', key: 'qm-1', at: at(0) }).file
    const again = fileMessage(f0, { text: 'Ship it', via: 'chat', key: 'qm-1', at: at(1) })
    expect(again.duplicate).toBe(true)
    expect(again.file).toBe(f0)
    // "yes" to two questions a minute apart: two answers, never one.
    const yes1 = fileMessage(emptyThreads('n'), { text: 'yes', via: 'chat', at: at(0) }).file
    const yes2 = fileMessage(yes1, { text: 'yes', via: 'chat', at: at(1) })
    expect(yes2.duplicate).toBe(false)
    expect(yes2.file.threads).toHaveLength(2)
    // A Follow up "ok" in B is B's, whatever A's last words were.
    let f = fileMessage(emptyThreads('n'), { text: 'ok', via: 'chat', at: at(0) }).file
    f = fileMessage(f, { text: 'second subject', via: 'chat', at: at(1) }).file
    const b = f.threads[1]
    const ok = fileMessage(f, { text: 'ok', via: 'follow-up', threadId: b.id, at: at(2) })
    expect(ok.duplicate).toBe(false)
    expect(ok.thread.id).toBe(b.id)
  })

  it('the same planned message filed twice (two writers racing) is stored once', () => {
    const draft = { text: 'x', via: 'chat' as const, at: at(0), newThreadId: 'th-abcdef123456', messageId: 'tm-abcdef123456' }
    const once = fileMessage(emptyThreads('n'), draft).file
    const twice = fileMessage(once, draft)
    expect(twice.duplicate).toBe(true)
    expect(twice.file.threads).toHaveLength(1)
  })

  it('ids chosen ahead are kept, so the node is told the id before the message is stored', () => {
    const r = fileMessage(emptyThreads('n'), { text: 'x', via: 'chat', at: at(0), newThreadId: 'th-abcdef123456', messageId: 'tm-abcdef123456' })
    expect(r.thread.id).toBe('th-abcdef123456')
    expect(r.message.id).toBe('tm-abcdef123456')
  })

  it('a message past the cap is clipped, never refused', () => {
    const r = fileMessage(emptyThreads('n'), { text: 'y'.repeat(20_000), via: 'chat', at: at(0) })
    expect(r.message.text.length).toBeLessThanOrEqual(8000)
  })
})

describe('the node keeps a thread current', () => {
  it('title, ask, state, reply and tasks', () => {
    const f0 = file('long voice message about the org page being a mess')
    const id = f0.threads[0].id
    const { thread } = updateThread(f0, id, {
      title: 'Org: a Threads tab', ask: 'One thread per request', state: 'working', reply: 'Handed to **Threads**', tasks: ['t-1', 't-1', 'bad id!'],
    }, 'task:lead-1', at(3))
    expect(thread).toMatchObject({ title: 'Org: a Threads tab', titled: true, ask: 'One thread per request', state: 'working', reply: 'Handed to **Threads**', tasks: ['t-1'], by: 'task:lead-1' })
    const more = updateThread({ ...f0, threads: [thread] }, id, { add_tasks: ['t-2', 't-1'], ask: '', reply: '' }, 'task:lead-1', at(4)).thread
    expect(more.tasks).toEqual(['t-1', 't-2'])
    expect(more.ask).toBeUndefined()
    expect(more.reply).toBeUndefined()
  })

  it('refuses a bad state, a blank title, and close with reopen', () => {
    const f0 = file('x')
    const id = f0.threads[0].id
    expect(() => updateThread(f0, id, { state: 'done' as never }, 'human', at(1))).toThrow(ThreadError)
    expect(() => updateThread(f0, id, { title: '  ' }, 'human', at(1))).toThrow(ThreadError)
    expect(() => updateThread(f0, id, { close: 'acked', reopen: true }, 'human', at(1))).toThrow(ThreadError)
    expect(() => updateThread(f0, 'th-ffffffffffff', { state: 'working' }, 'human', at(1))).toThrow(/No thread/)
  })

  it('Acknowledge closes it (who and when kept); Reopen opens it again', () => {
    const f0 = file('x')
    const id = f0.threads[0].id
    const closed = updateThread(f0, id, { close: 'acked' }, 'human', at(9))
    expect(closed.thread.closed).toEqual({ how: 'acked', at: at(9), by: 'human' })
    const reopened = updateThread(closed.file, id, { reopen: true }, 'human', at(10))
    expect(reopened.thread.closed).toBeUndefined()
  })

  it('closing a closed thread again keeps its close (who, when, told)', () => {
    const f0 = file('x')
    const id = f0.threads[0].id
    const closed = updateThread(f0, id, { close: 'acked' }, 'human', at(9)).file
    const told = { ...closed, threads: closed.threads.map((t) => ({ ...t, closed: { ...t.closed!, told: true } })) }
    const again = updateThread(told, id, { close: 'acked' }, 'task:lead-1', at(12))
    expect(again.thread.closed).toEqual({ how: 'acked', at: at(9), by: 'human', told: true })
  })
})

describe('a pending thread: only handed off or being worked on, out of his sight until there is news', () => {
  // 2026-11-01, the user: "if it is just assigned no need to tell me, or doing, unless there are
  // some update ... there can be thread pending, which is auto hide like closed".
  const pending = () => {
    const f0 = file('build the Threads view')
    const id = f0.threads[0].id
    return { id, f: updateThread(f0, id, { state: 'pending', reply: 'Handed to the Threads task', add_tasks: ['t-1'] }, 'task:lead-1', at(2)).file }
  }

  it('the node sets it, with its summary in the same write, and it stays pending', () => {
    const { id, f } = pending()
    expect(f.threads.find((t) => t.id === id)).toMatchObject({ state: 'pending', reply: 'Handed to the Threads task', tasks: ['t-1'] })
  })

  it('a new summary brings it back; the same summary, a title, tasks or an explicit state do not', () => {
    const { id, f } = pending()
    const same = (patch: Parameters<typeof updateThread>[2]) => updateThread(f, id, patch, 'task:lead-1', at(5)).thread.state
    expect(same({ reply: 'Handed to the Threads task' })).toBe('pending')
    expect(same({ title: 'Threads: build it' })).toBe('pending')
    expect(same({ add_tasks: ['t-2'] })).toBe('pending')
    expect(same({ reply: 'Done; live on prod, check the card', state: 'pending' })).toBe('pending')
    expect(same({ reply: 'Built; it needs your call on the default view' })).toBe('answered')
    expect(same({ reply: 'Still building', state: 'working' })).toBe('working')
    expect(same({ reply: 'Built; which default?', state: 'needs', user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' })).toBe('needs')
  })

  it('a new summary without a state on a working or new thread is news too (answered); an answered one stays answered', () => {
    const f0 = file('build it')
    const id = f0.threads[0].id
    expect(updateThread(f0, id, { reply: 'Found the cause' }, 'task:lead-1', at(1)).thread.state).toBe('answered')
    const working = updateThread(f0, id, { state: 'working', reply: 'On it' }, 'task:lead-1', at(1)).file
    expect(updateThread(working, id, { reply: 'Fixed and live' }, 'task:lead-1', at(2)).thread.state).toBe('answered')
    const needs = updateThread(f0, id, { state: 'needs', reply: 'Which one?', user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' }, 'task:lead-1', at(1)).file
    expect(updateThread(needs, id, { reply: 'Which one: A or B?' }, 'task:lead-1', at(2)).thread.state).toBe('needs')
  })

  it('he writes in it (a follow-up, or the node merges his new ask under it): it is the node\'s turn again', () => {
    const { id, f } = pending()
    expect(fileMessage(f, { text: 'and keep it short', via: 'follow-up', threadId: id, at: at(6) }).thread.state).toBe('working')
    const asked = fileMessage(f, { text: 'also the empty state', via: 'chat', at: at(7) })
    expect(mergeThreads(asked.file, asked.thread.id, id, 'task:lead-1', at(8)).thread.state).toBe('working')
  })

  it('is a state the file keeps (a reload reads it back)', () => {
    const { f } = pending()
    expect(normalizeThreads(JSON.parse(JSON.stringify(f)), 'lead-1').threads[0].state).toBe('pending')
  })
})

describe('several asks about one subject are one thread', () => {
  it('merge puts the messages under the target in time order, with its tasks, and the source is gone', () => {
    let f = file('Hints: show which are built in', 'Rich output should not be built in')
    const [a, b] = f.threads
    f = updateThread(f, b.id, { add_tasks: ['t-9'] }, 'task:lead-1', at(15)).file
    const { file: merged, thread } = mergeThreads(f, b.id, a.id, 'task:lead-1', at(20))
    expect(merged.threads.map((t) => t.id)).toEqual([a.id])
    expect(thread.messages.map((m) => m.text)).toEqual(['Hints: show which are built in', 'Rich output should not be built in'])
    expect(thread.tasks).toEqual(['t-9'])
  })

  it('never into itself, never into a closed thread (that ask stays its own thread)', () => {
    let f = file('one', 'two')
    const [a, b] = f.threads
    expect(() => mergeThreads(f, a.id, a.id, 'human', at(30))).toThrow(ThreadError)
    f = updateThread(f, a.id, { close: 'acked' }, 'human', at(31)).file
    expect(() => mergeThreads(f, b.id, a.id, 'human', at(32))).toThrow(/closed/)
    // Nor a closed one into an open one: that would open it again unasked.
    expect(() => mergeThreads(f, a.id, b.id, 'human', at(33))).toThrow(/reopen it first/)
  })

  it('a wrong merge is split back out: the message becomes its own thread, the rest stays', () => {
    let f = file('Website redesign', 'Inbox and Needs action are two things')
    const [a, b] = f.threads
    f = mergeThreads(f, b.id, a.id, 'task:lead-1', at(25)).file
    const msg = f.threads[0].messages[1]
    const out = splitThreadMessage(f, a.id, msg.id, 'human', at(26))
    expect(out.from.messages.map((m) => m.text)).toEqual(['Website redesign'])
    expect(out.thread.messages.map((m) => m.text)).toEqual(['Inbox and Needs action are two things'])
    expect(out.thread.title).toBe('Inbox and Needs action are two things')
    expect(out.file.threads).toHaveLength(2)
    // A thread keeps one message: nothing left to split.
    expect(() => splitThreadMessage(out.file, out.thread.id, msg.id, 'human', at(27))).toThrow(/at least one/)
  })

  it('splitting the first message out of a thread Walnut titled re-titles what is left', () => {
    let f = file('first ask', 'second ask')
    const [a, b] = f.threads
    f = mergeThreads(f, b.id, a.id, 'human', at(25)).file
    const out = splitThreadMessage(f, a.id, f.threads[0].messages[0].id, 'human', at(26))
    expect(out.from.title).toBe('second ask')
  })
})

describe('reading and keeping', () => {
  it('open first by last change, then closed by close time', () => {
    let f = file('a', 'b', 'c')
    const [a, b, c] = f.threads
    f = updateThread(f, a.id, { close: 'acked' }, 'human', at(50)).file
    f = updateThread(f, c.id, { state: 'working' }, 'task:x', at(40)).file
    expect(sortedThreads(f.threads).map((t) => t.id)).toEqual([c.id, b.id, a.id])
  })

  it('a closed thread is kept a week, then deleted for good; open ones never are', () => {
    const day = 24 * 3600_000
    const t0 = Date.UTC(2026, 9, 1)
    let f = file('done long ago', 'done yesterday', 'still open')
    const [old, recent] = f.threads
    f = updateThread(f, old.id, { close: 'acked' }, 'human', new Date(t0).toISOString()).file
    f = updateThread(f, recent.id, { close: 'acked' }, 'human', new Date(t0 + 7 * day).toISOString()).file
    const swept = sweepClosed(f, new Date(t0 + CLOSED_KEEP_MS + day).toISOString())
    expect(swept.dropped).toBe(1)
    expect(swept.file.threads.map((t) => t.messages[0].text)).toEqual(['done yesterday', 'still open'])
    // Nothing past its week: the same file back, nothing written.
    expect(sweepClosed(swept.file, new Date(t0 + 8 * day).toISOString()).file).toBe(swept.file)
    // A write prunes too, so an old close never outlives the next change.
    const next = fileMessage(f, { text: 'new ask', via: 'chat', at: new Date(t0 + CLOSED_KEEP_MS + day).toISOString() }).file
    expect(next.threads.some((t) => t.id === old.id)).toBe(false)
  })

  it('and never more than the cap of closed ones within the week', () => {
    let f = emptyThreads('n')
    for (let i = 0; i < CLOSED_KEPT + 5; i++) {
      const r = fileMessage(f, { text: `ask ${i}`, via: 'chat', at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString() })
      f = updateThread(r.file, r.thread.id, { close: 'acked' }, 'human', new Date(Date.UTC(2026, 9, 1, 12) + i * 60_000).toISOString()).file
    }
    expect(f.threads.filter((t) => t.closed)).toHaveLength(CLOSED_KEPT)
    expect(f.threads.some((t) => t.messages[0].text === 'ask 0')).toBe(false)
  })

  it('a broken or hand-edited file reads as the threads it can, never a crash', () => {
    expect(normalizeThreads(null, 'n').threads).toEqual([])
    const raw = { threads: [
      null, { id: 'x' }, { id: 'th-1', messages: [] },
      // Missing times, state and close time: repaired from its messages, still sortable.
      { id: 'th-2', messages: [{ id: 'tm-1', at: at(3), text: 'hello' }, { bad: true }], closed: { how: 'acked' } },
      { id: 'th-3', title: '', state: 'weird', messages: [{ id: 'tm-2', at: at(4), text: 'second' }], closed: { how: 'nope' } },
    ] }
    const f = normalizeThreads(raw, 'n')
    expect(f.threads.map((t) => t.id)).toEqual(['th-2', 'th-3'])
    expect(f.threads[0]).toMatchObject({ updatedAt: at(3), createdAt: at(3), title: 'hello', state: 'new', closed: { how: 'acked', at: at(3), by: 'human' } })
    expect(f.threads[0].messages).toHaveLength(1)
    expect(f.threads[1]).toMatchObject({ title: 'second', state: 'new' })
    expect(f.threads[1].closed).toBeUndefined()
    expect(() => sortedThreads(f.threads)).not.toThrow()
  })
})

const answer = (min: number, text = 'An answer'): ThreadAnswer => ({ text, at: at(min) })

describe('the node\'s answers, and what he already knows', () => {
  it('answers land on their messages by id, wherever a merge moved them; one already kept stays', () => {
    let f = file('one', 'two')
    const [a, b] = f.threads
    f = mergeThreads(f, b.id, a.id, 'task:lead-1', at(15)).file
    const [m1, m2] = f.threads[0].messages
    const r = setAnswers(f, new Map([[m1.id, answer(5)], [m2.id, answer(16, 'x'.repeat(20_000))]]))
    expect(r.changed).toEqual([a.id])
    expect(r.file.threads[0].messages[0].answer?.text).toBe('An answer')
    expect(r.file.threads[0].messages[1].answer).toMatchObject({ clipped: true })
    // Read again (a second turn end): nothing changes.
    expect(setAnswers(r.file, new Map([[m1.id, answer(30, 'other')]])).changed).toEqual([])
  })

  it('the user\'s case: the node answers, he says nothing, the node cannot close or fold it (silence is not knowing)', () => {
    let f = file('what is the small model?')
    const t = f.threads[0]
    f = setAnswers(f, new Map([[t.messages[0].id, answer(3)]])).file
    expect(() => updateThread(f, t.id, { close: 'acked' }, 'task:lead-1', at(4))).toThrow(/not written to you since/)
    expect(() => updateThread(f, t.id, { close: 'dropped' }, 'task:lead-1', at(4))).toThrow(ThreadError)
    expect(() => updateThread(f, t.id, { known: 'all' }, 'task:lead-1', at(4))).toThrow(/not reacted|not written/)
    // It stays open, answered, for him.
    const ok = updateThread(f, t.id, { state: 'answered' }, 'task:lead-1', at(4)).thread
    expect(ok.closed).toBeUndefined()
    expect(ok.known).toBeUndefined()
    // His own Acknowledge needs no check.
    expect(updateThread(f, t.id, { close: 'acked' }, 'human', at(4)).thread.closed?.by).toBe('human')
  })

  it('once he wrote after the answer, the node may mark it known and close it', () => {
    let f = file('what is the small model?')
    const t = f.threads[0]
    f = setAnswers(f, new Map([[t.messages[0].id, answer(3)]])).file
    // He writes again (here in another thread: the node judges it a reaction).
    f = fileMessage(f, { text: 'ok, thanks', via: 'chat', at: at(5) }).file
    const known = updateThread(f, t.id, { known: t.messages[0].id }, 'task:lead-1', at(6))
    expect(known.thread.known).toEqual({ through: t.messages[0].id, by: 'task:lead-1', at: at(6) })
    expect(updateThread(known.file, t.id, { close: 'acked' }, 'task:lead-1', at(7)).thread.closed).toMatchObject({ how: 'acked', by: 'task:lead-1' })
    // A message id that is not in the thread is refused, never stored.
    expect(() => updateThread(f, t.id, { known: 'tm-ffffffffffff' }, 'task:lead-1', at(6))).toThrow(/No message/)
    expect(() => updateThread(f, t.id, { known: 'nope' }, 'task:lead-1', at(6))).toThrow(ThreadError)
  })

  it('an answer that came after his last message is not known even when an older one is', () => {
    let f = file('first')
    const t = f.threads[0]
    f = fileMessage(f, { text: 'second', via: 'follow-up', threadId: t.id, at: at(10) }).file
    const [m1, m2] = f.threads[0].messages
    f = setAnswers(f, new Map([[m1.id, answer(5)], [m2.id, answer(12)]])).file
    expect(updateThread(f, t.id, { known: m1.id }, 'task:lead-1', at(13)).thread.known?.through).toBe(m1.id)
    // A mark past what he reacted to is cut back to it.
    expect(updateThread(f, t.id, { known: m2.id }, 'task:lead-1', at(13)).thread.known?.through).toBe(m1.id)
    expect(updateThread(f, t.id, { known: 'all' }, 'task:lead-1', at(13)).thread.known?.through).toBe(m1.id)
  })
})

describe('a thread the node opens itself', () => {
  it('opens with the node\'s first post and where it came from; his Follow up is filed under it', () => {
    const o = openThread(emptyThreads('lead-1'), { title: 'Mail: the meetup asks about the talk', text: 'The organizer wrote: confirm the slot by Friday?', from: 'mail', ref: 'Talk slot', user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' }, 'task:lead-1', at(0))
    expect(o.thread).toMatchObject({ titled: true, state: 'needs', messages: [], opener: { from: 'mail', ref: 'Talk slot', by: 'task:lead-1', at: at(0) } })
    const r = fileMessage(o.file, { text: 'yes, confirm it', via: 'follow-up', threadId: o.thread.id, at: at(5) })
    expect(r.created).toBe(false)
    expect(r.thread.id).toBe(o.thread.id)
    expect(r.thread.messages.map((m) => m.text)).toEqual(['yes, confirm it'])
    // He answered: the node's turn again.
    expect(r.thread.state).toBe('working')
    // It survives a read from disk with no message of his yet.
    expect(normalizeThreads(JSON.parse(JSON.stringify(o.file)), 'lead-1').threads[0].opener?.text).toBe('The organizer wrote: confirm the slot by Friday?')
  })

  it('his chat message about it merges into it, never the other way; the react rule holds for its first post too', () => {
    let f = openThread(emptyThreads('lead-1'), { title: 'A team needs your call', text: 'Ship on Monday or wait?', from: 'task', user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' }, 'task:lead-1', at(0)).file
    const opened = f.threads[0]
    expect(() => updateThread(f, opened.id, { close: 'acked' }, 'task:lead-1', at(1))).toThrow(/not written/)
    // Dropping its own post he never saw is the node's call.
    expect(updateThread(f, opened.id, { close: 'dropped' }, 'task:lead-1', at(1)).thread.closed?.how).toBe('dropped')
    f = fileMessage(f, { text: 'wait until Tuesday', via: 'chat', at: at(3) }).file
    const mine = f.threads.find((t) => t.id !== opened.id)!
    expect(() => mergeThreads(f, opened.id, mine.id, 'task:lead-1', at(4))).toThrow(/merge .* into it instead/)
    f = mergeThreads(f, mine.id, opened.id, 'task:lead-1', at(4)).file
    expect(f.threads).toHaveLength(1)
    expect(f.threads[0].messages.map((m) => m.text)).toEqual(['wait until Tuesday'])
    // A split of his only message leaves the node's post standing.
    const out = splitThreadMessage(f, opened.id, f.threads[0].messages[0].id, 'human', at(5))
    expect(out.from.messages).toEqual([])
    expect(out.from.opener?.text).toBe('Ship on Monday or wait?')
  })

  it('refuses a blank title or post and an unknown source', () => {
    const e = emptyThreads('n')
    expect(() => openThread(e, { title: ' ', text: 'x', from: 'mail' }, 'task:x', at(0))).toThrow(ThreadError)
    expect(() => openThread(e, { title: 'x', text: ' ', from: 'mail' }, 'task:x', at(0))).toThrow(ThreadError)
    expect(() => openThread(e, { title: 'x', text: 'y', from: 'fax' as never }, 'task:x', at(0))).toThrow(/from must be/)
  })
})
