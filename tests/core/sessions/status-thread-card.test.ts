/**
 * A status line rewrites no card that still holds (src/core/sessions/status-thread-card.ts;
 * 2026-11-23, the user: "每次它结束聊天之后，我会看到屏幕闪一下，会显示好多好多不同的 thread"). The
 * turn-end question is a side question that never sees its own last answer: his VP wrote all 12
 * cards it was asked about anew every turn, and the cards in Done changed and re-sorted under his eyes.
 *
 *   answered      the question quotes his card and asks for a line only when the result changed or
 *                 it is done; no card quoted while a summary is owed or a joined word waits
 *   hidden        working and waiting threads take their lines as before, words included, and
 *                 the task's own state is read from them
 *   a result      a working or waiting line on a result he has not read writes no progress over it
 *   still lines   his new word, a first answer, a state that moves, a done: written as before
 *   every block   that lists a carded thread carries the rule (kept by Walnut or not, node or task)
 *   an answer     that puts new words on more than CARDS_RESTATED_MAX cards that hold says its list
 *                 again: none of those words is written (2026-11-26, the thread monitor: 6 of 6)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-card'))

import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { listForQuestion, patchForLine, planThreadWrites, settleStateFromThreads, threadQuestionBlock, type ListedThread, type StatusThreadLine } from '../../../src/core/sessions/status-threads.js'
import { CARD_KEEPS_LINE, CARD_SHOWN_MAX, CARDS_RESTATED_MAX, cardHolds, cardPart, cardWords, keepsCardWords, restatesCard } from '../../../src/core/sessions/status-thread-card.js'
import { emptyThreads, fileMessage, openThread, SAME_CONVERSATION_MS, setAnswers, updateThread, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import type { StatusReport } from '../../../src/core/user-status.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 23, 20, min)).toISOString()
const NODE = 'task:lead-1' as const
afterEach(() => setThreadsKept(false))

/** His question, answered in the chat at 1 and summed up on the card at 2, in `state`. */
function summed(state: OrgThread['state'] = 'answered'): { f: ThreadsFile; t: OrgThread } {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'is the orchard fence tall enough?', via: 'chat', at: at(0) }).file
  const id = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Yes: two metres keeps the deer out.', at: at(1) }]])).file
  f = updateThread(f, id, { title: 'Orchard fence', state, reply: 'Two metres keeps the deer out; the gate latch is new.' }, NODE, at(2)).file
  return { f, t: f.threads.find((x) => x.id === id)! }
}
const line = (t: OrgThread, state: StatusThreadLine['state'], progress: string): StatusThreadLine => ({ id: t.id, title: t.title, state, progress })

describe('the card the question quotes', () => {
  it('an answered thread\'s summary that answers his newest word there', () => {
    expect(cardWords(summed().t)).toBe('Two metres keeps the deer out; the gate latch is new.')
  })

  it('none on a thread that is not answered: its line still says its state', () => {
    for (const state of ['working', 'pending', 'new'] as const) expect(cardWords(summed(state).t)).toBeUndefined()
  })

  it('none while a summary is owed: a first answer with no summary yet (review H1)', () => {
    let f = fileMessage(emptyThreads('lead-1'), { text: 'which mulch?', via: 'chat', at: at(0) }).file
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Bark mulch: it holds the water longest.', at: at(1) }]])).file
    f = updateThread(f, f.threads[0].id, { state: 'answered' }, NODE, at(1)).file
    expect(cardWords(f.threads[0])).toBeUndefined()
    const opened = openThread(emptyThreads('lead-1'), { title: 'Hose fixed', text: 'The hose is fixed; the leak was at the tap.', from: 'node', state: 'answered' }, NODE, at(3)).file
    expect(cardWords(opened.threads[0])).toBeUndefined()
  })

  it('none while a word of his waits, a message joined only by timing included (review L1)', () => {
    const { f, t } = summed()
    const later = fileMessage(f, { text: 'and the north side too?', via: 'follow-up', at: at(10), threadId: t.id }).file
    expect(cardWords(later.threads.find((x) => x.id === t.id)!)).toBeUndefined()
    const joined = fileMessage(f, { text: 'also, what about the apples', via: 'chat', at: at(3), joinRecent: SAME_CONVERSATION_MS })
    expect(joined.thread.id).toBe(t.id)
    expect(cardWords(joined.file.threads.find((x) => x.id === t.id)!)).toBeUndefined()
  })

  it('quoted on one line, cut to CARD_SHOWN_MAX characters; nothing for no card', () => {
    const part = cardPart('The east row is pruned and tied. '.repeat(10))
    expect(part.startsWith('; card: "')).toBe(true)
    expect(part.length).toBeLessThanOrEqual(CARD_SHOWN_MAX + '; card: ""'.length)
    expect(cardPart(undefined)).toBe('')
  })
})

