/**
 * Each question he asks is its own thread, on a real server (experiment threads_each_question,
 * src/core/org/thread-question.ts; 2026-11-25, the user, after his second question on one subject,
 * asked 3.5 minutes after the first, was merged into the first's thread by the node's status answer:
 * "each question I ask needs to have one thread, otherwise how can I track").
 *
 * He types in the chat of a task with Threads on (the phone's send route), the CLI takes the lines,
 * the turn ends as a real one does and the status question is the one the turn-complete hook arms
 * (tests/helpers/reply-card-flow.ts). The fake session answers it the way the reported node did: a
 * FOR_USER_THREAD_MERGE of his second question into the first, and a title that repeats the first's.
 * Then the other ways a node merges: thread_update merge_into, thread_split merge_into, merge_into a
 * thread of a task below, and a reply's card line (at the turn end and by the reply). Off first:
 * today's behaviour, his second question joins the first by timing.
 *
 * What's real: server, routes, task and threads stores, the send path, the turn end and the status
 * question. Mocked: constants, the daemon file reader, the CLI (a recorded fake session).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-each-question', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { fileThreadMessage, readThreads } from '../../src/core/org/threads-store.js'
import { eachQuestionNow } from '../../src/core/org/thread-question.js'
import { applyReplyCards } from '../../src/core/org/reply-card.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { cliTakes, filedUnder, flow, hintOf, listed, of, questionAfter, say, setTag, startFlow, stopFlow, stopHook, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-0000000eac11'
const A_TITLE = 'Bike ride time to the north fence workshop'
const Q_A = 'How long does the bike ride to the north fence workshop take?'
const Q_B = 'Can the bike ride to the fence workshop go along the river instead?'
const REMARK = 'The river path was muddy last week'
const WORKING = 'FOR_USER_STATE: working\nFOR_USER_NOW: Planning the ride.'

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Weekend ride helper', project: 'Rides' })
  // His messages minutes apart are one conversation, as in production (the flow turns the join off).
  process.env.WALNUT_THREAD_JOIN_SECS = '180'
}, 40_000)

afterAll(stopFlow)

async function switches(each: boolean, tag = false): Promise<void> {
  await setTag(tag, { threads_kept_by_walnut: true, threads_reminder: true, threads_each_question: each })
  await vi.waitFor(() => { expect(eachQuestionNow()).toBe(each) }, { timeout: 5000 })
}

/** The ref the question lists a thread under, found by the start of its title. */
function refOf(prompt: string, title: string): string {
  const i = listed(prompt).findIndex((t) => t.startsWith(title.slice(0, 30)))
  if (i < 0) throw new Error(`"${title}" not listed in:\n${prompt}`)
  return `t${i + 1}`
}

const thread = async (id: string) => of((await readThreads(flow.taskId)).threads, id)!
const texts = async (id: string) => (await thread(id)).messages.map((m) => m.text)

/** The session's op, as its CLI calls it. */
const asSession = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: `${flow.base}/api/v1`, origin: LOCAL_ORIGIN, callerMode: 'session', callerSid: SID })

