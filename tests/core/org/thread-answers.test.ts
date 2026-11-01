/**
 * The node's answer to each of the user's thread messages, read from its own chat
 * (src/core/org/thread-answers.ts answersFromRows). The rows have the shape of a busy lead's chat
 * on 2026-11-01: Walnut notices between his messages, acknowledgement-only replies, a notice
 * delivered into a running turn after a tool call, a message batched behind a notice, two
 * messages answered by one reply, a reply still being written.
 */
import { describe, it, expect } from 'vitest'
import { answersFromRows, pendingBySession, type AnswerRow } from '../../../src/core/org/thread-answers.js'
import type { OrgThread, ThreadMessage } from '../../../src/core/org/threads-model.js'
import { buildLetterDeliveryText } from '../../../src/core/human-inbox/letter-ops.js'

const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 10, 1, 4, min, sec)).toISOString()
const person = (min: number, text: string): AnswerRow => ({ role: 'user', sentBy: 'person', text, timestamp: at(min) })
const notice = (min: number, body = 'A task you follow changed its status.'): AnswerRow => ({
  role: 'user', sentBy: 'agent', timestamp: at(min),
  text: `<walnut-message kind="notification" from="Walnut" outcome="status" note="status changes of tasks you follow, not a work request">\n${body}\n</walnut-message>`,
})
const says = (min: number, text: string, about?: string[]): AnswerRow => ({ role: 'assistant', text, timestamp: at(min), ...(about ? { about } : {}) })
const tool = (min: number): AnswerRow => ({ role: 'assistant', kind: 'tool', text: 'Bash', timestamp: at(min) })
const thinks = (min: number): AnswerRow => ({ role: 'assistant', kind: 'thinking', text: 'Looking', timestamp: at(min) })
const ACK = '<walnut-turn status="agent-ack"/>'
/** The chat is finished up to here (its turn ended). */
const END = at(59)
const m = (id: string, min: number, text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ id, at: at(min), text, via: 'chat', ...extra })

