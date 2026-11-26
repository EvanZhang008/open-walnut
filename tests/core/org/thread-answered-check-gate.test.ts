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
import { emptyThreads, fileMessage, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import type { AnswerRow } from '../../../src/core/org/thread-answers.js'

const NODE = 'bakery-gate-node'
const state: { file: ThreadsFile; rows: AnswerRow[]; rowReads: number } = { file: emptyThreads(NODE), rows: [], rowReads: 0 }

vi.mock('../../../src/core/server-role.js', async (orig) => ({ ...(await orig<object>()), isFollower: () => false }))
vi.mock('../../../src/core/org/thread-question.js', async (orig) => ({ ...(await orig<object>()), eachQuestionOn: async () => true }))
vi.mock('../../../src/core/task-manager.js', async (orig) => ({ ...(await orig<object>()), getTask: async () => ({ id: NODE, org_role: 'lead' }) }))
vi.mock('../../../src/core/org/threads-store.js', async (orig) => ({ ...(await orig<object>()), readThreads: async () => state.file }))
vi.mock('../../../src/core/org/thread-answers.js', async (orig) => ({
  ...(await orig<object>()),
  rowsSince: async () => { state.rowReads++; return state.rows },
  transcriptSource: async () => ({}),
}))

const { checkTurnAnswers, markAnswered, setAnsweredJudgeOverride, __resetAnsweredCheck, JUDGED_REOPEN_MS } = await import('../../../src/core/org/thread-answered-check.js')

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