describe('the lines a card keeps out', () => {
  it('a working or waiting thread (hidden from him) takes its line\'s words as before (2026-11-22: "quietly")', () => {
    for (const [state, word] of [['working', 'working'], ['pending', 'waiting']] as const) {
      const { t } = summed(state)
      expect(keepsCardWords(t, state, state)).toBe(false)
      expect(patchForLine(t, line(t, word, 'The fence is still two metres, nothing new.'))).toMatchObject({ reply: 'The fence is still two metres, nothing new.' })
    }
  })

  it('the task still reads its state from those lines (review H2)', () => {
    const { t } = summed('pending')
    const report: StatusReport = { state: 'needs', now: 'Something to read.', threads: [line(t, 'waiting', 'The rollout runs outside.')] } as StatusReport
    expect(settleStateFromThreads(report)).toMatchObject({ state: 'waiting', waiting_kind: 'outside' })
  })

  it('a working or waiting line on a result he has not read writes no progress over it', () => {
    const { t } = summed('answered')
    expect(patchForLine(t, line(t, 'working', 'Looking at the gate again.'))).toBeNull()
    expect(patchForLine(t, line(t, 'waiting', 'The latch comes Friday.'))).toBeNull()
    // Once he read it, the wait hides it with its words: status-threads-consistency.test.ts.
  })

  it('still written: his new word answered, a state that moves, a done, a changed result', () => {
    // His follow-up in a working thread, answered in the chat: the summary is behind him, so it is written.
    let { f, t } = summed('working')
    f = fileMessage(f, { text: 'and the north side too?', via: 'follow-up', at: at(10), threadId: t.id }).file
    t = f.threads.find((x) => x.id === t.id)!
    expect(patchForLine(t, line(t, 'working', 'The north side is next.'))).toMatchObject({ reply: 'The north side is next.' })
    // A state that moves writes the line's words.
    const w = summed('working').t
    expect(patchForLine(w, line(w, 'answered', 'Done: both sides are two metres.'))).toMatchObject({ state: 'answered', reply: 'Done: both sides are two metres.' })
    const p = summed('pending').t
    expect(patchForLine(p, line(p, 'working', 'Back on it: the latch broke.'))).toBeTruthy()
    // An answered line on an answered card is the node's word that the result changed.
    const a = summed('answered').t
    expect(patchForLine(a, line(a, 'answered', 'The gate latch was replaced too.'))).toMatchObject({ reply: 'The gate latch was replaced too.' })
    // A done line on a thread the node opened, its card holding, closes it (review M2).
    const o = openThread(emptyThreads('lead-1'), { title: 'Hose fixed', text: 'The hose is fixed.', from: 'node', state: 'answered' }, NODE, at(3))
    const h = updateThread(o.file, o.thread.id, { reply: 'The hose is fixed; the leak was at the tap.' }, NODE, at(4)).file.threads[0]
    expect(patchForLine(h, line(h, 'done', 'The hose is fixed; the leak was at the tap.'))).toMatchObject({ close: 'dropped' })
  })
})

