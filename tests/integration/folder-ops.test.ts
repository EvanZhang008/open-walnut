/**
 * The folder ops against a REAL server (startServer({ port: 0, dev: true }) over
 * a temp home), through the ops registry's own HTTP executor, so this is the
 * path `walnut tools call` and the MCP server take.
 *
 * Pinned:
 *  1. folder_list shows each folder with its project and task count, and filters
 *     by project (case-insensitive, "" = Inbox).
 *  2. folder_move takes the folder, its subfolder and every task in them to the
 *     other project, creates a new project name, and a second call is a no-op.
 *  3. folder_add_tasks files a task of the same project into the folder and
 *     refuses one from another project (the op fails, nothing moves).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const prevDisableSearch = process.env.WALNUT_DISABLE_SEARCH
process.env.WALNUT_DISABLE_SEARCH = '1'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-folder-ops'))

import { startServer, stopServer } from '../../src/web/server.js'
import { closeDb } from '../../src/core/task-db.js'
import { executeOp } from '../../src/ops/index.js'

let server: HttpServer
let port = 0
const root = (): string => `http://127.0.0.1:${port}`

async function op(name: string, args: Record<string, unknown>) {
  return executeOp(name, args, { apiBase: root() })
}

async function okOp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await op(name, args)
  expect(out.ok, `${name} failed: ${out.ok ? '' : out.message}`).toBe(true)
  return (out as { result: unknown }).result as Record<string, unknown>
}

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${root()}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  expect(res.ok, `${method} ${path} → ${res.status} ${await res.clone().text()}`).toBe(true)
  return res.json() as Promise<Record<string, unknown>>
}

async function newTask(title: string, project: string): Promise<string> {
  const body = await api('POST', '/api/tasks', { title, project, source: 'local' })
  return (body.task as { id: string }).id
}

async function projectOf(id: string): Promise<{ project: string; group_id?: string }> {
  const body = await api('GET', `/api/tasks/${id}`)
  return body.task as { project: string; group_id?: string }
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect(port).toBeGreaterThan(0)
})

afterAll(async () => {
  await stopServer().catch(() => {})
  closeDb()
  if (prevDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = prevDisableSearch
})

describe('folder ops', () => {
  it('lists, moves a folder with its subfolder and tasks, and files tasks into a folder', async () => {
    const a = await newTask('redesign the pipeline', 'Hub Context')
    const b = await newTask('measure the latency', 'Hub Context')
    const c = await newTask('draw the diagram', 'Hub Context')
    const loose = await newTask('unrelated work', 'Hub Context')
    const elsewhere = await newTask('other project work', 'Tidepool')
    const folder = (await api('POST', '/api/tasks/groups', { task_ids: [a, b], label: 'Pipeline Redesign' })).group_id as string
    const sub = (await api('POST', '/api/tasks/folders', { label: 'Diagrams', project: 'Hub Context', parent_id: folder })).group_id as string
    await api('POST', `/api/tasks/groups/${sub}/add`, { task_ids: [c] })

    const listed = await okOp('folder_list', { project: 'hub context' })
    const rows = listed.folders as Array<{ id: string; label: string; project: string; task_count: number; parent_id?: string }>
    expect(rows.map((r) => r.id).sort()).toEqual([folder, sub].sort())
    expect(rows.find((r) => r.id === folder)).toMatchObject({ label: 'Pipeline Redesign', project: 'Hub Context', task_count: 2 })
    expect(rows.find((r) => r.id === sub)).toMatchObject({ parent_id: folder, task_count: 1 })
    expect((await okOp('folder_list', { project: 'Tidepool' })).count).toBe(0)

    const moved = await okOp('folder_move', { id: folder, project: 'Cluster View' })
    expect((moved.moved_task_ids as string[]).sort()).toEqual([a, b, c].sort())
    expect((moved.moved_folder_ids as string[]).sort()).toEqual([folder, sub].sort())
    expect(String(moved.outcome)).toContain('Moved 2 folder(s) and 3 task(s) to Cluster View')
    for (const id of [a, b, c]) expect((await projectOf(id)).project).toBe('Cluster View')
    expect((await projectOf(c)).group_id).toBe(sub)
    expect((await projectOf(loose)).project).toBe('Hub Context')
    const projects = (await api('GET', '/api/projects')).projects as Array<{ name: string }>
    expect(projects.map((p) => p.name)).toContain('Cluster View')

    const again = await okOp('folder_move', { id: folder, project: 'cluster view' })
    expect(again.moved_task_ids).toEqual([])
    expect(String(again.outcome)).toContain('already in')

    // Same project: filed. Another project: refused, and nothing moves.
    await api('PATCH', `/api/tasks/${loose}`, { project: 'Cluster View' })
    const filed = await okOp('folder_add_tasks', { id: folder, task_ids: [loose] })
    expect((filed.member_ids as string[]).sort()).toEqual([a, b, loose].sort())
    const refused = await op('folder_add_tasks', { id: folder, task_ids: [elsewhere] })
    expect(refused.ok).toBe(false)
    expect((await projectOf(elsewhere)).group_id).toBeUndefined()
  })

  it('a folder id that is not a folder fails the op', async () => {
    const out = await op('folder_move', { id: 'g_nosuchfolder', project: 'Anywhere' })
    expect(out.ok).toBe(false)
    const bad = await op('folder_move', { id: '../etc', project: 'Anywhere' })
    expect(bad.ok).toBe(false)
  })
})