describe('each question he asks is its own thread', () => {
  let a = ''
  let b = ''

  it('flag off: his second question within the minute joins the first by timing, as today', async () => {
    await switches(false)
    flow.statusAnswer = WORKING
    await say('Which train goes to the coast early on Saturday?')
    let rows = await cliTakes()
    const first = filedUnder(rows[0])
    await questionAfter(await turnEnds(rows, 'The 7:10 is the earliest.'))
    await say('Does the early train stop at the harbour?')
    rows = await cliTakes()
    expect(filedUnder(rows[0])).toBe(first)
    expect(hintOf(rows[0])).toContain('it came right after his last message there')
    await questionAfter(await turnEnds(rows, 'It does, at 7:52.'))
    expect(await texts(first)).toEqual(['Which train goes to the coast early on Saturday?', 'Does the early train stop at the harbour?'])
  }, 60_000)

  it('flag on: two questions, two threads; the status answer\'s merge of the second is refused and its title is asked again', async () => {
    await switches(true)
    // Question A, a minute after his last message: its own thread all the same.
    await say(Q_A)
    let rows = await cliTakes()
    a = filedUnder(rows[0])
    expect(hintOf(rows[0])).toContain(`filed as new thread ${a}`)
    flow.statusAnswer = (prompt) => `${WORKING}\nFOR_USER_THREAD_TITLE: ${refOf(prompt, Q_A)} | ${A_TITLE}\nFOR_USER_THREAD: ${refOf(prompt, Q_A)} | working | Checking the route to the workshop.`
    await questionAfter(await turnEnds(rows, 'About 40 minutes on the road.'))
    expect(await thread(a)).toMatchObject({ title: A_TITLE, titled: true })

    // Question B on the same subject within the minute, then a remark that asks nothing.
    await say(Q_B)
    await say(REMARK)
    rows = await cliTakes()
    expect(rows).toHaveLength(2)
    b = filedUnder(rows[0])
    expect(b).not.toBe(a)
    expect(hintOf(rows[0])).toContain('His own question: its own thread')
    expect(hintOf(rows[0])).not.toContain('merge_into')
    expect(filedUnder(rows[1])).toBe(b)
    expect(await texts(a)).toEqual([Q_A])
    expect(await texts(b)).toEqual([Q_B, REMARK])

    // The node answers as the reported one did: B merged into A, titled like A, with its line.
    let asked = ''
    flow.statusAnswer = (prompt) => {
      asked = prompt
      const [rb, ra] = [refOf(prompt, Q_B), refOf(prompt, A_TITLE)]
      return `${WORKING}\nFOR_USER_THREAD_MERGE: ${rb} | ${ra}\nFOR_USER_THREAD_TITLE: ${rb} | ${A_TITLE}\nFOR_USER_THREAD: ${rb} | working | Looking at the river path for the ride.`
    }
    await questionAfter(await turnEnds(rows, 'The river path adds ten minutes.'))
    // The question offered no merge for his questions.
    expect(asked).not.toContain('FOR_USER_THREAD_MERGE')
    const bt = await thread(b)
    expect(bt.closed).toBeUndefined()
    expect(bt.messages.map((m) => m.text)).toEqual([Q_B, REMARK])
    // Its line is written on it, and the title that repeats A's is held, not written.
    expect(bt).toMatchObject({ state: 'working', reply: 'Looking at the river path for the ride.' })
    expect(bt.titled).toBeFalsy()
    expect(bt.titleHeld).toMatchObject({ title: A_TITLE, like: a })
    expect(await texts(a)).toEqual([Q_A])

    // The next question asks it a title of its own, never the merge.
    await say('I will pack a rain jacket', b)
    rows = await cliTakes()
    flow.statusAnswer = (prompt) => `${WORKING}\nFOR_USER_THREAD_TITLE: ${refOf(prompt, Q_B)} | River route for the workshop ride`
    const q = await questionAfter(await turnEnds(rows, 'Good call.'))
    const rb = refOf(q.prompt, Q_B)
    expect(q.prompt).toContain(`His own questions whose title repeats another listed thread: ${rb}, which you titled "${A_TITLE}"`)
    expect(q.prompt).toContain('Each stays its own thread: give it a title that says what this question asks, and answer it there')
    expect(q.prompt).not.toContain('FOR_USER_THREAD_MERGE')
    expect(await thread(b)).toMatchObject({ title: 'River route for the workshop ride', titled: true })
    expect((await thread(b)).titleHeld).toBeUndefined()
  }, 90_000)

  it('a node\'s thread_update merge_into and thread_split merge_into of his question are refused; his own merge goes through', async () => {
    const merge = await asSession('thread_update', { id: b, merge_into: a })
    expect(merge.ok).toBe(false)
    expect(JSON.stringify(merge)).toContain('is his own question, so it stays its own thread')
    const first = (await thread(b)).messages[0].id
    const split = await asSession('thread_split', { id: b, message: first, merge_into: a })
    expect(split.ok).toBe(false)
    expect(JSON.stringify(split)).toContain('is his own question')
    expect(await texts(b)).toEqual([Q_B, REMARK, 'I will pack a rain jacket'])
    expect(await texts(a)).toEqual([Q_A])
  }, 30_000)

  it('merge_into a thread on a task below refuses his question and moves nothing', async () => {
    const child = (await addTask({ title: 'Workshop booking', project: 'Rides', parent_task_id: flow.taskId })).task.id
    await updateTaskRaw(child, { threads_on: true } as never, { source: 'test' })
    const there = (await fileThreadMessage(child, { text: 'book the workshop slot for Saturday morning', via: 'chat', at: new Date().toISOString() })).thread.id
    const r = await asSession('thread_update', { id: b, merge_into: there })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('is his own question')
    const bt = await thread(b)
    expect(bt.closed).toBeUndefined()
    expect(bt.movedTo).toBeUndefined()
    expect((await readThreads(child)).threads.map((t) => t.id)).toEqual([there])
  }, 30_000)

  it('a card line\'s merge of his question is refused at the turn end and by the reply, and he is told why', async () => {
    await switches(true, true)
    const line = `<walnut-card thread="${b}" merge="${a}"/>`
    const stop = await stopHook(`The river route works.\n\n${line}`)
    expect(stop.decision).toBe('block')
    expect(stop.reason).toContain(`${b} was not merged`)
    expect(stop.reason).toContain('is his own question')
    const task = (await getTask(flow.taskId))!
    const out = await applyReplyCards({ task, sessionId: SID, reply: `The river route works.\n\n${line}` })
    expect(out.applied).not.toContain(b)
    expect(out.refused.find((x) => x.thread === b)?.reason).toContain('is his own question')
    expect((await thread(b)).closed).toBeUndefined()
    expect(await texts(a)).toEqual([Q_A])
    await switches(true)
  }, 30_000)

  it('he may still merge it himself', async () => {
    const res = await fetch(`${flow.base}/api/v1/tasks/${flow.taskId}/threads/${b}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merge_into: a }) })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await texts(a)).toEqual([Q_A, Q_B, REMARK, 'I will pack a rain jacket'])
  }, 30_000)
})