describe('the question with the cards', () => {
  const listedOf = (f: ThreadsFile): ListedThread[] => listForQuestion(f, f.threads).listed

  it('quotes an answered card and asks for no line where it holds, kept by Walnut or not; other threads read as before', () => {
    for (const kept of [false, true]) {
      setThreadsKept(kept)
      const both = fileMessage(summed().f, { text: 'order the seeds for spring', via: 'chat', at: at(30) }).file
      for (const org of [false, true]) {
        const { block } = threadQuestionBlock(listedOf(both), undefined, { org })
        expect(block).toMatch(/"Orchard fence" \(answered[^;]*; card: "Two metres keeps the deer out; the gate latch is new\."\)/)
        expect(block).toMatch(/"order the seeds for spring" \(new[^;)]*\)/)
        expect(block).toContain(CARD_KEEPS_LINE)
      }
    }
  })

  // Class guard: every listing block, however it is built, carries the rule and quotes a card only
  // where the listed thread holds one.
  it('every listing block carries the rule, and a card part only on a carded thread', () => {
    const states = ['new', 'working', 'pending', 'answered', 'answered'] as const
    const open: ListedThread[] = states.map((state, i) => ({ id: `th-card0000${i}`, title: `Row ${i + 1}`, state, ...(i === 3 ? { card: `Row ${i + 1} holds.` } : {}) }))
    for (const kept of [false, true]) {
      setThreadsKept(kept)
      for (const org of [false, true]) {
        const { block } = threadQuestionBlock(open, 'English', { org })
        expect(block).toContain(CARD_KEEPS_LINE)
        expect(block).toContain('"Row 4" (answered; card: "Row 4 holds.")')
        for (const t of open.filter((x) => !x.card)) expect(block).toMatch(new RegExp(`"${t.title}" \\(${t.state}[^;)]*\\)`))
      }
    }
  })

  // The browser check's fixture CLI (tests/e2e/browser/threads-turn-end-still.spec.ts) follows the rule as worded now.
  it('the fixture CLI leaves out the line of a quoted card, and writes the others', async () => {
    const mock = await import('../../providers/mock-claude-side-answer.mjs')
    mock.noteUserMessage('snapshot-clean-turn:Go. reword-threads')
    const { block } = threadQuestionBlock([
      { id: 'th-card00010', title: 'Row A', state: 'answered', card: 'Row A holds.' },
      { id: 'th-card00011', title: 'Row B', state: 'working' },
    ])
    const answer = mock.sideQuestionAnswer(`FOR_USER_STATE: <state>\n${block}`)
    expect(answer).toContain('FOR_USER_THREAD: t2 | working |')
    expect(answer).not.toContain('FOR_USER_THREAD: t1')
  })

  it('no card on a thread whose result he acknowledged: a line there only closes it', () => {
    const { block } = threadQuestionBlock([{ id: 'th-card00009', title: 'Hose fixed', state: 'pending', acked: true, card: 'The hose is fixed.' }])
    expect(block).not.toContain('card: "The hose is fixed."')
    expect(block).toContain('a line only closes it (done)')
  })
})

