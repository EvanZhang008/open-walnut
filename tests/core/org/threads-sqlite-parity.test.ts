/**
 * The experiment threads_sqlite changes where Threads are kept, never what the store does: the same
 * sequence of every public threads-store.ts function, run once on the JSON files and once on the
 * database (the same clock; ids compared by their order of appearance), answers the same and reads the same after every step, and the
 * database's file written back reads as the JSON run's file. Then 20 writers of one node at once
 * keep all 20 changes on either.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-threads-sqlite-parity'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, useThreadsDb } from '../../../src/core/org/threads-backend.js'
import { _setThreadsExportEveryForTesting, flushThreadsExports, parseThreadsText } from '../../../src/core/org/threads-sync.js'
import * as store from '../../../src/core/org/threads-store.js'

const NODE = 'node-parity'
const OTHER = 'node-parity-b'
const T0 = Date.parse('2026-11-20T08:00:00.000Z')
/** Thread and message ids named by their order of first appearance, so two runs compare. */
function canonical(value: unknown): string {
  const names = new Map<string, string>()
  return JSON.stringify(value).replace(/\b(th|tm)-[a-f0-9]{6,32}\b/g, (id, kind: string) => {
    if (!names.has(id)) names.set(id, `${kind}-${names.size + 1}`)
    return names.get(id)!
  })
}

async function settle<T>(p: Promise<T>): Promise<unknown> {
  try { return await p } catch (err) { return { error: err instanceof Error ? err.message : String(err) } }
}

/** Every public store function, in a sequence a node's day could hold; each step's answer and both nodes' reads. */
async function scenario(): Promise<unknown[]> {
  const steps: unknown[] = []
  let minute = 0
  const now = () => new Date(T0 + minute * 60_000).toISOString()
  const step = async (name: string, run: () => Promise<unknown>) => {
    minute += 1
    vi.setSystemTime(T0 + minute * 60_000)
    const out = await settle(run())
    steps.push({ name, out, node: await store.readThreads(NODE), other: await store.readThreads(OTHER) })
    return out as any
  }
  const r1 = await step('file a message', () => store.fileThreadMessage(NODE, { text: 'Order the seed trays', via: 'chat', at: now(), sid: 'sess-parity' }))
  const r2 = await step('file a second subject', () => store.fileThreadMessage(NODE, { text: 'Book the caf\u00e9 delivery \u{1F69A}', via: 'chat', at: now() }))
  const t3 = await step('the node opens a thread', () => store.openNodeThread(NODE, { title: 'Frost tonight', text: 'The forecast says -2C', from: 'node', state: 'answered' }, 'agent'))
  await step('the node answers', () => store.patchThread(NODE, r1.thread.id, { title: 'Seed trays', state: 'answered', reply: 'Ordered the 72-cell trays' }, 'agent', { sid: 'sess-parity' }))
  await step('answers read from the chat', () => store.setThreadAnswers(NODE, new Map([[r1.message.id, { text: 'Done: **72-cell**', at: now() }]])))
  const r4 = await step('a follow up', () => store.fileThreadMessage(NODE, { text: 'and the potting soil too', via: 'follow-up', threadId: r1.thread.id, at: now() }))
  await step('merge', () => store.mergeThread(NODE, r2.thread.id, r1.thread.id, 'human'))
  await step('split', () => store.splitThread(NODE, r1.thread.id, r4.message.id, 'human'))
  await step('rechecked', () => store.noteThreadsRechecked(NODE, new Map([[t3.id, { since: now(), at: now(), why: 'reply' as const }]])))
  await step('buzzed', () => store.markNeedsBuzzed(NODE, t3.id, now()))
  await step('he closes one', () => store.patchThread(NODE, r1.thread.id, { close: 'acked' }, 'human'))
  await step('closes told', () => store.noteClosesTold(NODE, [r1.thread.id]))
  await step('move', () => store.moveThread({ from: { task: NODE, title: 'Parity' }, to: { task: OTHER, title: 'Parity B' }, threadId: t3.id, by: 'human', kind: 'hand', owners: OTHER }))
  await step('a write to the moved thread', () => store.patchThread(NODE, t3.id, { title: 'Too late' }, 'human'))
  await step('the moved copy gets an answer', () => store.patchThread(OTHER, t3.id, { reply: 'Covered the beds', state: 'answered' }, 'agent'))
  await step('his message into a moved thread goes where it lives', () => store.fileThreadMessage(NODE, { text: 'cover the seedlings too', via: 'follow-up', threadId: t3.id, at: now() }))
  await step('reopen', () => store.patchThread(NODE, r1.thread.id, { reopen: true }, 'human'))
  await step('an unknown thread', () => store.patchThread(NODE, 'th-ffffffffffff', { title: 'x' }, 'human'))
  await step('a bad node id', () => store.readThreads('../etc'))
  await step('where it lives', () => store.threadHolder(NODE, t3.id))
  await step('the sweep a week later', () => store.sweepClosedThreads(T0 + 9 * 24 * 3600_000))
  await step('nodes', async () => ({ list: (await store.listThreadNodes()).sort(), ids: (await store.threadTaskIds()).sort() }))
  return steps
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  _setThreadsExportEveryForTesting(undefined)
})

