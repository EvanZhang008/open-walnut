/**
 * The answered check's cheap gate (src/core/org/thread-answered-check.ts checkOnce): a turn whose
 * node has no question of his a reply may answer reads no transcript and calls no model. Review
 * 2026-11-26: an answer the check wrote stayed open to replacement with no time limit, so one such
 * thread made every later turn read the transcript and call the model. Past JUDGED_REOPEN_MS it is
 * no candidate, and the gate stops there.
 *
 * Mocked: the node's task, the Threads switch, the threads read, the transcript read and the model
 * seam. Real: the check itself and the threads model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyThreads, fileMessage, setAnswers, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import type { AnswerRow } from '../../../src/core/org/thread-answers.js'

const NODE = 'bakery-gate-node'
const state: { file: ThreadsFile; rows: AnswerRow[]; rowReads: number } = { file: emptyThreads(NODE), rows: [], rowReads: 0 }

vi.mock('../../../src/core/server-role.js', async (orig) => ({ ...(await orig<object>()), isFollower: () => false }))
vi.mock('../../../src/core/org/thread-question.js', async (orig) => ({ ...(await orig<object>()), eachQuestionOn: async () => true }))
vi.mock('../../../src/core/task-manager.js', async (orig) => ({ ...(await orig<object>()), getTask: async () => ({ id: NODE, org_role: 'lead' }) }))
vi.mock('../../../src/core/org/threads-store.js', async (orig) => ({
  ...(await orig<object>()),
  readThreads: async () => state.file,
  // The locked write, on the file in memory.
  writeThreadsFor: async (_id: string, fn: (cur: ThreadsFile) => { file: ThreadsFile; out: unknown }) => { const r = fn(state.file); state.file = r.file; return r.out },
}))
vi.mock('../../../src/core/org/thread-answers.js', async (orig) => ({
  ...(await orig<object>()),
  rowsSince: async () => { state.rowReads++; return state.rows },
  transcriptSource: async () => ({}),
}))

const { checkTurnAnswers, markAnswered, setAnsweredJudgeOverride, __resetAnsweredCheck, CONFIRM_MAX, JUDGED_REOPEN_MS } = await import('../../../src/core/org/thread-answered-check.js')

const REPLY = 'The bakery by the coast station opens at six on weekdays and at seven on Saturday mornings.'

/** His question, answered by the check `agoMs` before now, with nothing of his since. */
function answeredAgo(agoMs: number): ThreadsFile {
  const now = Date.now()
  const iso = (ms: number) => new Date(now - ms).toISOString()
  const a = fileMessage(emptyThreads(NODE), { text: 'When does the bakery by the coast station open?', via: 'chat', at: iso(agoMs + 120_000) })
  const f = updateThread(a.file, a.thread.id, { state: 'working' }, `task:${NODE}`, iso(agoMs + 60_000), undefined, { line: true }).file
  return markAnswered(f, a.thread.id, { text: `${REPLY} (first answer)`, at: iso(agoMs) }, iso(agoMs - 1000), iso(agoMs + 1000)).file
}

let calls = 0
beforeEach(() => {
  __resetAnsweredCheck()
  calls = 0
  state.rowReads = 0
  state.rows = [{ role: 'assistant', text: REPLY, timestamp: new Date().toISOString() }]
  setAnsweredJudgeOverride(async () => { calls++; return 'NONE' })
})
afterEach(() => setAnsweredJudgeOverride(null))

describe('the gate before the transcript read and the model call', () => {
  it('an answer the check wrote past its window: no transcript read, no model call', async () => {
    state.file = answeredAgo(JUDGED_REOPEN_MS + 10 * 60_000)
    expect(state.file.threads[0]).toMatchObject({ state: 'answered' })
    expect(await checkTurnAnswers(NODE, 'sid-gate-1', Date.now())).toBe(0)
    expect(state.rowReads).toBe(0)
    expect(calls).toBe(0)
  })

  it('within its window the next reply is read and judged once', async () => {
    state.file = answeredAgo(30 * 60_000)
    expect(await checkTurnAnswers(NODE, 'sid-gate-2', Date.now())).toBe(0)
    expect(state.rowReads).toBe(1)
    expect(calls).toBe(1)
  })
})

/** His questions, each worked on with an interim reply under it, asked a few minutes ago. Their thread ids, oldest first. */
function waiting(questions: string[]): string[] {
  const now = Date.now()
  let f = emptyThreads(NODE)
  const ids: string[] = []
  questions.forEach((text, i) => {
    // Far enough apart that each is its own thread, never a follow-up of the one before.
    const at = (ms: number) => new Date(now - 3_600_000 + i * 420_000 + ms).toISOString()
    const a = fileMessage(f, { text, via: 'chat', at: at(0) })
    f = setAnswers(a.file, new Map([[a.message.id, { text: 'I am looking into it and will come back with the answer.', at: at(1000) }]])).file
    f = updateThread(f, a.thread.id, { state: 'working' }, `task:${NODE}`, at(2000), undefined, { line: true }).file
    ids.push(a.thread.id)
  })
  state.file = f
  expect(new Set(ids).size).toBe(questions.length)
  return ids
}
const stateOf = (id: string) => state.file.threads.find((t) => t.id === id)

describe('the second read decides what is written (review 2026-11-26)', () => {
  it('two questions named, one confirmed: that one is answered alone, the other stays as it was', async () => {
    const [bakery, ferry] = waiting(['When does the bakery by the coast station open?', 'When does the last ferry to the island leave?'])
    const seconds: string[] = []
    setAnsweredJudgeOverride(async () => 'ANSWERED: 1, 2', async (input) => {
      seconds.push(input)
      return input.includes('When does the bakery by the coast station open?') ? '"The bakery by the coast station opens at six on weekdays" => YES' : '"-" => NO'
    })
    expect(await checkTurnAnswers(NODE, 'sid-gate-3', Date.now())).toBe(1)
    expect(seconds).toHaveLength(2)
    expect(stateOf(bakery)).toMatchObject({ state: 'answered' })
    expect(stateOf(bakery)?.messages[0].answer).toMatchObject({ text: REPLY, judged: true })
    // Not merged into the other, not marked, its interim reply kept.
    expect(state.file.threads.filter((t) => !t.closed)).toHaveLength(2)
    expect(stateOf(ferry)).toMatchObject({ state: 'working' })
    expect(stateOf(ferry)?.messages[0].answer?.text).toContain('I am looking into it')
  })

  it('more questions named than the second read takes: only the first CONFIRM_MAX are read, and one not read is never written', async () => {
    const ids = waiting(['When does the bakery open?', 'When does the ferry leave?', 'When does the mill close?', 'When does the market start?', 'When does the tram stop?', 'When does the library open?'].slice(0, CONFIRM_MAX + 1))
    let seconds = 0
    setAnsweredJudgeOverride(async () => `ANSWERED: ${ids.map((_, i) => i + 1).join(', ')}`, async () => { seconds++; return '"-" => NO' })
    expect(await checkTurnAnswers(NODE, 'sid-gate-4', Date.now())).toBe(0)
    expect(seconds).toBe(CONFIRM_MAX)
    for (const id of ids) expect(stateOf(id)).toMatchObject({ state: 'working' })
  })

  it('a list stand-in with no second one confirms nothing', async () => {
    const [bakery] = waiting(['When does the bakery by the coast station open?'])
    setAnsweredJudgeOverride(async () => 'ANSWERED: 1')
    expect(await checkTurnAnswers(NODE, 'sid-gate-5', Date.now())).toBe(0)
    expect(stateOf(bakery)).toMatchObject({ state: 'working' })
  })
})

