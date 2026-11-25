/**
 * A node's reply that answers his question marks the question's thread answered in that turn, on a
 * real server (experiment threads_each_question, src/core/org/thread-answered-check.ts; 2026-11-25,
 * the reported case: his question's turn ended on an interim reply, a teammate's result woke the
 * node 17 minutes later, the node wrote the real answer in its chat, and the thread stayed working
 * with the interim reply on it, folded out of his sight).
 *
 * He types in the chat of a task with Threads on (the phone's send route), the turn ends as a real
 * one does and the status question is the one the turn-complete hook arms (tests/helpers/reply-card-flow.ts).
 * The first turn ends on the interim reply, its status answer keeping the thread working; the second,
 * started by a teammate's notice, ends on the real answer with no line for the thread.
 *
 * What's real: server (not isolated, so its job keeps the node's answers under his messages, as
 * production does), routes, task and threads stores, the send path, the turn end, the status
 * question and its answer, the read of the turn's reply from the transcript. Mocked: constants, the
 * daemon file reader, the CLI (a recorded fake session), and the fast model at its one seam.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-answered-check'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { readThreads } from '../../src/core/org/threads-store.js'
import { eachQuestionNow } from '../../src/core/org/thread-question.js'
import { setAnsweredJudgeOverride } from '../../src/core/org/thread-answered-check.js'
import { cardView } from '../../src/core/org/thread-view.js'
import { cliTakes, filedUnder, flow, listed, noticeTurnEnds, of, questionAfter, say, setTag, startFlow, stopFlow, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-0000000ea2c1'
const WORKING = 'FOR_USER_STATE: working\nFOR_USER_NOW: Reading the timetable.'
const NOTICE = '<walnut-message kind="notification" from="Walnut: subtask" outcome="done">The timetable reader finished: its result is in its report.</walnut-message>'
const INTERIM = 'I am looking into it: a subagent is reading the Saturday timetable now, and I will come back with the answer.'
const REAL = 'The 7:10 from the central station reaches the coast at 8:42: it is the only train before nine on Saturday.'

/** What the model was asked, and what it said: NOT_YET to the interim reply, ANSWERED to the real one. */
const judged: Array<{ input: string; said: string }> = []

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Weekend trip helper', project: 'Trips' })
  setAnsweredJudgeOverride(async (input) => {
    const said = input.includes('reaches the coast at 8:42') ? 'ANSWERED' : 'NOT_YET'
    judged.push({ input, said })
    return said
  })
}, 40_000)

afterAll(async () => {
  setAnsweredJudgeOverride(null)
  await stopFlow()
})

async function switches(each: boolean): Promise<void> {
  await setTag(false, { threads_kept_by_walnut: true, threads_reminder: true, threads_each_question: each })
  await vi.waitFor(() => { expect(eachQuestionNow()).toBe(each) }, { timeout: 5000 })
}

const thread = async (id: string) => of((await readThreads(flow.taskId)).threads, id)!

/** The ref the question lists a thread under, found by the start of its title. */
function refOf(prompt: string, title: string): string {
  const i = listed(prompt).findIndex((t) => title.startsWith(t.replace(/…$/, '').slice(0, 30)))
  if (i < 0) throw new Error(`"${title}" not listed in:\n${prompt}`)
  return `t${i + 1}`
}

/** He asks; the turn ends on the interim reply with a line that keeps his thread working. Its id. */
async function askAndPromise(question: string): Promise<string> {
  await say(question)
  const rows = await cliTakes()
  const id = filedUnder(rows[0])
  flow.statusAnswer = (prompt) => `${WORKING}\nFOR_USER_THREAD: ${refOf(prompt, question)} | working | Checking the Saturday timetable for him.`
  await questionAfter(await turnEnds(rows, INTERIM))
  return id
}

describe('a reply that answers his question marks its thread answered', () => {
  it('flag on: the interim reply leaves it working; the real answer in a later turn he did not start marks it answered, with the answer on it', async () => {
    await switches(true)
    const id = await askAndPromise('Which train reaches the coast before nine on Saturday?')
    // The interim reply was judged once, and not an answer: the thread stays as the line wrote it.
    await vi.waitFor(() => { expect(judged).toHaveLength(1) }, { timeout: 10_000 })
    expect(judged[0].said).toBe('NOT_YET')
    expect(judged[0].input).toContain('Which train reaches the coast before nine on Saturday?')
    let t = await thread(id)
    expect(t).toMatchObject({ state: 'working', reply: 'Checking the Saturday timetable for him.' })
    expect(t.messages[0].answer?.text).toBe(INTERIM)

    // A teammate's result wakes the node; it writes the real answer, and its status answer has no line for the thread.
    flow.statusAnswer = WORKING
    await questionAfter(await noticeTurnEnds(NOTICE, REAL))
    await vi.waitFor(async () => { expect((await thread(id)).state).toBe('answered') }, { timeout: 10_000 })
    expect(judged).toHaveLength(2)
    expect(judged[1].said).toBe('ANSWERED')
    t = await thread(id)
    expect(t.messages[0].answer).toMatchObject({ text: REAL, sid: SID })
    // The working summary is gone: his card's line is the answer's own.
    expect(t.reply).toBeUndefined()
    expect(cardView(t).summary).toMatchObject({ by: 'walnut', from: 'answer' })
    expect(cardView(t).summary.text).toContain('The 7:10 from the central station')

    // An answered thread is no candidate any more: the next turn asks the model nothing.
    flow.statusAnswer = WORKING
    await questionAfter(await noticeTurnEnds(NOTICE, REAL))
    await new Promise((r) => setTimeout(r, 1500))
    expect(judged).toHaveLength(2)
  }, 90_000)

  it('flag off: the same flow changes nothing and asks no model', async () => {
    await switches(false)
    const id = await askAndPromise('Which bike shop near the north fence is open on Sunday?')
    flow.statusAnswer = WORKING
    await questionAfter(await noticeTurnEnds(NOTICE, 'The shop by the north fence opens at ten on Sunday and closes at four, the only one open that day.'))
    await new Promise((r) => setTimeout(r, 2000))
    expect(judged).toHaveLength(2)
    const t = await thread(id)
    expect(t).toMatchObject({ state: 'working', reply: 'Checking the Saturday timetable for him.' })
    expect(t.messages[0].answer?.text).toBe(INTERIM)
  }, 90_000)
})
