/**
 * The decision id a thread stores (OrgThread.askId, a report's `ask-...` id; experiment
 * threads_reply_tag; review 2026-11-25), on both stores (JSON files and threads_sqlite):
 *  - a thread an older build wrote (no id, or the pop-up's own `ak-` stamp) reads exactly as
 *    before, and counts as naming no decision: only its words do;
 *  - markThreadDecision names it on an open needs thread, the store keeps it through later writes,
 *    and a new stretch of needs leaves it behind; threads_pop_up's stamp keeps the id a write set;
 *  - every write that leaves a needs thread asking another question gives it a new id (review
 *    2026-11-25, N1), whichever writer it is: the rule runs in mutateThreads, the one place a
 *    threads file is written (tests/core/org/thread-needs-push-guard.test.ts holds that), and the
 *    writers here are each that can change a needs thread's question;
 *  - an id held only while the thread asks it in needs holds the task's ask item (thread-holds.ts, N3);
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
import { HELD_BY_THREAD } from '../../../src/core/org/thread-holds.js'
import fs from 'node:fs'
import path from 'node:path'

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

const FENCE = 'Should the orchard fence be two metres tall or three?'
const GATE = 'Should the orchard fence gate be painted green or brown?'
const KIND = { user_kind: 'spending', user_kind_why: 'the taller fence costs twice the budget he set' } as const
const BG = 'The fence posts arrive Friday; the taller fence needs a permit, the gate needs paint ordered.'

for (const [name, onDb] of [['JSON files', false], ['threads_sqlite', true]] as const) {
  describe(`a needs thread that asks another question gets another decision id, on ${name} (N1)`, () => {
    const node = `node-n1-${onDb ? 'db' : 'json'}`
    beforeEach(() => _resetThreadsBackendForTesting(onDb))

    /** A needs thread carrying the fence decision under D. */
    async function fence(id: string, extra: Partial<OrgThread> = {}): Promise<void> {
      await put(`${node}-${id}`, [thread(id, { state: 'needs', ask: FENCE, ...extra })])
      expect(await markThreadDecision(`${node}-${id}`, id, D)).toBe(true)
    }

    it('thread_update (patchThread): another question, a new id; the same question reworded, or a new summary only, the same id', async () => {
      setReplyTag(true)
      await fence('th-c0b1d011')
      const n = `${node}-th-c0b1d011`
      await store.patchThread(n, 'th-c0b1d011', { reply: `${BG} Still waiting.` }, 'task:t-1')
      expect((await read(n, 'th-c0b1d011')).askId).toBe(D)
      await store.patchThread(n, 'th-c0b1d011', { ask: 'Orchard fence: two metres tall, or three?', ...KIND }, 'task:t-1')
      expect((await read(n, 'th-c0b1d011')).askId).toBe(D)
      await store.patchThread(n, 'th-c0b1d011', { ask: GATE, reply: BG, ...KIND }, 'task:t-1')
      const after = await read(n, 'th-c0b1d011')
      expect(after).toMatchObject({ state: 'needs', ask: GATE })
      expect(after.askId).toMatch(/^ask-[a-z0-9]+$/)
      expect(after.askId).not.toBe(D)
    })

    it('the same question reworded with the same worded choices keeps the id; other choices on another question do not', async () => {
      setReplyTag(true)
      const options = [{ label: 'Two metres', recommended: true }, { label: 'Three metres' }]
      await fence('th-c0b1d012', { options })
      const n = `${node}-th-c0b1d012`
      await set(n, 'th-c0b1d012', { ask: 'Two metres or three for the orchard fence?' })
      expect((await read(n, 'th-c0b1d012')).askId).toBe(D)
      await set(n, 'th-c0b1d012', { ask: GATE, options: [{ label: 'Green', recommended: true }, { label: 'Brown' }] })
      expect((await read(n, 'th-c0b1d012')).askId).not.toBe(D)
    })

    it('Walnut\'s own writes (writeThreadsFor) and a merge into it are held to the same rule', async () => {
      setReplyTag(true)
      await fence('th-c0b1d013')
      const n = `${node}-th-c0b1d013`
      // A merge of another subject into it changes no question: the id stays.
      await store.writeThreadsFor(n, (cur: ThreadsFile) => ({ file: { ...cur, threads: [...cur.threads, thread('th-c0b1d014', { title: 'Orchard gate' })] }, out: undefined }))
      await store.mergeThread(n, 'th-c0b1d014', 'th-c0b1d013', 'human')
      expect((await read(n, 'th-c0b1d013')).askId).toBe(D)
      await set(n, 'th-c0b1d013', { ask: GATE })
      expect((await read(n, 'th-c0b1d013')).askId).not.toBe(D)
    })

    it('with the experiment off another question moves no id, as before', async () => {
      setReplyTag(true)
      await fence('th-c0b1d015')
      setReplyTag(false)
      const n = `${node}-th-c0b1d015`
      await set(n, 'th-c0b1d015', { ask: GATE })
      expect((await read(n, 'th-c0b1d015')).askId).toBe(D)
    })
  })
}

describe('the rule sits in the one write of a threads file (N1: no writer goes around it)', () => {
  it('mutateThreads runs keepThreadDecisions on every write, before the pop-up stamp', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/core/org/threads-store.ts'), 'utf8')
    expect(src).toMatch(/async function mutateThreads[\s\S]*?const step = \(read: ThreadsFile\): ThreadsFile => \{[\s\S]*?const res = mutate\(cur\);[\s\S]*?replyTagNow\(\) \? keepThreadDecisions\(cur, res\.file\) : res\.file;[\s\S]*?stampAskIds\(cur, file\)/)
    // Every function of the store that writes goes through it (no other updateJsonFile or db write).
    expect(src.match(/updateJsonFile/g)?.length).toBe(2)
    expect(src.match(/dbMutateThreads\(/g)?.length).toBe(1)
  })
})

describe('a decision id holds the task\'s ask item only while its thread asks it in needs (N3)', () => {
  const holds = HELD_BY_THREAD.ask!
  const item = { id: D }
  it('needs and open: holds; answered, working or closed: holds nothing; the read view\'s heldAsk still holds', () => {
    expect(holds(item, { id: 't', title: 'x', askId: D, state: 'needs' })).toBe(true)
    for (const state of ['answered', 'working', 'pending']) expect(holds(item, { id: 't', title: 'x', askId: D, state }), state).toBe(false)
    expect(holds(item, { id: 't', title: 'x', askId: D, state: 'needs', closed: { how: 'acked' } })).toBe(false)
    expect(holds(item, { id: 't', title: 'x', heldAsk: { id: D }, state: 'answered' })).toBe(true)
  })
})

