/**
 * A node's claim that he reacted to an answer is read against his words, on a real server with
 * only the CLI and the small model faked (experiment threads_seen_check,
 * src/core/org/thread-seen-check.ts; 2026-11-26, a trial with a real session: he thanked the
 * session for one answer, and its line marked another thread's answer seen too, 5 runs of 5).
 *
 *   1. he asks two things, each answered and kept under his message;
 *   2. his next message thanks for ONE of them and asks something new;
 *   3. the session's reply ends with a done line that says seen for BOTH;
 *   4. the judge reads his words: the thread he thanked for is known and closed, the other keeps
 *      its answer on his card (answered, not known, not closed);
 *   5. the same claim made with the session's own thread_update is refused, and says why.
 * The flow is the real one (tests/helpers/reply-card-flow.ts): the phone's send route, the hint,
 * the turn's end, the card write, the status question.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-seen-check-e2e', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { readThreads } from '../../src/core/org/threads-store.js'
import { seenCheckOn, setSeenJudgeOverride } from '../../src/core/org/thread-seen-check.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { cliTakes, filedUnder, flow, of, questionAfter, say, setTag, startFlow, stopFlow, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-0000005ee4c4'
let base = ''
let taskId = ''
const asked: string[] = []

/** One question, answered with a titled line, its reply kept under his message. */
async function ask(question: string, reply: string, title: string): Promise<string> {
  await say(question)
  const rows = await cliTakes()
  const id = filedUnder(rows[0])
  const endedAt = await turnEnds(rows, `${reply}\n\n<walnut-card thread="${id}" state="answered" title="${title}"/>`)
  await questionAfter(endedAt)
  // Here answers are kept when his Threads are read (no job does it on an isolated server).
  await vi.waitFor(async () => {
    const res = await fetch(`${base}/api/v1/tasks/${taskId}/threads`)
    expect(((await res.json()) as { threads: OrgThread[] }).threads.find((t) => t.id === id)?.messages[0].answer?.text).toBe(reply)
  }, { timeout: 20_000, interval: 500 })
  return id
}

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Garden pond helper', project: 'Garden' })
  base = flow.base
  taskId = flow.taskId
  await setTag(true, { threads_reminder: true, threads_seen_check: true })
  expect(await seenCheckOn()).toBe(true)
  // The judge, asked once per claim: YES only for the hedge answer, and it keeps what it was asked.
  setSeenJudgeOverride(async (input) => {
    asked.push(input)
    return input.includes('his question (thread "North hedge")') ? '"Hornbeam it is, thanks" => YES' : 'none => NO'
  })
}, 40_000)

afterAll(async () => { setSeenJudgeOverride(null); await stopFlow() })

describe('a seen claim is read against his words', () => {
  let pond = ''
  let hedge = ''

  it('a line that says seen for two threads marks only the one his words are about', async () => {
    pond = await ask('How deep should the pond be?', 'Sixty centimetres at the middle.', 'Pond depth')
    hedge = await ask('Which hedge for the north side?', 'Hornbeam: it keeps its leaves in winter.', 'North hedge')
    expect(of((await readThreads(taskId)).threads, pond)?.known).toBeUndefined()
    expect(of((await readThreads(taskId)).threads, hedge)?.known).toBeUndefined()

    // He thanks for the hedge answer only, and asks something new: filed on its own.
    await say('Hornbeam it is, thanks. Next: how many paving slabs for the path?')
    const rows = await cliTakes()
    const slabs = filedUnder(rows[0])
    expect([pond, hedge]).not.toContain(slabs)
    const endedAt = await turnEnds(rows, `Forty slabs.\n\n<walnut-card thread="${pond}" state="done" seen="yes"/>\n<walnut-card thread="${hedge}" state="done" seen="yes"/>\n<walnut-card thread="${slabs}" state="answered" title="Paving slabs"/>`)
    const q = await questionAfter(endedAt)

    // One call per claim: its question, its answer, and his newest message; the hedge answer was the last he got.
    expect(asked).toHaveLength(2)
    const pondAsk = asked.find((x) => x.includes('his question (thread "Pond depth")'))!
    const hedgeAsk = asked.find((x) => x.includes('his question (thread "North hedge")'))!
    expect(hedgeAsk).toContain('the assistant\'s answer (the last answer he got before he wrote what follows)\nHornbeam: it keeps its leaves in winter.')
    expect(pondAsk).toContain('the assistant\'s answer\nSixty centimetres at the middle.')
    for (const x of [pondAsk, hedgeAsk]) expect(x).toContain('what he wrote afterwards, oldest first\n- Hornbeam it is, thanks. Next: how many paving slabs for the path?\n')
    // The hedge question was answered in its own turn: it is not read again as a reaction to the pond answer.
    expect(pondAsk).not.toContain('- Which hedge for the north side?')

    expect(of(q.threads, hedge)?.known).toBeTruthy()
    expect(of(q.threads, hedge)?.closed?.how).toBe('acked')
    // The pond answer he never reacted to stays on his card.
    const p = of(q.threads, pond)!
    expect(p.known).toBeUndefined()
    expect(p.closed).toBeUndefined()
    expect(p.state).toBe('answered')
    expect(p.messages[0].readAt).toBeUndefined()
    const shown = ((await (await fetch(`${base}/api/v1/tasks/${taskId}/threads`)).json()) as { threads: Array<OrgThread & { shown?: boolean }> }).threads.find((t) => t.id === pond)
    expect(shown?.shown).toBe(true)
  }, 120_000)

  it('the same claim through the session\'s own thread_update is refused, and says why', async () => {
    const res = await fetch(`${base}/api/v1/tasks/${taskId}/threads/${pond}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': SID }, body: JSON.stringify({ known: 'all' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: { code?: string; message?: string } | string; code?: string; message?: string }
    expect(JSON.stringify(body)).toContain('not_reacted')
    expect(JSON.stringify(body)).toContain('Walnut read those words and they do not react to it')
    expect(asked).toHaveLength(3)
    expect(of((await readThreads(taskId)).threads, pond)?.known).toBeUndefined()
  }, 40_000)
})
