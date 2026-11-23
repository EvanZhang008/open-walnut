/**
 * A message filed into a thread only for coming right after his last one is checked once by the
 * node, in its status answer (src/core/sessions/status-thread-split.ts; 2026-11-23, Walnut VP, of
 * messages each joined to the thread of the message before it though their subject was another).
 *
 * The class: every rule of fileMessage that files his message into a thread he did not name. A rule
 * that can join another subject marks the message, the question asks about it, and a split line
 * takes it (with the joined ones right after it) into a thread of its own; no answer, or an answer
 * without the line, only takes the mark off. The last test fails when fileMessage gains a filing
 * rule nobody classified.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-split'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { emptyThreads, fileMessage, normalizeThreads, SAME_CONVERSATION_MS, setAnswers, splitThreadMessage, updateThread, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { threadHintText } from '../../../src/core/org/thread-capture.js'
import { readThreads } from '../../../src/core/org/threads-store.js'
import { applyThreadLines, listForQuestion, readThreadLines, threadQuestionBlock } from '../../../src/core/sessions/status-threads.js'
import { JOIN_ASK_MAX_AGE_MS, JOINS_ASKED_MAX, splitRun } from '../../../src/core/sessions/status-thread-split.js'

const TASK = 'orchard-split-task'
const T0 = Date.now() - 30 * 60_000
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

/** His burst: the gate, then (a minute later) compost, then (a minute later) more on compost. */
function burst(): { f: ThreadsFile; id: string; ids: string[] } {
  let r = fileMessage(emptyThreads(TASK), { text: 'the garden gate sticks when it rains', via: 'chat', at: at(0), joinRecent: SAME_CONVERSATION_MS })
  const id = r.thread.id
  const ids = [r.message.id]
  for (const [i, text] of ['also order compost for the raised beds', 'three bags is enough'].entries()) {
    r = fileMessage(r.file, { text, via: 'chat', at: at(i + 1), joinRecent: SAME_CONVERSATION_MS })
    ids.push(r.message.id)
  }
  return { f: r.file, id, ids }
}

