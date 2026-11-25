/**
 * A thread its reply's card line spoke for is not asked about by the status question of that turn
 * (experiment threads_reply_tag; src/core/sessions/status-thread-carded.ts, status-threads.ts
 * threadQuestionFor): that question's model pass is what the line saves. Every thread with no line
 * is still asked, so a line left out loses nothing; with the switch off the record is never read.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-carded'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { cardedNow, cardsWritten, CARDS_WAIT_MAX_MS, noteCarded, queueCardWrite, resetCarded } from '../../../src/core/sessions/status-thread-carded.js'
import { threadQuestionFor } from '../../../src/core/sessions/status-threads.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { setReplyTag } from '../../../src/core/org/reply-card-switch.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'

const FENCE = 'th-feec0de1'
const SEEDS = 'th-feec0de2'
const TASK = { id: 'lead-carded-1', org_role: 'lead' as const }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

function fixture(): OrgThread[] {
  return [
    { id: FENCE, title: 'Orchard fence', titled: true, state: 'working', reply: 'Posts are in; the rails come Friday.', replyAt: ago(30), createdAt: ago(40), updatedAt: ago(30), by: `task:${TASK.id}`,
      messages: [{ id: 'tm-feec0de1', at: ago(40), text: 'How tall should the orchard fence be?', via: 'chat', answer: { text: 'Two metres keeps the deer out.', at: ago(30) } }] },
    { id: SEEDS, title: 'Spring seed order', titled: true, state: 'working', reply: 'Comparing two suppliers.', replyAt: ago(9), createdAt: ago(10), updatedAt: ago(9), by: `task:${TASK.id}`,
      messages: [{ id: 'tm-feec0de2', at: ago(10), text: 'ok, now order the seeds for spring', via: 'chat', answer: { text: 'On it: I compare two suppliers.', at: ago(9) } }] },
  ] as OrgThread[]
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${TASK.id}.json`), JSON.stringify({ version: 1, taskId: TASK.id, threads: fixture() }))
})
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })
afterEach(() => { resetCarded(); setReplyTag(false); setThreadsKept(false) })

describe('the record of what a turn\'s card lines spoke for', () => {
  const threads = [{ id: FENCE, messages: [{ id: 'tm-1' }, { id: 'tm-2' }] }, { id: SEEDS, messages: [] }]

  it('a thread is spoken for while it holds nothing of his newer than the line saw', () => {
    noteCarded('t-1', [{ id: FENCE, upTo: 'tm-2' }, { id: SEEDS, upTo: '' }])
    expect([...cardedNow('t-1', threads)].sort()).toEqual([FENCE, SEEDS].sort())
    // He wrote in the fence thread since.
    expect([...cardedNow('t-1', [{ id: FENCE, messages: [{ id: 'tm-1' }, { id: 'tm-2' }, { id: 'tm-3' }] }, threads[1]])]).toEqual([SEEDS])
    // The line saw only the first message.
    noteCarded('t-1', [{ id: FENCE, upTo: 'tm-1' }])
    expect([...cardedNow('t-1', threads)]).toEqual([])
  })

  it('the next turn\'s end replaces it; a turn with no line clears it; another task has none', () => {
    noteCarded('t-1', [{ id: FENCE, upTo: 'tm-2' }])
    expect(cardedNow('t-2', threads).size).toBe(0)
    noteCarded('t-1', [{ id: SEEDS, upTo: '' }])
    expect([...cardedNow('t-1', threads)]).toEqual([SEEDS])
    noteCarded('t-1', [])
    expect(cardedNow('t-1', threads).size).toBe(0)
  })
})

describe('the status question after the turn', () => {
  it('asks about every open thread when no line spoke', async () => {
    setThreadsKept(true)
    setReplyTag(true)
    const { block, refs } = await threadQuestionFor(TASK)
    expect(block).toContain('"Orchard fence"')
    expect(block).toContain('"Spring seed order"')
    expect([...refs.values()].map((r) => r.id).sort()).toEqual([FENCE, SEEDS].sort())
  })

  it('leaves out the thread a line spoke for, and still asks the other', async () => {
    setThreadsKept(true)
    setReplyTag(true)
    noteCarded(TASK.id, [{ id: FENCE, upTo: 'tm-feec0de1' }])
    const { block, refs } = await threadQuestionFor(TASK)
    expect(block).not.toContain('"Orchard fence"')
    expect(block).toContain('"Spring seed order"')
    expect([...refs.values()].map((r) => r.id)).toEqual([SEEDS])
  })

  it('holds no thread block at all when a line spoke for every open thread', async () => {
    setThreadsKept(true)
    setReplyTag(true)
    noteCarded(TASK.id, [{ id: FENCE, upTo: 'tm-feec0de1' }, { id: SEEDS, upTo: 'tm-feec0de2' }])
    expect(await threadQuestionFor(TASK)).toEqual({ block: '', refs: new Map() })
  })

  it('asks again about a thread whose line did not see his newest message', async () => {
    setThreadsKept(true)
    setReplyTag(true)
    noteCarded(TASK.id, [{ id: FENCE, upTo: 'tm-older' }, { id: SEEDS, upTo: 'tm-feec0de2' }])
    const { refs } = await threadQuestionFor(TASK)
    expect([...refs.values()].map((r) => r.id)).toEqual([FENCE])
  })

  it('switch off: the record is not read, and the question is as it was', async () => {
    setThreadsKept(true)
    const before = await threadQuestionFor(TASK)
    noteCarded(TASK.id, [{ id: FENCE, upTo: 'tm-feec0de1' }, { id: SEEDS, upTo: 'tm-feec0de2' }])
    const after = await threadQuestionFor(TASK)
    expect(after.block).toBe(before.block)
    expect([...after.refs.values()].map((r) => r.id).sort()).toEqual([FENCE, SEEDS].sort())
  })
})

// 2026-11-25, a real session: the line was in the reply and the question asked about its thread
// anyway, because the write came after something slower. The question now waits for the write.
describe('the question waits for the turn\'s card write', () => {
  const SID = 'sess-carded-1'
  const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('a write on its way is waited for, and what it notes is read: the thread is left out', async () => {
    setThreadsKept(true)
    setReplyTag(true)
    void queueCardWrite(SID, async () => { await later(300); noteCarded(TASK.id, [{ id: FENCE, upTo: 'tm-feec0de1' }]) })
    const started = Date.now()
    const { refs } = await threadQuestionFor(TASK, undefined, { sessionId: SID })
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    expect([...refs.values()].map((r) => r.id)).toEqual([SEEDS])
    // Done: the next question waits for nothing.
    expect(await cardsWritten(SID, 5)).toBe(true)
  })

  it('writes of one session run one after another, and the wait covers them all', async () => {
    const order: string[] = []
    void queueCardWrite(SID, async () => { await later(120); order.push('first') })
    void queueCardWrite(SID, async () => { order.push('second') })
    expect(await cardsWritten(SID)).toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('a write that fails is over: nothing waits for it, and the next one still runs', async () => {
    void queueCardWrite(SID, async () => { throw new Error('store busy') })
    let ran = false
    await queueCardWrite(SID, async () => { ran = true })
    expect(ran).toBe(true)
    expect(await cardsWritten(SID, 5)).toBe(true)
  })

  it('no write, another session\'s write, or no session named: no wait', async () => {
    void queueCardWrite('sess-other', () => later(400))
    const started = Date.now()
    expect(await cardsWritten(SID)).toBe(true)
    expect(await cardsWritten(undefined)).toBe(true)
    await threadQuestionFor(TASK)
    expect(Date.now() - started).toBeLessThan(300)
  })

  it('at the bound the wait ends, and the question leaves no thread out: what an earlier turn noted is not trusted', async () => {
    setThreadsKept(true)
    setReplyTag(true)
    expect(CARDS_WAIT_MAX_MS).toBe(10_000)
    // The turn before spoke for both; this turn's write hangs.
    noteCarded(TASK.id, [{ id: FENCE, upTo: 'tm-feec0de1' }, { id: SEEDS, upTo: 'tm-feec0de2' }])
    let finish = () => {}
    void queueCardWrite(SID, () => new Promise<void>((r) => { finish = r }))
    expect(await cardsWritten(SID, 40)).toBe(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const asked = threadQuestionFor(TASK, undefined, { sessionId: SID })
      await vi.advanceTimersByTimeAsync(CARDS_WAIT_MAX_MS + 10)
      vi.useRealTimers()
      const { refs } = await asked
      expect([...refs.values()].map((r) => r.id).sort()).toEqual([FENCE, SEEDS].sort())
    } finally {
      vi.useRealTimers()
      finish()
    }
    // The write ended: what it noted counts again.
    await later(10)
    expect((await threadQuestionFor(TASK, undefined, { sessionId: SID })).refs.size).toBe(0)
  })

  it('switch off: nothing queues a write, and a question with a session named is as it was', async () => {
    setThreadsKept(true)
    const before = await threadQuestionFor(TASK)
    expect(await threadQuestionFor(TASK, undefined, { sessionId: SID })).toEqual(before)
  })
})
