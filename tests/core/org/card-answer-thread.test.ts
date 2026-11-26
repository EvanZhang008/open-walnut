/**
 * His answer from a card (`Answer to "<ask>": <words>`, user-status.ts askAnswerText) is never a
 * question of his, and it goes to the thread that asked (src/core/org/card-answer-thread.ts,
 * thread-question.ts, thread-capture.ts).
 *
 * 2026-11-25: a task asked one decision in its report, in a decision letter and on the letter's
 * thread. He tapped an option on the report's ask. The answer reached the chat naming no thread; with
 * threads_each_question on, the question mark of the QUOTED ask made it "his own question", so it
 * opened a second thread no merge could take, and the letter stayed open: two cards for one matter.
 *
 * The class: every writer of the frame is read by one reader (parseCardAnswer), whatever the ask or
 * his words say; the guard at the end fails when a new writer of the frame appears.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-card-answer-thread'))

import {
  emptyThreads, fileMessage, mergeThreads, SAME_CONVERSATION_MS, updateThread,
  type OrgThread, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'
import { askAnswerText, cardAnswerReadings, parseCardAnswer } from '../../../src/core/user-status.js'
import { asksQuestion, isQuestionThread, setEachQuestion } from '../../../src/core/org/thread-question.js'
import { cardAnswerFit, cardAnswerThread } from '../../../src/core/org/card-answer-thread.js'

const TASK = 'bike-card-answer'
const NODE = `task:${TASK}` as const
const T0 = Date.parse('2026-11-25T09:00:00.000Z')
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const chat = (f: ThreadsFile, text: string, sec: number) => fileMessage(f, { text, via: 'chat', at: at(sec), joinRecent: SAME_CONVERSATION_MS })

const ASK = 'Has the bike shop fitted the new brake cable on the red bike yet?'
const FITTED = 'They already fitted it'
const NOT_YET = 'Not fitted yet'
/** The answer a tap on the report's ask sends: the ask quoted (with its question mark), then the label. */
const TAPPED = askAnswerText({ summary: ASK, kind: 'single', options: [{ id: 'fitted', label: FITTED }, { id: 'not_yet', label: NOT_YET }] }, { picked: ['fitted'] })

/** A thread holding the task's decision letter for the same matter: its question is the report's ask with less detail, waiting on him. */
function letterThread(f: ThreadsFile, sec = 0): { f: ThreadsFile; id: string } {
  const one = chat(f, 'keep an eye on the red bike repair', sec)
  const id = one.thread.id
  let next = updateThread(one.file, id, { title: 'Red bike repair: is the cable fitted', ask: 'Has the shop fitted the brake cable yet?', reply: 'Waiting to hear whether the cable is on.', state: 'needs', user_kind: 'user_fact', user_kind_why: 'only he knows what the shop did' } as never, 'human', at(sec + 5)).file
  next = { ...next, threads: next.threads.map((t) => (t.id === id ? { ...t, letter: { id: 'lt-bike-cable', task: TASK, options: [{ id: 'fitted', label: FITTED }, { id: 'not_yet', label: NOT_YET }] } } : t)) }
  return { f: next, id }
}

beforeEach(() => { setEachQuestion(true) })
afterEach(() => { setEachQuestion(false) })

/**
 * The frame escapes nothing, so an ask (or his words) may hold the frame's own marks. Each row is one
 * way they can: a new shape that breaks the reader goes here.
 */
