/**
 * Four task API papercuts an agent hit while running a time review (2026-10-09),
 * each through a REAL server:
 *   - PATCH /api/tasks/:id and PATCH /api/v1/tasks/:id answered 200 and dropped
 *     `pinned` / `focus_tier`;
 *   - task_update refused null for due_date/start_date (the v1 PATCH refused a null due_date);
 *   - task_get_bulk refused `id` in `fields`;
 *   - a raw non-ASCII query (`?q=<CJK>`) got an empty 400 body from Node's parser.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-api-papercuts'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'

let server: HttpServer
let port: number

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const op = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN })

async function newTask(title: string): Promise<string> {
  const r = await api('POST', '/api/tasks', { title, priority: 'none', project: 'Papercuts', pinned: false })
  expect(r.status).toBe(201)
  return r.body.task.id
}
const read = async (id: string) => (await api('GET', `/api/tasks/${id}`)).body.task

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('PATCH pinned / focus_tier', () => {
  it('the web PATCH pins, moves tiers, unpins, and applies other fields in the same call', async () => {
    const id = await newTask('Pin me (web)')
    let r = await api('PATCH', `/api/tasks/${id}`, { focus_tier: 'focus', title: 'Pinned (web)' })
    expect(r.status).toBe(200)
    expect(r.body.task).toMatchObject({ title: 'Pinned (web)', pinned: true, focus_tier: 'focus' })
    expect(await read(id)).toMatchObject({ pinned: true, focus_tier: 'focus' })
    r = await api('PATCH', `/api/tasks/${id}`, { pinned: true })
    expect(r.body.task.focus_tier).toBe('focus') // pinned:true alone keeps the tier
    r = await api('PATCH', `/api/tasks/${id}`, { pinned: false })
    expect(r.body.task.pinned).toBeFalsy()
    r = await api('PATCH', `/api/tasks/${id}`, { pinned: true })
    expect(r.body.task).toMatchObject({ pinned: true })
    expect(['satellite', undefined, null]).toContain(r.body.task.focus_tier)
  })

  it('the v1 PATCH takes the pin fields alone and checks them before writing anything', async () => {
    const id = await newTask('Pin me (v1)')
    let r = await api('PATCH', `/api/v1/tasks/${id}`, { focus_tier: 'wait' })
    expect(r.status).toBe(200)
    expect(await read(id)).toMatchObject({ pinned: true, focus_tier: 'wait' })
    r = await api('PATCH', `/api/v1/tasks/${id}`, { title: 'Never written', focus_tier: 'nowhere' })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/focus_tier must be one of/)
    expect((await read(id)).title).toBe('Pin me (v1)')
    r = await api('PATCH', `/api/v1/tasks/${id}`, { pinned: false, focus_tier: 'focus' })
    expect(r.status).toBe(400)
    r = await api('PATCH', `/api/v1/tasks/${id}`, { pinned: 'yes' })
    expect(r.status).toBe(400)
    r = await api('PATCH', `/api/v1/tasks/${id}`, { pinned: false })
    expect(r.status).toBe(200)
    expect((await read(id)).pinned).toBeFalsy()
    expect((await api('PATCH', '/api/v1/tasks/zzzzzzzz-none', { pinned: true })).status).toBe(404)
  })

  it('refuses to pin a completed task, on both routes, and leaves it as it was', async () => {
    const id = await newTask('Done already')
    expect((await api('POST', `/api/tasks/${id}/complete`)).status).toBeLessThan(300)
    const web = await api('PATCH', `/api/tasks/${id}`, { focus_tier: 'focus' })
    expect(web.status).toBe(409)
    const v1 = await api('PATCH', `/api/v1/tasks/${id}`, { pinned: true, title: 'Renamed?' })
    expect(v1.status).toBe(409)
    expect(await read(id)).toMatchObject({ title: 'Done already' })
    expect((await read(id)).pinned).toBeFalsy()
    // Completing in the same PATCH that pins is refused too.
    const other = await newTask('Finish and pin')
    expect((await api('PATCH', `/api/v1/tasks/${other}`, { phase: 'COMPLETE', focus_tier: 'focus' })).status).toBe(409)
  })
})

describe('null clears a date', () => {
  it('task_update takes null for due_date and start_date; the v1 PATCH takes a null due_date', async () => {
    const id = await newTask('Has dates')
    expect((await api('PATCH', `/api/v1/tasks/${id}`, { due_date: '2026-12-01', start_date: '2026-11-20' })).status).toBe(200)
    expect(await read(id)).toMatchObject({ due_date: expect.stringContaining('2026-12-01'), start_date: expect.stringContaining('2026-11-20') })
    const cleared = await op('task_update', { id, due_date: null, start_date: null })
    expect(cleared.ok).toBe(true)
    let task = await read(id)
    expect(task.due_date ?? '').toBe('')
    expect(task.start_date ?? '').toBe('')
    await api('PATCH', `/api/v1/tasks/${id}`, { due_date: '2026-12-02' })
    expect((await api('PATCH', `/api/v1/tasks/${id}`, { due_date: null })).status).toBe(200)
    task = await read(id)
    expect(task.due_date ?? '').toBe('')
    expect((await api('PATCH', `/api/v1/tasks/${id}`, { due_date: 7 })).status).toBe(400)
  })
})

describe('task_get_bulk with id in fields', () => {
  it('answers the rows instead of failing the batch', async () => {
    const id = await newTask('Bulk row')
    const out = await op('task_get_bulk', { ids: [id], fields: ['id', 'title'] })
    expect(out.ok).toBe(true)
    const rows = out.ok ? (out.result as any).tasks : []
    expect(rows[0]).toMatchObject({ id, title: 'Bulk row' })
  })
})

describe('a raw non-ASCII URL', () => {
  function rawGet(pathBytes: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
      socket.write(Buffer.concat([Buffer.from('GET '), pathBytes, Buffer.from(' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')]))
    })
  }

  it('answers JSON that says to percent-encode, and the encoded form works', async () => {
    // Two CJK characters (test data, escaped) as raw UTF-8 bytes in the request line.
    const cjk = '\u4f60\u597d'
    const raw = await rawGet(Buffer.from(`/api/tasks?q=${cjk}`, 'utf8'))
    const [head, body] = raw.split('\r\n\r\n')
    expect(head).toMatch(/^HTTP\/1\.1 400 /)
    expect(head).toMatch(/Content-Type: application\/json/i)
    expect(JSON.parse(body!)).toMatchObject({ error: 'invalid_url', message: expect.stringMatching(/percent-encoded/) })
    const ok = await fetch(`http://127.0.0.1:${port}/api/tasks?q=${encodeURIComponent(cjk)}`)
    expect(ok.status).toBe(200)
    await ok.json()
    // The server still serves after the refusal.
    expect((await api('GET', '/api/config')).status).toBe(200)
  })
})
