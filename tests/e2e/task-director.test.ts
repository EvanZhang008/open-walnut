/**
 * Task.director on a real server (src/core/task-director.ts, src/core/org/org-directors.ts;
 * 2026-11-20, the user: "we can also de-promote or promote any task to director ... and we can
 * also create director"):
 *
 *   1. PATCH /api/tasks/:id and PATCH /api/v1/tasks/:id store yes and no, and auto / null delete
 *      the field; a bad value is 400 and changes nothing;
 *   2. an org node (a VP) refuses yes / no with 400 org_node_director, on both routes, and keeps
 *      nothing (a description sent with it is not written either on API v1);
 *   3. POST /api/tasks and POST /api/v1/tasks create a Director in one call;
 *   4. GET /api/v1/org carries `director` on every task node, and /org/reports of the VP lists
 *      its Directors with the rows that are one marked.
 * Only the Claude CLI is mocked (no session runs here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-director'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import type { OrgTaskNode, OrgTree } from '../../src/core/org/org-tree.js'

let base = ''
let vpId = ''
let leaderId = ''
let soloId = ''

const json = { 'content-type': 'application/json' }
const patch = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })

function nodesOf(tree: OrgTree): Map<string, OrgTaskNode> {
  const out = new Map<string, OrgTaskNode>()
  const walk = (ns: OrgTaskNode[]) => { for (const n of ns) { out.set(n.id, n); walk(n.workers) } }
  for (const p of tree.projects) walk(p.teams)
  return out
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vpId = (await addTask({ title: 'Orchard VP', project: 'Orchard', source: 'local', org_role: 'lead' })).task.id
  leaderId = (await addTask({ title: 'Greenhouse care', project: 'Orchard' })).task.id
  await addTask({ title: 'Check the vents', project: 'Orchard', parent_task_id: leaderId })
  soloId = (await addTask({ title: 'Prune the pears', project: 'Orchard' })).task.id
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Task.director over the routes', () => {
  it('the web PATCH stores yes and no, deletes on auto and null, and refuses a bad value', async () => {
    let res = await patch(`/api/tasks/${soloId}`, { director: 'yes' })
    expect(res.status).toBe(200)
    expect((await res.json()).task.director).toBe('yes')
    expect((await getTask(soloId)).director).toBe('yes')

    res = await patch(`/api/tasks/${soloId}`, { director: 'maybe' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/director must be one of/)
    expect((await getTask(soloId)).director).toBe('yes')

    expect((await patch(`/api/tasks/${soloId}`, { director: 'no' })).status).toBe(200)
    expect((await getTask(soloId)).director).toBe('no')
    expect((await patch(`/api/tasks/${soloId}`, { director: 'auto' })).status).toBe(200)
    expect('director' in (await getTask(soloId))).toBe(false)
    await patch(`/api/tasks/${soloId}`, { director: 'yes' })
    expect((await patch(`/api/tasks/${soloId}`, { director: null })).status).toBe(200)
    expect('director' in (await getTask(soloId))).toBe(false)
  })

  it('API v1 PATCH takes director alone, projects it, and deletes it on auto / null', async () => {
    let res = await patch(`/api/v1/tasks/${leaderId}`, { director: 'no' })
    expect(res.status).toBe(200)
    expect((await res.json()).task.director).toBe('no')
    expect((await getTask(leaderId)).director).toBe('no')

    res = await patch(`/api/v1/tasks/${leaderId}`, { director: 7 })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')

    res = await patch(`/api/v1/tasks/${leaderId}`, { director: 'auto' })
    expect(res.status).toBe(200)
    expect('director' in (await res.json()).task).toBe(false)
    expect('director' in (await getTask(leaderId))).toBe(false)

    await patch(`/api/v1/tasks/${leaderId}`, { director: 'yes' })
    expect((await patch(`/api/v1/tasks/${leaderId}`, { director: null })).status).toBe(200)
    expect('director' in (await getTask(leaderId))).toBe(false)

    // The "at least one field" message names it.
    res = await patch(`/api/v1/tasks/${leaderId}`, {})
    expect((await res.json()).error.message).toContain('director')
  })

  it('an org node refuses yes and no on both routes and keeps nothing', async () => {
    const before = await getTask(vpId)
    let res = await patch(`/api/tasks/${vpId}`, { director: 'yes' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('org_node_director')

    res = await patch(`/api/v1/tasks/${vpId}`, { director: 'no', description: 'should not land' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('org_node_director')

    const after = await getTask(vpId)
    expect('director' in after).toBe(false)
    expect(after.description).toBe(before.description)
    // auto on an org node changes nothing and is no error.
    expect((await patch(`/api/v1/tasks/${vpId}`, { director: 'auto' })).status).toBe(200)
  })

  it('creates a Director in one call on both create routes', async () => {
    let res = await post('/api/tasks', { title: 'Seed library', project: 'Orchard', director: 'yes' })
    expect(res.status).toBe(201)
    const webId = (await res.json()).task.id as string
    expect((await getTask(webId)).director).toBe('yes')

    res = await post('/api/v1/tasks', { title: 'Cider press', project: 'Orchard', director: 'yes' })
    expect(res.status).toBeLessThan(300)
    const v1 = await res.json()
    expect(v1.task.director).toBe('yes')
    expect((await getTask(v1.task.id)).director).toBe('yes')

    // auto stores nothing; a bad value makes no task.
    res = await post('/api/tasks', { title: 'Mulch run', project: 'Orchard', director: 'auto' })
    expect('director' in (await getTask((await res.json()).task.id))).toBe(false)
    expect((await post('/api/tasks', { title: 'Bad one', project: 'Orchard', director: 'sure' })).status).toBe(400)
    expect((await post('/api/v1/tasks', { title: 'Bad two', project: 'Orchard', director: false })).status).toBe(400)
  })

  it('the org tree carries director per node, and the VP reads its Directors', async () => {
    // Greenhouse care leads a worker (auto: a Director); Prune the pears chose no.
    await patch(`/api/tasks/${soloId}`, { director: 'no' })
    const tree = (await (await fetch(`${base}/api/v1/org`)).json()).tree as OrgTree
    const nodes = nodesOf(tree)
    expect(nodes.get(leaderId)!.director).toBe(true)
    expect(nodes.get(soloId)!.director).toBe(false)
    for (const node of nodes.values()) expect(typeof node.director).toBe('boolean')

    const reports = await (await fetch(`${base}/api/v1/org/reports?of=${vpId}`)).json() as {
      rows: Array<{ id: string; director?: true }>; directors?: Array<{ id: string; title: string; leads: number }>
    }
    expect(reports.rows.find((r) => r.id === leaderId)!.director).toBe(true)
    expect('director' in reports.rows.find((r) => r.id === soloId)!).toBe(false)
    const directorTitles = (reports.directors ?? []).map((d) => d.title).sort()
    expect(directorTitles).toEqual(['Cider press', 'Greenhouse care', 'Seed library'])
    expect(reports.directors!.find((d) => d.id === leaderId)!.leads).toBe(1)
  })
})