describe('the answer to each message', () => {
  const rows: AnswerRow[] = [
    notice(20), says(20.2, ACK),
    person(24, 'what is the small model?'),
    notice(24.3), says(25, 'It is the fast model in the local config.'),
    person(26, 'who asked you to do this?'),
    person(26.2, 'do not do this, why?'),
    notice(26.5), thinks(27), tool(27), says(27.5, 'Let me check who started it.'), tool(27.6),
    // A notice delivered into the running turn after a tool call: the turn goes on.
    notice(27.7), tool(27.8),
    says(28, 'Nobody asked. I stopped all of it.\n\n<walnut-about tasks="task-1"/>'),
    notice(28.5), says(28.6, ACK),
  ]

  it('the last words of the turn that first spoke after it; two messages before a reply share it', () => {
    const msgs = [m('tm-1', 24, 'what is the small model?'), m('tm-2', 26, 'who asked you to do this?'), m('tm-3', 26.2, 'do not do this, why?')]
    const got = answersFromRows(msgs, rows, { wholeUntil: END })
    expect(got.get('tm-1')).toEqual({ text: 'It is the fast model in the local config.', at: at(25) })
    expect(got.get('tm-2')?.text).toMatch(/^Nobody asked/)
    expect(got.get('tm-3')).toEqual(got.get('tm-2'))
    expect(got.get('tm-2')?.about).toEqual(['task-1'])
  })

  it('a reply still being written is not kept: no finish time, a run past it, or a run ending on a tool call', () => {
    const msgs = [m('tm-2', 26, 'who asked you to do this?')]
    // The turn is still going (nothing after its last words yet): its words so far are not the answer.
    expect(answersFromRows(msgs, rows.slice(0, 15), { wholeUntil: null }).size).toBe(0)
    // A turn ended at 27.9, and its rows after that are the next turn's, still talking.
    expect(answersFromRows(msgs, rows.slice(0, 15), { wholeUntil: at(27, 54) }).size).toBe(0)
    // Read before the last words reached the transcript: it ends on a tool call.
    expect(answersFromRows(msgs, rows.slice(0, 13), { wholeUntil: END }).size).toBe(0)
    expect(answersFromRows(msgs, rows, { wholeUntil: END }).get('tm-2')?.text).toMatch(/^Nobody asked/)
    // A run a later message of his closed is whole whatever the finish time.
    const closed = [...rows.slice(0, 15), person(29, 'next'), says(30, 'Next answer.')]
    expect(answersFromRows(msgs, closed, { wholeUntil: null }).get('tm-2')?.text).toMatch(/^Nobody asked/)
  })

  it('an answered message holds its row: the second "yes" is not given the first one\'s answer', () => {
    const r = [person(1, 'yes'), says(2, 'First yes noted.'), person(5, 'yes'), says(6, 'Second yes noted.')]
    const first = m('tm-c', 1, 'yes', { answer: { text: 'First yes noted.', at: at(2) } })
    const got = answersFromRows([first, m('tm-d', 4.5, 'yes')], r, { wholeUntil: END })
    expect([...got.keys()]).toEqual(['tm-d'])
    expect(got.get('tm-d')?.text).toBe('Second yes noted.')
  })

  it('his words batched behind a Walnut notice in one row still match', () => {
    const batched = [{ ...notice(1), sentBy: 'person', text: `${notice(1).text}\n\nuse the command line instead` }, says(2, 'Switched to it.')]
    expect(answersFromRows([m('tm-1', 1, 'use the command line instead')], batched, { wholeUntil: END }).get('tm-1')?.text).toBe('Switched to it.')
  })

  it('exactly his words: "this" is not "this has subagents", and "yes" twice is two rows', () => {
    const r = [person(1, 'this has subagents but shows one speed'), says(2, 'Speed per model, handed on.'), person(3, 'this'), says(4, 'Forwarded the screenshot.'),
      person(5, 'yes'), says(6, 'First yes noted.'), person(7, 'yes'), says(8, 'Second yes noted.')]
    const got = answersFromRows([m('tm-a', 3, 'this'), m('tm-b', 1, 'this has subagents but shows one speed'), m('tm-c', 5, 'yes'), m('tm-d', 7, 'yes')], r, { wholeUntil: END })
    expect(got.get('tm-a')?.text).toBe('Forwarded the screenshot.')
    expect(got.get('tm-b')?.text).toBe('Speed per model, handed on.')
    expect(got.get('tm-c')?.text).toBe('First yes noted.')
    expect(got.get('tm-d')?.text).toBe('Second yes noted.')
  })

  it('pictures and a picture alone match by their path; a letter answer by its note', () => {
    const header = '[Images attached — use the Read tool to view them]\n- /tmp/open-walnut/images/1-a.jpg\n\n'
    const letter = buildLetterDeliveryText({ id: 'lt-1', subject: 'Website: ten designs' }, { choice: 'Pick', text: 'combine 1 and 10' })
    const r = [person(1, `${header}it should say which is built in`), says(2, 'Labels added.'), person(3, header), says(4, 'Got the picture.'),
      { role: 'user', sentBy: 'agent', text: letter, timestamp: at(5) }, says(6, 'Combining them.')]
    const got = answersFromRows([
      m('tm-1', 1, 'it should say which is built in', { images: ['/tmp/open-walnut/images/1-a.jpg'] }),
      m('tm-2', 3, '', { images: ['/tmp/open-walnut/images/1-a.jpg'] }),
      m('tm-3', 5, 'combine 1 and 10', { via: 'letter', about: 'Website: ten designs' }),
    ], r, { wholeUntil: END })
    expect([...got.values()].map((a) => a.text)).toEqual(['Labels added.', 'Got the picture.', 'Combining them.'])
  })

  it('a message with no row (or no reply after it) gets nothing; a row far off in time is not his', () => {
    expect(answersFromRows([m('tm-1', 1, 'never sent')], rows, { wholeUntil: END }).size).toBe(0)
    expect(answersFromRows([m('tm-1', 30, 'what is the small model?')], [person(30, 'what is the small model?'), notice(31)], { wholeUntil: END }).size).toBe(0)
    const late = [{ ...person(0, 'old words'), timestamp: new Date(Date.UTC(2026, 9, 1)).toISOString() }, says(1, 'old reply')]
    expect(answersFromRows([m('tm-1', 0, 'old words')], late, { wholeUntil: END }).size).toBe(0)
  })
})

describe('which messages are still looked for', () => {
  it('the recent ones of every session with one still waiting (answered ones hold their rows), else the node\'s own session', () => {
    const now = Date.parse(at(60))
    const t = (messages: ThreadMessage[]): OrgThread => ({ id: 'th-aaaaaaaaaaaa', title: 'x', state: 'new', messages, createdAt: at(0), updatedAt: at(0) })
    const got = pendingBySession([t([
      m('tm-1', 1, 'a', { sid: 's-old' }), m('tm-2', 2, 'b'), m('tm-3', 3, 'c', { answer: { text: 'C', at: at(4) } }),
      { ...m('tm-4', 0, 'd'), at: new Date(now - 15 * 24 * 3600_000).toISOString() },
    ])], 's-now', now)
    expect([...got.entries()].map(([sid, ms]) => [sid, ms.map((x) => x.id)])).toEqual([['s-old', ['tm-1']], ['s-now', ['tm-2', 'tm-3']]])
    // A session whose messages are all answered is not read.
    const done = pendingBySession([t([m('tm-5', 3, 'c', { answer: { text: 'C', at: at(4) } })])], 's-now', now)
    expect(done.size).toBe(0)
  })
})
