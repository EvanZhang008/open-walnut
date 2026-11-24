/**
 * A message of his joined to a thread by timing is checked even when that thread waits on him, and a
 * mark nobody checked never hides his words for good nor reads as his reaction (2026-11-24, the
 * threads inspection, item 6: five of his 30 messages on a decision card of a task below Main were off
 * the card for 13 hours, since a thread in needs was never listed for the check, and a mark swept
 * after a day read as his reaction). status-threads.ts threadQuestionFor, thread-view.ts
 * uncheckedJoin / readsAsReaction / JOIN_CHECK_MS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-join-needs'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { emptyThreads, fileMessage, SAME_CONVERSATION_MS, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { readThreads } from '../../../src/core/org/threads-store.js'
import { applyThreadLines, NEEDS_JOIN_WORDS, readThreadLines, threadQuestionFor } from '../../../src/core/sessions/status-threads.js'
import { cardMessages, JOIN_CHECK_MS, readsAsReaction, shownToHim, uncheckedJoin } from '../../../src/core/org/thread-view.js'

const TASK = 'orchard-join-needs'
const T0 = Date.now() - 30 * 60_000
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const node = { id: TASK, threads_on: true } as never

/** The gate, compost a minute later (joined by timing), then the node hands the gate to him as a decision. */
function decisionWithJoin(): { f: ThreadsFile; id: string } {
  let r = fileMessage(emptyThreads(TASK), { text: 'the garden gate sticks when it rains', via: 'chat', at: at(0), joinRecent: SAME_CONVERSATION_MS })
  const id = r.thread.id
  r = fileMessage(r.file, { text: 'also order compost for the raised beds', via: 'chat', at: at(1), joinRecent: SAME_CONVERSATION_MS })
  expect(r.thread.id).toBe(id)
  expect(r.message.joined).toBe('recent')
  const t = { ...r.file.threads[0], title: 'Garden gate: repair or replace?', titled: true, state: 'needs' as const, needsAt: at(5),
    reply: 'Repairing the hinge costs 40, a new gate 180; I recommend the repair.', replyAt: at(5), updatedAt: at(5) }
  return { f: { ...r.file, threads: [t] }, id }
}

async function seed(f: ThreadsFile): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${TASK}.json`), JSON.stringify({ ...f, taskId: TASK }))
}
const get = async () => (await readThreads(TASK)).threads

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('a join on a thread waiting on him', () => {
  it('is asked, with no line asked for the decision itself', async () => {
    const { f } = decisionWithJoin()
    await seed(f)
    const q = await threadQuestionFor(node)
    expect(q.block).toContain(NEEDS_JOIN_WORDS)
    expect(q.block).toContain('also order compost for the raised beds')
    expect([...q.refs.values()].map((r) => r.joined)).toEqual([f.threads[0].messages[1].id])
  })

  it('a split takes his other subject off the decision card, which stays waiting on him; a line for it writes nothing', async () => {
    const { f, id } = decisionWithJoin()
    await seed(f)
    const { refs } = await threadQuestionFor(node)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD: t1 | answered | The gate is fixed.\nFOR_USER_THREAD_SPLIT: t1 | Compost order | working | Ordering compost for the raised beds.', refs))
    const threads = await get()
    const gate = threads.find((t) => t.id === id)!
    expect(gate).toMatchObject({ state: 'needs', reply: 'Repairing the hinge costs 40, a new gate 180; I recommend the repair.' })
    expect(gate.messages.map((m) => m.text)).toEqual(['the garden gate sticks when it rains'])
    expect(threads.find((t) => t.id !== id)).toMatchObject({ title: 'Compost order', state: 'working' })
  })

  it('an answer without the split takes the mark off: his words show on the decision card, and it is not asked again', async () => {
    const { f, id } = decisionWithJoin()
    await seed(f)
    const { refs } = await threadQuestionFor(node)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD: t1 | answered | The gate is fixed.', refs))
    const gate = (await get()).find((t) => t.id === id)!
    expect(gate.state).toBe('needs')
    expect(gate.messages.every((m) => !m.joined)).toBe(true)
    expect(cardMessages(gate).map((m) => m.text)).toHaveLength(2)
    const again = await threadQuestionFor(node)
    expect(again.refs.size).toBe(0)
    expect(again.block).not.toContain(NEEDS_JOIN_WORDS)
  })
})

describe('a mark nobody checked', () => {
  it('hides his words for a day at most, and never reads as his reaction', () => {
    const { f } = decisionWithJoin()
    const t = f.threads[0]
    const joined = t.messages[1]
    const now = Date.parse(joined.at)
    expect(uncheckedJoin(joined, now + 60_000)).toBe(true)
    expect(cardMessages(t, now + 60_000)).toHaveLength(1)
    const later = now + JOIN_CHECK_MS + 60_000
    expect(uncheckedJoin(joined, later)).toBe(false)
    expect(cardMessages(t, later)).toHaveLength(2)
    expect(readsAsReaction(joined)).toBe(false)
    // An answered card with his old unchecked words after its result stays in his sight.
    const answered = { ...t, state: 'answered' as const, needsAt: undefined }
    expect(shownToHim(answered, undefined, later)).toBe(true)
  })
})
