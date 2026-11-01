/**
 * An Org node's Threads (src/core/org/threads-model.ts): the user's own requests, one thread per
 * subject. Pure steps: filing a message, the node's updates, merge and split, close and reopen.
 */
import { describe, it, expect } from 'vitest'
import {
  CLOSED_KEPT, emptyThreads, fallbackTitle, fileMessage, mergeThreads, normalizeThreads,
  sortedThreads, splitThreadMessage, ThreadError, updateThread, type ThreadsFile,
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

  it('keeps every open thread and the newest closed ones', () => {
    let f = emptyThreads('n')
    for (let i = 0; i < CLOSED_KEPT + 5; i++) {
      const r = fileMessage(f, { text: `ask ${i}`, via: 'chat', at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString() })
      f = updateThread(r.file, r.thread.id, { close: 'acked' }, 'human', new Date(Date.UTC(2026, 9, 2) + i * 60_000).toISOString()).file
    }
    f = fileMessage(f, { text: 'still open', via: 'chat', at: at(0) }).file
    expect(f.threads.filter((t) => t.closed)).toHaveLength(CLOSED_KEPT)
    expect(f.threads.some((t) => t.messages[0].text === 'ask 0')).toBe(false)
    expect(f.threads.some((t) => !t.closed)).toBe(true)
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
