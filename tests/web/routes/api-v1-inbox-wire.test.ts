/**
 * The frozen /api/v1 keeps saying `""` for the Inbox (v1ProjectName, src/core/inbox-project.ts),
 * while the store and the web's own /api name it `Inbox`: an installed phone app shows its one
 * fixed Inbox entry, keeps its saved `""` filters, and finds the Inbox's tasks in every list.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-inbox-wire'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { INBOX_PROJECT } from '../../../src/core/inbox-project.js'

let server: HttpServer
let port: number

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the Inbox on /api/v1', () => {
  it('an Inbox task says "" on every v1 read, and Inbox on the web api', async () => {
    const created = await call('POST', '/api/v1/tasks', { title: 'Unfiled errand' })
    expect(created.status).toBe(201)
    expect(created.data.task.project).toBe('')
    const id = created.data.task.id as string
    const list = await call('GET', '/api/v1/tasks')
    expect(list.data.tasks.find((t: { id: string }) => t.id === id)?.project).toBe('')
    expect((await call('GET', `/api/v1/tasks/${id}`)).data.task.project).toBe('')
    // A filter on "" (a saved phone view) and on Inbox both find it.
    for (const q of ['', INBOX_PROJECT]) {
      const filtered = await call('GET', `/api/v1/tasks?project=${encodeURIComponent(q)}`)
      expect(filtered.data.tasks.map((t: { id: string }) => t.id), `project=${q}`).toContain(id)
    }
    // The store and the web's own api name the project.
    const web = await call('GET', `/api/tasks/${id}`)
    expect(web.data.task?.project ?? web.data.project).toBe(INBOX_PROJECT)
  })

  it('a move back to the Inbox answers "" too, whichever name the phone sends', async () => {
    const { data } = await call('POST', '/api/v1/tasks', { title: 'Roaming', project: 'Errands' })
    for (const to of ['', INBOX_PROJECT]) {
      await call('PATCH', `/api/v1/tasks/${data.task.id}`, { project: 'Errands' })
      const moved = await call('PATCH', `/api/v1/tasks/${data.task.id}`, { project: to })
      expect(moved.status).toBe(200)
      expect(moved.data.task.project, `sent ${JSON.stringify(to)}`).toBe('')
    }
  })

  it('the project order names the Inbox "" on v1 and Inbox on the web api', async () => {
    expect((await call('PUT', '/api/v1/ordering/projects', { order: ['Errands', '', 'Reading'] })).status).toBe(200)
    expect((await call('GET', '/api/v1/ordering')).data.projects).toEqual(['Errands', '', 'Reading'])
    expect((await call('GET', '/api/ordering')).data.projects).toEqual(['Errands', INBOX_PROJECT, 'Reading'])
  })

  it('a project cannot be renamed onto the Inbox (its settings and claim would become the Inbox\'s)', async () => {
    await call('POST', '/api/v1/projects', { name: 'Work' })
    const res = await call('PATCH', '/api/v1/projects/Work', { name: 'inbox' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.data)).toMatch(/Delete it instead/)
  })
})
