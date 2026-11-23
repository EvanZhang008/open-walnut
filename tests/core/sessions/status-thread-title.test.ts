/**
 * A title a status answer gives that repeats another open thread is held, and the node's next
 * answer says whether the two are one subject (src/core/sessions/status-thread-title.ts; 2026-11-23,
 * the thread monitor's [dup]: his second word on acknowledged cards, 40 minutes after his first,
 * opened a thread the node then titled like the open one, so he had two cards for one subject).
 *
 * The class: every place Walnut writes a node's words as the title of an existing thread of his.
 * The status answer's title line and a split line's title go through the hold; the held title is
 * written only after the question asked; the node's own thread_update title is its explicit word;
 * a thread a node opens is checked by the same-subject rule. The last test fails when a new place
 * sets `titled` that nobody classified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-title'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { emptyThreads, fileMessage, normalizeThreads, SAME_CONVERSATION_MS, setAnswers, sortedThreads, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { openNotWaiting } from '../../../src/core/org/thread-view.js'
import { readThreads } from '../../../src/core/org/threads-store.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { applyThreadLines, listForQuestion, readThreadLines, threadQuestionBlock } from '../../../src/core/sessions/status-threads.js'
import { holdRepeatTitles, MERGES_ASKED_MAX, repeatedBy, throughMerges } from '../../../src/core/sessions/status-thread-title.js'

const TASK = 'orchard-title-task'
const NODE = `task:${TASK}` as const
const T0 = Date.now() - 90 * 60_000
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const FIRST = 'Oven timer review: Dana approved, merged'
const REPEAT = 'Oven timer review: Dana approved, merged, rolling out'

/** His request, answered and titled; then his second word 40 minutes later, a thread of its own. */
function twoCards(): { f: ThreadsFile; first: string; second: string } {
  let f = fileMessage(emptyThreads(TASK), { text: 'watch the oven timer review until Dana approves it', via: 'chat', at: at(0), joinRecent: SAME_CONVERSATION_MS }).file
  const first = f.threads[0].id
  // The node's chat reply under his message (Walnut files it), then its summary.
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Watching it; I will tell you when Dana approves.', at: at(1) }]])).file
  f = updateThread(f, first, { title: FIRST, state: 'answered', reply: 'Dana approved the oven timer change and it is merged.' }, NODE, at(2)).file
  const r = fileMessage(f, { text: 'did it reach every oven yet?', via: 'chat', at: at(42), joinRecent: SAME_CONVERSATION_MS })
  return { f: r.file, first, second: r.thread.id }
}

async function seed(f: ThreadsFile): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${TASK}.json`), JSON.stringify({ ...f, taskId: TASK }))
}

function ask(f: ThreadsFile) {
  const { listed, his } = listForQuestion(f, sortedThreads(f.threads).filter(openNotWaiting))
  return threadQuestionBlock(listed, undefined, { his })
}
const refOf = (refs: ReturnType<typeof ask>['refs'], id: string) => [...refs].find(([, r]) => r.id === id)![0]

/** The first answer: it names his new thread like the open one. */
async function heldOnce(): Promise<{ first: string; second: string }> {
  const { f, first, second } = twoCards()
  await seed(f)
  const q = ask(f)
  expect(f.threads.find((t) => t.id === second)!.titled).toBeFalsy()
  await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_TITLE: ${refOf(q.refs, second)} | ${REPEAT}\nFOR_USER_THREAD: ${refOf(q.refs, second)} | working | Checking which ovens have the change.`, q.refs))
  return { first, second }
}

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); setThreadsKept(true) })
afterEach(() => { setThreadsKept(false) })