describe('an ask that holds the frame\'s own marks still finds its thread, and his words stay his', () => {
  const LARCH = 'Plant the larch'
  const OAK = 'Plant the oak'
  const options = [{ id: 'larch', label: LARCH }, { id: 'oak', label: OAK }]
  const asks: Array<[string, string]> = [
    ['a quoted name, then a colon', 'The tag on the sapling says "sold": which tree goes by the north gate?'],
    ['two quoted names and a colon', 'Rename "old shed" to "tool shed": which tree shades it better?'],
    ['an ask that reads like the frame itself', 'Answer to "which corner": which tree goes in the far corner of the orchard?'],
    ['an ask that ends in a quote', 'Which tree goes beside the bench marked "wet paint"'],
    ['a quote and a colon on a second line', 'The crew wrote "ready":\nwhich tree do they plant first by the pond?'],
  ]
  const answers: Array<[string, { picked?: string[]; words?: string }]> = [
    ['a tapped option', { picked: ['oak'] }],
    ['an option and words of his', { picked: ['oak'], words: 'before the frost' }],
    ['words of his that hold a quote and a colon', { picked: ['oak'], words: 'the note says "north": check it' }],
    ['typed words alone', { words: 'neither, wait for spring' }],
  ]
  /** A thread waiting on him with this ask, beside another decision of the same task with the same options. */
  function asking(ask: string): { threads: OrgThread[]; id: string } {
    const one = chat(emptyThreads(NODE), 'plan the orchard planting', 0)
    const id = one.thread.id
    let f = updateThread(one.file, id, { title: 'Orchard planting', ask, state: 'needs', user_kind: 'user_own', user_kind_why: 'he asked to pick the trees of his orchard himself', options: options.map((o) => ({ ...o })) }, 'agent', at(5)).file
    const two = chat(f, 'and the hedge along the lane', 400)
    f = updateThread(two.file, two.thread.id, { title: 'Hedge along the lane', ask: 'Which sapling starts the hedge along the lane this autumn?', state: 'needs', user_kind: 'user_own', user_kind_why: 'he asked to pick the saplings of his hedge himself', options: options.map((o) => ({ ...o })) }, 'agent', at(405)).file
    return { threads: f.threads, id }
  }

  for (const [askName, ask] of asks) {
    for (const [answerName, answer] of answers) {
      it(`${askName}; ${answerName}`, () => {
        const { threads, id } = asking(ask)
        const text = askAnswerText({ summary: ask, kind: 'single', options }, answer)
        const said = text.slice(`Answer to "${ask}": `.length)
        const fit = cardAnswerFit(threads, text)
        expect(fit?.thread.id, text).toBe(id)
        expect(fit?.card).toEqual({ ask: ask.trim(), words: said })
        expect(cardAnswerThread(threads, text)?.id).toBe(id)
        // It stays a card answer for every reader, and never a question of his.
        expect(parseCardAnswer(text)).not.toBeNull()
        expect(asksQuestion(text)).toBe(false)
      })
    }
  }

  it('every reading of a message is listed, the shortest ask first, and no more than eight', () => {
    expect(cardAnswerReadings('Answer to "a": b": c')).toEqual([{ ask: 'a', words: 'b": c' }, { ask: 'a": b', words: 'c' }])
    expect(cardAnswerReadings(TAPPED)).toEqual([{ ask: ASK, words: FITTED }])
    expect(cardAnswerReadings(`Answer to "x${'": y'.repeat(20)}`)).toHaveLength(8)
    for (const text of ['', 'Answer to "no end', 'Answer to "x":', 'the Answer to "x": y']) expect(cardAnswerReadings(text), text).toEqual([])
  })

  it('a piece of the ask that fits too never takes the rest of the ask as his words', () => {
    // The ask up to its inner quote has the same content words as a shorter thread ask: the whole quote still wins.
    const ask = 'Which tree goes by the north gate says the tag "sold": the larch or the oak?'
    const { threads, id } = asking(ask)
    const fit = cardAnswerFit(threads, askAnswerText({ summary: ask, kind: 'single', options }, { picked: ['larch'] }))
    expect(fit?.thread.id).toBe(id)
    expect(fit?.card.words).toBe(LARCH)
  })
})

