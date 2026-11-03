/**
 * The Org page's Watching end to end, on a real server (src/core/org/org-pins.ts, PUT / DELETE
 * /api/v1/org/pins/:taskId, op org_pin). 2026-11-02, the user: "if it watching then concideras
 * pinnedl rename this to watching ... same wathcing as regular home pannel":
 *   - the routes that pinned a task to a node now watch it, the same field Home's eye writes
 *     (Task.watched_at), with or without a node, and watching twice changes nothing
 *   - Home's own write (PATCH watched_at) and the Org route read each other's watch
 *   - every old Org pin is carried over as a watch, kept on the task for an older Walnut, and a
 *     stopped watch takes the pins off so the next boot does not watch the task again
 *   - an agent watches and stops through the op; a node no row names, a missing task and a
 *     plugin's own task are refused
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-watching'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { orgProjectNode } from '../../src/core/org/org-tree.js'
import { carryPinsToWatch } from '../../src/core/org/org-pins.js'
import { listTasks } from '../../src/core/task-manager.js'
import { executeOp } from '../../src/ops/index.js'

let server: HttpServer
let port: number

async function api<T = Record<string, any>>(method: string, p: string, body?: unknown, sid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://localhost:${port}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  void server
})

describe('Watching on the Org page', () => {
  it('watches through the old pin routes, Home\'s own field, with or without a node', async () => {
    const vp = await api('POST', '/org/projects', { name: 'Orchard', vpName: 'Fruit' })
    expect(vp.status, JSON.stringify(vp.json)).toBe(201)
    const a = (await addTask({ title: 'Prune the pear trees', project: 'Orchard' })).task
    const b = (await addTask({ title: 'Order new ladders', project: 'Orchard' })).task

    const first = await api('PUT', `/org/pins/${a.id}`, { node: 'Fruit VP' })
    expect([first.status, first.json.watched, first.json.node, first.json.changed]).toEqual([200, true, orgProjectNode('Orchard'), true])
    expect(first.json.task.watched_at).toBeTruthy()
    expect((await getTask(a.id)).watched_at).toBe(first.json.task.watched_at)
    // Watching twice, or under another node, changes nothing: one list.
    expect((await api('PUT', `/org/pins/${a.id}`, { node: 'CEO' })).json.changed).toBe(false)
    // No node at all: the task shows under its own work's VP.
    const nodeless = await api('PUT', `/org/pins/${b.id}`, {})
    expect([nodeless.status, nodeless.json.node, nodeless.json.changed]).toEqual([200, 'project:orchard', true])
    expect((await getTask(a.id)).org_pins).toBeUndefined()

    // Home's eye writes the same field: the Org route sees it, and the other way round.
    await api('PATCH', `/tasks/${a.id}`, { watched_at: '' })
    expect((await getTask(a.id)).watched_at).toBeUndefined()
    expect((await api('DELETE', `/org/pins/${a.id}`)).json.changed).toBe(false)
    const off = await api('DELETE', `/org/pins/${b.id}?node=main`)
    expect([off.status, off.json.watched, off.json.changed]).toEqual([200, false, true])
    expect((await getTask(b.id)).watched_at).toBeUndefined()

    // A watch and other writes of the same task at the same moment all land.
    const c = (await addTask({ title: 'Mend the fence', project: 'Orchard' })).task
    await Promise.all([
      api('PUT', `/org/pins/${c.id}`, { node: 'main' }),
      updateTask(c.id, { title: 'Mend the north fence' }),
      updateTask(c.id, { due_date: '2026-12-01' }),
    ])
    const after = await getTask(c.id)
    expect([!!after.watched_at, after.title, after.due_date]).toEqual([true, 'Mend the north fence', '2026-12-01'])
  })

  it('carries every old pin over as a watch, once, and a stopped watch takes the pins off', async () => {
    const pinned = (await addTask({ title: 'Net the vines', project: 'Orchard' })).task
    const twice = (await addTask({ title: 'Sharpen the shears', project: 'Orchard' })).task
    const watched = (await addTask({ title: 'Oil the press', project: 'Orchard' })).task
    const plugin = (await addTask({ title: 'Read the orchard mail', project: 'Orchard' })).task
    // As an older Walnut stored them: one entry per node.
    await updateTaskRaw(pinned.id, { org_pins: [{ node: 'project:orchard', at: '2026-10-31T10:00:00.000Z', by: 'human' }] })
    await updateTaskRaw(twice.id, { org_pins: [{ node: 'main', at: '2026-10-31T12:00:00.000Z', by: 'human' }, { node: 'project:orchard', at: '2026-10-31T11:00:00.000Z', by: 'human' }] })
    await updateTaskRaw(watched.id, { watched_at: '2026-11-01T09:00:00.000Z', org_pins: [{ node: 'main', at: '2026-10-30T09:00:00.000Z', by: 'human' }] })
    await updateTaskRaw(plugin.id, { plugin_only: 'mail', org_pins: [{ node: 'main', at: '2026-10-30T09:00:00.000Z', by: 'human' }] })
    const updatedBefore = (await getTask(pinned.id)).updated_at

    expect(await carryPinsToWatch()).toBe(2)
    expect((await getTask(pinned.id)).watched_at).toBe('2026-10-31T10:00:00.000Z')
    // The first pin's time, so the Watching order is the order they were pinned.
    expect((await getTask(twice.id)).watched_at).toBe('2026-10-31T11:00:00.000Z')
    // A watch already on keeps its own time; a plugin's own task shows on no Org node.
    expect((await getTask(watched.id)).watched_at).toBe('2026-11-01T09:00:00.000Z')
    expect((await getTask(plugin.id)).watched_at).toBeUndefined()
    // The pins stay for an older Walnut, and the carry-over reshuffles no list.
    expect((await getTask(pinned.id)).org_pins).toHaveLength(1)
    expect((await getTask(pinned.id)).updated_at).toBe(updatedBefore)
    expect(await carryPinsToWatch()).toBe(0)

    // Stopping the watch from Home takes the pins off: the next boot leaves it unwatched.
    await api('PATCH', `/tasks/${pinned.id}`, { watched_at: '' })
    expect((await getTask(pinned.id)).org_pins).toBeUndefined()
    // And from the Org route.
    await api('DELETE', `/org/pins/${twice.id}`)
    expect((await getTask(twice.id)).org_pins).toBeUndefined()
    // And on a raw path (an offline write replayed, the outbox): the pins go with the watch too.
    const raw = (await addTask({ title: 'Stack the crates', project: 'Orchard' })).task
    await updateTaskRaw(raw.id, { watched_at: '2026-10-31T09:00:00.000Z', org_pins: [{ node: 'main', at: '2026-10-31T09:00:00.000Z', by: 'human' }] })
    await updateTaskRaw(raw.id, { watched_at: '' })
    expect((await getTask(raw.id)).org_pins ?? null).toBeNull()
    expect((await getTask(twice.id)).org_pins).toBeUndefined()
    expect(await carryPinsToWatch()).toBe(0)
    expect((await getTask(pinned.id)).watched_at).toBeUndefined()
    expect((await listTasks()).filter((t) => t.org_pins?.length && !t.watched_at && !t.plugin_only)).toEqual([])
  })

  it('refuses a plugin\'s own task, a node no row names and a task that is not there', async () => {
    const t = (await addTask({ title: 'Read the mail', project: 'Orchard' })).task
    await updateTaskRaw(t.id, { plugin_only: 'mail' })
    expect((await api('PUT', `/org/pins/${t.id}`, { node: 'main' })).json).toMatchObject({ code: 'not_on_org' })
    const u = (await addTask({ title: 'Count the hives', project: 'Orchard' })).task
    expect((await api('PUT', `/org/pins/${u.id}`, { node: 'No such place' })).json).toMatchObject({ code: 'not_org_node' })
    expect((await api('PUT', '/org/pins/nope-0000', {})).json).toMatchObject({ code: 'task_not_found' })
    expect((await api('PUT', `/org/pins/${u.id}`, { node: 42 })).status).toBe(400)
  })

  it('an agent watches and stops through the op', async () => {
    const caller = (await addTask({ title: 'Plan the harvest', project: 'Orchard' })).task
    const sid = '99999999-aaaa-4bbb-8ccc-ffffffffffff'
    await createSessionRecord(sid, caller.id, 'Orchard', WALNUT_HOME)
    const target = (await addTask({ title: 'Book the cider press', project: 'Orchard' })).task
    const run = async (args: Record<string, unknown>) => {
      const out = await executeOp('org_pin', args, { apiBase: `http://localhost:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
      if (!out.ok) throw new Error(out.message)
      return out
    }
    const on = await run({ task: target.id })
    expect(JSON.stringify(on)).toContain('Watching Book the cider press (on the Org page under the Fruit VP)')
    expect((await getTask(target.id)).watched_at).toBeTruthy()
    await run({ task: target.id, node: 'Orchard', unpin: true })
    expect((await getTask(target.id)).watched_at).toBeUndefined()
  })
})
