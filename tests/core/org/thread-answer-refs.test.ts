/**
 * Ratchet: each reply is stored once (src/core/org/thread-answer-refs.ts; 2026-11-21, the user: "To
 * save token, be efficient"; the Walnut VP's threads kept 1.73 copies a reply, one reply 7 times).
 * In the Threads database a message row whose answer is an earlier message's holds a reference, and
 * every read gives each message its answer as before. The JSON files keep every reply whole: they are
 * what an older build reads, and the database is schema 2, which a build of schema 1 refuses (review
 * 2026-11-22: a schema-1 build hands a row's reference on as an answer with no text, and its routes
 * and the phone's decoder fail on it).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-answer-refs'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb, threadsDb, THREADS_DB_VERSION } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, useThreadsDb } from '../../../src/core/org/threads-backend.js'
import { _setThreadsExportEveryForTesting, flushThreadsExports, parseThreadsText } from '../../../src/core/org/threads-sync.js'
import * as store from '../../../src/core/org/threads-store.js'
import { expandAnswerRefs, storedMessages } from '../../../src/core/org/thread-answer-refs.js'
import type { ThreadMessage } from '../../../src/core/org/threads-model.js'

const NODE = 'node-answer-refs'
const REPLY = 'Both done: the trays are ordered and the soil is on its way \u{1F331}. '.repeat(20)

const msg = (id: string, answer?: ThreadMessage['answer'], extra: Partial<ThreadMessage> = {}): ThreadMessage =>
  ({ id, at: '2026-11-21T10:00:00.000Z', text: `words of ${id}`, via: 'chat', ...(answer ? { answer } : {}), ...extra })

describe('stored once, read back whole', () => {
  const shared = { text: REPLY, at: '2026-11-21T10:01:00.000Z', sid: 'sess-a' }
  const messages = [msg('tm-1', shared, { readAt: '2026-11-21T10:05:00.000Z' }), msg('tm-2', { ...shared }), msg('tm-3', { text: 'Other', at: '2026-11-21T10:02:00.000Z' }), msg('tm-4', { ...shared })]

  it('a repeated answer becomes a reference to the first message holding it; the read is the same JSON', () => {
    const stored = storedMessages(messages)
    expect(stored[0]!.answer).toEqual(shared)
    expect(stored[1]!.answer).toEqual({ same: 'tm-1' })
    expect(stored[2]!.answer?.text).toBe('Other')
    expect(stored[3]!.answer).toEqual({ same: 'tm-1' })
    expect(JSON.stringify(stored).split(REPLY).length - 1).toBe(1)
    expect(JSON.stringify(expandAnswerRefs(JSON.parse(JSON.stringify(stored))))).toBe(JSON.stringify(messages))
  })

  it('an answer that differs in anything (its session) is its own copy', () => {
    const stored = storedMessages([msg('tm-1', shared), msg('tm-2', { ...shared, sid: 'sess-b' })])
    expect(stored[1]!.answer).toMatchObject({ text: REPLY, sid: 'sess-b' })
  })

  it('a reference to nothing here reads as no answer (the chat is read for it again); the first message keeps the whole', () => {
    const read = expandAnswerRefs([msg('tm-2', { same: 'tm-gone' } as never)])
    expect(read[0]).not.toHaveProperty('answer')
    expect(storedMessages(messages)[0]!.answer?.text).toBe(REPLY)
  })
})

beforeEach(async () => {
  vi.restoreAllMocks()
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  _setThreadsExportEveryForTesting(0)
})

afterAll(async () => {
  _resetThreadsBackendForTesting(undefined)
  _setThreadsExportEveryForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const fileText = () => fs.readFileSync(path.join(WALNUT_HOME, 'org', 'threads', `${NODE}.json`), 'utf8')
const copies = (text: string) => text.split(REPLY).length - 1

describe.each([['the JSON files', false], ['the database', true]] as const)('on %s', (_name, onDb) => {
  it('one reply to two messages is stored once, read under both, and kept whole through a split and a reload', async () => {
    _resetThreadsBackendForTesting(onDb)
    expect(await useThreadsDb()).toBe(onDb)
    const a = await store.fileThreadMessage(NODE, { text: 'Order the seed trays', via: 'chat', at: '2026-11-21T10:00:00.000Z' })
    const b = await store.fileThreadMessage(NODE, { text: 'and the potting soil', via: 'follow-up', threadId: a.thread.id, at: '2026-11-21T10:00:20.000Z' })
    const answer = { text: REPLY, at: '2026-11-21T10:01:00.000Z' }
    await store.setThreadAnswers(NODE, new Map([[a.message.id, answer], [b.message.id, answer]]))

    const read = (await store.readThreads(NODE)).threads.find((t) => t.id === a.thread.id)!
    expect(read.messages.map((m) => m.answer?.text)).toEqual([REPLY, REPLY])
    if (onDb) {
      const rows = threadsDb().prepare('SELECT body FROM thread_messages WHERE node = ? ORDER BY seq').pluck().all(NODE) as string[]
      expect(rows.map(copies)).toEqual([1, 0])
      expect(JSON.parse(rows[1]!).answer).toEqual({ same: a.message.id })
      // A schema-1 build (the one before it) opens a file only up to its own version: it refuses this one.
      expect(threadsDb().pragma('user_version', { simple: true })).toBe(THREADS_DB_VERSION)
      expect(THREADS_DB_VERSION).toBeGreaterThan(1)
      await flushThreadsExports()
    }
    // The file keeps both whole: what an older build and the JSON mode read.
    expect(copies(fileText())).toBe(2)
    expect(fileText()).not.toContain('"same"')
    expect(parseThreadsText(fileText(), NODE).threads.find((t) => t.id === a.thread.id)!.messages.map((m) => m.answer?.text)).toEqual([REPLY, REPLY])

    // The message holding it moves out: each thread keeps the whole answer.
    const split = await store.splitThread(NODE, a.thread.id, b.message.id, 'human')
    closeThreadsDb()
    const after = await store.readThreads(NODE)
    for (const id of [split.thread.id, split.from.id]) {
      expect(after.threads.find((t) => t.id === id)!.messages.map((m) => m.answer?.text)).toEqual([REPLY])
    }
    if (onDb) await flushThreadsExports()
    expect(copies(fileText())).toBe(2)
  })
})

describe('only the database rows hold references', () => {
  it('its rows write and read them; the JSON writers never do', () => {
    const src = (f: string) => fs.readFileSync(`src/core/org/${f}`, 'utf8')
    expect(src('threads-db.ts')).toMatch(/storedTexts\(t\)\.forEach\(\(text, seq\)/)
    expect(src('threads-db.ts')).toMatch(/expandAnswerRefs\(texts\.map/)
    for (const f of ['threads-store.ts', 'threads-sync.ts', 'threads-model.ts']) expect(src(f), f).not.toMatch(/from '\.\/thread-answer-refs\.js'|storedMessages\(/)
    // No other file writes a node's threads.
    const writers = fs.readdirSync('src/core/org').filter((f) => f.endsWith('.ts')).filter((f) => {
      const text = src(f)
      return /upsertMessage\.run/.test(text) || (/threadsFile\(|threadsJsonFile\(/.test(text) && /writeTextFile\(|updateJsonFile[<(]|writeJsonFile\(/.test(text))
    })
    expect(writers.sort()).toEqual(['threads-db.ts', 'threads-store.ts', 'threads-sync.ts'])
  })
})
