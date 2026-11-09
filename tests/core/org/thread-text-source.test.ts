/**
 * Who wrote each piece of an Org thread (src/core/org/threads-model.ts, thread-answers.ts): the
 * summary's writer, the first post's, each answer's (2026-11-07: a summary's path opened on the
 * node's current machine, though an older session on another host wrote it).
 *
 *  - a summary records its writer's verified session only when its words change; a pin, a close,
 *    a state move, or the same words sent again by another session keep the writer it had;
 *  - the user's summary is the primary's; a caller Walnut could not place leaves it unknown;
 *  - a file from before the fields existed reads unknown, never guessed; a hand edit is checked;
 *  - an answer keeps the session whose transcript (or letter turn) it was read from, never the
 *    message's own `sid`; a letter turn with no writer recorded keeps none.
 */
import { describe, it, expect } from 'vitest'
import {
  emptyThreads, fileMessage, normalizeThreads, openThread, setAnswers, updateThread, type ThreadAnswer, type ThreadPatch, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'
import { answersFromRows, letterAnswerOf, type AnswerRow, type LetterTurn } from '../../../src/core/org/thread-answers.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 7, 4, min)).toISOString()
const REMOTE = { sid: 'sid-old-remote', host: 'devbox' }
const LOCAL = { sid: 'sid-new-local', host: '__local__' }

function oneThread(): { file: ThreadsFile; id: string } {
  const r = fileMessage(emptyThreads('lead-1'), { text: 'where are the notes?', via: 'chat', at: at(0), sid: LOCAL.sid })
  return { file: r.file, id: r.thread.id }
}

const sourceOf = (f: ThreadsFile, id: string) => {
  const t = f.threads.find((x) => x.id === id)!
  return { reply: t.reply, reply_by: t.reply_by, reply_sid: t.reply_sid, reply_host: t.reply_host }
}

describe('the summary keeps the session that wrote it', () => {
  it('records the writer of the words; a later write that leaves them alone keeps it, whoever writes', () => {
    let { file, id } = oneThread()
    file = updateThread(file, id, { reply: 'Notes in /home/me/notes.txt:2', state: 'answered' }, 'task:lead-1', at(1), REMOTE).file
    const written = { reply: 'Notes in /home/me/notes.txt:2', reply_by: 'task:lead-1', reply_sid: REMOTE.sid, reply_host: REMOTE.host }
    expect(sourceOf(file, id)).toEqual(written)
    // The node moved to a local session: its pin, its title, a state move that repeats the same
    // words, the user's close: none of them wrote the summary.
    file = updateThread(file, id, { pin: true }, 'task:lead-1', at(2), LOCAL).file
    file = updateThread(file, id, { title: 'Notes' }, 'task:lead-1', at(3), LOCAL).file
    file = updateThread(file, id, { state: 'answered', reply: '  Notes in /home/me/notes.txt:2  ' }, 'task:lead-1', at(4), LOCAL).file
    expect(sourceOf(file, id)).toEqual(written)
    file = updateThread(file, id, { close: 'acked' }, 'human', at(5)).file
    expect(sourceOf(file, id)).toEqual(written)
    expect(file.threads[0].closed?.how).toBe('acked')
    // Read back from disk the same.
    expect(sourceOf(normalizeThreads(JSON.parse(JSON.stringify(file)), 'lead-1'), id)).toEqual(written)
  })

  it('new words take their own writer; cleared words take the writer away', () => {
    let { file, id } = oneThread()
    file = updateThread(file, id, { reply: 'First' }, 'task:lead-1', at(1), REMOTE).file
    file = updateThread(file, id, { reply: 'Second' }, 'task:lead-1', at(2), LOCAL).file
    expect(sourceOf(file, id)).toEqual({ reply: 'Second', reply_by: 'task:lead-1', reply_sid: LOCAL.sid, reply_host: LOCAL.host })
    file = updateThread(file, id, { reply: '' }, 'task:lead-1', at(3), LOCAL).file
    expect(sourceOf(file, id)).toEqual({ reply: undefined, reply_by: undefined, reply_sid: undefined, reply_host: undefined })
  })

  it('the user\'s words are the primary\'s (no session even if one is handed in); an unplaced caller is unknown', () => {
    let { file, id } = oneThread()
    file = updateThread(file, id, { reply: 'Mine' }, 'human', at(1), REMOTE).file
    expect(sourceOf(file, id)).toEqual({ reply: 'Mine', reply_by: 'human', reply_sid: undefined, reply_host: undefined })
    file = updateThread(file, id, { reply: 'An agent with no session Walnut knows' }, 'agent', at(2)).file
    expect(sourceOf(file, id)).toEqual({ reply: 'An agent with no session Walnut knows', reply_by: 'agent', reply_sid: undefined, reply_host: undefined })
  })

  it('a patch carries no writer: fields named like it are not patch fields and change nothing', () => {
    let { file, id } = oneThread()
    const forged = { reply: 'Forged', reply_sid: 'sid-forged', reply_by: 'human', sid: 'sid-forged', host: 'evil' } as ThreadPatch
    file = updateThread(file, id, forged, 'task:lead-1', at(1), REMOTE).file
    expect(sourceOf(file, id)).toEqual({ reply: 'Forged', reply_by: 'task:lead-1', reply_sid: REMOTE.sid, reply_host: REMOTE.host })
  })
})

describe('a thread file from before the writer was recorded, or edited by hand', () => {
  const raw = (thread: Record<string, unknown>) => normalizeThreads({ threads: [{ id: 'th-aaaaaaaaaaaa', messages: [{ id: 'tm-aaaaaaaaaaaa', at: at(0), text: 'hi' }], ...thread }] }, 'lead-1').threads[0]

  it('an old summary has no writer: none is made up', () => {
    const t = raw({ reply: 'Old summary with /home/me/notes.txt' })
    expect(t.reply).toBe('Old summary with /home/me/notes.txt')
    expect([t.reply_by, t.reply_sid, t.reply_host]).toEqual([undefined, undefined, undefined])
  })

  it('a session with no writer, a session on the user\'s words, a non-string or a writer with no words is dropped', () => {
    expect(raw({ reply: 'x', reply_sid: 'sid-1' }).reply_sid).toBeUndefined()
    expect(raw({ reply: 'x', reply_by: 'human', reply_sid: 'sid-1', reply_host: 'devbox' })).toMatchObject({ reply_by: 'human' })
    expect(raw({ reply: 'x', reply_by: 'human', reply_sid: 'sid-1' }).reply_sid).toBeUndefined()
    expect(raw({ reply: 'x', reply_by: 'task:a', reply_sid: 42, reply_host: 'devbox' }).reply_host).toBeUndefined()
    expect(raw({ reply_by: 'task:a', reply_sid: 'sid-1' }).reply_by).toBeUndefined()
    expect(raw({ reply: 'x', reply_by: 'task:a', reply_sid: 'sid-1', reply_host: 'devbox' })).toMatchObject({ reply_sid: 'sid-1', reply_host: 'devbox' })
  })

  it('an answer and a first post keep only a well-formed session; the user\'s first post keeps none', () => {
    const t = raw({
      messages: [
        { id: 'tm-aaaaaaaaaaaa', at: at(0), text: 'a', sid: 'sid-sent-to', answer: { text: 'old answer', at: at(1) } },
        { id: 'tm-bbbbbbbbbbbb', at: at(2), text: 'b', answer: { text: 'new answer', at: at(3), sid: 'sid-read', host: 'devbox' } },
        { id: 'tm-cccccccccccc', at: at(4), text: 'c', answer: { text: 'bad', at: at(5), sid: { x: 1 }, host: 'devbox' } },
      ],
      opener: { text: 'From mail', at: at(0), from: 'mail', by: 'human', sid: 'sid-x', host: 'devbox' },
    })
    // The message's own sid is where his words went, never the answer's writer.
    expect(t.messages[0].answer).toEqual({ text: 'old answer', at: at(1) })
    expect(t.messages[1].answer).toMatchObject({ sid: 'sid-read', host: 'devbox' })
    expect(t.messages[2].answer?.sid).toBeUndefined()
    expect(t.messages[2].answer?.host).toBeUndefined()
    expect(t.opener?.sid).toBeUndefined()
    expect(t.opener?.host).toBeUndefined()
  })
})

describe('the first post of a thread the node opened', () => {
  it('records the opener\'s verified session; the user\'s and an unplaced caller\'s record none', () => {
    const input = { title: 'From mail', text: 'Invoice at /home/me/inv.pdf', from: 'mail' as const, state: 'answered' as const }
    expect(openThread(emptyThreads('lead-1'), input, 'task:lead-1', at(0), REMOTE).thread.opener).toMatchObject({ by: 'task:lead-1', sid: REMOTE.sid, host: REMOTE.host })
    const human = openThread(emptyThreads('lead-1'), input, 'human', at(0), REMOTE).thread.opener!
    expect([human.sid, human.host]).toEqual([undefined, undefined])
    const agent = openThread(emptyThreads('lead-1'), input, 'agent', at(0)).thread.opener!
    expect([agent.by, agent.sid]).toEqual(['agent', undefined])
  })
})

describe('an answer keeps the session it was read from', () => {
  const rows: AnswerRow[] = [
    { role: 'user', sentBy: 'person', text: 'where are the notes?', timestamp: at(0) },
    { role: 'assistant', text: 'In /home/me/notes.txt:2', timestamp: at(1) },
  ]
  const msg = (extra: Record<string, unknown> = {}) => ({ id: 'tm-aaaaaaaaaaaa', at: at(0), text: 'where are the notes?', via: 'chat' as const, ...extra })

  it('the transcript actually read names it, also when the message went to another session (the node\'s fallback)', () => {
    // The message names no session (filed before Walnut kept one), or another one: the answer was
    // read from the node's own chat, and that chat is its writer.
    for (const m of [msg(), msg({ sid: 'sid-sent-to' })]) {
      const got = answersFromRows([m], rows, { wholeUntil: at(59), source: LOCAL }).get(m.id)!
      expect(got).toMatchObject({ text: 'In /home/me/notes.txt:2', sid: LOCAL.sid, host: LOCAL.host })
    }
    // No source handed in (an older caller): no writer, not the message's sid.
    expect(answersFromRows([msg({ sid: 'sid-sent-to' })], rows, { wholeUntil: at(59) }).get('tm-aaaaaaaaaaaa')?.sid).toBeUndefined()
  })

  it('a letter turn\'s recorded writer, or none: never the session the note was sent to', () => {
    const ms = (min: number) => Date.parse(at(min))
    const note = msg({ via: 'letter', sid: 'sid-sent-to' })
    const turns = (sender?: LetterTurn['sender']): LetterTurn[] => [
      { from: 'human', text: 'where are the notes?', at: ms(0) },
      { from: 'agent', text: 'In /home/me/notes.txt', at: ms(1), ...(sender ? { sender } : {}) },
    ]
    expect(letterAnswerOf(note, turns({ sessionId: REMOTE.sid, host: REMOTE.host }))).toEqual({ text: 'In /home/me/notes.txt', at: at(1), from: 'letter', sid: REMOTE.sid, host: REMOTE.host })
    expect(letterAnswerOf(note, turns({ sessionId: REMOTE.sid }))).toEqual({ text: 'In /home/me/notes.txt', at: at(1), from: 'letter', sid: REMOTE.sid })
    // A plugin's turn: no session, but its recorded host names the machine.
    expect(letterAnswerOf(note, turns({ sessionId: 'external', host: 'devbox' }))).toEqual({ text: 'In /home/me/notes.txt', at: at(1), from: 'letter', sid: 'external', host: 'devbox' })
    for (const sender of [undefined, { sessionId: 'external' }, { sessionId: 'external', host: '  ' }, { host: 'devbox' }]) {
      const got = letterAnswerOf(note, turns(sender))!
      expect([got.sid, got.host]).toEqual([undefined, undefined])
    }
  })

  it('setAnswers keeps the answer\'s session; a letter answer replacing a chat one takes its own (or none)', () => {
    let { file, id } = oneThread()
    const mid = file.threads[0].messages[0].id
    file = setAnswers(file, new Map<string, ThreadAnswer>([[mid, { text: 'From the chat', at: at(1), sid: REMOTE.sid, host: REMOTE.host }]])).file
    expect(file.threads.find((t) => t.id === id)!.messages[0].answer).toMatchObject({ sid: REMOTE.sid, host: REMOTE.host })
    // A letter note whose chat answer an older Walnut kept: the letter's answer replaces it whole.
    file = { ...file, threads: file.threads.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, via: 'letter' as const })) })) }
    file = setAnswers(file, new Map<string, ThreadAnswer>([[mid, { text: 'From the letter', at: at(2), from: 'letter' }]])).file
    const a = file.threads.find((t) => t.id === id)!.messages[0].answer!
    expect(a.text).toBe('From the letter')
    expect([a.sid, a.host]).toEqual([undefined, undefined])
  })
})
