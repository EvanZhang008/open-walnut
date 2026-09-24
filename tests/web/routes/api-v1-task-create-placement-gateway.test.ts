/**
 * The agent-facing half of caller placement, over the daemon gateway: what a
 * `walnut tools call` inside a session actually gets back.
 *
 *   - task_create with only a title lands beside the caller and SAYS so;
 *   - task_list {} from a worker lists its folder (its project when it has no
 *     folder) with a hint naming the default, and scope widens it;
 *   - a call naming a place, and the Personal AI, get the old whole-board query.
 *
 * Real startServer({ port: 0, dev: true }); the gateway's executeOp reaches it
 * through the server's own API root. Server rules: api-v1-task-create-placement.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate-placement-gw'))
vi.mock('../../../src/core/fork-title.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/fork-title.js')>()),
  summarizeGroupLabel: vi.fn(async () => 'Refined Folder'),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'

let seq = 0
async function seedCaller(project: string, opts: { walnutAgent?: boolean } = {}) {
  seq += 1
  const { task } = await addTask({ title: `Caller ${seq}`, project, ...(opts.walnutAgent ? { walnut_agent: true } : {}) })
  const sid = `22222222-2222-3333-4444-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, project, `/repo/${project}`, { title: task.title })
  return { task: await getTask(task.id), sid }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await startServer({ port: 0, dev: true })
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('through the daemon gateway (what `walnut tools call` in a session does)', () => {
  const deps = () => ({ throttle: new PeerThrottle(), cloudMode: false })
  const call = async (sid: string, name: string, args: Record<string, unknown>) => {
    const r = await handleGatewayCapability('tools.call', sid, { name, args }, '__local__', deps())
    if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r)}`)
    return r.result as Record<string, any>
  }

  it('task_create with only a title lands beside the caller, and task_list {} lists that folder', async () => {
    const { task: caller, sid } = await seedCaller('gateway-proj')
    await addTask({ title: 'Unrelated in the same project', project: 'gateway-proj' })
    await addTask({ title: 'Unrelated elsewhere', project: 'acme' })

    const created = await call(sid, 'task_create', { title: 'Follow-up the user asked for', record_only: true })
    expect(created.placement).toMatchObject({ project: 'gateway-proj', folder_created: true, inherited_from: caller.id })
    expect(created.outcome).toMatch(/^Filed in project gateway-proj, folder ".+" \(new, holding your task and this one\), beside your task\. Placeholder saved/)
    expect(created.task.group_id).toBe(created.placement.group_id)

    const listed = await call(sid, 'task_list', {})
    expect(listed.scope).toBe('folder')
    expect(listed.you).toMatchObject({ id: caller.id, project: 'gateway-proj', group_id: created.placement.group_id })
    expect(listed.hint).toMatch(/by default, because you called from inside a task/)
    expect((listed.tasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual([caller.id, created.task.id].sort())

    const project = await call(sid, 'task_list', { scope: 'project' })
    expect(project.scope).toBe('project')
    expect(project.hint).toBeUndefined()
    expect((project.tasks as Array<{ title: string }>).map((t) => t.title)).toContain('Unrelated in the same project')
    expect((project.tasks as Array<{ title: string }>).map((t) => t.title)).not.toContain('Unrelated elsewhere')

    const board = await call(sid, 'task_list', { scope: 'all' })
    expect(board.you).toBeUndefined()
    expect((board.tasks as Array<{ title: string }>).map((t) => t.title)).toContain('Unrelated elsewhere')
  })

  it('a worker in no folder lists its project by default; a named place skips the default', async () => {
    const { task: caller, sid } = await seedCaller('ring-proj')
    const listed = await call(sid, 'task_list', {})
    expect(listed.scope).toBe('project')
    expect(listed.hint).toMatch(/Listed project ring-proj by default/)
    expect((listed.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(caller.id)
    const named = await call(sid, 'task_list', { project: 'acme' })
    expect(named.scope).toBeUndefined()
    expect(named.you).toBeUndefined()
  })

  it('a Personal AI ask still lists the whole board', async () => {
    const { sid } = await seedCaller('Ask Walnut', { walnutAgent: true })
    const listed = await call(sid, 'task_list', {})
    expect(listed.scope).toBeUndefined()
    expect((listed.tasks as Array<{ title: string }>).map((t) => t.title)).toContain('Unrelated elsewhere')
  })
})