describe('a card answer is never a question of his', () => {
  const frames: Array<[string, string]> = [
    ['a picked option on an ask that ends in a question mark', TAPPED],
    ['yes to a yes or no ask', askAnswerText({ summary: 'Shall I prune the old plum this week?', kind: 'yes_no' }, { picked: ['yes'] })],
    ['typed words that themselves ask something', askAnswerText({ summary: ASK, kind: 'text' }, { words: 'why would they not have fitted it?' })],
    ['an option and typed words', askAnswerText({ summary: ASK, kind: 'single', options: [{ id: 'fitted', label: FITTED }] }, { picked: ['fitted'], words: 'can you check the invoice' })],
    ['two picked options', askAnswerText({ summary: 'Which beds get mulch?', kind: 'multi', options: [{ id: 'a', label: 'North bed' }, { id: 'b', label: 'Herb bed' }] }, { picked: ['a', 'b'] })],
    ['no answer at all', askAnswerText({ summary: ASK, kind: 'text' }, {})],
    ['a Chinese ask with a full-width question mark', askAnswerText({ summary: '\u8f66\u4fee\u597d\u4e86\u5417\uff1f', kind: 'single', options: [{ id: 's', label: '\u4fee\u597d\u4e86' }] }, { picked: ['s'] })],
    ['an ask that holds a quote and a colon', askAnswerText({ summary: 'The label says "fragile": ship it anyway?', kind: 'yes_no' }, { picked: ['no'] })],
  ]
  for (const [name, text] of frames) {
    it(name, () => {
      expect(parseCardAnswer(text), text).not.toBeNull()
      expect(asksQuestion(text), text).toBe(false)
    })
  }

  it('the frame reads back its ask and his words, and nothing else is one', () => {
    expect(parseCardAnswer(TAPPED)).toEqual({ ask: ASK, words: FITTED })
    expect(parseCardAnswer(`  ${TAPPED}\n`)).toEqual({ ask: ASK, words: FITTED })
    for (const text of ['Answer the bike shop today?', 'the answer to "which bike" is the red one?', ASK]) {
      expect(parseCardAnswer(text), text).toBeNull()
    }
    // His own question typed in the chat stays a question.
    expect(asksQuestion(ASK)).toBe(true)
  })

  it('filed with no thread asking it, it is an ordinary thread: no question thread, so it merges', () => {
    const one = chat(emptyThreads(TASK), 'keep an eye on the red bike repair', 0)
    const first = one.thread.id
    let f = updateThread(one.file, first, { title: 'Red bike repair', reply: 'The cable went on on Monday.' }, NODE, at(10)).file
    // An hour later, so the timing join does not take it.
    const filed = fileMessage(f, { text: TAPPED, via: 'chat', at: at(3600), joinRecent: SAME_CONVERSATION_MS })
    expect(filed.created).toBe(true)
    f = filed.file
    const made = f.threads.find((t) => t.id === filed.thread.id)!
    expect(isQuestionThread(made)).toBe(false)
    const merged = mergeThreads(f, made.id, first, NODE, at(3700))
    expect(merged.file.threads.map((t) => t.id)).toEqual([first])
  })
})