afterAll(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const fileText = (node: string) => fs.readFileSync(path.join(WALNUT_HOME, 'org', 'threads', `${node}.json`), 'utf8')

describe('the same store on both backends', () => {
  it('every public function answers and reads the same, and the file written back reads as the JSON run\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    _resetThreadsBackendForTesting(false)
    const json = await scenario()
    const jsonFiles = { node: parseThreadsText(fileText(NODE), NODE), other: parseThreadsText(fileText(OTHER), OTHER) }
    closeThreadsDb()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    const db = await scenario()

    expect(db.length).toBe(json.length)
    // One id map over the whole run: the same id at every step stays the same name.
    expect(canonical(db)).toBe(canonical(json))
    for (let i = 0; i < json.length; i++) expect(canonical(db.slice(0, i + 1)), (json[i] as { name: string }).name).toBe(canonical(json.slice(0, i + 1)))
    await flushThreadsExports()
    expect(canonical([db, parseThreadsText(fileText(NODE), NODE), parseThreadsText(fileText(OTHER), OTHER)])).toBe(canonical([json, jsonFiles.node, jsonFiles.other]))
  })
})

describe.each([['the JSON files', false], ['the database', true]] as const)('20 writers at once on %s', (_name, onDb) => {
  it('keep all 20 changes on two threads of one node', async () => {
    _resetThreadsBackendForTesting(onDb)
    _setThreadsExportEveryForTesting(0)
    expect(await useThreadsDb()).toBe(onDb)
    const a = await store.fileThreadMessage(NODE, { text: 'Plant the beans', via: 'chat', at: new Date().toISOString() })
    const b = await store.fileThreadMessage(NODE, { text: 'Prune the apple trees', via: 'chat', at: new Date().toISOString() })
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.patchThread(NODE, i % 2 ? b.thread.id : a.thread.id, { add_tasks: [`task-${i}`] }, 'human')))
    const read = await store.readThreads(NODE)
    const tasksOf = (id: string) => [...(read.threads.find((t) => t.id === id)?.tasks ?? [])].sort()
    expect(tasksOf(a.thread.id)).toEqual(Array.from({ length: 10 }, (_, k) => `task-${k * 2}`).sort())
    expect(tasksOf(b.thread.id)).toEqual(Array.from({ length: 10 }, (_, k) => `task-${k * 2 + 1}`).sort())
    if (onDb) {
      await flushThreadsExports()
      expect(parseThreadsText(fileText(NODE), NODE)).toEqual(read)
    }
  })
})
