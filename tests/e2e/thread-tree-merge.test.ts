/**
 * Threads of one task tree join, on a real server (2026-11-23, the user's real data: a task with
 * Threads on, under a VP, with subtasks that keep their own Threads, had several threads about one
 * issue and its agent could not join them):
 *
 *   1. merge_into a thread on a task below or above the caller's (src/core/org/thread-tree-merge.ts):
 *      the caller's thread moves to the task holding the target and is merged there; a thread
 *      outside the tree is still refused, saying why; a merge the target would refuse moves nothing;
 *   2. thread_move to a task that keeps its own Threads lands on that task, not on its VP
 *      (thread-follow.ts moveTargetOf), and moving it back works; a task without Threads still
 *      sends it to its team's node;
 *   3. ask_owner from a task with Threads on names one of its own subtasks (threads-store.ts patchThread).
 *
 * What's real: server, task store, threads store, the routes. Mocked: constants. No session runs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-tree-merge'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { fileThreadMessage, readThreads } from '../../src/core/org/threads-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const PROJECT = 'Juniper'
let base = ''
let lead = ''
let parent = ''
let child = ''
let plain = ''
let outsider = ''

const T0 = Date.now()
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString()

/** One of his asks as a stored thread (id th-<hex>, its message tm-<same hex>01). */
function asked(id: string, text: string, over: Partial<OrgThread> = {}): OrgThread {
  return {
    id, title: text, titled: true, state: 'working',
    messages: [{ id: `tm-${id.slice(3)}01`, at: iso(90), text, via: 'chat' }],
    createdAt: iso(90), updatedAt: iso(60), ...over,
  } as OrgThread
}

async function writeThreads(taskId: string, threads: OrgThread[]): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, threads }))
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

const stored = async (taskId: string, id: string) => (await readThreads(taskId)).threads.find((t) => t.id === id)

