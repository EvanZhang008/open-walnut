/**
 * One reply, one card, through the store (src/core/org/threads-store.ts writeOwnThreads,
 * setThreadAnswers, joinOneReplyCards; thread-one-reply.ts), on both ways threads are kept: the
 * node's lines and the answers read from its chat reach the store as two writes, in either order,
 * and the second one leaves the two questions one thread, with one `merged` change for it. What
 * another write left so (a node's own op) is joined by the thread check's step, which writes
 * nothing when there is nothing to join.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-one-reply-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { closeThreadsDb } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, useThreadsDb } from '../../../src/core/org/threads-backend.js'
import { _setThreadsExportEveryForTesting } from '../../../src/core/org/threads-sync.js'
import * as store from '../../../src/core/org/threads-store.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { eachQuestionOn } from '../../../src/core/org/thread-question.js'
import { applyThreadLines } from '../../../src/core/sessions/status-threads.js'
import { listedForHim } from '../../../src/core/org/thread-view.js'

// A node of its own per test: a late export of one test's threads never reaches the next one's.
let NODE = 'node-one-reply-store'
let n = 0
const SUB = 'test-thread-one-reply-store'
const R_BOTH = 'Yes, oil the top hinge before you start. The primer goes on first, and the gloss only once the primer is dry.'
const now = () => new Date().toISOString()
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString()

beforeEach(async () => {
  NODE = `node-one-reply-store-${++n}`
  bus.unsubscribe(SUB)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  _setThreadsExportEveryForTesting(undefined)
  await updateConfig({ experimental: { threads_each_question: true } })
  expect(await eachQuestionOn()).toBe(true)
})

afterAll(async () => {
  bus.unsubscribe(SUB)
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** Two questions he typed before the node spoke: two threads, both waiting. */
async function twoQuestions() {
  const a = await store.fileThreadMessage(NODE, { text: 'Does the top hinge of the shed door need oil as well?', via: 'chat', at: ago(40) })
  const b = await store.fileThreadMessage(NODE, { text: 'Which goes on first, the primer or the gloss?', via: 'chat', at: ago(25) })
  expect(a.thread.id).not.toBe(b.thread.id)
  return { hinge: a.thread.id, order: b.thread.id, hingeMsg: a.message.id, orderMsg: b.message.id }
}
const lines = (q: Awaited<ReturnType<typeof twoQuestions>>, from?: 'reply card lines') => applyThreadLines(NODE, { threads: [
  { id: q.hinge, title: 'Top hinge needs oil first', state: 'answered' },
  { id: q.order, title: 'Paint order: primer, then gloss', state: 'answered' },
] } as never, undefined, from)
const answers = (q: Awaited<ReturnType<typeof twoQuestions>>) => {
  const reply = { text: R_BOTH, at: now() }
  return store.setThreadAnswers(NODE, new Map([[q.hingeMsg, reply], [q.orderMsg, reply]]))
}
function events(): Array<{ kind?: string; threadId?: string }> {
  const got: Array<{ kind?: string; threadId?: string }> = []
  bus.subscribe(SUB, (e) => {
    if (e.name === EventNames.ORG_THREADS_CHANGED && (e.data as { taskId?: string }).taskId === NODE) got.push(e.data as { kind?: string; threadId?: string })
  }, { global: true, interest: [EventNames.ORG_THREADS_CHANGED] })
  return got
}
const openNow = async () => (await store.readThreads(NODE)).threads.filter((t) => !t.closed)

describe.each([['the JSON files', false], ['the database', true]] as const)('one reply, one card on %s', (_name, onDb) => {
  beforeEach(async () => {
    _resetThreadsBackendForTesting(onDb)
    expect(await useThreadsDb()).toBe(onDb)
  })

  it('a reply\'s card lines, then the answers: the answers\' write leaves one thread', async () => {
    const q = await twoQuestions()
    await lines(q, 'reply card lines')
    expect((await openNow()).map((t) => t.state)).toEqual(['answered', 'answered'])
    const seen = events()
    expect(await answers(q)).toBe(2)
    const left = await openNow()
    expect(left.map((t) => t.id)).toEqual([q.hinge])
    expect(left[0]).toMatchObject({ state: 'answered', was: [q.order] })
    expect(left[0].messages.map((m) => m.answer?.text)).toEqual([R_BOTH, R_BOTH])
    expect(listedForHim(left).map((t) => t.id)).toEqual([q.hinge])
    expect(seen.filter((e) => e.kind === 'merged')).toEqual([{ taskId: NODE, kind: 'merged', threadId: q.hinge }])
  })

  it('the answers, then the status question\'s lines: the lines\' write leaves one thread', async () => {
    const q = await twoQuestions()
    expect(await answers(q)).toBe(2)
    expect(await openNow()).toHaveLength(2)
    const seen = events()
    const changed = await lines(q)
    // The lines it wrote, by the ids it wrote them under.
    expect(changed.sort()).toEqual([q.hinge, q.order].sort())
    const left = await openNow()
    expect(left.map((t) => t.id)).toEqual([q.hinge])
    expect(left[0]).toMatchObject({ state: 'answered', was: [q.order] })
    expect(seen.filter((e) => e.kind === 'merged')).toEqual([{ taskId: NODE, kind: 'merged', threadId: q.hinge }])
    // The same lines again, by the old id too: one thread still, nothing joined twice.
    await lines(q)
    expect((await openNow()).map((t) => t.id)).toEqual([q.hinge])
  })

  it('the task\'s ask that names the merged thread goes on the thread it is under (review 2026-11-27)', async () => {
    const q = await twoQuestions()
    await answers(q)
    const by = `task:${NODE}` as const
    await store.writeOwnThreads(NODE, () => ({
      writes: [{ id: q.hinge, patch: { state: 'answered' } }, { id: q.order, patch: { state: 'answered' } }], opens: [],
    }), by, { ask: { id: 'ask-aaaa01', ask: 'Pick the gloss colour: green or white?' }, named: q.order })
    const left = await openNow()
    expect(left.map((t) => t.id)).toEqual([q.hinge])
    expect(left[0].was).toEqual([q.order])
    expect(left[0].reportAsk?.id).toBe('ask-aaaa01')
  })

  it('what another write left so is joined by the thread check\'s step, which writes nothing when there is nothing', async () => {
    const q = await twoQuestions()
    await answers(q)
    // A node's own op on each thread (thread_update), one at a time: no line, no chat answer.
    await store.patchThread(NODE, q.hinge, { state: 'answered' }, `task:${NODE}`)
    await store.patchThread(NODE, q.order, { state: 'answered' }, `task:${NODE}`)
    expect(await openNow()).toHaveLength(2)
    expect(listedForHim(await openNow())).toEqual([])
    const seen = events()
    expect(await store.joinOneReplyCards(NODE)).toEqual([{ into: q.hinge, from: [q.order] }])
    expect((await openNow()).map((t) => t.id)).toEqual([q.hinge])
    expect(listedForHim(await openNow()).map((t) => t.id)).toEqual([q.hinge])
    expect(seen).toEqual([{ taskId: NODE, kind: 'merged', threadId: q.hinge }])
    seen.length = 0
    expect(await store.joinOneReplyCards(NODE)).toEqual([])
    expect(seen).toEqual([])
  })
})
