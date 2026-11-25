/**
 * A reply's card line through the real turn end, on an isolated server (experiment
 * threads_reply_tag; src/core/org/reply-card.ts turnEndedWith, src/core/sessions/status-thread-carded.ts).
 *
 * 2026-11-25, a real session on an isolated Walnut: its reply ended with the card line, the check
 * before the turn's end passed it, and nothing wrote it. Five seconds later the status question
 * asked about that thread as if no line had been given. The write hung on the job that keeps
 * answers under his messages (a transcript read), which an isolated server never starts and a busy
 * one can finish after the question. The tests of that day passed because each started a server
 * of the other kind and then called the write and the question itself, in the order it wanted.
 *
 * So nothing is called by hand here. He types through the phone's send route, the line leaves the
 * queue as when a CLI takes and answers it, the turn ends with the event the runner emits (its
 * data, its destinations), and the status question is the one the turn-complete hook arms, five
 * seconds later, asked of a session that records what it is asked. The server is the isolated kind:
 * no answers job at all, the slowest answers read there is (a read that takes tens of seconds on a
 * server that has the job: tests/e2e/reply-card-slow-answers.test.ts).
 *
 * Every kind of line goes this way: a state with a title, a decision, a merge, a reaction he gave,
 * a line the reply wrote without seeing his newer message, a turn end announced a second time with
 * no words, the switch off, and a write that is still running when the question's wait runs out.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-real-flow', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { IS_EPHEMERAL } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { STATUS_SETTLE_MS } from '../../src/core/sessions/status-question.js'
import { cardedNow, CARDS_WAIT_MAX_MS, queueCardWrite } from '../../src/core/sessions/status-thread-carded.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { cliAnswers, cliTakes, filedUnder, flow, hintOf, listed, of, questionAfter, say, setTag, startFlow, stopFlow, stopHook, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-00000000ca4d'
let base = ''
let taskId = ''

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Garden plan helper', project: 'Garden' })
  base = flow.base
  taskId = flow.taskId
}, 40_000)

afterAll(stopFlow)

describe('a real turn end on an isolated server: the line is written before the turn\'s status question is built', () => {
  let fence = ''
  let seeds = ''
  let shed = ''

  it('the server is the kind that failed: isolated, with no job that keeps answers', () => {
    expect(IS_EPHEMERAL).toBe(true)
  })

  it('a first question: the hint asks for the title in the line, the thread is titled and answered from it, and the question leaves it out', async () => {
    await setTag(true)
    await say('How tall should the orchard fence be?')
    const rows = await cliTakes()
    fence = filedUnder(rows[0])
    // One instruction for the title, in the line: never a thread_update beside it.
    expect(hintOf(rows[0])).toBe(`filed as new thread ${fence}. End your reply with: <walnut-card thread="${fence}" state="answered" title="..."/> (state: working, waiting, answered, done; title: a short one of your own).`)
    expect(of((await readThreads(taskId)).threads, fence)?.titled).toBeFalsy()

    const endedAt = await turnEnds(rows, `Two metres keeps the deer out.\n\n<walnut-card thread="${fence}" state="answered" title="Orchard fence height" summary="Two metres; posts go in Monday."/>`)
    const q = await questionAfter(endedAt)
    // Written before the question was built, by the task itself.
    expect(of(q.threads, fence)).toMatchObject({ title: 'Orchard fence height', titled: true, state: 'answered', reply: 'Two metres; posts go in Monday.', by: `task:${taskId}` })
    // And the question asks about no thread: the one there is was spoken for.
    expect(listed(q.prompt)).toEqual([])
    expect(q.prompt).not.toContain('Orchard fence height')
    expect(q.prompt).not.toContain('FOR_USER_THREAD:')
    // No job read the transcript: the reply is not under his message, and the line was written all the same.
    expect(of(q.threads, fence)?.messages[0].answer).toBeUndefined()
  }, 40_000)

  // 2026-11-25, the live server: 45 seconds after its start the sweep for reports a restart lost
  // (sessions/report-phase.ts askMissedReports) announced the turn that had just ended once more,
  // with no words, two seconds after its result. That second turn end read no line and wiped what
  // the first had noted, so the question five seconds later had nothing to leave out.
  it('the same turn end announced again with no words keeps what its lines spoke for', async () => {
    await say('And how far apart do the posts go?', fence)
    const rows = await cliTakes()
    const endedAt = await turnEnds(rows, `Two and a half metres.\n\n<walnut-card thread="${fence}" state="answered" summary="Two metres tall, posts every 2.5 m."/>`)
    await new Promise((r) => setTimeout(r, 1_000))
    bus.emit(EventNames.SESSION_TURN_SETTLED, { sessionId: SID, taskId, source: 'restart' }, ['*'], { source: 'report-phase' })
    // The announcement arms the question again: it comes five seconds after that.
    const q = await questionAfter(endedAt + 1_000)
    expect(of(q.threads, fence)).toMatchObject({ state: 'answered', reply: 'Two metres tall, posts every 2.5 m.' })
    expect(cardedNow(taskId, q.threads).has(fence)).toBe(true)
    expect(listed(q.prompt)).toEqual([])
  }, 40_000)

  it('a follow-up and a second subject in one turn: the thread with a line is left out, the one without is asked', async () => {
    await say('And should the posts be larch or oak?', fence)
    await say('Now order the seeds for spring.')
    const rows = await cliTakes()
    expect(rows).toHaveLength(2)
    expect(filedUnder(rows[0])).toBe(fence)
    seeds = filedUnder(rows[1])
    expect(seeds).not.toBe(fence)
    // A thread that has its title is asked for none.
    expect(hintOf(rows[0])).toContain(`End your reply with: <walnut-card thread="${fence}" state="answered"/> (state: working, waiting, answered, done).`)

    const endedAt = await turnEnds(rows, `Larch: it lasts longer in wet ground. I will look at seed suppliers next.\n\n<walnut-card thread="${fence}" state="answered" summary="Larch posts, two metres."/>`)
    const q = await questionAfter(endedAt)
    expect(of(q.threads, fence)).toMatchObject({ state: 'answered', reply: 'Larch posts, two metres.' })
    // The seeds thread got no line: it is the one thread the question asks about, under the words
    // he opened it with, and for its title. The fence thread is named only beside it, as the
    // subject his message before it was about (the question's form is the card's, threads-kept.ts linesAreCards).
    expect(listed(q.prompt)[0]).toContain('Now order the seeds')
    expect(listed(q.prompt).slice(1)).toEqual(['Orchard fence height'])
    expect(q.prompt).toMatch(/t1 "Now order the seeds[^"]*" \([^)]*he wrote in t2 just before it: merge it into one only if it is that subject[^)]*untitled/)
    expect(q.prompt).toContain('Each untitled thread gets a short title: FOR_USER_THREAD_TITLE: <ref> | <title>.')
  }, 40_000)

  // 2026-11-25, the live session: its fourth turn was sent back for a line on a thread that turn
  // never touched. The check took every message with no answer kept under it as this turn's, and
  // an isolated server keeps none (a busy one keeps them late).
  it('the check before a turn\'s end owes a line only for what this turn read, with no answer kept under the older messages', async () => {
    const before = (await readThreads(taskId)).threads
    // The seeds message was read by the turn before, which gave it no line; nothing kept an answer under it.
    expect(of(before, seeds)?.messages.every((m) => !m.answer)).toBe(true)
    await say('And what do the posts stand in?', fence)
    const rows = await cliTakes()
    await cliAnswers(rows)
    // A reply with the fence line: nothing to send back, the seeds thread included.
    // A reply with the fence line: the card check has nothing to send back, for the seeds thread
    // either (the summaries check, which is not about lines, still names a thread with no summary).
    const ok = await stopHook(`x\n\n<walnut-card thread="${fence}" state="answered" summary="Posts stand in gravel."/>`)
    expect(ok.reason ?? '').not.toContain('card line')
    // A reply with no line: held for the fence, where this turn's message went, and for no other thread.
    const held = await stopHook('x\n\nx')
    expect(held.decision).toBe('block')
    expect(held.reason).toContain(`your reply holds no card line for thread ${fence} `)
    expect(held.reason).not.toContain(`no card line for thread ${seeds}`)
    const endedAt = await turnEnds(rows, `In gravel, for drainage.\n\n<walnut-card thread="${fence}" state="answered" summary="Posts stand in gravel."/>`)
    const q = await questionAfter(endedAt)
    expect(of(q.threads, fence)?.reply).toBe('Posts stand in gravel.')
  }, 40_000)

  it('a decision: the line puts it to him with its choices before the question is built', async () => {
    await say('Which supplier do we take?', seeds)
    const rows = await cliTakes()
    const endedAt = await turnEnds(rows, `Two suppliers carry them. The choice is yours.\n\n<walnut-card thread="${seeds}" state="needs" title="Spring seed order" ask="Which seed supplier?" options="Larch Seeds; Oak Seeds" kind="spending" why="Oak Seeds costs twice the budget he set"/>`)
    const q = await questionAfter(endedAt)
    const t = of(q.threads, seeds)!
    expect(t).toMatchObject({ state: 'needs', ask: 'Which seed supplier?', title: 'Spring seed order', titled: true })
    expect(t.options?.map((o) => [o.label, !!o.recommended])).toEqual([['Larch Seeds', true], ['Oak Seeds', false]])
    // A thread that waits on him is his to move: the question asks no line for it.
    expect(listed(q.prompt)).not.toContain('Spring seed order')
  }, 40_000)

  it('a merge: his new message joins the thread the line names, and the thread it was filed under is not asked about', async () => {
    await say('And the gate, which way should it swing?')
    const rows = await cliTakes()
    const gate = filedUnder(rows[0])
    expect(gate).not.toBe(fence)
    // The hint names the open threads and gives the merge as a line too.
    expect(hintOf(rows[0])).toContain(`Same subject as an open one: <walnut-card thread="${gate}" merge="th-..."/> alone instead.`)
    expect(hintOf(rows[0])).not.toMatch(/thread_update merge_into|give it a short title/i)

    const endedAt = await turnEnds(rows, `Inward: the path outside is narrow. This is part of the fence.\n\n<walnut-card thread="${gate}" merge="${fence}"/>`)
    const q = await questionAfter(endedAt)
    expect(q.threads.find((t) => t.id === gate && !t.closed && !t.mergedInto)).toBeUndefined()
    expect(of(q.threads, fence)!.messages.map((m) => m.text)).toContain('And the gate, which way should it swing?')
    expect(listed(q.prompt).some((title) => title.includes('And the gate'))).toBe(false)
  }, 40_000)

  it('a reaction: once his answer is kept, a line that says he reacted marks it known and closes the thread', async () => {
    await say('What colour for the shed?')
    let rows = await cliTakes()
    shed = filedUnder(rows[0])
    let endedAt = await turnEnds(rows, `Green, like the gate.\n\n<walnut-card thread="${shed}" state="answered" title="Shed colour"/>`)
    await questionAfter(endedAt)
    // Here answers are kept when his Threads are read (no job does it on an isolated server).
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/api/v1/tasks/${taskId}/threads`)
      expect(((await res.json()) as { threads: OrgThread[] }).threads.find((t) => t.id === shed)?.messages[0].answer?.text).toBe('Green, like the gate.')
    }, { timeout: 20_000, interval: 500 })
    expect(of((await readThreads(taskId)).threads, shed)?.known).toBeUndefined()

    // He reacts in his next chat message, which is about something else and is filed on its own.
    await say('Green is good, thanks. Next: where does the water butt go?')
    rows = await cliTakes()
    const butt = filedUnder(rows[0])
    expect(butt).not.toBe(shed)
    endedAt = await turnEnds(rows, `By the shed downpipe.\n\n<walnut-card thread="${shed}" state="done" seen="yes"/>\n<walnut-card thread="${butt}" state="answered" title="Water butt place"/>`)
    const q = await questionAfter(endedAt)
    expect(of(q.threads, shed)?.known).toBeTruthy()
    expect(of(q.threads, shed)?.closed?.how).toBe('acked')
    expect(of(q.threads, butt)).toMatchObject({ title: 'Water butt place', titled: true, state: 'answered' })
    for (const title of listed(q.prompt)) expect(['Shed colour', 'Water butt place']).not.toContain(title)
  }, 60_000)

  it('a line written without seeing his newer message is not written, and the question asks about that thread', async () => {
    await say('Should the bench be painted too?')
    const rows = await cliTakes()
    const bench = filedUnder(rows[0])
    // He writes again in that thread while the turn runs: the line waits in the queue, unread.
    await say('Make it two coats.', bench)
    expect((await getQueue(SID)).filter((r) => r.status === 'pending')).toHaveLength(1)

    const endedAt = await turnEnds(rows, `Yes, one coat.\n\n<walnut-card thread="${bench}" state="answered" title="Bench paint" summary="One coat."/>`)
    const q = await questionAfter(endedAt)
    const t = of(q.threads, bench)!
    expect(t.state).not.toBe('answered')
    expect(t.reply).not.toBe('One coat.')
    expect(listed(q.prompt).some((title) => title.includes('Should the bench be painted'))).toBe(true)

    // The next turn read both: its line is written.
    const next = await cliTakes()
    const ended2 = await turnEnds(next, `Two coats then.\n\n<walnut-card thread="${bench}" state="answered" title="Bench paint" summary="Two coats."/>`)
    const q2 = await questionAfter(ended2)
    expect(of(q2.threads, bench)).toMatchObject({ state: 'answered', title: 'Bench paint', reply: 'Two coats.' })
    expect(listed(q2.prompt)).not.toContain('Bench paint')
  }, 60_000)

  it('a write still running when the question\'s wait runs out: every thread is asked as before, and the line lands when the write ends', async () => {
    await say('Where does the compost heap go?')
    const rows = await cliTakes()
    const compost = filedUnder(rows[0])
    // The session's write before this one hangs for longer than the question waits, holding the
    // chain all that time (its own hold given: by default one write holds it no longer than the
    // question waits, tests/core/sessions/status-thread-carded.test.ts).
    const hangMs = STATUS_SETTLE_MS + CARDS_WAIT_MAX_MS + 2_000
    void queueCardWrite(SID, () => new Promise((r) => setTimeout(r, hangMs)), hangMs)
    const endedAt = await turnEnds(rows, `Behind the shed, out of the wind.\n\n<walnut-card thread="${compost}" state="answered" title="Compost heap place"/>`)
    const q = await questionAfter(endedAt, STATUS_SETTLE_MS + CARDS_WAIT_MAX_MS + 10_000)
    // It waited its whole bound, then asked about the thread: nothing was noted for it yet.
    expect(q.at - endedAt).toBeGreaterThanOrEqual(STATUS_SETTLE_MS + CARDS_WAIT_MAX_MS - 250)
    expect(of(q.threads, compost)?.titled).toBeFalsy()
    expect(listed(q.prompt).some((title) => title.includes('Where does the compost heap go'))).toBe(true)
    // The write goes on: the line is on the thread once it ends.
    await vi.waitFor(async () => {
      expect(of((await readThreads(taskId)).threads, compost)).toMatchObject({ title: 'Compost heap place', titled: true, state: 'answered' })
    }, { timeout: 15_000, interval: 300 })
  }, 60_000)

  it('switch off: the hint asks for no line, a line a session still writes changes no thread, and the question asks about it as today', async () => {
    await setTag(false)
    await say('How deep is the pond?')
    const rows = await cliTakes()
    const pond = filedUnder(rows[0])
    expect(rows[0].message).not.toContain('walnut-card')
    const before = of((await readThreads(taskId)).threads, pond)!

    const endedAt = await turnEnds(rows, `A metre at the middle.\n\n<walnut-card thread="${pond}" state="done" title="Pond depth" summary="One metre."/>`)
    const q = await questionAfter(endedAt)
    expect(of(q.threads, pond)).toEqual(before)
    expect(listed(q.prompt).some((title) => title.includes('How deep is the pond'))).toBe(true)
  }, 40_000)
})