async function seed(f: ThreadsFile): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${TASK}.json`), JSON.stringify({ ...f, taskId: TASK }))
}

function ask(f: ThreadsFile) {
  const open = f.threads.filter((t) => !t.closed)
  const { listed, his } = listForQuestion(f, open)
  return threadQuestionBlock(listed, undefined, { his })
}

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('filing marks a join the node has not checked', () => {
  it('a message right after his last one joins that thread, marked; the first message is not', () => {
    const { f, id, ids } = burst()
    expect(f.threads).toHaveLength(1)
    const t = f.threads.find((x) => x.id === id)!
    expect(t.messages.map((m) => m.id)).toEqual(ids)
    expect(t.messages.map((m) => m.joined)).toEqual([undefined, 'recent', 'recent'])
  })

  it('a follow-up he named, and a message after the window, carry no mark', () => {
    const { f, id } = burst()
    const named = fileMessage(f, { text: 'the hinge is rusty too', via: 'follow-up', at: at(2), threadId: id })
    expect(named.message.joined).toBeUndefined()
    const later = fileMessage(f, { text: 'book the piano tuner', via: 'chat', at: at(30), joinRecent: SAME_CONVERSATION_MS })
    expect(later.created).toBe(true)
    expect(later.message.joined).toBeUndefined()
  })

  it('a split takes the mark off the message it moves', () => {
    const { f, id, ids } = burst()
    const r = splitThreadMessage(f, id, ids[1], 'human', at(5))
    expect(r.thread.messages[0].joined).toBeUndefined()
  })

  it('the mark survives a read, and a value an older or newer build wrote that is not known is dropped', () => {
    const { f, id } = burst()
    const raw = JSON.parse(JSON.stringify(f)) as ThreadsFile
    raw.threads[0].messages[2] = { ...raw.threads[0].messages[2], joined: 'similar' as 'recent' }
    const t = normalizeThreads(raw, TASK).threads.find((x) => x.id === id)!
    expect(t.messages.map((m) => m.joined)).toEqual([undefined, 'recent', undefined])
  })
})

describe('the status question asks about each join once', () => {
  it('names the joined message with the one before it, and the line to split it', () => {
    const { f, ids } = burst()
    const { block, refs } = ask(f)
    expect(block).toContain('t1 "also order compost for the raised beds" (right after "the garden gate sticks when it rains")')
    expect(block).toContain('FOR_USER_THREAD_SPLIT: <ref> | <title> |')
    expect(refs.get('t1')!.joined).toBe(ids[1])
  })

  it('costs nothing when no message joined by coming right after', () => {
    const f = fileMessage(emptyThreads(TASK), { text: 'the garden gate sticks when it rains', via: 'chat', at: at(0), joinRecent: SAME_CONVERSATION_MS }).file
    const { block, refs } = ask(f)
    expect(block).not.toContain('FOR_USER_THREAD_SPLIT')
    expect([...refs.values()].some((r) => r.joined)).toBe(false)
  })

  it('asks about at most JOINS_ASKED_MAX threads', () => {
    let f = emptyThreads(TASK)
    for (let i = 0; i < JOINS_ASKED_MAX + 2; i++) {
      // Each pair far apart from the others: a thread of its own, then a join into it.
      f = fileMessage(f, { text: `bed ${i} needs water`, via: 'chat', at: at(i * 10), joinRecent: SAME_CONVERSATION_MS }).file
      f = fileMessage(f, { text: `and prune hedge ${i}`, via: 'chat', at: at(i * 10 + 1), joinRecent: SAME_CONVERSATION_MS }).file
    }
    const { refs } = ask(f)
    expect([...refs.values()].filter((r) => r.joined)).toHaveLength(JOINS_ASKED_MAX)
  })
})

describe('which joins are asked', () => {
  it('a mark older than a day is not asked: a thread he reopens later is not carved up by an old join (review round 1)', () => {
    const { f } = burst()
    const { listed } = listForQuestion(f, f.threads)
    expect(listed[0].joined).toBeTruthy()
    const old = { ...f, threads: f.threads.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, at: new Date(Date.parse(m.at) - JOIN_ASK_MAX_AGE_MS - 60_000).toISOString() })) })) }
    expect(listForQuestion(old, old.threads).listed[0].joined).toBeUndefined()
  })

  it('a split run stops at the newest message the question saw, and with no fence takes only the asked one', () => {
    const { f, ids } = burst()
    const t = f.threads[0]
    expect(splitRun(t, ids[1], ids[2])).toEqual([ids[1], ids[2]])
    expect(splitRun(t, ids[1], ids[1])).toEqual([ids[1]])
    expect(splitRun(t, ids[1])).toEqual([ids[1]])
    expect(splitRun(t, ids[1], 'tm-gone00')).toEqual([ids[1]])
  })

  it('a bare reaction joins the newest answer unmarked, and its hint says so', () => {
    const { f, id, ids } = burst()
    const answered = setAnswers(f, new Map([[ids[2], { text: 'Three bags it is.', at: at(4) }]])).file
    const r = fileMessage(answered, { text: 'ok, thanks', via: 'chat', at: at(20), joinRecent: SAME_CONVERSATION_MS })
    expect(r.joined).toBe('reaction')
    expect(r.thread.id).toBe(id)
    expect(r.message.joined).toBeUndefined()
    const hint = threadHintText({ threadId: id, title: 'Gate', joined: 'reaction', created: false, followUp: false, duplicate: false, open: [], closed: [] })
    expect(hint).toContain('a bare reaction')
    expect(hint).not.toContain('status question asks')
  })
})

describe('reading the answer', () => {
  it('a split line names its title, state and words; every asked join is checked whatever the answer says', () => {
    const { f, id, ids } = burst()
    const { refs } = ask(f)
    const read = readThreadLines('FOR_USER_THREAD: t1 | working | Oiling the gate hinge.\nFOR_USER_THREAD_SPLIT: t1 | Compost order | answered | Ordered three bags of compost; they come Friday.', refs)
    // Each carries the thread's newest message and his newest anywhere when asked: the split stops there.
    const when = { upTo: ids[2], hisAt: f.threads[0].messages[2].at }
    expect(read.threads_split).toEqual([{ id, messageId: ids[1], ...when, title: 'Compost order', state: 'answered', progress: 'Ordered three bags of compost; they come Friday.' }])
    expect(read.joins_checked).toEqual([{ id, messageId: ids[1], ...when }])
    const quiet = readThreadLines('FOR_USER_THREAD: t1 | working | Oiling the gate hinge.', refs)
    expect(quiet.threads_split).toBeUndefined()
    expect(quiet.joins_checked).toEqual([{ id, messageId: ids[1], ...when }])
  })

  it('takes full-width colon and bar (\\uff1a, \\uff5c), and ignores an unknown ref, a ref with no join, a bad state or no title', () => {
    const { f, id } = burst()
    const other = fileMessage(f, { text: 'book the piano tuner', via: 'chat', at: at(30), joinRecent: SAME_CONVERSATION_MS }).file
    const { refs } = ask(other)
    const joinedRef = [...refs].find(([, r]) => r.id === id)![0]
    const plainRef = [...refs].find(([, r]) => r.id !== id)![0]
    const bad = [`FOR_USER_THREAD_SPLIT: t9 | Compost order | answered | x`, `FOR_USER_THREAD_SPLIT: ${plainRef} | Tuner | working | x`,
      `FOR_USER_THREAD_SPLIT: ${joinedRef} | Compost order | maybe | x`, `FOR_USER_THREAD_SPLIT: ${joinedRef} |  | working | x`].join('\n')
    expect(readThreadLines(bad, refs).threads_split).toBeUndefined()
    const wide = readThreadLines(`FOR_USER_THREAD_SPLIT\uff1a ${joinedRef} \uff5c Compost order \uff5c working \uff5c Asking the shop.`, refs)
    expect(wide.threads_split?.[0]).toMatchObject({ id, title: 'Compost order', state: 'working', progress: 'Asking the shop.' })
  })
})

describe('writing the answer', () => {
  const get = async () => (await readThreads(TASK)).threads

  it('a split takes the message and the joins right after it into a thread of its own, named and stated by the line', async () => {
    const { f, id, ids } = burst()
    await seed(f)
    const { refs } = ask(f)
    const read = readThreadLines(`FOR_USER_THREAD: t1 | working | Oiling the gate hinge.\nFOR_USER_THREAD_SPLIT: t1 | Compost order | answered | Ordered three bags of compost; they come Friday.`, refs)
    const changed = await applyThreadLines(TASK, read)
    const threads = await get()
    const gate = threads.find((t) => t.id === id)!
    const compost = threads.find((t) => t.id !== id)!
    expect(changed).toContain(compost.id)
    expect(gate.closed).toBeUndefined()
    expect(gate.messages.map((m) => m.id)).toEqual([ids[0]])
    expect(gate.reply).toBe('Oiling the gate hinge.')
    expect(compost.messages.map((m) => m.id)).toEqual([ids[1], ids[2]])
    // The asked one is answered; the one right after it is asked next, in its new thread (review round 1).
    expect(compost.messages.map((m) => m.joined)).toEqual([undefined, 'recent'])
    expect(compost).toMatchObject({ title: 'Compost order', titled: true, state: 'answered', reply: 'Ordered three bags of compost; they come Friday.' })
    const again = ask(await readThreads(TASK))
    const asked = [...again.refs.values()].filter((r) => r.joined)
    expect(asked).toEqual([expect.objectContaining({ id: compost.id, joined: ids[2] })])
    expect(again.block).toContain('"three bags is enough" (right after "also order compost for the raised beds")')
  })

  it('a message he wrote after the question stays where it was, marked, and is asked next (review round 1)', async () => {
    const { f, id, ids } = burst()
    // The question saw the gate and compost only.
    const seen = { ...f, threads: f.threads.map((t) => ({ ...t, messages: t.messages.slice(0, 2) })) }
    const { refs } = ask(seen)
    await seed(f)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD_SPLIT: t1 | Compost order | working | Asking the shop.', refs))
    const threads = await get()
    const gate = threads.find((t) => t.id === id)!
    expect(threads.find((t) => t.id !== id)!.messages.map((m) => m.id)).toEqual([ids[1]])
    expect(gate.messages.map((m) => [m.id, m.joined])).toEqual([[ids[0], undefined], [ids[2], 'recent']])
  })

  it('a word of his on the source after the question still holds its line when the split ran (review round 2)', async () => {
    let r = fileMessage(emptyThreads(TASK), { text: 'the garden gate sticks when it rains', via: 'chat', at: at(0), joinRecent: SAME_CONVERSATION_MS })
    const id = r.thread.id
    r = fileMessage(r.file, { text: 'also order compost for the raised beds', via: 'chat', at: at(1), joinRecent: SAME_CONVERSATION_MS })
    const { refs } = ask(r.file)
    // While the node answers he writes about the gate again (not joined: he named the thread).
    r = fileMessage(r.file, { text: 'wait, the gate is fine now, it was the latch', via: 'follow-up', threadId: id, at: at(2) })
    await seed(r.file)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD: t1 | answered | Oiled the gate hinge.\nFOR_USER_THREAD_SPLIT: t1 | Compost order | working | Asking the shop.', refs))
    const gate = (await get()).find((t) => t.id === id)!
    expect(gate.messages.map((m) => m.text)).toEqual(['the garden gate sticks when it rains', 'wait, the gate is fine now, it was the latch'])
    expect(gate.reply).toBeUndefined()
    expect(gate.state).not.toBe('answered')
  })

  it('a done line on the source beside a split closes only what is left of it (review round 1)', async () => {
    // A subject the node opened, answered; his reply to it, then (a minute later) another subject.
    const base = emptyThreads(TASK)
    const src: OrgThread = { id: 'th-abcdef123456', title: 'Reply to the landlord', titled: true, state: 'answered', messages: [], createdAt: at(0), updatedAt: at(0),
      reply: 'A draft reply to the landlord is ready.', replyAt: at(0), opener: { text: 'The landlord asks about the lease.', at: at(0), from: 'node', by: `task:${TASK}` } }
    let f: ThreadsFile = { ...base, threads: [src] }
    f = fileMessage(f, { text: 'send the draft as is', via: 'follow-up', threadId: src.id, at: at(1) }).file
    const r = fileMessage(f, { text: 'also book the piano tuner for friday', via: 'chat', at: at(2), joinRecent: SAME_CONVERSATION_MS })
    expect(r.thread.id).toBe(src.id)
    expect(r.message.joined).toBe('recent')
    await seed(r.file)
    const { refs } = ask(r.file)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD: t1 | done | Sent the draft to the landlord.\nFOR_USER_THREAD_SPLIT: t1 | Piano tuner | working | Booking the tuner for Friday.', refs))
    const threads = await get()
    const left = threads.find((t) => t.id === src.id)!
    const tuner = threads.find((t) => t.id !== src.id)!
    expect(left.closed).toBeTruthy()
    expect(left.messages.map((m) => m.text)).toEqual(['send the draft as is'])
    expect(tuner).toMatchObject({ title: 'Piano tuner', state: 'working' })
    expect(tuner.closed).toBeUndefined()
    expect(tuner.messages.map((m) => m.text)).toEqual(['also book the piano tuner for friday'])
  })

  it('an answer without the line only takes the mark off: nothing moves, and it is not asked again', async () => {
    const { f, id, ids } = burst()
    await seed(f)
    const { refs } = ask(f)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD: t1 | working | Oiling the gate hinge; compost ordered too.', refs))
    const threads = await get()
    expect(threads).toHaveLength(1)
    const t = threads.find((x) => x.id === id)!
    expect(t.messages.map((m) => m.id)).toEqual(ids)
    expect(t.messages.find((m) => m.id === ids[1])!.joined).toBeUndefined()
    // The join after it was not asked yet (one per thread): the next question asks it.
    const again = ask(await readThreads(TASK))
    expect(again.refs.get('t1')!.joined).toBe(ids[2])
  })

  it('a working line opens it out of his sight, a done line as the result of his request', async () => {
    for (const [state, want] of [['working', 'working'], ['done', 'answered']] as const) {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true })
      const { f, id } = burst()
      await seed(f)
      const { refs } = ask(f)
      await applyThreadLines(TASK, readThreadLines(`FOR_USER_THREAD_SPLIT: t1 | Compost order | ${state} | Three bags of compost, from the garden shop.`, refs))
      const made = (await get()).find((t) => t.id !== id)!
      expect(made.state).toBe(want)
    }
  })

  it('a message the node split out itself meanwhile is not split again, and nothing else moves', async () => {
    const { f, id, ids } = burst()
    const { refs } = ask(f)
    const read = readThreadLines('FOR_USER_THREAD_SPLIT: t1 | Compost order | answered | Three bags ordered.', refs)
    const moved = splitThreadMessage(f, id, ids[1], `task:${TASK}`, at(4), undefined, 'en', { keepOpen: true })
    await seed(moved.file)
    await applyThreadLines(TASK, read)
    const threads = await get()
    expect(threads).toHaveLength(2)
    expect(threads.find((t) => t.id === id)!.messages.map((m) => m.id)).toEqual([ids[0], ids[2]])
    expect(threads.find((t) => t.id === moved.thread.id)!.messages.map((m) => m.id)).toEqual([ids[1]])
    expect(threads.some((t) => t.title === 'Compost order')).toBe(false)
  })

  it('a source he closed meanwhile splits nothing, the mark only comes off', async () => {
    const { f, id, ids } = burst()
    const { refs } = ask(f)
    const closed = updateThread(f, id, { close: 'acked' }, 'human', at(4)).file
    await seed(closed)
    await applyThreadLines(TASK, readThreadLines('FOR_USER_THREAD_SPLIT: t1 | Compost order | answered | Three bags ordered.', refs))
    const threads = await get()
    expect(threads).toHaveLength(1)
    expect(threads[0].messages.find((m) => m.id === ids[1])!.joined).toBeUndefined()
  })
})

describe('the class: every rule that files his message into a thread he did not name', () => {
  // How each rule is checked. A rule that may join another subject marks the message (the node is asked).
  const CLASSIFIED: Record<string, 'marked' | 'unmarked'> = {
    recent: 'marked', // right after his last message: the status question asks the node
    reopened: 'unmarked', // he named the thread (a follow-up on one he closed minutes ago)
    reaction: 'unmarked', // a bare reaction (ok, thanks): no subject of its own
  }
  const src = readFileSync(path.join(process.cwd(), 'src/core/org/threads-model.ts'), 'utf8')

  it('every kind fileMessage can report is classified here', () => {
    const decl = /joined\?: ((?:'[a-z]+'(?: \| )?)+);/.exec(src.slice(src.indexOf('export interface FileMessageResult')))
    expect(decl, 'FileMessageResult.joined is a union of string kinds').toBeTruthy()
    const kinds = decl![1].split('|').map((k) => k.trim().replace(/'/g, ''))
    expect(kinds.filter((k) => !CLASSIFIED[k]), 'a new kind: classify it here, and mark its messages if it can join another subject').toEqual([])
    const pick = /const target = ([^;]+);/.exec(src.slice(src.indexOf('export function fileMessage(')))
    expect(pick![1].split('??').map((x) => x.trim()), 'fileMessage picks its thread by these rules only').toEqual(['named', 'recent', 'reaction'])
  })

  it('each kind files as classified: only a recent join carries the mark', () => {
    const { f, id, ids } = burst()
    const seen: Record<string, boolean> = { recent: f.threads[0].messages[1].joined === 'recent' }
    const answered = setAnswers(f, new Map([[ids[2], { text: 'Three bags it is.', at: at(4) }]])).file
    const reaction = fileMessage(answered, { text: 'ok, thanks', via: 'chat', at: at(20), joinRecent: SAME_CONVERSATION_MS })
    seen[reaction.joined!] = reaction.message.joined === 'recent'
    const closedByHim = updateThread(f, id, { close: 'acked' }, 'human', at(5)).file
    const reopened = fileMessage(closedByHim, { text: 'one more thing on the gate', via: 'follow-up', threadId: id, at: at(6) })
    seen[reopened.joined!] = reopened.message.joined === 'recent'
    expect(Object.keys(seen).sort()).toEqual(Object.keys(CLASSIFIED).sort())
    for (const [k, marked] of Object.entries(seen)) expect(marked, k).toBe(CLASSIFIED[k] === 'marked')
  })
})
