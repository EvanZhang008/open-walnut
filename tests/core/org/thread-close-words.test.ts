/**
 * His words about a thread go with it (src/core/org/threads-model.ts carryHisWords, called by the
 * store's close and merge: threads-store.ts patchThread, mergeThread).
 *
 * 2026-11-26, a trial with a real session, 7 runs of 7: he wrote "that first one is done, close it".
 * The thread he meant was closed, and his message, filed right after another one and then taken out
 * as a subject of its own, stayed as a card telling him the thread was closed, waiting for his
 * Acknowledge.
 *
 * The class: every store write that takes his quoted words (`user_words`) carries the message that
 * holds them; the guard at the end reads the store's source and fails on a new one that does not.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-close-words'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting } from '../../../src/core/org/threads-backend.js'
import * as store from '../../../src/core/org/threads-store.js'
import { carryHisWords, emptyThreads, fileMessage, setAnswers } from '../../../src/core/org/threads-model.js'

const NODE = 'node-close-words'
const BY = `task:${NODE}` as const
const T0 = Date.now() - 60 * 60_000
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const open = async () => (await store.readThreads(NODE)).threads.filter((t) => !t.closed && !t.movedTo)

const Q_TREE = 'What is the difference between a larch and an oak?'
const A_TREE = 'A larch drops its needles in autumn; an oak keeps its leaves until spring.'
const Q_FERN = 'How often do I water the fern?'
const CLOSE = 'that tree one is done, close it'

beforeEach(async () => {
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})
afterAll(async () => {
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** The thread he will ask to close: his question, answered. */
async function answeredTree(): Promise<string> {
  const x = await store.fileThreadMessage(NODE, { text: Q_TREE, via: 'chat', at: at(0) })
  await store.setThreadAnswers(NODE, new Map([[x.message.id, { text: A_TREE, at: at(1) }]]))
  return x.thread.id
}

