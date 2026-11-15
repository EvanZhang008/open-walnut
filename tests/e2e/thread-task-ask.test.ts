/**
 * A thread whose decision a task already asks him reads as a pointer to that task through the real
 * route (src/web/routes/org-threads-v1.ts, src/core/org/thread-task-ask.ts): `pending` with
 * `askedIn`, out of `shown` and `shown_count`, the stored file still needs; the node names the owner
 * with `ask_owner` (stored with the task's decision id), and the thread is his own ask again once
 * that task stops asking it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-task-ask'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const PROJECT = 'Juniper'
const ASK = 'Approve the Talos node image design review'
let base = ''
let lead = ''
let owner = ''
let idle = ''

const T0 = Date.now()
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString()

function thread(id: string, over: Partial<OrgThread>): OrgThread {
  return {
    id, title: 'Talos review', titled: true, state: 'needs',
    messages: [{ id: `tm-${id.slice(3)}01`, at: iso(90), text: 'Where is the Talos review?', via: 'chat' }],
    createdAt: iso(90), updatedAt: iso(60), by: `task:${lead}`, ...over,
  } as OrgThread
}

async function asks(id: string, ask: string | null, decision = 'ask-aaaaaa'): Promise<void> {
  const at = new Date().toISOString()
  await updateTaskRaw(id, ask
    ? {
      phase: 'NEED_ACTION',
      status_report: { state: 'needs', ask, ask_id: decision, ask_own: { kind: 'user_own', why: 'Only he signs off on this design.' }, at },
      user_status: { state: 'needs', source: 'session', ask, decision: { id: decision, key: `${decision}|` } },
    }
    : { phase: 'IN_PROGRESS', status_report: { state: 'working', now: 'Back on the image build', at }, user_status: { state: 'working' } } as never, { source: 'test' })
  // The status sync may derive it again from the report; wait until it reads as set.
  const { getTask } = await import('../../src/core/task-manager.js')
  for (let i = 0; i < 50; i++) {
    const s = (await getTask(id)).user_status
    if (ask ? s?.state === 'needs' && s.ask === ask && s.decision?.id === decision : s?.state !== 'needs') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`task ${id} status never settled: ${JSON.stringify((await getTask(id)).user_status)}`)
}

type Read = { threads: Array<OrgThread & { shown: boolean; askedIn?: { task: string; via: string } }>; shown_count: number }
const list = async (): Promise<Read> => (await fetch(`${base}/api/v1/tasks/${lead}/threads?open=1`)).json() as Promise<Read>
const patch = (id: string, body: Record<string, unknown>) => fetch(`${base}/api/v1/tasks/${lead}/threads/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeAll(async () => {
  lead = (await ensureProjectLead(PROJECT)).id
  owner = (await addTask({ title: 'Talos image review', project: PROJECT, parent_task_id: lead })).task.id
  idle = (await addTask({ title: 'Quiet task', project: PROJECT, parent_task_id: lead })).task.id
  await asks(owner, ASK)
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${lead}.json`), JSON.stringify({ version: 1, taskId: lead, threads: [
    // The summary asks what its linked task asks.
    thread('th-b00001', { tasks: [owner], reply: `Needs you: ${ASK.toLowerCase()}. The doc covers boot flow and rollback.`, replyAt: iso(60) }),
    // Another decision, linked to the same task: never hidden.
    thread('th-b00002', { title: 'Budget', tasks: [owner], ask: 'Pick the build budget for next quarter', messages: [{ id: 'tm-b0000201', at: iso(80), text: 'budget?', via: 'chat' }] }),
    // Other words, no link: only the node's ask_owner makes it a pointer.
    thread('th-b00003', { title: 'Talos', ask: 'Can you look at the Talos thing before Friday?', messages: [{ id: 'tm-b0000301', at: iso(70), text: 'talos?', via: 'chat' }] }),
  ] }))
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a thread whose decision a task asks him', () => {
  it('reads pending with askedIn, out of shown and the count, while the file keeps needs', async () => {
    const r = await list()
    const byId = new Map(r.threads.map((t) => [t.id, t]))
    expect(byId.get('th-b00001')).toMatchObject({ state: 'pending', shown: false, askedIn: { task: owner, via: 'words' } })
    expect(byId.get('th-b00002')).toMatchObject({ state: 'needs', shown: true })
    expect(byId.get('th-b00002')!.askedIn).toBeUndefined()
    expect(byId.get('th-b00003')).toMatchObject({ state: 'needs', shown: true })
    expect(r.shown_count).toBe(2)
    expect(r.threads.filter((t) => t.shown).length).toBe(r.shown_count)
    const { readStatusFacts } = await import('../../src/core/user-status-sync.js')
    const { getTask } = await import('../../src/core/task-manager.js')
    const facts = await readStatusFacts([await getTask(lead)])
    expect(facts.threads?.get(lead)?.needs).toBe(2)
    const stored = (await readThreads(lead)).threads.find((t) => t.id === 'th-b00001')!
    expect(stored.state).toBe('needs')
    expect((stored as { askedIn?: unknown }).askedIn).toBeUndefined()
    // One thread read the same way.
    const one = (await (await fetch(`${base}/api/v1/tasks/${lead}/threads/th-b00001`)).json()) as { thread: Read['threads'][number] }
    expect(one.thread).toMatchObject({ state: 'pending', shown: false, askedIn: { task: owner } })
  })

  it('ask_owner names the task: stored with its decision, linked, and the reply is the pointer read', async () => {
    const res = await patch('th-b00003', { ask_owner: owner })
    expect(res.status).toBe(200)
    const { thread } = (await res.json()) as { thread: Read['threads'][number] }
    expect(thread).toMatchObject({ state: 'pending', askedIn: { task: owner, via: 'owner' } })
    const stored = (await readThreads(lead)).threads.find((t) => t.id === 'th-b00003')!
    expect(stored.state).toBe('needs')
    expect(stored.askOwner).toMatchObject({ task: owner, decision: 'ask-aaaaaa', ask: ASK })
    expect(stored.tasks).toContain(owner)
    expect((await list()).shown_count).toBe(1)
  })

  it('refuses an owner that asks him nothing, and "" takes the owner off', async () => {
    const bad = await patch('th-b00002', { ask_owner: idle })
    expect(bad.status).toBe(409)
    expect((await readThreads(lead)).threads.find((t) => t.id === 'th-b00002')!.askOwner).toBeUndefined()
    const outsider = (await addTask({ title: 'Unrelated review', project: 'Maple' })).task.id
    await asks(outsider, ASK)
    const outside = await patch('th-b00002', { ask_owner: outsider })
    expect(outside.status).toBe(409)
    expect((await readThreads(lead)).threads.find((t) => t.id === 'th-b00002')!.askOwner).toBeUndefined()
    const off = await patch('th-b00003', { ask_owner: '' })
    expect(off.status).toBe(200)
    expect((await readThreads(lead)).threads.find((t) => t.id === 'th-b00003')!.askOwner).toBeUndefined()
    expect((await list()).threads.find((t) => t.id === 'th-b00003')).toMatchObject({ state: 'needs', shown: true })
    await patch('th-b00003', { ask_owner: owner })
  })

  it('a new decision there, then no ask at all: every pointer is his own ask again, conversation kept', async () => {
    await asks(owner, ASK, 'ask-bbbbbb')
    let r = await list()
    // The words still match, the named decision does not: the owner pointer drops, the word pointer holds.
    expect(r.threads.find((t) => t.id === 'th-b00003')).toMatchObject({ state: 'needs', shown: true })
    expect(r.threads.find((t) => t.id === 'th-b00001')).toMatchObject({ state: 'pending' })
    await asks(owner, null)
    r = await list()
    for (const id of ['th-b00001', 'th-b00002', 'th-b00003']) expect(r.threads.find((t) => t.id === id), id).toMatchObject({ state: 'needs', shown: true })
    expect(r.shown_count).toBe(3)
    expect(r.threads.find((t) => t.id === 'th-b00001')!.messages.map((m) => m.id)).toEqual(['tm-b0000101'])
  })

  it('answered there for him: the owner\'s thread stays a quiet pointer marked answered, never his needs again', async () => {
    await asks(owner, ASK, 'ask-cccccc')
    expect((await patch('th-b00003', { ask_owner: owner })).status).toBe(200)
    const { askKey } = await import('../../src/core/same-ask.js')
    await updateTaskRaw(owner, { ask_answered: { key: askKey(ASK), ask: ASK, text: 'Approved for him.', by: lead, byTitle: 'Lead', at: new Date().toISOString(), askId: 'ask-cccccc' } } as never, { source: 'test' })
    await asks(owner, null)
    const r = await list()
    expect(r.threads.find((t) => t.id === 'th-b00003')).toMatchObject({ state: 'pending', shown: false, askedIn: { task: owner, via: 'owner', answered: true } })
  })

  it('he answered in the task himself (his message after its last ask): quiet, never his needs again; nothing from him: back', async () => {
    const other = (await addTask({ title: 'Talos rollout plan', project: PROJECT, parent_task_id: lead })).task.id
    const ROLL = 'Approve the Talos rollout plan for the image cache'
    await asks(other, ROLL, 'ask-eeeeee')
    const dir = path.join(WALNUT_HOME, 'org', 'threads')
    const file = JSON.parse(await fs.readFile(path.join(dir, `${lead}.json`), 'utf8')) as { threads: OrgThread[] }
    file.threads.push(thread('th-b00004', { title: 'Rollout', ask: ROLL, tasks: [other], messages: [{ id: 'tm-b0000401', at: iso(60), text: 'rollout?', via: 'chat' }] }))
    await fs.writeFile(path.join(dir, `${lead}.json`), JSON.stringify(file))
    expect((await list()).threads.find((t) => t.id === 'th-b00004')).toMatchObject({ state: 'pending', askedIn: { task: other, via: 'words' } })
    // Its turn ran on his answer: the report remembers the decision it asked, and asks nothing now.
    const askedAt = new Date(Date.now() - 60_000).toISOString()
    const { getTask } = await import('../../src/core/task-manager.js')
    await updateTaskRaw(other, {
      phase: 'IN_PROGRESS', user_status: { state: 'working' },
      status_report: { state: 'working', now: 'Rolling out', at: new Date().toISOString(), last_ask: { id: 'ask-eeeeee', ask: ROLL, at: askedAt } },
    } as never, { source: 'test' })
    for (let i = 0; i < 50 && (await getTask(other)).user_status?.state === 'needs'; i++) await new Promise((r) => setTimeout(r, 100))
    // No word of his: the thread asks again.
    expect((await list()).threads.find((t) => t.id === 'th-b00004')).toMatchObject({ state: 'needs', shown: true })
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const sid = 'eeeeeeee-1111-4aaa-8bbb-cccccccccccc'
    await createSessionRecord(sid, other, PROJECT, WALNUT_HOME)
    await updateSessionRecord(sid, { humanInputAt: new Date(Date.now() - 30_000).toISOString() } as never)
    expect((await list()).threads.find((t) => t.id === 'th-b00004')).toMatchObject({ state: 'pending', shown: false, askedIn: { task: other, via: 'words', answered: true } })
    await updateTaskRaw(other, { phase: 'COMPLETE', status: 'done', user_status: { state: 'done' } }, { source: 'test' })
    expect((await list()).threads.find((t) => t.id === 'th-b00004')).toMatchObject({ state: 'pending', shown: false, askedIn: { task: other, answered: true } })
  })

  it('a write that changes what the thread asks drops the named owner', async () => {
    await asks(owner, ASK, 'ask-dddddd')
    expect((await patch('th-b00002', { ask_owner: owner })).status).toBe(200)
    expect((await readThreads(lead)).threads.find((t) => t.id === 'th-b00002')!.askOwner?.task).toBe(owner)
    expect((await patch('th-b00002', { ask: 'Pick the build budget for the next two quarters' })).status).toBe(200)
    expect((await readThreads(lead)).threads.find((t) => t.id === 'th-b00002')!.askOwner?.task).toBe(owner)
    expect((await patch('th-b00002', { ask: 'Roll back the Talos node image' })).status).toBe(200)
    expect((await readThreads(lead)).threads.find((t) => t.id === 'th-b00002')!.askOwner).toBeUndefined()
    expect((await list()).threads.find((t) => t.id === 'th-b00002')).toMatchObject({ state: 'needs', shown: true })
  })
})
