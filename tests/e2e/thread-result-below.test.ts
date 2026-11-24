/**
 * A task's result on the subject he asked his lead about is listed on the lead (2026-11-24, the
 * threads inspection, item 4: his VP held cards naming six tasks below it, and 21 unread results on
 * those tasks never reached the VP where he had asked, since only Needs you popped up).
 *
 *   Orchard VP (his request, handed to the task, in progress) ─ "Panel flash fix" (its own card: the result)
 *
 * With threads_pop_up on, the task's result is listed on the VP's Threads as the task's own record
 * (`owner`, `carries`: GET .../threads `shown`, `counted`, `shown_count`, and the VP's
 * `user_status.threads`), and the VP's card waits behind it (`askedIn` result). His Acknowledge on
 * the VP's list closes it on the task, and nothing of the subject is left for him. A VP card on
 * another subject naming the same task is untouched.
 *
 * What's real: server, task store, threads store, status sync. Mocked: constants, the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-result-below'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { nodeView, openNodeThread, patchThread, readThreads } from '../../src/core/org/threads-store.js'
import { listedForHim } from '../../src/core/org/thread-view.js'
import { threadsPopUpNow } from '../../src/core/org/thread-popup.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let server: Server
let port: number
const ids = { main: '', vp: '', fix: '', his: '', other: '', result: '' }

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

type Listed = OrgThread & { owner?: { task_id: string }; carries?: string; shown?: boolean; counted?: boolean; askedIn?: { task: string; via: string; thread?: string; result?: true } }

/** What the VP's surfaces read for him now. */
async function vpReads() {
  await settleUserStatusSync()
  await syncUserStatuses(new Set([ids.main, ids.vp, ids.fix]))
  const read = await api<{ threads: Listed[]; shown_count: number }>('GET', `/tasks/${ids.vp}/threads`)
  expect(read.status).toBe(200)
  const list = read.json.threads
  const status = (await api<{ task: { user_status?: { threads?: { shown: number; needs: number; below?: number } } } }>('GET', `/api/tasks/${ids.vp}`)).json.task.user_status?.threads
  return {
    inSight: list.filter((t) => t.counted).map((t) => t.id).sort(),
    web: listedForHim(list).map((t) => t.id).sort(),
    result: list.find((t) => t.id === ids.result),
    his: list.find((t) => t.id === ids.his),
    other: list.find((t) => t.id === ids.other),
    header: read.json.shown_count,
    badge: status,
  }
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  expect((await api('PUT', '/api/config', { experimental: { threads_pop_up: true, threads_one_card: true, brief_off: true } })).status).toBe(200)
  await vi.waitFor(() => expect(threadsPopUpNow()).toBe(true), { timeout: 5000 })
  ids.main = (await ensureMainTask()).id
  ids.vp = (await ensureProjectLead('Orchard')).id
  ids.fix = (await addTask({ title: 'Panel flash fix', project: 'Orchard', parent_task_id: ids.vp })).task.id
  await updateTaskRaw(ids.fix, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  // His request to the VP, handed to the task, then set aside while the task works: out of his sight.
  const request = async (title: string, reply: string) => {
    const id = (await openNodeThread(ids.vp, { title, text: reply, reply, from: 'node', state: 'answered', tasks: [ids.fix] }, `task:${ids.vp}`)).id
    await patchThread(ids.vp, id, { state: 'pending' }, `task:${ids.vp}`)
    return id
  }
  ids.his = await request('Threads panel flashes when opened on the lead page', 'The flash comes from the list sorting again while it opens.')
  // Another request of his handed to the same task.
  ids.other = await request('Spring seed budget for the orchard rows', 'Forty trays cover the east rows this spring.')
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_THREAD_FOLLOW
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('the task\'s result on the subject he asked the VP about', () => {
  it('before the result: nothing of the subject is in his sight on the VP', async () => {
    const r = await vpReads()
    expect(r.inSight).toEqual([])
    expect(r.his).toMatchObject({ state: 'pending' })
    expect(r.his?.askedIn).toBeUndefined()
  })

  it('once in, the result is listed on the VP as the task\'s own record, and the VP\'s card waits behind it', async () => {
    await new Promise((x) => setTimeout(x, 5))
    ids.result = (await openNodeThread(ids.fix, {
      title: 'Threads panel flash when opened: fixed and live', text: 'Working on the flash.', from: 'node', state: 'answered',
      reply: 'The panel keeps its place while it opens; it is live. Video: /tmp/panel/flash.mp4',
    }, `task:${ids.fix}`)).id
    const r = await vpReads()
    expect(r.inSight).toEqual([ids.result])
    expect(r.web).toEqual([ids.result])
    expect(r.result).toMatchObject({ owner: { task_id: ids.fix }, carries: ids.his, state: 'answered', shown: true, counted: true })
    expect(r.his).toMatchObject({ state: 'pending', askedIn: { task: ids.fix, via: 'thread', thread: ids.result, result: true } })
    // The VP's card on another subject is as stored.
    expect(r.other).toMatchObject({ state: 'pending' })
    expect(r.other?.askedIn).toBeUndefined()
    expect(r.header).toBe(1)
    expect(r.badge).toMatchObject({ shown: 1, needs: 0, below: 1 })
    // The task's own Threads list it as before: one record, two viewers.
    const own = (await api<{ threads: Listed[] }>('GET', `/tasks/${ids.fix}/threads`)).json.threads.find((t) => t.id === ids.result)
    expect(own).toMatchObject({ shown: true, counted: true })
    expect(own?.owner).toBeUndefined()
  })

  it('every other read of the VP agrees: its Board card, a change made from its list, and a needs-only reader skips the read', async () => {
    // The VP's Board card reads the result to read, not "waiting" behind it (brief_off).
    const states = await api<{ on: boolean; states: Record<string, { state: string; id: string }> }>('GET', `/thread-states?ids=${ids.vp}`)
    expect(states.json.states[ids.vp]).toMatchObject({ state: 'read', id: ids.result })
    // A change from the VP's list answers the card as the list draws it: still carried, its Acknowledge kept.
    const watched = await api<{ thread: Listed }>('PATCH', `/tasks/${ids.vp}/threads/${ids.result}`, { watch: true })
    expect(watched.status).toBe(200)
    expect(watched.json.thread).toMatchObject({ id: ids.result, owner: { task_id: ids.fix }, carries: ids.his })
    // A reader of the VP's needs alone reads no task below for it.
    const own = (await readThreads(ids.vp)).threads
    expect((await nodeView(ids.vp, own, undefined, { carry: false })).carried).toEqual([])
    expect((await nodeView(ids.vp, own)).carried.map((c) => c.thread.id)).toEqual([ids.result])
  })

  it('his Acknowledge on the VP\'s list closes it on the task, and nothing of the subject is left for him', async () => {
    // Most results come as their task completes: the record is found on the task the VP's card names.
    await updateTaskRaw(ids.fix, { phase: 'COMPLETE', status: 'done' } as never, { emitEvent: true })
    expect((await vpReads()).inSight).toEqual([ids.result])
    const ack = await api<{ thread: Listed }>('PATCH', `/tasks/${ids.vp}/threads/${ids.result}`, { close: 'acked' })
    expect(ack.status).toBe(200)
    const stored = (await readThreads(ids.fix)).threads.find((t) => t.id === ids.result)
    expect(stored?.closed ?? stored?.known).toMatchObject({ by: 'human' })
    expect((await readThreads(ids.vp)).threads.find((t) => t.id === ids.result)).toBeUndefined()
    const r = await vpReads()
    expect(r.inSight).toEqual([])
    expect(r.result).toBeUndefined()
    expect(r.header).toBe(0)
    expect(r.badge?.shown ?? 0).toBe(0)
  })
})
