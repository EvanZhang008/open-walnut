/**
 * The org's duty switches end to end, on a real server (src/core/org/duties/, /api/v1/org/duties):
 *   - the registry is listed, a VP's switch turns on and off and the node carries it
 *   - an unknown duty, a task that is no org node, and a bad body are refused
 *   - a node with reflection on is one the reflection pass reads (nodesWithDuty); off, it is not
 *   - the reflection's correction reaches the worker's session queue framed as Walnut's note,
 *     never as the user's own words
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-duties'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { nodesWithDuty } from '../../src/core/org/duties/node-duties.js'
import { defaultDeps } from '../../src/core/org/reflection/pipeline.js'

let server: HttpServer
let port: number

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://localhost:${port}/api/v1${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
})

describe('org duties', () => {
  it('lists the registry, switches a VP\'s duty on and off, and refuses what is no switch', async () => {
    const list = await api<{ duties: Array<{ id: string; name: string; roles: string[] }> }>('GET', '/org/duties')
    expect(list.status).toBe(200)
    expect(list.json.duties.map((d) => d.id)).toContain('reflection')

    const vp = await api<{ task: { id: string } }>('POST', '/org/vps', { name: 'Lagoon' })
    expect(vp.status).toBe(201)
    const id = vp.json.task.id
    expect((await getTask(id)).org_duties).toBeUndefined()
    expect((await nodesWithDuty('reflection')).map((t) => t.id)).not.toContain(id)

    const on = await api<{ task: { org_duties?: Record<string, { on: boolean; by?: string }> } }>('PUT', `/org/nodes/${id}/duties/reflection`, { on: true })
    expect(on.status).toBe(200)
    expect(on.json.task.org_duties?.reflection).toMatchObject({ on: true, by: 'human' })
    expect((await getTask(id)).org_duties?.reflection?.on).toBe(true)
    expect((await nodesWithDuty('reflection')).map((t) => t.id)).toContain(id)
    // The same switch again writes nothing new: the first stamp stays.
    const firstAt = (await getTask(id)).org_duties?.reflection?.at
    await api('PUT', `/org/nodes/${id}/duties/reflection`, { on: true })
    expect((await getTask(id)).org_duties?.reflection?.at).toBe(firstAt)

    const off = await api<{ task: { org_duties?: Record<string, { on: boolean }> } }>('PUT', `/org/nodes/${id}/duties/reflection`, { on: false })
    expect(off.json.task.org_duties?.reflection?.on).toBe(false)
    expect((await nodesWithDuty('reflection')).map((t) => t.id)).not.toContain(id)

    expect((await api('PUT', `/org/nodes/${id}/duties/no-such-duty`, { on: true })).status).toBe(404)
    expect((await api('PUT', `/org/nodes/${id}/duties/reflection`, { on: 'yes' })).status).toBe(400)
    const { task: plain } = await addTask({ title: 'A plain task', project: 'Lagoon', source: 'local' })
    expect((await api('PUT', `/org/nodes/${plain.id}/duties/reflection`, { on: true })).status).toBe(404)
  })

  it('delivers the reflection\'s correction into the worker\'s session as Walnut\'s note', async () => {
    const { task } = await addTask({ title: 'Upgrade the autoscaler', project: 'Lagoon', source: 'local' })
    const sid = 'sess-duty-correction'
    await createSessionRecord(sid, task.id, 'Upgrade the autoscaler', WALNUT_HOME)
    await updateTaskRaw(task.id, { session_id: sid, phase: 'IN_PROGRESS' })
    const ok = await defaultDeps().send(await getTask(task.id), 'Open a clean 1.8 now and move every dependent.', 'Lagoon VP\'s reflection: open 1.8')
    expect(ok).toBe(true)
    const row = (await getQueue(sid)).find((m) => m.message.includes('Open a clean 1.8 now'))
    expect(row, 'the correction is queued for the worker session').toBeTruthy()
    // Framed: the session reads it as a note from Walnut, never as the user's own words.
    expect(row!.message).toMatch(/<walnut-message[^>]*kind="peer-note"/)
    expect(row!.message).toContain('Walnut (org-reflection)')
    // A finished task is never reopened by a correction.
    await updateTaskRaw(task.id, { phase: 'COMPLETE' })
    expect(await defaultDeps().send(await getTask(task.id), 'late', 't')).toBe(false)
  })
})
