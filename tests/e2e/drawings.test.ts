/**
 * E2E: a drawing through a real server (startServer on port 0, real task store, real vault).
 * A task drawing is created in the task's project folder, an agent-style append lands with a
 * label and an arrow, the editor's poll gets 304, a stale save gets 409 with the current scene,
 * and the companion note is in the Notes tree, readable as a note and found by Notes search
 * through the index's own NOTES_UPDATED hook. The scene itself is served as a Notes attachment.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('drawings-e2e'))

import { NOTES_DIR, WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

let server: HttpServer
let base = ''

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? (() => { try { return JSON.parse(text) } catch { return text } })() : null }
}

async function eventually<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(NOTES_DIR, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  base = `http://localhost:${(server.address() as { port: number }).port}`
}, 30_000)

afterAll(async () => {
  if (server) await stopServer(server)
})

describe('drawings end to end', () => {
  it('creates, appends, polls, conflicts, and shows up in Notes', async () => {
    const task = await call('POST', '/api/tasks', { title: 'Design the ingest path', project: 'Platform' })
    expect(task.status).toBe(201)
    const taskId = task.body.task.id as string

    const created = await call('POST', '/api/drawings', { taskId, title: 'Ingest' })
    expect(created.status).toBe(200)
    expect(created.body.path).toBe(`Projects/Platform/Design the ingest path (${taskId})/Ingest.excalidraw`)
    const path = created.body.path as string

    const appended = await call('POST', '/api/drawings/append', {
      path, revision: created.body.revision,
      elements: [
        { id: 'src', type: 'rectangle', x: 0, y: 0, width: 160, height: 60, text: 'Collector zebrafinch' },
        { id: 'dst', type: 'ellipse', x: 400, y: 0, width: 120, height: 80, text: 'Store' },
        { type: 'arrow', start: { id: 'src' }, end: { id: 'dst' } },
      ],
    })
    expect(appended.status).toBe(200)
    expect(appended.body.indexWarning).toBeUndefined()
    const els = appended.body.scene.elements as Array<Record<string, unknown>>
    expect(els.map((e) => e.type)).toEqual(['rectangle', 'text', 'ellipse', 'text', 'arrow'])
    expect(els.find((e) => e.type === 'arrow')!.endBinding).toMatchObject({ elementId: appended.body.idMap.dst })

    const fileUrl = `/api/drawings/file?path=${encodeURIComponent(path)}`
    const polled = await call('GET', fileUrl, undefined, { 'If-None-Match': `"${appended.body.revision}"` })
    expect(polled.status).toBe(304)

    const stale = await call('PUT', '/api/drawings/file', { path, revision: created.body.revision, scene: created.body.scene })
    expect(stale.status).toBe(409)
    expect(stale.body.current.revision).toBe(appended.body.revision)
    expect(stale.body.current.scene.elements).toHaveLength(5)

    const listed = await call('GET', `/api/drawings?taskId=${encodeURIComponent(taskId)}`)
    expect(listed.body.drawings.map((d: { path: string }) => d.path)).toEqual([path])

    // Notes: the tree lists the scene and its companion; the scene is an attachment (JSON).
    const tree = await call('GET', '/api/notes-v2')
    const flat: Array<{ path: string; kind?: string }> = []
    const walk = (nodes: Array<{ path: string; kind?: string; children?: unknown[] }>) => {
      for (const n of nodes) { if (n.children) walk(n.children as never); else flat.push(n) }
    }
    walk(tree.body.tree)
    const mdPath = path.replace(/\.excalidraw$/, '.drawing.md')
    expect(flat.find((n) => n.path === path)?.kind).toBe('attachment')
    expect(flat.find((n) => n.path === mdPath)?.kind).toBe('note')
    const attachment = await fetch(`${base}/api/notes-v2/attachment?path=${encodeURIComponent(path)}`)
    expect(attachment.status).toBe(200)
    expect(attachment.headers.get('content-type')).toMatch(/^application\/json/)
    expect(JSON.parse(await attachment.text()).elements).toHaveLength(5)

    const note = await call('GET', `/api/notes-v2/content/${mdPath.split('/').map(encodeURIComponent).join('/')}`)
    expect(note.status).toBe(200)
    expect(note.body.content).toContain('- Collector zebrafinch')
    expect(note.body.content).toContain(`/apps/walnut-drawing~main?path=${encodeURIComponent(path)}`)

    // Search finds the drawing's words through the companion, via the index's existing hooks.
    const hit = await eventually(async () => {
      const res = await call('GET', '/api/notes-v2/search?q=zebrafinch')
      return (res.body?.results as Array<{ path: string }> | undefined)?.find((r) => r.path === mdPath)
    })
    expect(hit.path).toBe(mdPath)
  }, 60_000)

  it('refuses a missing task, traversal and an oversize body', async () => {
    expect((await call('POST', '/api/drawings', { taskId: 'nope-0000' })).status).toBe(404)
    expect((await call('GET', '/api/drawings/file?path=..%2F..%2Fetc%2Fpasswd.excalidraw')).status).toBe(400)
    const inbox = await call('POST', '/api/drawings', {})
    // No title, no task, no first text: named by the date, never "Untitled drawing".
    expect(inbox.body.path).toMatch(/^inbox\/Drawing \d{4}-\d\d-\d\d \d\d\.\d\d( \d+)?\.excalidraw$/)
    const huge = { ...inbox.body.scene, files: { f: { dataURL: 'x'.repeat(10 * 1024 * 1024) } } }
    const res = await call('PUT', '/api/drawings/file', { path: inbox.body.path, revision: inbox.body.revision, scene: huge })
    expect(res.status).toBe(413)
    const again = await call('GET', `/api/drawings/file?path=${encodeURIComponent(inbox.body.path)}`)
    expect(again.body.revision).toBe(inbox.body.revision)
  }, 30_000)
})
