/**
 * thread_split's two options in the store (src/core/org/threads-store.ts splitThread), on the JSON
 * files and on the database alike: `mergeInto` moves the message straight into another open thread
 * in one locked write, `keepOpen` keeps the thread it leaves open; a merge that refuses writes
 * nothing; each write tells the web one event (org-threads:changed).
 *
 * 2026-11-21: a split of a thread's last open message closed the thread it left without saying so,
 * and a split then a merge took two calls each answering the whole thread.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-split-into'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { closeThreadsDb } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, useThreadsDb } from '../../../src/core/org/threads-backend.js'
import { _setThreadsExportEveryForTesting } from '../../../src/core/org/threads-sync.js'
import * as store from '../../../src/core/org/threads-store.js'
import { ThreadError } from '../../../src/core/org/threads-model.js'

const NODE = 'node-split-into'
const SUB = 'test-thread-split-into'

beforeEach(async () => {
  bus.unsubscribe(SUB)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  _setThreadsExportEveryForTesting(undefined)
})

afterAll(async () => {
  bus.unsubscribe(SUB)
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** Two subjects: A holds an answered message he reacted to and a new one; B is open. */
async function twoThreads() {
  const now = () => new Date().toISOString()
  const a = await store.fileThreadMessage(NODE, { text: 'Explain the seed trays', via: 'chat', at: now() })
  await store.setThreadAnswers(NODE, new Map([[a.message.id, { text: 'The 72-cell ones.', at: now() }]]))
  const second = await store.fileThreadMessage(NODE, { text: 'and the potting soil?', via: 'follow-up', threadId: a.thread.id, at: now() })
  const b = await store.fileThreadMessage(NODE, { text: 'Book the soil delivery', via: 'chat', at: now() })
  return { a: a.thread.id, b: b.thread.id, moved: second.message.id }
}

function events(): Array<{ kind?: string; threadId?: string }> {
  const got: Array<{ kind?: string; threadId?: string }> = []
  bus.subscribe(SUB, (e) => {
    if (e.name === EventNames.ORG_THREADS_CHANGED && (e.data as { taskId?: string }).taskId === NODE) got.push(e.data as { kind?: string; threadId?: string })
  }, { global: true, interest: [EventNames.ORG_THREADS_CHANGED] })
  return got
}

describe.each([['the JSON files', false], ['the database', true]] as const)('splitThread on %s', (_name, onDb) => {
  beforeEach(async () => {
    _resetThreadsBackendForTesting(onDb)
    expect(await useThreadsDb()).toBe(onDb)
  })

  it('mergeInto: the message lands in the open thread in one write, and one merged event names it', async () => {
    const { a, b, moved } = await twoThreads()
    const seen = events()
    const out = await store.splitThread(NODE, a, moved, 'human', { mergeInto: b })
    expect(out.mergedInto).toBe(b)
    expect(out.thread.id).toBe(b)
    const read = await store.readThreads(NODE)
    expect(read.threads.map((t) => t.id).sort()).toEqual([a, b].sort())
    expect(read.threads.find((t) => t.id === b)!.messages.map((m) => m.id)).toContain(moved)
    expect(read.threads.find((t) => t.id === a)!.messages.map((m) => m.id)).not.toContain(moved)
    expect(seen).toEqual([{ taskId: NODE, kind: 'merged', threadId: b }])
  })

  it('keepOpen keeps the thread it leaves open; without it closedFrom says when it closed', async () => {
    const kept = await twoThreads()
    const open = await store.splitThread(NODE, kept.a, kept.moved, 'human', { keepOpen: true })
    expect(open.closedFrom).toBe(false)
    expect((await store.readThreads(NODE)).threads.find((t) => t.id === kept.a)!.closed).toBeUndefined()
    const seen = events()
    const plain = await store.splitThread(NODE, open.thread.id, open.thread.messages[0].id, 'human').catch((err: unknown) => err)
    // The new thread holds one message: nothing to split, refused, nothing told.
    expect(plain).toBeInstanceOf(ThreadError)
    expect(seen).toEqual([])
  })

  it('a merge into a missing or closed thread refuses and writes nothing', async () => {
    const { a, b, moved } = await twoThreads()
    const before = JSON.stringify(await store.readThreads(NODE))
    const seen = events()
    await expect(store.splitThread(NODE, a, moved, 'human', { mergeInto: 'th-ffffffffffff' })).rejects.toMatchObject({ code: 'no_thread' })
    await store.patchThread(NODE, b, { close: 'dropped' }, 'human')
    const closed = JSON.stringify(await store.readThreads(NODE))
    await expect(store.splitThread(NODE, a, moved, 'human', { mergeInto: b })).rejects.toMatchObject({ code: 'thread_closed' })
    await expect(store.splitThread(NODE, a, moved, 'human', { mergeInto: a })).rejects.toMatchObject({ code: 'same_thread' })
    expect(JSON.stringify(await store.readThreads(NODE))).toBe(closed)
    expect(before).not.toBe(closed)
    // Only the close was told.
    expect(seen.map((e) => e.kind)).toEqual(['updated'])
  })
})
