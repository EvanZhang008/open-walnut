/**
 * A node's pain registry over its routes, on a real server (/api/v1/org/nodes/:id/pains,
 * src/web/routes/org-pains-v1.ts): pains written elsewhere are added (an id already there kept, a
 * picture copied next to the registry), the task that fixes one writes its rule, test and owner and
 * it reads live, a guard run is recorded and shown, and a task that is no org node is refused.
 * Only the Claude CLI is mocked (no session is started here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-pains'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'

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

type Entry = { id: string; shown: string; status: string; quotes: Array<{ images?: string[] }>; rule?: unknown; test?: unknown; changedBy?: string }

describe('the pain registry routes', () => {
  it('adds pains, takes a rule and a test, records a guard run, and refuses a task that is no node', async () => {
    const vp = await api<{ task: { id: string } }>('POST', '/org/vps', { name: 'Lagoon' })
    const id = vp.json.task.id
    const pic = path.join(WALNUT_HOME, 'pics', '1795-pier.png')
    await fs.mkdir(path.dirname(pic), { recursive: true })
    await fs.writeFile(pic, 'png')
    const pain = { id: 'pn-01', title: 'Cards lose their reply', kind: 'regression', scope: 'all_users', firstAt: '2026-11-20T10:00:00Z', lastAt: '2026-11-20T10:00:00Z', count: 1, status: 'unowned', quotes: [{ at: '2026-11-20T10:00:00Z', text: 'the reply is gone', images: [pic] }] }

    const added = await api<{ added: string[]; kept: string[] }>('POST', `/org/nodes/${id}/pains`, { entries: [pain, { title: 'no id' }] })
    expect(added.status).toBe(200)
    expect(added.json).toMatchObject({ added: ['pn-01'], kept: [], refused: 1 })
    // An id already there is kept as it is.
    expect((await api('POST', `/org/nodes/${id}/pains`, { entries: [{ ...pain, title: 'Overwritten' }] })).json).toMatchObject({ added: [], kept: ['pn-01'] })

    let read = await api<{ entries: Entry[]; markdown: string }>('GET', `/org/nodes/${id}/pains`)
    expect(read.json.entries[0]).toMatchObject({ id: 'pn-01', shown: 'unowned' })
    const kept = read.json.entries[0].quotes[0].images![0]
    expect(kept).not.toBe(pic)
    expect(await fs.readFile(kept, 'utf-8')).toBe('png')

    const patched = await api<{ entry: Entry }>('PATCH', `/org/nodes/${id}/pains/pn-01`, {
      rule: { where: 'src/core/x.ts', text: 'Keep the reply.' }, test: { file: 'tests/core/x.test.ts', name: 'keeps the reply' }, status: 'live',
    })
    expect(patched.status).toBe(200)
    expect(patched.json.entry).toMatchObject({ shown: 'live', changedBy: 'human' })
    expect((await api('PATCH', `/org/nodes/${id}/pains/pn-01`, { status: 'done' })).status).toBe(400)
    expect((await api('PATCH', `/org/nodes/${id}/pains/pn-01`, { test: { file: 'tests/x.ts' } })).status).toBe(400)
    expect((await api('PATCH', `/org/nodes/${id}/pains/pn-99`, { note: 'x' })).status).toBe(404)

    expect((await api('PUT', `/org/nodes/${id}/pains-tests`, { results: {} })).status).toBe(400)
    const run = await api('PUT', `/org/nodes/${id}/pains-tests`, { at: new Date().toISOString(), commit: 'abc123', results: { 'pn-01': { result: 'failed', detail: 'expected 1' } } })
    expect(run.status).toBe(200)
    read = await api<{ entries: Entry[]; markdown: string; guardRun: { results: Record<string, { result: string }> } }>('GET', `/org/nodes/${id}/pains`)
    expect(read.json.guardRun.results['pn-01'].result).toBe('failed')
    expect(await fs.readFile(read.json.markdown, 'utf-8')).toContain('(last run: failed, expected 1)')

    const plain = await addTask({ title: 'Just a task' })
    expect((await api('GET', `/org/nodes/${plain.task.id}/pains`)).status).toBe(404)
  })
})
