/**
 * Project tombstones through the REAL HTTP surface
 * (startServer({ port: 0, dev: true })) — the routes the human actually uses.
 *
 * The 2026-09-08 report was "I delete a project and it grows back". The ledger's
 * contract, stated as routes:
 *
 *   DELETE /api/projects/:name   → the name is CLOSED. Any later writer that
 *                                  names it files into Inbox instead, and the
 *                                  registry never grows the row back by itself.
 *   POST   /api/projects         → the ONE door back (an explicit human create).
 *   PATCH  /api/projects/:name   → leaves a REDIRECT, so writers that still know
 *                                  the old name follow the rename instead of
 *                                  re-minting it next to the survivor.
 *
 * The ledger lives in SQLite, so this file also restarts the server to prove a
 * tombstone is not in-memory state that a deploy forgets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-tombstone-routes'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { _resetForTesting } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'

let server: HttpServer
let port: number

function url(p: string): string {
  return `http://127.0.0.1:${port}${p}`
}

async function json(res: Response): Promise<any> {
  return res.json()
}

async function post(p: string, body: unknown): Promise<Response> {
  return fetch(url(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patch(p: string, body: unknown): Promise<Response> {
  return fetch(url(p), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function del(p: string): Promise<Response> {
  return fetch(url(p), { method: 'DELETE' })
}

/** The names the registry currently lists. */
async function projectNames(): Promise<string[]> {
  const body = await json(await fetch(url('/api/projects')))
  return (body.projects as Array<{ name: string }>).map((p) => p.name)
}

async function createTask(title: string, project?: string): Promise<any> {
  const res = await post('/api/tasks', project === undefined ? { title } : { title, project })
  expect(res.status, `create "${title}" → ${res.status}`).toBe(201)
  return (await json(res)).task
}

async function bootServer(): Promise<void> {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect(port).toBeGreaterThan(0)
}

beforeAll(async () => {
  await bootServer()
})

afterAll(async () => {
  await stopServer().catch(() => {})
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

beforeEach(async () => {
  // Clear the registry + tasks between cases without restarting the server.
  for (const name of await projectNames()) await del(`/api/projects/${encodeURIComponent(name)}`)
  const tasks = (await json(await fetch(url('/api/tasks')))).tasks as Array<{ id: string }>
  for (const t of tasks) await fetch(url(`/api/tasks/${t.id}`), { method: 'DELETE' })
  // …and forget the tombstones those deletes just wrote, so each case starts clean.
  const { clearProjectTombstone, listProjectTombstones } = await import('../../src/core/project-tombstones.js')
  for (const t of listProjectTombstones()) clearProjectTombstone(t.name)
})

describe('DELETE closes the name', () => {
  it('a task created under a deleted project files into Inbox, not a new row', async () => {
    expect((await post('/api/projects', { name: 'Fix Walnut' })).status).toBe(201)
    const before = await createTask('An earlier task', 'Fix Walnut')
    expect(before.project).toBe('Fix Walnut')

    const gone = await del('/api/projects/Fix%20Walnut')
    expect(gone.status).toBe(200)
    expect(await projectNames()).not.toContain('Fix Walnut')

    // The writer that used to re-mint the row: a plain create naming the project.
    const after = await createTask('A8 probe plain', 'Fix Walnut')
    expect(after.project).toBe('')
    expect(await projectNames()).not.toContain('Fix Walnut')
  })

  it('a MOVE onto a deleted project is dropped — the task keeps its place', async () => {
    expect((await post('/api/projects', { name: 'Keep Me' })).status).toBe(201)
    expect((await post('/api/projects', { name: 'Fix Walnut' })).status).toBe(201)
    const task = await createTask('Stays put', 'Keep Me')
    await del('/api/projects/Fix%20Walnut')

    const res = await patch(`/api/tasks/${task.id}`, { project: 'Fix Walnut' })
    expect(res.status).toBe(200)
    expect((await json(res)).task.project).toBe('Keep Me')
    expect(await projectNames()).not.toContain('Fix Walnut')
  })

  it('case does not reopen it (the registry key is case-insensitive)', async () => {
    expect((await post('/api/projects', { name: 'Fix Walnut' })).status).toBe(201)
    await del('/api/projects/Fix%20Walnut')

    const sneaky = await createTask('lower case try', 'fix walnut')
    expect(sneaky.project).toBe('')
    expect(await projectNames()).not.toContain('fix walnut')
  })

  it('survives a server restart (the ledger is on disk, not in memory)', async () => {
    expect((await post('/api/projects', { name: 'Fix Walnut' })).status).toBe(201)
    await del('/api/projects/Fix%20Walnut')

    await stopServer()
    closeDb()
    _resetForTesting()
    await bootServer()

    const after = await createTask('after restart', 'Fix Walnut')
    expect(after.project).toBe('')
  })
})

describe('POST is the door back', () => {
  it('an explicit human create re-opens the name and makes it stick', async () => {
    expect((await post('/api/projects', { name: 'Fix Walnut' })).status).toBe(201)
    await del('/api/projects/Fix%20Walnut')

    const reopened = await post('/api/projects', { name: 'Fix Walnut' })
    expect(reopened.status).toBe(201)
    expect((await json(reopened)).created).toBe(true)

    const task = await createTask('now it sticks', 'Fix Walnut')
    expect(task.project).toBe('Fix Walnut')
    expect(await projectNames()).toContain('Fix Walnut')
  })

  it('re-opening keeps the row idempotent (a second POST is a 200, not a reset)', async () => {
    await post('/api/projects', { name: 'Fix Walnut' })
    await del('/api/projects/Fix%20Walnut')
    await post('/api/projects', { name: 'Fix Walnut' })

    const again = await post('/api/projects', { name: 'Fix Walnut' })
    expect(again.status).toBe(200)
    expect((await json(again)).created).toBe(false)
  })
})

describe('PATCH leaves a redirect', () => {
  it('a writer still using the OLD name follows the rename', async () => {
    expect((await post('/api/projects', { name: 'Old Name' })).status).toBe(201)
    expect((await patch('/api/projects/Old%20Name', { name: 'New Name' })).status).toBe(200)

    const task = await createTask('written by a stale client', 'Old Name')
    expect(task.project).toBe('New Name')
    // No second row next to the survivor.
    expect(await projectNames()).toEqual(['New Name'])
  })

  it('a merge redirects the absorbed name to the survivor', async () => {
    await post('/api/projects', { name: 'Alpha' })
    await post('/api/projects', { name: 'Beta' })
    expect((await patch('/api/projects/Alpha', { name: 'Beta' })).status).toBe(200)

    const task = await createTask('meant for Alpha', 'Alpha')
    expect(task.project).toBe('Beta')
  })

  it('deleting the survivor closes the redirect too — the chain dead-ends in Inbox', async () => {
    await post('/api/projects', { name: 'Old Name' })
    await patch('/api/projects/Old%20Name', { name: 'New Name' })
    await del('/api/projects/New%20Name')

    const viaOld = await createTask('via the old name', 'Old Name')
    expect(viaOld.project).toBe('')
    const viaNew = await createTask('via the new name', 'New Name')
    expect(viaNew.project).toBe('')
    expect(await projectNames()).toEqual([])
  })
})