describe('a title that repeats another open thread is held', () => {
  it('the real case: his second word, titled like the open thread, keeps Walnut\'s stand-in title and its line', async () => {
    const { first, second } = await heldOnce()
    const t = (await readThreads(TASK)).threads.find((x) => x.id === second)!
    expect(t.titled).toBeFalsy()
    expect(t.title).not.toBe(REPEAT)
    expect(t.titleHeld).toMatchObject({ title: REPEAT, like: first })
    // Its line is written as usual: only the title waits.
    expect(t).toMatchObject({ state: 'working', reply: 'Checking which ovens have the change.' })
  })

  it('a title of another subject is written at once; so is one that repeats only a closed thread', () => {
    const { f, first, second } = twoCards()
    const now = at(43)
    expect(holdRepeatTitles(f, [{ id: second, title: 'Grill thermometer battery' }], now).held.size).toBe(0)
    const closed = updateThread(f, first, { close: 'dropped', user_words: 'never mind' }, 'human', at(43)).file
    expect(holdRepeatTitles(closed, [{ id: second, title: REPEAT }], now).held.size).toBe(0)
    expect(repeatedBy(f, second, REPEAT, Date.parse(now))).toBe(first)
  })

  it('a thread already titled, or already holding a title, is not held (each is asked once)', () => {
    const { f, first, second } = twoCards()
    const held = holdRepeatTitles(f, [{ id: second, title: REPEAT }], at(43)).file
    expect(holdRepeatTitles(held, [{ id: second, title: REPEAT }], at(44)).held.size).toBe(0)
    const titled = updateThread(f, second, { title: 'Oven rollout' }, NODE, at(43)).file
    expect(holdRepeatTitles(titled, [{ id: second, title: REPEAT }], at(44)).held.size).toBe(0)
    expect(holdRepeatTitles(f, [{ id: second, title: REPEAT, besides: first }], at(43)).held.size).toBe(0)
  })

  it('the hold survives a read; one an older or newer build wrote badly is dropped; a title write clears it', () => {
    const { f, first, second } = twoCards()
    const held = holdRepeatTitles(f, [{ id: second, title: REPEAT }], at(43)).file
    expect(normalizeThreads(JSON.parse(JSON.stringify(held)), TASK).threads.find((t) => t.id === second)!.titleHeld).toMatchObject({ like: first })
    const bad = { ...held, threads: held.threads.map((t) => (t.id === second ? { ...t, titleHeld: { title: REPEAT, like: 'not-a-thread', at: at(43) } } : t)) }
    expect(normalizeThreads(JSON.parse(JSON.stringify(bad)), TASK).threads.find((t) => t.id === second)!.titleHeld).toBeUndefined()
    expect(updateThread(held, second, { title: 'Oven rollout' }, NODE, at(44)).thread.titleHeld).toBeUndefined()
  })
})

describe('the next question asks whether they are one subject', () => {
  it('names the held thread with the one it reads like, and no longer asks it a title', async () => {
    const { first, second } = await heldOnce()
    const q = ask(await readThreads(TASK))
    const ref = refOf(q.refs, second)
    expect(q.refs.get(ref)).toMatchObject({ mergeInto: first })
    expect(q.refs.get(ref)!.untitled).toBeFalsy()
    expect(q.block).toContain(`${ref}, which you titled "${REPEAT}", reads like ${refOf(q.refs, first)} "${FIRST}"`)
    expect(q.block).toContain('FOR_USER_THREAD_MERGE: <ref>')
  })

  it('costs nothing when no thread holds a title', () => {
    expect(ask(twoCards().f).block).not.toContain('Threads whose title repeats')
  })

  it(`asks about at most ${MERGES_ASKED_MAX} at once; the rest come next`, () => {
    let { f, first } = twoCards()
    const ids: string[] = []
    for (let i = 0; i < MERGES_ASKED_MAX + 2; i++) {
      const r = fileMessage(f, { text: `oven question number ${i}`, via: 'chat', at: at(50 + i * 10), joinRecent: SAME_CONVERSATION_MS })
      f = holdRepeatTitles(r.file, [{ id: r.thread.id, title: REPEAT }], at(51 + i * 10)).file
      ids.push(r.thread.id)
    }
    const q = ask(f)
    expect([...q.refs.values()].filter((r) => r.mergeInto === first)).toHaveLength(MERGES_ASKED_MAX)
  })
})

