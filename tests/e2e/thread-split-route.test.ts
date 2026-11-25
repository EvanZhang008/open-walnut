/**
 * POST /api/v1/tasks/:id/threads/:thread/split with its two options (src/web/routes/org-threads-v1.ts):
 * a split into a new thread answers 201, one straight into another open thread (`merge_into`)
 * answers 200 with `merged_into`; a bad merge_into or keep_open is a 400, a target that is not
 * there a 404, and a refused merge leaves the node's threads as they were. The thread_split op
 * titles the new thread in the same call (2026-11-24: a split with a title was refused bad_args).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-split-route'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { executeOp } from '../../src/ops/index.js'

let base = ''
let leadId = ''

async function file(text: string, thread?: string): Promise<{ thread: OrgThread; message: { id: string } }> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(thread ? { thread } : {}) }),
  })
  expect(res.status).toBeLessThan(300)
  return await res.json() as { thread: OrgThread; message: { id: string } }
}

async function split(thread: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/tasks/${leadId}/threads/${thread}/split`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

async function threads(): Promise<OrgThread[]> {
  const res = await fetch(`${base}/api/v1/tasks/${leadId}/threads`)
  return ((await res.json()) as { threads: OrgThread[] }).threads
}

/** What the node keeps, without the parts a read projects anew each time. */
const kept = async () => JSON.stringify((await threads()).map((t) => ({ id: t.id, state: t.state, closed: t.closed, messages: t.messages.map((m) => m.id) })))

beforeAll(async () => {
  // Separate messages make separate threads here (the join window is its own case elsewhere).
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  process.env.WALNUT_THREAD_REOPEN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  leadId = (await ensureProjectLead('Garden')).id
})

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  delete process.env.WALNUT_THREAD_REOPEN_SECS
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the split route', () => {
  it('201 into a new thread; 200 straight into another open thread, with merged_into', async () => {
    const a = await file('Order the seed trays')
    const second = await file('and the potting soil', a.thread.id)
    const third = await file('and the watering cans', a.thread.id)
    const b = await file('Book the soil delivery')

    const fresh = await split(a.thread.id, { message: third.message.id, keep_open: true })
    expect(fresh.status).toBe(201)
    const made = await fresh.json() as { thread: OrgThread; from: OrgThread; merged_into?: string }
    expect(made.thread.id).not.toBe(a.thread.id)
    expect(made.thread.messages.map((m) => m.id)).toEqual([third.message.id])
    expect(made.merged_into).toBeUndefined()

    const into = await split(a.thread.id, { message: second.message.id, merge_into: b.thread.id })
    expect(into.status).toBe(200)
    const merged = await into.json() as { thread: OrgThread; from: OrgThread; merged_into?: string }
    expect(merged.merged_into).toBe(b.thread.id)
    expect(merged.thread.id).toBe(b.thread.id)
    expect(merged.thread.messages.map((m) => m.id)).toContain(second.message.id)
    expect(merged.from.messages.map((m) => m.id)).toEqual([a.message.id])
    const list = await threads()
    expect(list.find((t) => t.id === b.thread.id)!.messages.map((m) => m.id)).toContain(second.message.id)
    // No thread was left over from the move.
    expect(list.map((t) => t.id).sort()).toEqual([a.thread.id, b.thread.id, made.thread.id].sort())
  })

  it('400 for a bad merge_into or keep_open, 404 for a target that is not there, and nothing written', async () => {
    const a = await file('Prune the apple trees')
    const second = await file('and the pears', a.thread.id)
    const before = await kept()
    expect((await split(a.thread.id, { message: second.message.id, merge_into: 'not-a-thread' })).status).toBe(400)
    expect((await split(a.thread.id, { message: second.message.id, keep_open: 'yes' })).status).toBe(400)
    const missing = await split(a.thread.id, { message: second.message.id, merge_into: 'th-ffffffffffff' })
    expect(missing.status).toBe(404)
    expect(JSON.stringify(await missing.json())).toContain('no_thread')
    const same = await split(a.thread.id, { message: second.message.id, merge_into: a.thread.id })
    expect(same.status).toBe(400)
    expect(await kept()).toBe(before)
  })
})

describe('the thread_split op on this server', () => {
  const op = async (args: Record<string, unknown>) => {
    const out = await executeOp('thread_split', { ...args, task: leadId }, { apiBase: base, origin: '__local__', callerMode: 'human' })
    if (!out.ok) throw new Error(out.message)
    return out.result as { thread: OrgThread; next: string; not_applied?: string[] }
  }

  it('a title names the new thread in the same call; with merge_into the thread it joins keeps its own', async () => {
    const a = await file('Repot the basil')
    const second = await file('and the mint', a.thread.id)
    const third = await file('and the rosemary', a.thread.id)
    const made = await op({ id: a.thread.id, message: second.message.id, title: 'Mint pots', keep_open: true })
    expect(made.thread).toMatchObject({ title: 'Mint pots', titled: true })
    expect(made.not_applied).toBeUndefined()
    expect(made.next).not.toContain('Give it a title')
    const stored = (await threads()).find((t) => t.id === made.thread.id)!
    expect(stored).toMatchObject({ title: 'Mint pots', messages: [expect.objectContaining({ id: second.message.id })] })

    const into = await op({ id: a.thread.id, message: third.message.id, merge_into: made.thread.id, title: 'Herb pots' })
    expect(into.not_applied).toEqual(['title'])
    expect((await threads()).find((t) => t.id === made.thread.id)).toMatchObject({ title: 'Mint pots' })
  })
})