describe('an answer that says its cards again', () => {
  /** `n` questions of his, far enough apart to be `n` threads, each answered with a summary on its card. */
  function cards(n: number): ThreadsFile {
    let f = emptyThreads('lead-1')
    const day = Date.UTC(2026, 10, 23, 6)
    const plots = ['north bed', 'herb spiral', 'apple row', 'pond edge', 'tool shed', 'compost bay', 'vine arch']
    for (let i = 0; i < n; i++) {
      const filed = fileMessage(f, { text: `what is left to do at the ${plots[i]}?`, via: 'chat', at: new Date(day + i * 3 * SAME_CONVERSATION_MS).toISOString() })
      f = updateThread(filed.file, filed.thread.id, { title: `The ${plots[i]}`, state: 'answered', reply: `The ${plots[i]} is finished: see /srv/garden/${i}.png for how it looks.` }, NODE, new Date(day + i * 3 * SAME_CONVERSATION_MS + 60_000).toISOString()).file
    }
    expect(f.threads.filter((t) => t.state === 'answered' && cardHolds(t))).toHaveLength(n)
    return f
  }
  const again = (t: OrgThread, state: StatusThreadLine['state'] = 'answered') => line(t, state, `${t.title} is all done now.`)
  const wrote = (f: ThreadsFile, lines: StatusThreadLine[], side: boolean) => planThreadWrites(f, lines, [], {}, side)

  it('new words on more held cards than CARDS_RESTATED_MAX in one answer: none is written, and the cards keep their proof', () => {
    const f = cards(CARDS_RESTATED_MAX + 1)
    // A done line on his own request stays answered with the line's words: the same rewrite.
    const lines = f.threads.map((t, i) => again(t, i === 0 ? 'done' : 'answered'))
    const plan = wrote(f, lines, true)
    expect(plan.writes).toEqual([])
    expect(plan.restated.sort()).toEqual(f.threads.map((t) => t.id).sort())
  })

  it('up to CARDS_RESTATED_MAX at once are results that moved on: written (2,049 real answers: one, two or three in 268, more in 1)', () => {
    const f = cards(CARDS_RESTATED_MAX)
    const plan = wrote(f, f.threads.map((t) => again(t)), true)
    expect(plan.writes.map((w) => w.patch.reply)).toEqual(f.threads.map((t) => `${t.title} is all done now.`))
    expect(plan.restated).toEqual([])
  })

  it('his reply\'s own card lines speak for what the reply says: never held back', () => {
    const f = cards(CARDS_RESTATED_MAX + 2)
    const plan = wrote(f, f.threads.map((t) => again(t)), false)
    expect(plan.writes).toHaveLength(CARDS_RESTATED_MAX + 2)
    expect(plan.restated).toEqual([])
  })

  it('every other write of that answer stays: a state that moves, a card that did not hold, a hidden thread\'s line', () => {
    let f = cards(CARDS_RESTATED_MAX + 1)
    const [first, ...rest] = f.threads
    // A word of his after the summary: that card holds no more, so its line is the answer to it.
    f = fileMessage(f, { text: 'and the gate there?', via: 'follow-up', at: new Date(Date.UTC(2026, 10, 24, 9)).toISOString(), threadId: first.id }).file
    // A thread still in work, hidden from him.
    const work = fileMessage(f, { text: 'order the seeds for spring', via: 'chat', at: new Date(Date.UTC(2026, 10, 24, 12)).toISOString() })
    f = updateThread(work.file, work.thread.id, { title: 'Spring seeds', state: 'working' }, NODE, new Date(Date.UTC(2026, 10, 24, 12, 1)).toISOString()).file
    const now = (id: string) => f.threads.find((t) => t.id === id)!
    expect(restatesCard(now(first.id), { state: 'answered', reply: 'x' })).toBe(false)
    const lines = [again(now(first.id)), ...rest.map((t) => again(t)), line(now(work.thread.id), 'answered', 'The seeds are ordered.')]
    // Three held cards rewritten beside the two others: within the limit, all five written.
    const plan = wrote(f, lines, true)
    expect(plan.writes).toHaveLength(5)
    expect(plan.restated).toEqual([])
    // One more held card in the same answer: the held ones are left, the two others still written.
    const more = cards(CARDS_RESTATED_MAX + 2)
    const extra = fileMessage(more, { text: 'order the seeds for spring', via: 'chat', at: new Date(Date.UTC(2026, 10, 24, 12)).toISOString() })
    const g = updateThread(extra.file, extra.thread.id, { title: 'Spring seeds', state: 'working' }, NODE, new Date(Date.UTC(2026, 10, 24, 12, 1)).toISOString()).file
    const held = g.threads.filter((t) => t.state === 'answered')
    const out = wrote(g, [...held.map((t) => again(t)), line(g.threads.find((t) => t.id === extra.thread.id)!, 'answered', 'The seeds are ordered.')], true)
    expect(out.writes.map((w) => w.id)).toEqual([extra.thread.id])
    expect(out.restated.sort()).toEqual(held.map((t) => t.id).sort())
  })

  // Class guard: a model's status lines reach his cards through one function, and each caller says
  // whether its lines are the side question's (held to the limit) or his reply's own card lines.
  it('class guard: every path that writes status lines on cards is listed with its kind', () => {
    const KINDS: Record<string, 'side question' | 'reply card lines'> = {
      'src/core/sessions/status-question.ts': 'side question',
      'src/core/org/reply-card.ts': 'reply card lines',
    }
    const root = path.resolve(__dirname, '../../..')
    const files: string[] = []
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) files.push(p) } }
    walk(path.join(root, 'src'))
    const calls = (name: string) => files.flatMap((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return [...text.matchAll(new RegExp(`(?<!function )\\b${name}\\(([^\\n]*)`, 'g'))].map((m) => ({ file: path.relative(root, f), args: m[1] }))
    })
    // The plan is made in one place, and it passes on which kind the lines are.
    expect(calls('planThreadWrites')).toEqual([{ file: 'src/core/sessions/status-threads.ts', args: expect.stringMatching(/^cur, a\.lines, opened, a\.marks, !from\)/) }])
    const appliers = calls('applyThreadLines')
    expect([...new Set(appliers.map((c) => c.file))].sort()).toEqual(Object.keys(KINDS).sort())
    for (const c of appliers) expect(c.args.includes("'reply card lines'"), `${c.file}: ${c.args}`).toBe(KINDS[c.file] === 'reply card lines')
  })
})
