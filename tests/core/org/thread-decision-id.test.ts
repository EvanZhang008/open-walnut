/**
 * The decision id a thread stores (OrgThread.askId, a report's `ask-...` id; experiment
 * threads_reply_tag; review 2026-11-25), on both stores (JSON files and threads_sqlite):
 *  - a thread an older build wrote (no id, or the pop-up's own `ak-` stamp) reads exactly as
 *    before, and counts as naming no decision: only its words do;
 *  - markThreadDecision names it on an open needs thread, the store keeps it through later writes,
 *    and a new stretch of needs leaves it behind; threads_pop_up's stamp keeps the id a write set;
 *  - with the experiment off nothing names one, and a write moves no id.
 * The field is not new: older builds read and write it already (normalizeThread spreads it).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-decision-id'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting } from '../../../src/core/org/threads-backend.js'
import * as store from '../../../src/core/org/threads-store.js'
import { markThreadDecision, needsThreadOf, threadDecisionsOf } from '../../../src/core/org/thread-report-ask.js'
import { setReplyTag } from '../../../src/core/org/reply-card-switch.js'
import { setThreadsPopUp } from '../../../src/core/org/thread-popup-rules.js'
import type { OrgThread, ThreadsFile } from '../../../src/core/org/threads-model.js'

const T0 = '2026-11-25T09:00:00.000Z'
const ASK = 'Wood or plastic for the compost bin?'
const D = 'ask-c0b1d001'

function thread(id: string, extra: Partial<OrgThread>): OrgThread {
  // A stored thread holds at least its first message (threads-model.ts normalizeThread).
  return { id, title: 'Compost bin', state: 'working', messages: [{ id: `tm-${id.slice(3)}`, at: T0, text: 'Which bin should I buy?', via: 'chat' }], createdAt: T0, updatedAt: T0, ...extra } as OrgThread
}
/** A raw write, as an older build left the file. */
const put = (node: string, threads: OrgThread[]) => store.writeThreadsFor(node, (cur: ThreadsFile) => ({ file: { ...cur, threads }, out: undefined }))
const set = (node: string, id: string, patch: Partial<OrgThread>) => store.writeThreadsFor(node, (cur: ThreadsFile) => ({
  file: { ...cur, threads: cur.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, out: undefined,
}))
const read = async (node: string, id: string) => (await store.readThreads(node)).threads.find((t) => t.id === id)!

beforeEach(() => closeThreadsDb())
afterEach(() => { setReplyTag(false); setThreadsPopUp(false); _resetThreadsBackendForTesting(undefined); closeThreadsDb() })
afterAll(async () => { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

for (const [name, onDb] of [['JSON files', false], ['threads_sqlite', true]] as const) {
  describe(`a thread's decision id on ${name}`, () => {
    const node = `node-${onDb ? 'db' : 'json'}`
    beforeEach(() => _resetThreadsBackendForTesting(onDb))

    it('a thread written without one, or with the pop-up\'s stamp, reads as before and names no decision', async () => {
      const older = [thread('th-c0b1d001', { state: 'needs', ask: ASK }), thread('th-c0b1d002', { state: 'needs', ask: 'Lid or no lid for the bin?', askId: 'ak-0123456789' })]
      await put(`${node}-old`, older)
      const back = (await store.readThreads(`${node}-old`)).threads
      expect(back).toEqual(older)
      setReplyTag(true)
      expect(threadDecisionsOf({ threads_on: true }, back).map((d) => [d.thread, d.id])).toEqual([['th-c0b1d001', undefined], ['th-c0b1d002', undefined]])
      // Its words alone then: the same question finds it, an id of another decision does not change that.
      expect(needsThreadOf(back, { id: D, ask: ASK })?.id).toBe('th-c0b1d001')
      expect(needsThreadOf(back, { id: D, ask: 'Should the compost bin have a lid?' })).toBeNull()
    })

    it('named on an open needs thread, kept through later writes, left behind by a new stretch of needs', async () => {
      await put(node, [thread('th-c0b1d003', { state: 'needs', ask: ASK })])
      // Off: nothing is named.
      expect(await markThreadDecision(node, 'th-c0b1d003', D)).toBe(false)
      expect((await read(node, 'th-c0b1d003')).askId).toBeUndefined()
      setReplyTag(true)
      expect(await markThreadDecision(node, 'th-c0b1d003', 'ak-0123456789')).toBe(false)
      expect(await markThreadDecision(node, 'th-c0b1d003', D)).toBe(true)
      expect(await markThreadDecision(node, 'th-c0b1d003', D)).toBe(false)
      expect((await read(node, 'th-c0b1d003')).askId).toBe(D)
      // A later write while it still asks keeps it; it stays on the thread after it leaves needs (his answer there is read by it).
      await set(node, 'th-c0b1d003', { reply: 'Wood lasts longer.' })
      expect((await read(node, 'th-c0b1d003')).askId).toBe(D)
      await set(node, 'th-c0b1d003', { state: 'working' })
      expect((await read(node, 'th-c0b1d003')).askId).toBe(D)
      expect(await markThreadDecision(node, 'th-c0b1d003', 'ask-c0b1d002')).toBe(false)
      // In needs again: a new decision until a write names it.
      await set(node, 'th-c0b1d003', { state: 'needs', ask: 'Should the compost bin have a lid?' })
      expect((await read(node, 'th-c0b1d003')).askId).toBeUndefined()
    })

    it('threads_pop_up\'s stamp keeps the decision id a write set, and stamps its own when it enters needs', async () => {
      setReplyTag(true)
      setThreadsPopUp(true)
      await put(`${node}-pop`, [thread('th-c0b1d004', { state: 'working', ask: ASK })])
      await set(`${node}-pop`, 'th-c0b1d004', { state: 'needs' })
      expect((await read(`${node}-pop`, 'th-c0b1d004')).askId).toMatch(/^ak-/)
      expect(await markThreadDecision(`${node}-pop`, 'th-c0b1d004', D)).toBe(true)
      expect((await read(`${node}-pop`, 'th-c0b1d004')).askId).toBe(D)
      await set(`${node}-pop`, 'th-c0b1d004', { reply: 'Wood lasts longer.' })
      expect((await read(`${node}-pop`, 'th-c0b1d004')).askId).toBe(D)
    })

    it('with the experiment off a write into needs moves no id, as before', async () => {
      await put(`${node}-off`, [thread('th-c0b1d005', { state: 'working', ask: ASK, askId: D })])
      await set(`${node}-off`, 'th-c0b1d005', { state: 'needs' })
      expect((await read(`${node}-off`, 'th-c0b1d005')).askId).toBe(D)
    })
  })
}
