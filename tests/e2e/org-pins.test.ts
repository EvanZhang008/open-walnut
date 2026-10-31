/**
 * Pins on an Org node end to end, on a real server (src/core/org/org-pins.ts, PUT / DELETE
 * /api/v1/org/pins/:taskId, op org_pin). 2026-10-31, the user picked a Pinned tab first in a
 * node's Task view, and the node's pins under its chat in the Org list:
 *   - the user pins a task to the CEO and to a VP (by the VP's name, its project, or its node key);
 *     the task holds one entry per node, in pin order, with who pinned it
 *   - pinning twice changes nothing; unpinning takes only that node's pin
 *   - an agent pins and unpins through the op, recorded as its task
 *   - a node no row names, a task that does not exist, and a missing node are refused
 *   - another write of the task never takes a pin back out
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-pins'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { nodePins, orgProjectNode } from '../../src/core/org/org-tree.js'
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

describe('pins on an Org node', () => {
  it('pins to the CEO and to a VP, in order, and takes one pin off', async () => {
    const vp = await api('POST', '/org/projects', { name: 'Orchard', vpName: 'Fruit' })
    expect(vp.status, JSON.stringify(vp.json)).toBe(201)
    const a = (await addTask({ title: 'Prune the pear trees', project: 'Orchard' })).task
    const b = (await addTask({ title: 'Order new ladders', project: 'Orchard' })).task

    // A VP by its name, its project, or its node key: one node.
    const first = await api('PUT', `/org/pins/${a.id}`, { node: 'Fruit VP' })
    expect([first.status, first.json.node, first.json.changed]).toEqual([200, orgProjectNode('Orchard'), true])
    expect((await api('PUT', `/org/pins/${a.id}`, { node: 'orchard' })).json.changed).toBe(false)
    expect((await api('PUT', `/org/pins/${b.id}`, { node: 'project:ORCHARD' })).json.changed).toBe(true)
    expect((await api('PUT', `/org/pins/${a.id}`, { node: 'CEO' })).json.node).toBe('main')

    const pins = (await getTask(a.id)).org_pins ?? []
    expect(pins.map((p) => p.node)).toEqual(['project:orchard', 'main'])
    expect(pins[0]).toMatchObject({ by: 'human' })
    expect(nodePins(await listTasks(), 'project:orchard').map((t) => t.id)).toEqual([a.id, b.id])

    // Pins and other writes of the same task at the same moment all land.
    const c = (await addTask({ title: 'Mend the fence', project: 'Orchard' })).task
    await Promise.all([
      api('PUT', `/org/pins/${c.id}`, { node: 'main' }),
      api('PUT', `/org/pins/${c.id}`, { node: 'Orchard VP' }),
      updateTask(c.id, { title: 'Mend the north fence' }),
      updateTask(c.id, { due_date: '2026-12-01' }),
    ])
    const after = await getTask(c.id)
    expect([...(after.org_pins ?? []).map((p) => p.node)].sort()).toEqual(['main', 'project:orchard'])
    expect([after.title, after.due_date]).toEqual(['Mend the north fence', '2026-12-01'])

    const off = await api('DELETE', `/org/pins/${a.id}?node=${encodeURIComponent('project:orchard')}`)
    expect([off.status, off.json.changed]).toEqual([200, true])
    expect(((await getTask(a.id)).org_pins ?? []).map((p) => p.node)).toEqual(['main'])
    expect((await api('DELETE', `/org/pins/${a.id}?node=project:orchard`)).json.changed).toBe(false)
    // The last pin off leaves no field behind.
    await api('DELETE', `/org/pins/${a.id}?node=main`)
    expect((await getTask(a.id)).org_pins).toBeUndefined()
  })

  it('carries a VP\'s pins through a project rename, and never moves a pinned task of another project', async () => {
    await api('POST', '/org/projects', { name: 'Vineyard' })
    const own = (await addTask({ title: 'Net the vines', project: 'Vineyard' })).task
    const other = (await addTask({ title: 'Sharpen the shears', project: 'Orchard' })).task
    await api('PUT', `/org/pins/${own.id}`, { node: 'Vineyard' })
    await api('PUT', `/org/pins/${other.id}`, { node: 'Vineyard' })
    const { renameProject } = await import('../../src/core/task-manager.js')
    await renameProject('Vineyard', 'Grapes')
    expect((await getTask(own.id)).org_pins?.map((p) => p.node)).toEqual(['project:grapes'])
    expect((await getTask(other.id)).org_pins?.map((p) => p.node)).toEqual(['project:grapes'])
    expect((await getTask(other.id)).project).toBe('Orchard')
  })

  it('unpins a project by its name after another VP took it over', async () => {
    const t = (await addTask({ title: 'Pick the berries', project: 'Berries' })).task
    await addTask({ title: 'Wash the berries', project: 'Berries' })
    expect((await api('PUT', `/org/pins/${t.id}`, { node: 'Berries' })).json.node).toBe('project:berries')
    const { updateTaskRaw } = await import('../../src/core/task-manager.js')
    const lead = (await listTasks()).find((x) => x.org_role === 'lead' && x.project === 'Orchard')!
    await updateTaskRaw(lead.id, { org_leads: ['Berries'] })
    // The name now names the Fruit VP's row, where the pin still shows: it still comes off.
    const off = await api('DELETE', `/org/pins/${t.id}?node=Berries`)
    expect([off.status, off.json.node, off.json.changed]).toEqual([200, 'project:berries', true])
    expect((await getTask(t.id)).org_pins).toBeUndefined()
  })

  it('refuses a plugin\'s own task, which the Org page never shows', async () => {
    const t = (await addTask({ title: 'Read the mail', project: 'Orchard' })).task
    const { updateTaskRaw } = await import('../../src/core/task-manager.js')
    await updateTaskRaw(t.id, { plugin_only: 'mail' })
    expect((await api('PUT', `/org/pins/${t.id}`, { node: 'main' })).json).toMatchObject({ code: 'not_on_org' })
  })

  it('refuses a node no row names, a task that is not there, and a missing node', async () => {
    const t = (await addTask({ title: 'Count the hives', project: 'Orchard' })).task
    expect((await api('PUT', `/org/pins/${t.id}`, { node: 'No such place' })).json).toMatchObject({ code: 'not_org_node' })
    expect((await api('PUT', '/org/pins/nope-0000', { node: 'main' })).json).toMatchObject({ code: 'task_not_found' })
    const missing = await api('PUT', `/org/pins/${t.id}`, {})
    expect([missing.status, missing.json.code]).toEqual([400, 'bad_node'])
  })

  it('an agent pins and unpins through the op, recorded as its task', async () => {
    const caller = (await addTask({ title: 'Plan the harvest', project: 'Orchard' })).task
    const sid = '99999999-aaaa-4bbb-8ccc-ffffffffffff'
    await createSessionRecord(sid, caller.id, 'Orchard', WALNUT_HOME)
    const target = (await addTask({ title: 'Book the cider press', project: 'Orchard' })).task
    const run = async (args: Record<string, unknown>) => {
      const out = await executeOp('org_pin', args, { apiBase: `http://localhost:${port}`, origin: '__local__', callerMode: 'session', callerSid: sid })
      if (!out.ok) throw new Error(out.message)
      return out
    }
    const pinned = await run({ task: target.id, node: 'Orchard' })
    expect(JSON.stringify(pinned)).toContain('Pinned Book the cider press to the Fruit VP')
    expect((await getTask(target.id)).org_pins?.[0]).toMatchObject({ node: 'project:orchard', by: `task:${caller.id}`, by_name: 'the task "Plan the harvest"' })
    await run({ task: target.id, node: 'Orchard', unpin: true })
    expect((await getTask(target.id)).org_pins).toBeUndefined()
  })
})