beforeAll(async () => {
  lead = (await ensureProjectLead(PROJECT)).id
  const maple = (await ensureProjectLead('Maple')).id
  parent = (await addTask({ title: 'Launch review', project: PROJECT, parent_task_id: lead })).task.id
  child = (await addTask({ title: 'Image build', project: PROJECT, parent_task_id: parent })).task.id
  plain = (await addTask({ title: 'Docs pass', project: PROJECT, parent_task_id: parent })).task.id
  outsider = (await addTask({ title: 'Maple review', project: 'Maple', parent_task_id: maple })).task.id
  for (const id of [parent, child, outsider]) await updateTaskRaw(id, { threads_on: true } as never, { source: 'test' })
  await writeThreads(parent, [
    asked('th-c00001', 'the image build is red again'),
    asked('th-c00002', 'why does the launch wait?'),
    asked('th-c00007', 'docs for the launch'),
    asked('th-c00009', 'can the image ship Friday?', { state: 'needs' }),
    asked('th-c0000a', 'which base image?', { state: 'needs' }),
    asked('th-c0000b', 'ship the image Friday?', { state: 'needs' }),
    asked('th-c0000c', 'is the image build fixed yet?'),
  ])
  await writeThreads(child, [
    asked('th-c00003', 'image build red on main'),
    asked('th-c00005', 'launch blocked on the image'),
    // The node's own post: his ask never goes under another thread.
    { id: 'th-c00006', title: 'Mail: the vendor asks', titled: true, state: 'answered', messages: [], opener: { text: 'The vendor asks for the image date.', at: iso(80), from: 'mail', by: `task:${child}` }, createdAt: iso(80), updatedAt: iso(80) } as OrgThread,
  ])
  await writeThreads(outsider, [asked('th-c00004', 'maple image')])
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('merge_into a thread on another task of the same tree', () => {
  it('down: the caller\'s thread moves to the subtask holding the target and is merged there', async () => {
    const r = await api<{ thread: OrgThread; merged?: string; merged_on?: { task: string } }>('PATCH', `/tasks/${parent}/threads/th-c00001`, { merge_into: 'th-c00003' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ merged: 'th-c00001', merged_on: { task: child }, thread: { id: 'th-c00003' } })
    const there = await stored(child, 'th-c00003')
    expect(there?.messages.map((m) => m.text).sort()).toEqual(['image build red on main', 'the image build is red again'])
    expect(await stored(child, 'th-c00001')).toBeUndefined()
    // The caller's copy closed as moved, pointing where it went and at the thread it joined.
    expect((await stored(parent, 'th-c00001'))?.movedTo).toMatchObject({ task: child, merged: 'th-c00003' })
    // His follow-up from a card of the old thread joins the merged one, never a new thread.
    const filed = await fileThreadMessage(parent, { text: 'any news on the build?', via: 'follow-up', threadId: 'th-c00001', at: new Date().toISOString() })
    expect(filed).toMatchObject({ node: child, thread: { id: 'th-c00003' }, created: false })
  })

  // 2026-11-27, real use: the task holding the merged thread kept the id it had been told, and
  // every write of its with that id was refused as naming no thread of its own.
  it('the old id names the merged thread on the task holding it: read, write, his follow-up, a merge', async () => {
    expect((await stored(child, 'th-c00003'))?.was).toEqual(['th-c00001'])
    const got = await api<{ thread: OrgThread }>('GET', `/tasks/${child}/threads/th-c00001`)
    expect(got.status).toBe(200)
    expect(got.json.thread.id).toBe('th-c00003')
    const put = await api<{ thread: OrgThread }>('PATCH', `/tasks/${child}/threads/th-c00001`, { title: 'Image build red' })
    expect(put.status).toBe(200)
    expect(put.json.thread).toMatchObject({ id: 'th-c00003', title: 'Image build red' })
    expect(await stored(child, 'th-c00001')).toBeUndefined()
    // His words sent to the old id on that task join the thread, never a new one.
    const filed = await fileThreadMessage(child, { text: 'is it green now?', via: 'follow-up', threadId: 'th-c00001', at: new Date().toISOString() })
    expect(filed).toMatchObject({ node: child, thread: { id: 'th-c00003' }, created: false })
    // Merging the two again is done already, and the answer names the id to write.
    const again = await api<{ error?: { code?: string; message?: string } }>('PATCH', `/tasks/${child}/threads/th-c00001`, { merge_into: 'th-c00003' })
    expect(again.status).toBe(400)
    expect(again.json.error?.code).toBe('same_thread')
    expect(again.json.error?.message).toContain('write th-c00003')
    // A merge aimed at the old id from the task above reaches the thread it is under.
    const more = await api<{ thread: OrgThread; merged_on?: { task: string } }>('PATCH', `/tasks/${parent}/threads/th-c0000c`, { merge_into: 'th-c00001' })
    expect(more.status).toBe(200)
    expect(more.json).toMatchObject({ merged_on: { task: child }, thread: { id: 'th-c00003' } })
    expect((await stored(child, 'th-c00003'))?.was).toEqual(['th-c0000c', 'th-c00001'])
    // An id nobody held is still no thread.
    expect((await api('GET', `/tasks/${child}/threads/th-c0ffee`)).status).toBe(404)
  })

  it('up: a subtask\'s thread merges into its parent\'s', async () => {
    const r = await api<{ thread: OrgThread; merged_on?: { task: string } }>('PATCH', `/tasks/${child}/threads/th-c00005`, { merge_into: 'th-c00002' })
    expect(r.status).toBe(200)
    expect(r.json.merged_on?.task).toBe(parent)
    expect((await stored(parent, 'th-c00002'))?.messages.map((m) => m.text).sort()).toEqual(['launch blocked on the image', 'why does the launch wait?'])
    expect((await stored(child, 'th-c00005'))?.movedTo?.task).toBe(parent)
  })

  it('a merge the target would refuse moves nothing', async () => {
    const r = await api<{ error?: { message?: string } }>('PATCH', `/tasks/${child}/threads/th-c00006`, { merge_into: 'th-c00007' })
    expect(r.status).toBe(409)
    expect(r.json.error?.message).toContain('{"id":"th-c00007","merge_into":"th-c00006"}')
    const kept = await stored(child, 'th-c00006')
    expect(kept?.closed).toBeUndefined()
    expect(await stored(parent, 'th-c00006')).toBeUndefined()
  })

  it('a thread outside the tree is refused, saying why', async () => {
    const r = await api<{ error?: { code?: string; message?: string } }>('PATCH', `/tasks/${parent}/threads/th-c00007`, { merge_into: 'th-c00004' })
    expect(r.status).toBe(404)
    expect(r.json.error?.code).toBe('no_thread')
    expect(r.json.error?.message).toMatch(/above or below yours/)
    expect((await stored(parent, 'th-c00007'))?.closed).toBeUndefined()
  })
})

describe('thread_move to a task that keeps its own Threads', () => {
  it('lands on that task, not its VP, and moving it back works', async () => {
    const down = await api<{ moved_to: { task: string } }>('POST', `/tasks/${parent}/threads/th-c00007/move`, { to: child })
    expect(down.status).toBe(200)
    expect(down.json.moved_to.task).toBe(child)
    expect((await stored(child, 'th-c00007'))?.closed).toBeUndefined()
    expect(await stored(lead, 'th-c00007')).toBeUndefined()
    const back = await api<{ moved_to: { task: string } }>('POST', `/tasks/${child}/threads/th-c00007/move`, { to: parent })
    expect(back.status).toBe(200)
    expect(back.json.moved_to.task).toBe(parent)
    expect((await stored(parent, 'th-c00007'))?.closed).toBeUndefined()
  })

  it('a task without Threads still sends it to its team\'s node', async () => {
    const r = await api<{ moved_to: { task: string } }>('POST', `/tasks/${parent}/threads/th-c00007/move`, { to: plain })
    expect(r.status).toBe(200)
    expect(r.json.moved_to.task).toBe(lead)
  })
})

describe('ask_owner from a task with Threads on', () => {
  async function asks(id: string, ask: string, decision: string): Promise<void> {
    const at = new Date().toISOString()
    await updateTaskRaw(id, {
      phase: 'NEED_ACTION',
      status_report: { state: 'needs', ask, ask_id: decision, ask_own: { kind: 'user_own', why: 'Only he signs off on this release.' }, at },
      user_status: { state: 'needs', source: 'session', ask, decision: { id: decision, key: `${decision}|` } },
    } as never, { source: 'test' })
    for (let i = 0; i < 50 && (await getTask(id)).user_status?.decision?.id !== decision; i++) await new Promise((r) => setTimeout(r, 100))
  }

  it('names one of its own subtasks', async () => {
    await asks(child, 'Approve shipping the image on Friday', 'ask-cccccc')
    const r = await api('PATCH', `/tasks/${parent}/threads/th-c00009`, { ask_owner: child })
    expect(r.status).toBe(200)
    expect((await stored(parent, 'th-c00009'))?.askOwner).toMatchObject({ task: child, decision: 'ask-cccccc' })
    // By a unique prefix of its id too, as task chips show it.
    expect((await api('PATCH', `/tasks/${parent}/threads/th-c0000b`, { ask_owner: child.slice(0, 12) })).status).toBe(200)
    expect((await stored(parent, 'th-c0000b'))?.askOwner?.task).toBe(child)
  })

  it('still refuses a task outside its tree', async () => {
    await asks(outsider, 'Approve the base image', 'ask-dddddd')
    const r = await api('PATCH', `/tasks/${parent}/threads/th-c0000a`, { ask_owner: outsider })
    expect(r.status).toBe(409)
    expect((await stored(parent, 'th-c0000a'))?.askOwner).toBeUndefined()
  })
})