describe('his words that close a thread go with it', () => {
  it('filed as a thread of their own: the thread is closed with them in it, and no card of theirs is left', async () => {
    const tree = await answeredTree()
    const own = await store.fileThreadMessage(NODE, { text: CLOSE, via: 'chat', at: at(60) })
    expect(own.thread.id).not.toBe(tree)
    const closed = await store.patchThread(NODE, tree, { close: 'acked', user_words: CLOSE }, BY)
    expect(closed.closed?.how).toBe('acked')
    expect(closed.messages.map((m) => m.text)).toEqual([Q_TREE, CLOSE])
    expect(await open()).toEqual([])
  })

  it('filed right after another message of his: they move alone, and that thread stays as it was', async () => {
    const tree = await answeredTree()
    const fern = await store.fileThreadMessage(NODE, { text: Q_FERN, via: 'chat', at: at(30) })
    const joined = await store.fileThreadMessage(NODE, { text: CLOSE, via: 'chat', threadId: fern.thread.id, at: at(60) })
    expect(joined.thread.id).toBe(fern.thread.id)
    const closed = await store.patchThread(NODE, tree, { close: 'acked', user_words: 'tree one is done, close it' }, BY)
    expect(closed.messages.map((m) => m.text)).toEqual([Q_TREE, CLOSE])
    const left = await open()
    expect(left.map((t) => t.id)).toEqual([fern.thread.id])
    expect(left[0].messages.map((m) => m.text)).toEqual([Q_FERN])
  })

  it('the thread they leave stays open, even when all else on it was answered: the node closed one thread, not two', async () => {
    const tree = await answeredTree()
    const fern = await store.fileThreadMessage(NODE, { text: Q_FERN, via: 'chat', at: at(30) })
    await store.setThreadAnswers(NODE, new Map([[fern.message.id, { text: 'Once a week, less in winter.', at: at(40) }]]))
    await store.fileThreadMessage(NODE, { text: CLOSE, via: 'chat', threadId: fern.thread.id, at: at(60) })
    await store.patchThread(NODE, tree, { close: 'acked', user_words: 'tree one is done, close it' }, BY)
    const left = await open()
    expect(left.map((t) => t.id)).toEqual([fern.thread.id])
    expect(left[0].messages.map((m) => m.text)).toEqual([Q_FERN])
  })

  it('a message that also asks something keeps its thread: its question is answered there', async () => {
    const tree = await answeredTree()
    const both = `${CLOSE}. and how often do I water the fern?`
    const own = await store.fileThreadMessage(NODE, { text: both, via: 'chat', at: at(60) })
    await store.patchThread(NODE, tree, { close: 'acked', user_words: CLOSE }, BY).catch(() => undefined)
    const left = await open()
    expect(left.map((t) => t.id)).toContain(own.thread.id)
    expect(left.find((t) => t.id === own.thread.id)!.messages.map((m) => m.text)).toEqual([both])
  })

  it('words already in the thread, words nobody wrote, his own close, or a closed target: nothing moves', async () => {
    let f = fileMessage(emptyThreads(NODE), { text: Q_TREE, via: 'chat', at: at(0) }).file
    const tree = f.threads[0].id
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: A_TREE, at: at(1) }]])).file
    const other = fileMessage(f, { text: CLOSE, via: 'chat', at: at(60) })
    f = other.file
    expect(carryHisWords(f, tree, 'close the pond one', BY, at(61))).toBe(f)
    expect(carryHisWords(f, tree, CLOSE, 'human', at(61))).toBe(f)
    expect(carryHisWords(f, tree, '', BY, at(61))).toBe(f)
    expect(carryHisWords(f, 'th-000000000000', CLOSE, BY, at(61))).toBe(f)
    const moved = carryHisWords(f, tree, CLOSE, BY, at(61))
    expect(moved.threads.find((t) => t.id === tree)!.messages.map((m) => m.text)).toEqual([Q_TREE, CLOSE])
    // Carried once: the same call again finds them where they are.
    expect(carryHisWords(moved, tree, CLOSE, BY, at(62))).toBe(moved)
  })
})

describe('his words that combine threads go under the one that keeps', () => {
  it('a third thread holding only "put those two together" is gone after the merge', async () => {
    const tree = await answeredTree()
    const fern = await store.fileThreadMessage(NODE, { text: Q_FERN, via: 'chat', at: at(30) })
    const ask = 'put those two together'
    const third = await store.fileThreadMessage(NODE, { text: ask, via: 'chat', at: at(60) })
    expect(third.thread.id).not.toBe(fern.thread.id)
    const kept = await store.mergeThread(NODE, fern.thread.id, tree, BY, { userWords: ask })
    expect(kept.id).toBe(tree)
    expect(kept.messages.map((m) => m.text)).toEqual([Q_TREE, Q_FERN, ask])
    expect((await open()).map((t) => t.id)).toEqual([tree])
  })
})

describe('every store write that takes his quoted words carries them (guard)', () => {
  it('each function of threads-store.ts that reads user_words calls carryHisWords', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/org/threads-store.ts'), 'utf8')
    const parts = src.split(/\n(?=export (?:async )?function )/)
    const takes = parts.filter((p) => /\buser_words\b|\buserWords\b/.test(p)).map((p) => /^export (?:async )?function (\w+)/.exec(p)?.[1] ?? '(top)')
    const carries = parts.filter((p) => /\bcarryHisWords\(/.test(p)).map((p) => /^export (?:async )?function (\w+)/.exec(p)?.[1] ?? '(top)')
    // A new store write that takes his words: call carryHisWords in it, so the message holding them goes with the thread.
    expect(takes.filter((n) => n !== '(top)').sort()).toEqual(['mergeThread', 'patchThread'])
    expect(carries.filter((n) => n !== '(top)').sort()).toEqual(['mergeThread', 'patchThread'])
  })
})