describe('the answer settles it', () => {
  it('a merge line puts it under the other thread before the lines: one card, his words in it, the other\'s line written', async () => {
    const { first, second } = await heldOnce()
    const q = ask(await readThreads(TASK))
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)}\nFOR_USER_THREAD: ${refOf(q.refs, first)} | answered | The oven timer change reached all 12 ovens.\nFOR_USER_THREAD: ${refOf(q.refs, second)} | working | Lost with the merge.`, q.refs))
    const f = await readThreads(TASK)
    expect(f.threads.find((t) => t.id === second)).toBeUndefined()
    const t = f.threads.find((x) => x.id === first)!
    expect(t.messages.map((m) => m.text)).toContain('did it reach every oven yet?')
    expect(t).toMatchObject({ title: FIRST, state: 'answered', reply: 'The oven timer change reached all 12 ovens.' })
  })

  it('no merge line: the held title is written, and it is not asked again', async () => {
    const { second } = await heldOnce()
    const q = ask(await readThreads(TASK))
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD: ${refOf(q.refs, second)} | working | Checking which ovens have the change.`, q.refs))
    const f = await readThreads(TASK)
    const t = f.threads.find((x) => x.id === second)!
    expect(t).toMatchObject({ title: REPEAT, titled: true })
    expect(t.titleHeld).toBeUndefined()
    expect(ask(f).block).not.toContain('FOR_USER_THREAD_MERGE')
  })

  it('a word of his in it since the question: neither merged nor titled, asked again', async () => {
    const { second } = await heldOnce()
    const q = ask(await readThreads(TASK))
    const later = fileMessage(await readThreads(TASK), { text: 'and the bakery ovens too', via: 'follow-up', threadId: second, at: new Date().toISOString() }).file
    await seed(later)
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)}`, q.refs))
    const t = (await readThreads(TASK)).threads.find((x) => x.id === second)!
    expect(t.titled).toBeFalsy()
    expect(t.titleHeld).toBeTruthy()
    expect(ask(await readThreads(TASK)).block).toContain('FOR_USER_THREAD_MERGE')
  })

  it('the other thread closed meanwhile: the merge cannot happen, so its title is written', async () => {
    const { first, second } = await heldOnce()
    const q = ask(await readThreads(TASK))
    await seed(updateThread(await readThreads(TASK), first, { close: 'dropped', user_words: 'drop the review one' }, 'human', new Date().toISOString()).file)
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)}`, q.refs))
    expect((await readThreads(TASK)).threads.find((x) => x.id === second)).toMatchObject({ title: REPEAT, titled: true })
  })

  it('a merge line naming no other listed thread does nothing', async () => {
    const { f, first, second } = twoCards()
    await seed(f)
    const q = ask(f)
    for (const line of [`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)}`, `FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)} | t9`, `FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)} | ${refOf(q.refs, second)}`]) {
      expect(readThreadLines(line, q.refs).threads_merge, line).toBeUndefined()
    }
    // A titled thread is not merged by a line: that is thread_update merge_into, the node's own word.
    expect(readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, first)} | ${refOf(q.refs, second)}`, q.refs).threads_merge).toBeUndefined()
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)}`, q.refs))
    expect((await readThreads(TASK)).threads.map((t) => t.id).sort()).toEqual([first, second].sort())
  })

  it('an answer that lost its thread lines asks nothing: the title stays held, and is asked again', async () => {
    const { second } = await heldOnce()
    const q = ask(await readThreads(TASK))
    expect(readThreadLines('FOR_USER_STATE: working', q.refs).merges_checked).toBeUndefined()
    await applyThreadLines(TASK, readThreadLines('FOR_USER_STATE: working', q.refs))
    expect((await readThreads(TASK)).threads.find((x) => x.id === second)!.titleHeld).toBeTruthy()
  })
})

describe('the same answer can merge an untitled thread (review: no wait for the next turn)', () => {
  it('the title line says how; a merge line takes his new thread under the open one, and its own line speaks for it there', async () => {
    const { f, first, second } = twoCards()
    await seed(f)
    const q = ask(f)
    expect(q.block).toContain('FOR_USER_THREAD_MERGE: <ref> | <that ref>')
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)} | ${refOf(q.refs, first)}\nFOR_USER_THREAD: ${refOf(q.refs, second)} | answered | The change reached all 12 ovens: https://example.com/ovens/rollout`, q.refs))
    const after = await readThreads(TASK)
    expect(after.threads.find((t) => t.id === second)).toBeUndefined()
    // The open thread had no line of its own: the merged one's line is its line now (review MEDIUM-1).
    expect(after.threads.find((t) => t.id === first)).toMatchObject({ title: FIRST, state: 'answered', reply: 'The change reached all 12 ovens: https://example.com/ovens/rollout' })
  })

  it('one thread only: no merge line is offered', () => {
    const f = fileMessage(emptyThreads(TASK), { text: 'watch the oven timer review', via: 'chat', at: at(0) }).file
    expect(ask(f).block).not.toContain('FOR_USER_THREAD_MERGE')
  })
})