describe('cardAnswerThread: the answer finds the thread that asked', () => {
  it('the thread asks the quoted question with less detail and his pick is its letter\'s option: that thread', () => {
    const { f, id } = letterThread(emptyThreads(TASK))
    expect(cardAnswerThread(f.threads, TAPPED)?.id).toBe(id)
    // The label first, his own words after it.
    const more = askAnswerText({ summary: ASK, kind: 'single', options: [{ id: 'fitted', label: FITTED }] }, { picked: ['fitted'], words: 'on Monday, with new pads too' })
    expect(cardAnswerThread(f.threads, more)?.id).toBe(id)
  })

  it('the thread asks the quoted question in the same words: that thread, whatever he answered', () => {
    const one = chat(emptyThreads(TASK), 'book the bike repair', 0)
    const f = updateThread(one.file, one.thread.id, { state: 'needs', reply: ASK, user_kind: 'user_fact', user_kind_why: 'only he knows' } as never, 'human', at(5)).file
    const typed = askAnswerText({ summary: ASK, kind: 'text' }, { words: 'no idea, call them' })
    expect(cardAnswerThread(f.threads, typed)?.id).toBe(one.thread.id)
  })

  it('a bare yes fits only a thread that asks the quoted question in the same words', () => {
    const one = chat(emptyThreads(TASK), 'prune the plum', 0)
    const options = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]
    const f = updateThread(one.file, one.thread.id, { state: 'needs', reply: 'Prune the old plum this week?', options, user_kind: 'user_own', user_kind_why: 'his tree' } as never, 'human', at(5)).file
    const yes = (summary: string) => askAnswerText({ summary, kind: 'yes_no' }, { picked: ['yes'] })
    expect(cardAnswerThread(f.threads, yes('Order two more bags of mulch for the herb bed?'))).toBeNull()
    // A question with detail added, or about one more thing, is not proof enough for a bare yes.
    expect(cardAnswerThread(f.threads, yes('Prune the old plum and the pear this week?'))).toBeNull()
    expect(cardAnswerThread(f.threads, yes('Prune the old plum by the gate this week, before the frost?'))).toBeNull()
    // The same content words, in another order or with filler, are the same question.
    expect(cardAnswerThread(f.threads, yes('Prune the old plum this week?'))?.id).toBe(one.thread.id)
    expect(cardAnswerThread(f.threads, yes('Shall I go ahead and prune that old plum this week?'))?.id).toBe(one.thread.id)
  })

  // Review 2026-11-26: a pick alone answered the letter of ANOTHER decision of the same task.
  it('an option alone is never proof: the same label on another decision finds no thread', () => {
    const letterOf = (title: string, labels: string[]) => {
      const one = chat(emptyThreads(TASK), 'look after the garden', 0)
      const f = updateThread(one.file, one.thread.id, { title, reply: title, state: 'needs', user_kind: 'user_own', user_kind_why: 'his garden' } as never, 'human', at(5)).file
      return f.threads.map((t) => ({ ...t, letter: { id: 'lt-garden', task: TASK, options: labels.map((label, i) => ({ id: `o${i}`, label })) } }))
    }
    const pick = (summary: string, labels: string[], i: number, words?: string) => askAnswerText({ summary, kind: 'single', options: labels.map((label, n) => ({ id: `o${n}`, label })) }, { picked: [`o${i}`], ...(words ? { words } : {}) })
    const cases: Array<[string, OrgThread[], string]> = [
      ['a generic label', letterOf('Publish the garden blog post draft to the website', ['Approve', 'Reject']), pick('Upgrade the potting shed lock to the new model this weekend?', ['Approve', 'Reject'], 0)],
      ['a later', letterOf('Send the seed order reminder to the nursery', ['Now', 'Later']), pick('Renew the allotment lease for another year?', ['Now', 'Later'], 1)],
      ['a yes with words of its own', letterOf('Plant out the second row of beans', ['Yes, plant them', 'Wait']), pick('Move the compost heap behind the shed now?', ['Yes, plant them', 'Wait'], 0)],
      ['a yes on two targets', letterOf('Water the new hedge on the north side?', ['Yes', 'No']), askAnswerText({ summary: 'Water the tomato beds on the south side?', kind: 'yes_no' }, { picked: ['yes'] })],
      ['a yes sharing one word', letterOf('Cut back the old ivy on the wall?', ['Yes', 'No']), askAnswerText({ summary: 'Cut the grass by the gate?', kind: 'yes_no' }, { picked: ['yes'] })],
      ['two picks, one of them its option', letterOf('Which bed gets the compost', ['North bed', 'South bed']), askAnswerText({ summary: 'Which beds get mulch?', kind: 'multi', options: [{ id: 'a', label: 'North bed' }, { id: 'b', label: 'Herb bed' }] }, { picked: ['a', 'b'] })],
    ]
    for (const [name, threads, text] of cases) expect(cardAnswerThread(threads, text), name).toBeNull()
  })

  it('the thread that asks the quoted question comes before one that only shares his pick', () => {
    const { f, id: letter } = letterThread(emptyThreads(TASK))
    // Another thread holds the report's own ask, word for word, and is not in needs.
    const two = chat(f, 'and the blue bike too', 7200)
    const threads = two.file.threads.map((t) => (t.id === two.thread.id ? { ...t, state: 'working' as const, reportAsk: { id: 'ask-abc123', at: at(7300), ask: ASK } } : t))
    expect(cardAnswerThread(threads, TAPPED)?.id).toBe(two.thread.id)
    expect(two.thread.id).not.toBe(letter)
  })

  it('no thread asks it, a closed or moved one, or two that fit: no thread', () => {
    const { f, id } = letterThread(emptyThreads(TASK))
    expect(cardAnswerThread(f.threads, askAnswerText({ summary: 'Paint the shed door?', kind: 'text' }, { words: 'green' }))).toBeNull()
    expect(cardAnswerThread(f.threads, 'they already fitted it')).toBeNull()
    const closed = f.threads.map((t) => (t.id === id ? { ...t, closed: { how: 'acked', at: at(50), by: 'human' } } as OrgThread : t))
    expect(cardAnswerThread(closed, TAPPED)).toBeNull()
    const moved = f.threads.map((t) => (t.id === id ? { ...t, movedTo: { task: 'elsewhere', at: at(50) } } as OrgThread : t))
    expect(cardAnswerThread(moved, TAPPED)).toBeNull()
    const two = letterThread(f, 7200)
    expect(cardAnswerThread(two.f.threads, TAPPED)).toBeNull()
  })

  it('a thread still waiting on him comes before one already answered; an answered one takes a resend', () => {
    const { f, id } = letterThread(emptyThreads(TASK))
    const answered = f.threads.map((t) => (t.id === id ? { ...t, state: 'answered' as const, letter: { ...t.letter!, done: true as const } } : t))
    expect(cardAnswerThread(answered, TAPPED)?.id).toBe(id)
    const again = letterThread({ ...f, threads: answered }, 7200)
    expect(cardAnswerThread(again.f.threads, TAPPED)?.id).toBe(again.id)
  })

  it('filed under the thread that asked, his answer opens no thread and ends its wait', () => {
    const { f, id } = letterThread(emptyThreads(TASK))
    const target = cardAnswerThread(f.threads, TAPPED)!
    const filed = fileMessage(f, { text: TAPPED, via: 'chat', at: at(3600), threadId: target.id })
    expect(filed.created).toBe(false)
    expect(filed.file.threads).toHaveLength(1)
    expect(filed.thread).toMatchObject({ id, state: 'working' })
    expect(filed.thread.messages.at(-1)!.text).toBe(TAPPED)
  })
})

