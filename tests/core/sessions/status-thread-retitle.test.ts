/**
 * A title that still asks him what waits on him no more is asked again (2026-11-24, the threads
 * inspection, item 8: "new task panel: three designs, please pick one" sat in his Done after the
 * pick shipped, since a title was asked for only while a thread was untitled). status-threads.ts
 * staleAskTitle, threadQuestionBlock, readThreadLines, planThreadWrites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyThreads, fileMessage, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { listForQuestion, planThreadWrites, readThreadLines, RETITLE_WORDS, staleAskTitle, threadQuestionBlock } from '../../../src/core/sessions/status-threads.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 12, min)).toISOString()

/** His pick of a design, shipped: the card's title still asks him to pick. */
function picked(title = 'New task panel: three designs, please pick one (A recommended)'): { f: ThreadsFile; id: string } {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'make the new task panel nicer', via: 'chat', at: at(0) }).file
  const id = f.threads[0].id
  f = updateThread(f, id, { title, state: 'answered', reply: 'Design A is live on the web: the Where box lists recent folders.' }, 'task:lead-1', at(5)).file
  return { f, id }
}

beforeEach(() => setThreadsKept(true))
afterEach(() => setThreadsKept(false))

describe('a title that still asks him', () => {
  it('is named so, and only a decision title out of Needs you is', () => {
    expect(staleAskTitle(picked().f.threads[0])).toBe(true)
    expect(staleAskTitle(picked('New task panel: design A is live').f.threads[0])).toBe(false)
    const waits = { ...picked().f.threads[0], state: 'needs' as const }
    expect(staleAskTitle(waits)).toBe(false)
    expect(staleAskTitle({ ...picked().f.threads[0], titled: false })).toBe(false)
  })

  it('the question asks for a title naming the subject as it stands, and the answer retitles it', () => {
    const { f, id } = picked()
    const { listed, his } = listForQuestion(f, f.threads)
    const q = threadQuestionBlock(listed, undefined, { his })
    expect(q.block).toContain(RETITLE_WORDS)
    expect(q.block).toContain('FOR_USER_THREAD_TITLE')
    const read = readThreadLines('FOR_USER_THREAD: t1 | answered | Design A is live on the web.\nFOR_USER_THREAD_TITLE: t1 | New task panel: design A is live', q.refs)
    const plan = planThreadWrites(f, read.threads ?? [], [], { titles: read.thread_titles })
    expect(plan.writes.find((w) => w.id === id && w.patch.title)?.patch.title).toBe('New task panel: design A is live')
  })

  it('a titled thread whose title says the subject is never retitled by a title line', () => {
    const { f } = picked('New task panel: design A is live')
    const { listed, his } = listForQuestion(f, f.threads)
    const q = threadQuestionBlock(listed, undefined, { his })
    expect(q.block).not.toContain(RETITLE_WORDS)
    const read = readThreadLines('FOR_USER_THREAD_TITLE: t1 | Something else', q.refs)
    expect(read.thread_titles).toBeUndefined()
  })
})
