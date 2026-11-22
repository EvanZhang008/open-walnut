/**
 * A session closing its OWN task after it shipped a change (a land, a deploy, a publish) is
 * refused until it names what real use should show (usage_watch set) or why nothing can (an
 * exemption), through every route a session can close by (src/core/usage-watch/gate.ts, called by
 * admitSessionClose in src/core/sessions/owed-to-user.ts). Another task closing it (its lead), a
 * person, a task that shipped nothing, and the experiment switched off are never held.
 * Only the Claude CLI is absent; session records and the ship are written directly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ship-watch-close'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { recordShip } from '../../src/core/usage-watch/ships.js'
import type { Task } from '../../src/core/types.js'

let server: HttpServer
let base: string
let n = 0

const json = (method: string, url: string, body: unknown, sid?: string) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
  body: JSON.stringify(body),
})

type Route = { name: string; close: (t: Task, sid?: string) => Promise<Response> }
const ROUTES: Route[] = [
  { name: 'v1 POST complete', close: (t, sid) => json('POST', `/api/v1/tasks/${t.id}/complete`, { result: 'Shipped the fix.' }, sid) },
  { name: 'v1 PATCH phase', close: (t, sid) => json('PATCH', `/api/v1/tasks/${t.id}`, { phase: 'COMPLETE' }, sid) },
  { name: 'v1 batch phase', close: (t, sid) => json('POST', '/api/v1/tasks/batch/phase', { task_ids: [t.id], phase: 'COMPLETE' }, sid) },
  { name: 'PATCH phase', close: (t, sid) => json('PATCH', `/api/tasks/${t.id}`, { phase: 'COMPLETE' }, sid) },
  { name: 'POST complete', close: (t, sid) => json('POST', `/api/tasks/${t.id}/complete`, { result: 'Shipped the fix.' }, sid) },
  { name: 'toggle complete', close: (t, sid) => json('POST', `/api/tasks/${t.id}/toggle-complete`, {}, sid) },
]

async function withSession(title: string, shipped: boolean): Promise<{ task: Task; sid: string }> {
  const task = (await addTask({ title: `${title} ${++n}`, project: 'Ships' })).task
  const sid = `sess-ship-${n}`
  await createSessionRecord(sid, task.id, 'Ships')
  await updateSessionRecord(sid, { process_status: 'idle' })
  await updateTaskRaw(task.id, { session_id: sid } as never, { emitEvent: true })
  await updateTask(task.id, { phase: 'IN_PROGRESS' })
  if (shipped) recordShip({ taskId: task.id, key: `tu-${n}`, at: Date.now() - 60_000, how: 'walnut-dev land', state: 'done' })
  return { task: await getTask(task.id), sid }
}

async function setFlag(on: boolean | null): Promise<void> {
  const res = await json('PUT', '/api/config', { experimental: { real_use_watch: on } })
  expect(res.status, await res.clone().text()).toBe(200)
}

async function expectRefused(route: Route, res: Response): Promise<void> {
  const text = await res.text()
  if (route.name.includes('batch')) {
    const body = JSON.parse(text) as { failed?: { error: string }[] }
    expect(body.failed?.[0]?.error ?? '', text).toMatch(/^no_real_use_watch:/)
  } else {
    expect(res.status, text).toBe(409)
    expect(text).toContain('no_real_use_watch')
    expect(text).toContain('usage_watch {\\"action\\":\\"set\\"')
  }
}

async function expectClosed(res: Response, id: string): Promise<void> {
  const text = await res.text()
  expect(res.status, text).toBe(200)
  expect((JSON.parse(text) as { failed?: unknown[] }).failed ?? [], text).toEqual([])
  expect((await getTask(id)).phase).toBe('COMPLETE')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`
  await setFlag(true)
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('its own session closing a task that shipped', () => {
  for (const route of ROUTES) {
    it(`${route.name}: refused until it names a watch; then the close goes through`, async () => {
      const { task, sid } = await withSession('Worker', true)
      await expectRefused(route, await route.close(task, sid))
      expect((await getTask(task.id)).phase).not.toBe('COMPLETE')
      const set = await json('POST', '/api/v1/usage-watch', { action: 'set', targets: ['op:thread_update'], check_after: '24h' }, sid)
      expect(set.status, await set.clone().text()).toBe(200)
      await expectClosed(await route.close(await getTask(task.id), sid), task.id)
    }, 60_000)
  }

  it('an exemption with its reason lets it close; a forced close without one does not', async () => {
    const { task, sid } = await withSession('Copy', true)
    const forced = await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Shipped.', force: true, reason: 'Only labels changed, nothing to watch here at all.' }, sid)
    expect(forced.status, await forced.clone().text()).toBe(409)
    const ex = await json('POST', '/api/v1/usage-watch', { action: 'exempt', kind: 'copy', reason: 'Only two button labels changed, no behaviour.' }, sid)
    expect(ex.status, await ex.clone().text()).toBe(200)
    await expectClosed(await json('POST', `/api/v1/tasks/${task.id}/complete`, { result: 'Shipped.' }, sid), task.id)
  }, 60_000)

  it('another task (its lead) closing it, or a person, is not held', async () => {
    const lead = await withSession('Lead', false)
    const a = await withSession('Worker', true)
    await expectClosed(await json('POST', `/api/v1/tasks/${a.task.id}/complete`, { result: 'Closed by its lead.' }, lead.sid), a.task.id)
    const b = await withSession('Worker', true)
    await expectClosed(await json('POST', `/api/v1/tasks/${b.task.id}/complete`, { result: 'Closed by the user.' }), b.task.id)
  }, 60_000)

  it('another task cannot arm or exempt a task it does not lead', async () => {
    const other = await withSession('Other', false)
    const a = await withSession('Worker', true)
    const res = await json('POST', '/api/v1/usage-watch', { action: 'exempt', task: a.task.id, kind: 'copy', reason: 'Only two button labels changed, no behaviour.' }, other.sid)
    expect(res.status, await res.clone().text()).toBe(403)
    await expectRefused(ROUTES[0]!, await ROUTES[0]!.close(a.task, a.sid))
  }, 60_000)

  it('a task that shipped nothing, or with the experiment off, closes as before', async () => {
    const none = await withSession('Reader', false)
    await expectClosed(await json('POST', `/api/v1/tasks/${none.task.id}/complete`, { result: 'Read the code.' }, none.sid), none.task.id)
    await setFlag(null)
    try {
      const off = await withSession('Worker', true)
      await expectClosed(await json('POST', `/api/v1/tasks/${off.task.id}/complete`, { result: 'Shipped.' }, off.sid), off.task.id)
    } finally { await setFlag(true) }
  }, 60_000)
})