describe('every writer of the frame is read by parseCardAnswer (guard)', () => {
  const ROOT = path.resolve(import.meta.dirname, '../../..')
  // Code that builds the frame: a template or an interpolated string that starts `Answer to "<ask>": `.
  const WRITES = /Answer to \\?"(?:\$\{[^}]+\}|\\\([^)]+\))\\?": (?:\$\{|\\\()/
  /** The writers known today; each builds exactly `Answer to "<ask>": <words>`. */
  const WRITERS = ['ios-native/Walnut/Views/Tasks/ActionNeededView.swift', 'src/core/user-status.ts']

  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) sources(rel, out)
      else if (/\.(ts|tsx|swift)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel)
    }
    return out
  }

  it('the files that build the frame are the known writers', () => {
    const found = ['src', 'web/src', 'ios-native/Walnut'].flatMap((d) => sources(d))
      .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').some((l) => WRITES.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)))
      .sort()
    // A new writer: build the same frame (so parseCardAnswer reads it), then add the file here.
    expect(found).toEqual(WRITERS)
  })

  it('the phone builds the frame the reader reads', () => {
    const swift = fs.readFileSync(path.join(ROOT, WRITERS[0]), 'utf8')
    expect(swift).toContain('"Answer to \\"\\(summary)\\": \\(words)"')
    const built = `Answer to "${ASK}": ${FITTED}`
    expect(parseCardAnswer(built)).toEqual({ ask: ASK, words: FITTED })
    expect(built).toBe(TAPPED)
  })
})
