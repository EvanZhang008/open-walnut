/**
 * A new thread of his comes with the threads it may belong to, so the node can put it there
 * (2026-11-24, the threads inspection, item 5: a message of his more than three minutes after his
 * last opens a thread of its own, and only a thread the status question listed could take it; on
 * his VP about nine subjects had two or three threads each, and title words found 1 of 11 repeats).
 * src/core/sessions/status-thread-title.ts nearThreads, status-threads.ts threadQuestionFor,
 * status-thread-pick.ts byNeed.
 *
 * Every state the older thread can be in is classified (a decision waiting on him included), and a
 * thread the node opened, one titled, or one he wrote in long before brings none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-near'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { emptyThreads, fileMessage, SAME_CONVERSATION_MS, setAnswers, THREAD_STATES, updateThread, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { readThreads } from '../../../src/core/org/threads-store.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { applyThreadLines, NEEDS_NO_LINE, readThreadLines, threadQuestionFor } from '../../../src/core/sessions/status-threads.js'
import { NEAR_RECENT, nearThreads } from '../../../src/core/sessions/status-thread-title.js'
import { resetListed } from '../../../src/core/sessions/status-thread-pick.js'

const TASK = 'orchard-near-task'
const NODE = `task:${TASK}` as const
const T0 = Date.now() - 3 * 3600_000
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

/** His message at `min`, answered a minute later, and titled by the node when `title` is given. */
function said(f: ThreadsFile, text: string, min: number, title?: string): { f: ThreadsFile; id: string } {
  const r = fileMessage(f, { text, via: 'chat', at: at(min), joinRecent: SAME_CONVERSATION_MS })
  let file = setAnswers(r.file, new Map([[r.message.id, { text: 'On it.', at: at(min + 1) }]])).file
  if (title) file = updateThread(file, r.thread.id, { title, state: 'working', reply: `${title}: on it.` }, NODE, at(min + 1)).file
  return { f: file, id: r.thread.id }
}

/** The leak (0), the fence posts (10), then 50 minutes later his short follow-up on the leak, a thread of its own. */
function orchard() {
  let f = emptyThreads(TASK)
  const leak = said(f, 'the sprinkler in bed three leaks again', 0, 'Sprinkler leak in bed three'); f = leak.f
  const posts = said(f, 'order the larch posts for the fence', 10, 'Larch fence posts order'); f = posts.f
  const again = said(f, 'why is it still dripping?', 60); f = again.f
  return { f, leak: leak.id, posts: posts.id, again: again.id }
}