describe('what the question asks when the other thread is not listed (review MEDIUM-3)', () => {
  it('the other waits on his decision: the held thread is asked its title again, and the title is written', async () => {
    const { first, second } = await heldOnce()
    let f = await readThreads(TASK)
    f = { ...f, threads: f.threads.map((t) => (t.id === first ? { ...t, state: 'needs' as const, ask: 'Roll the oven change out to the bakery too?' } : t)) }
    await seed(f)
    const q = ask(f)
    expect(q.block).not.toContain('FOR_USER_THREAD_MERGE: <ref> (')
    expect(q.refs.get(refOf(q.refs, second))).toMatchObject({ untitled: true })
    expect([...q.refs.values()].some((r) => r.mergeInto)).toBe(false)
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_TITLE: ${refOf(q.refs, second)} | ${REPEAT}`, q.refs))
    expect((await readThreads(TASK)).threads.find((x) => x.id === second)).toMatchObject({ title: REPEAT, titled: true })
  })

  it('a thread titled by an older build while it held a title holds nothing (review LOW-1)', () => {
    const { f, second } = twoCards()
    const held = holdRepeatTitles(f, [{ id: second, title: REPEAT }], at(43)).file
    const old = { ...held, threads: held.threads.map((t) => (t.id === second ? { ...t, title: 'Oven rollout', titled: true } : t)) }
    const back = normalizeThreads(JSON.parse(JSON.stringify(old)), TASK).threads.find((t) => t.id === second)!
    expect(back.titleHeld).toBeUndefined()
    expect(back.title).toBe('Oven rollout')
  })
})

describe('lines and marks through a merge', () => {
  const A = 'th-aaaaaaaaaaaa', B = 'th-bbbbbbbbbbbb', C = 'th-cccccccccccc'
  const merged = [{ from: B, into: A, before: 'm1', after: 'm2', intoUpTo: 'm1' }, { from: C, into: A, before: 'm2', after: 'm3' }]

  it('the other thread\'s own line reads on through each merge into it, and the merged ones\' lines go', () => {
    const lines = [{ id: A, upTo: 'm1' }, { id: B, upTo: 'm9' }, { id: C, upTo: 'm8' }]
    expect(throughMerges(lines, merged)).toEqual([{ id: A, upTo: 'm3' }])
    // Written before a newer word of his there: it keeps its fence, so it is held.
    expect(throughMerges([{ id: A, upTo: 'm0' }], merged)[0].upTo).toBe('m0')
  })

  it('with no line of its own, the merged one\'s line or seen mark speaks for it (review MEDIUM-1, MEDIUM-2)', () => {
    expect(throughMerges([{ id: B, upTo: 'm9', hisAt: 'h1' }], merged.slice(0, 1))).toEqual([{ id: A, upTo: 'm2', hisAt: 'h1' }])
    // He wrote in the other since the question: the retargeted one keeps that question's fence, and holds.
    expect(throughMerges([{ id: B, upTo: 'm9' }], [{ ...merged[0], intoUpTo: 'm0' }])).toEqual([{ id: A, upTo: 'm0' }])
  })

  it('a seen mark on the other thread is not lost to the merge: its known mark is written (review MEDIUM-2)', async () => {
    const { first, second } = await heldOnce()
    let f = await readThreads(TASK)
    f = fileMessage(f, { text: 'ok thanks, and did it reach every oven?', via: 'follow-up', threadId: second, at: new Date(Date.now() - 1000).toISOString() }).file
    await seed(f)
    const q = ask(f)
    const r = readThreadLines(`FOR_USER_THREAD_MERGE: ${refOf(q.refs, second)}\nFOR_USER_THREAD_SEEN: ${refOf(q.refs, first)}\nFOR_USER_THREAD: ${refOf(q.refs, first)} | working | Checking which ovens have it.`, q.refs)
    expect(r.threads_seen?.map((m) => m.id)).toEqual([first])
    await applyThreadLines(TASK, r)
    const t = (await readThreads(TASK)).threads.find((x) => x.id === first)!
    expect(t.messages.map((m) => m.text)).toContain('ok thanks, and did it reach every oven?')
    expect(t.known).toBeTruthy()
    expect(t).toMatchObject({ state: 'working', reply: 'Checking which ovens have it.' })
  })
})

describe('a split line\'s title goes through the same hold', () => {
  it('a message split out under a title that repeats another open thread (not its source) is held, and asked next', async () => {
    let { f, first } = twoCards()
    // A third thread: the fence, then (right after) a word on the oven rollout that joined it.
    let r = fileMessage(f, { text: 'the garden gate sticks when it rains', via: 'chat', at: at(60), joinRecent: SAME_CONVERSATION_MS })
    const gate = r.thread.id
    r = fileMessage(r.file, { text: 'and is the oven timer change on every oven yet', via: 'chat', at: at(61), joinRecent: SAME_CONVERSATION_MS })
    f = r.file
    expect(r.thread.id).toBe(gate)
    await seed(f)
    const q = ask(f)
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_SPLIT: ${refOf(q.refs, gate)} | ${REPEAT} | working | Checking which ovens have it.`, q.refs))
    const out = (await readThreads(TASK)).threads.find((t) => t.messages.some((m) => m.text.startsWith('and is the oven')))!
    expect(out.id).not.toBe(gate)
    expect(out.titled).toBeFalsy()
    expect(out.titleHeld).toMatchObject({ title: REPEAT, like: first })
    expect(out).toMatchObject({ state: 'working', reply: 'Checking which ovens have it.' })
  })

  it('a split title of a new subject is written as before', async () => {
    const { f } = twoCards()
    let r = fileMessage(f, { text: 'the garden gate sticks when it rains', via: 'chat', at: at(60), joinRecent: SAME_CONVERSATION_MS })
    const gate = r.thread.id
    r = fileMessage(r.file, { text: 'also order compost for the raised beds', via: 'chat', at: at(61), joinRecent: SAME_CONVERSATION_MS })
    await seed(r.file)
    const q = ask(r.file)
    await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_SPLIT: ${refOf(q.refs, gate)} | Compost order | working | Asking the shop.`, q.refs))
    expect((await readThreads(TASK)).threads.find((t) => t.title === 'Compost order')).toMatchObject({ titled: true })
  })
})

describe('the class: every place that sets a thread\'s title as given', () => {
  // Each file under src/ that writes `titled: true` (or `titled = true`), and why it is not the hold's.
  const CLASSIFIED: Record<string, string> = {
    'src/core/org/threads-model.ts': 'updateThread: the node\'s own thread_update title, or a status title the hold let through; openThread: a thread a node opens (thread_create: refuseSameSubjectThread; FOR_USER_THREAD_NEW: newSubjectsOnly makes a repeat that thread\'s line)',
    'src/core/sessions/status-thread-title.ts': 'the held title, written after the question asked',
    'src/core/org/choice-thread-model.ts': 'a choice he must make opens its own thread (needs)',
    'src/core/org/letter-thread-model.ts': 'a letter he must answer opens its own thread (needs)',
    'src/core/org/line-threads.ts': 'a task line read as a thread, never stored',
  }

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []
    })
  }

  it('every file that sets it is classified here', () => {
    const root = path.resolve(__dirname, '../../..')
    const found = walk(path.join(root, 'src')).filter((p) => /\btitled(:| =) true/.test(readFileSync(p, 'utf8'))).map((p) => path.relative(root, p).split(path.sep).join('/')).sort()
    expect(found, 'a new place sets a thread\'s title as given: route a node\'s title through holdRepeatTitles, or classify it here').toEqual(Object.keys(CLASSIFIED).sort())
  })

})