async function seed(f: ThreadsFile): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${TASK}.json`), JSON.stringify({ ...f, taskId: TASK }))
}
const ask = () => threadQuestionFor({ id: TASK, threads_on: true } as never)
const refOf = (refs: Awaited<ReturnType<typeof ask>>['refs'], id: string) => [...refs].find(([, r]) => r.id === id)?.[0]
const put = (f: ThreadsFile, id: string, over: Partial<OrgThread>): ThreadsFile => ({ ...f, threads: f.threads.map((t) => (t.id === id ? { ...t, ...over } as OrgThread : t)) })
/** A thread the node opened itself at `min` (no word of his on it), `over` its need. */
const nodeOpened = (i: number, min: number, over: Partial<OrgThread> = {}): OrgThread => ({
  id: `th-node${String(i).padStart(5, '0')}`, title: `Orchard chore ${i}`, titled: true, state: 'working', messages: [],
  opener: { by: NODE, from: 'task', at: at(min), text: `Chore ${i}` }, reply: `Chore ${i}: under way.`, replyAt: at(min),
  createdAt: at(min), updatedAt: at(min), by: NODE, ...over,
}) as OrgThread

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); setThreadsKept(true); resetListed() })
afterEach(() => { setThreadsKept(false) })

describe('the threads an untitled one may belong to', () => {
  it('the ones he wrote in last before it, newest first', () => {
    const { f, leak, posts, again } = orchard()
    expect(NEAR_RECENT).toBe(2)
    expect(nearThreads(f, f.threads.find((t) => t.id === again)!, Date.now())).toEqual([posts, leak])
  })

  it('then one whose title reads like his first words, outside the recent ones', () => {
    let { f, posts } = orchard()
    const late = said(f, 'when do the larch fence posts arrive?', 62 + 25 * 60); f = late.f
    // Over a day since he wrote in the posts thread: only the title words bring it.
    const near = nearThreads(f, f.threads.find((t) => t.id === late.id)!, Date.parse(at(62 + 25 * 60)))
    expect(near).toEqual([posts])
  })

  it('none for a titled thread, one the node opened, or one he wrote in over a day before; never a closed, moved or later one', () => {
    const { f, leak, posts, again } = orchard()
    const t = f.threads.find((x) => x.id === again)!
    expect(nearThreads(f, { ...t, titled: true }, Date.now())).toEqual([])
    expect(nearThreads(f, { ...t, opener: { by: NODE, from: 'task', at: at(60), text: 'x' } } as OrgThread, Date.now())).toEqual([])
    const closed = put(f, posts, { closed: { how: 'acked', at: at(30), by: 'human' } })
    expect(nearThreads(closed, t, Date.now())).toEqual([leak])
    const moved = put(f, leak, { movedTo: { taskId: 't-x', threadId: 'th-x', at: at(30) } } as never)
    expect(nearThreads(moved, t, Date.now())).toEqual([posts])
    const later = put(f, posts, { createdAt: at(61) })
    expect(nearThreads(later, t, Date.now())).toEqual([leak])
    const old = said(emptyThreads(TASK), 'the sprinkler in bed three leaks again', 0, 'Sprinkler leak in bed three')
    const next = said(old.f, 'why is it still dripping?', 25 * 60)
    expect(nearThreads(next.f, next.f.threads.find((x) => x.id === next.id)!, Date.parse(at(25 * 60)))).toEqual([])
  })
})

describe('the status question lists them beside it, and its merge line puts it there', () => {
  it('listed right after it, and its line names them', async () => {
    const { f, leak, posts, again } = orchard()
    await seed(f)
    const q = await ask()
    const order = [...q.refs.values()].map((r) => r.id)
    expect(order.slice(order.indexOf(again), order.indexOf(again) + 3)).toEqual([again, posts, leak])
    expect(q.block).toContain(`he wrote in ${refOf(q.refs, posts)}, ${refOf(q.refs, leak)} just before it: merge it into one only if it is that subject`)
    expect(q.block).toMatch(/FOR_USER_THREAD_MERGE: <ref> \| <that ref>.*Unsure: keep it apart\./)
  })

  it('right after it even when newer threads come between them in time', async () => {
    let { f, leak, posts, again } = orchard()
    // Ten threads the node opened after his posts message, each newer than the leak and the posts.
    f = { ...f, threads: [...f.threads, ...Array.from({ length: 10 }, (_, i) => nodeOpened(i, 20 + i))] }
    await seed(f)
    const order = [...(await ask()).refs.values()].map((r) => r.id)
    const i = order.indexOf(again)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(order.slice(i, i + 3)).toEqual([again, posts, leak])
  })

  it('a decision brought only beside it never takes a place of its own (review 2026-11-24)', async () => {
    // A decision on the leak, a day and a half quiet (overdue on him: a need of its own, were it ranked),
    // brought by the words of his new untitled thread; that one has its summary (no need but its title),
    // and twelve newer threads need a title too.
    let f = said(emptyThreads(TASK), 'the sprinkler in bed three leaks again', -36 * 60, 'Sprinkler leak in bed three').f
    const leak = f.threads[0].id
    f = put(f, leak, { state: 'needs', needsAt: at(-36 * 60 + 1) })
    const again = said(f, 'the sprinkler in bed three is still leaking', 60); f = again.f
    f = updateThread(f, again.id, { state: 'pending', reply: 'Checking the drip in bed three.' }, NODE, at(61)).file
    f = { ...f, threads: [...f.threads, ...Array.from({ length: 12 }, (_, i) => nodeOpened(i, 70 + i, { state: 'pending', title: `Please pick the orchard chore ${i} option` }))] }
    expect(nearThreads(f, f.threads.find((t) => t.id === again.id)!, Date.now())).toEqual([leak])
    await seed(f)
    const order = [...(await ask()).refs.values()].map((r) => r.id)
    const li = order.indexOf(leak)
    const ai = order.indexOf(again.id)
    // Listed only right after the untitled thread that brought it, or not at all.
    if (li >= 0) expect(li, order.join(' ')).toBe(ai + 1)
    else expect(order).not.toContain(again.id)
    expect(order[0]).not.toBe(leak)
  })

  it('a decision waiting on him is listed too, with no line asked, and takes his follow-up', async () => {
    let { f, leak, again } = orchard()
    f = put(f, leak, { state: 'needs', needsAt: at(5) })
    await seed(f)
    const q = await ask()
    const ref = refOf(q.refs, leak)!
    expect(q.block).toContain(`${ref} "Sprinkler leak in bed three" (needs, ${NEEDS_NO_LINE})`)
    expect(q.block).toMatch(/one waiting on him takes no line: answer his words there with thread_update/)
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, again)} | ${ref}`, q.refs))
    const after = await readThreads(TASK)
    const into = after.threads.find((t) => t.id === leak)!
    expect(into.messages.map((m) => m.text)).toContain('why is it still dripping?')
    expect(after.threads.find((t) => t.id === again && !t.closed && !t.movedTo)).toBeUndefined()
  })

  it('every state the older thread can be in, open: listed beside it', async () => {
    for (const state of THREAD_STATES) {
      resetListed()
      let { f, leak, again } = orchard()
      f = put(f, leak, { state, ...(state === 'needs' ? { needsAt: at(5) } : {}) })
      await seed(f)
      const q = await ask()
      expect(refOf(q.refs, leak), state).toBeTruthy()
      expect(q.block, state).toContain(`just before it: merge it into one only if it is that subject`)
      expect(refOf(q.refs, again), state).toBeTruthy()
    }
  })
})
