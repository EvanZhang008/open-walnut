/**
 * The drawing routes (src/web/routes/drawings.ts): the answer shapes the editor and the Drawing
 * plugin's ops read, ETag and If-None-Match (quoted, weak, lists), the 409 body, the 404s, and
 * the replica refusal.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('drawings-routes'))
const role = vi.hoisted(() => ({ follower: false }))
vi.mock('../../../src/core/server-role.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/server-role.js')>()),
  isFollower: () => role.follower,
}))
// The notes index is not under test: keep the reconciler off the real search index.
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  searchV2Lane: vi.fn(async () => []),
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
  getSearchIndexStatus: vi.fn(() => ({ enabled: true, model: null, docs: 0, byKind: {}, backfillRunning: false, error: null })),
  searchIndexBackfillRunning: vi.fn(() => false),
}))

import express from 'express'
import request from 'supertest'
import { NOTES_DIR } from '../../../src/constants.js'
import { drawingsRouter, ifNoneMatchNames } from '../../../src/web/routes/drawings.js'
import { deleteNoteAttachment, moveNote, settleIndexBootstrap } from '../../../src/web/routes/notes-v2.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { addTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { classify } from '../../../src/replica/route-table.js'

const app = express()
app.use(express.json({ limit: '15mb' }))
app.use('/api/drawings', drawingsRouter)
app.use(errorHandler)

let taskId = ''

beforeAll(async () => {
  await fs.mkdir(NOTES_DIR, { recursive: true })
  taskId = (await addTask({ title: 'Route task', project: 'Routes' })).task.id
})

afterAll(async () => {
  await settleIndexBootstrap()
  closeDb()
})

describe('drawing routes', () => {
  it('creates, reads with an ETag, and answers 304 to the revision the client holds', async () => {
    const created = await request(app).post('/api/drawings').send({ title: 'Board', taskId })
    expect(created.status).toBe(200)
    expect(Object.keys(created.body).sort()).toEqual(['path', 'revision', 'scene', 'taskId', 'title'])
    expect(created.body.scene).toMatchObject({ type: 'excalidraw', version: 2, source: 'walnut', elements: [], files: {} })
    expect(created.body.path).toMatch(/^Projects\/Routes\/Route task \(.+\)\/Board\.excalidraw$/)
    expect(created.headers.etag).toBe(`"${created.body.revision}"`)

    const url = `/api/drawings/file?path=${encodeURIComponent(created.body.path)}`
    const full = await request(app).get(url)
    expect(full.status).toBe(200)
    expect(full.headers.etag).toBe(`"${created.body.revision}"`)
    expect(full.body).toMatchObject({ path: created.body.path, revision: created.body.revision, title: 'Board' })
    for (const tag of [`"${created.body.revision}"`, `W/"${created.body.revision}"`, `"other", "${created.body.revision}"`, created.body.revision]) {
      const cached = await request(app).get(url).set('If-None-Match', tag)
      expect(cached.status, tag).toBe(304)
      expect(cached.headers.etag).toBe(`"${created.body.revision}"`)
    }
    expect((await request(app).get(url).set('If-None-Match', '"stale"')).status).toBe(200)
  })

  it('lists by task and by session context with ISO update times', async () => {
    const res = await request(app).get(`/api/drawings?taskId=${encodeURIComponent(taskId)}`)
    expect(res.status).toBe(200)
    expect(res.body.drawings).toHaveLength(1)
    const [entry] = res.body.drawings
    expect(Object.keys(entry).sort()).toEqual(['path', 'revision', 'taskId', 'title', 'updatedAt'])
    expect(new Date(entry.updatedAt).toISOString()).toBe(entry.updatedAt)
    expect((await request(app).get('/api/drawings?sessionId=missing')).status).toBe(404)
    expect((await request(app).get('/api/drawings?taskId=a&taskId=b')).status).toBe(400)
  })

  it('saves with the current revision and answers a stale one 409 with the current document', async () => {
    const created = (await request(app).post('/api/drawings').send({ title: 'Saves' })).body
    const scene = { ...created.scene, elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }
    const saved = await request(app).put('/api/drawings/file').send({ path: created.path, revision: created.revision, scene })
    expect(saved.status).toBe(200)
    expect(saved.body.scene.elements).toHaveLength(1)
    const stale = await request(app).put('/api/drawings/file').send({ path: created.path, revision: created.revision, scene: created.scene })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/changed/)
    expect(Object.keys(stale.body.current).sort()).toEqual(['path', 'revision', 'scene', 'title'])
    expect(stale.body.current.revision).toBe(saved.body.revision)

    const appended = await request(app).post('/api/drawings/append').send({ path: created.path, revision: saved.body.revision, elements: [{ type: 'text', x: 0, y: 50, text: 'hi' }] })
    expect(appended.status).toBe(200)
    expect(appended.body.scene.elements.map((e: { id: string }) => e.id)[0]).toBe('a')
    const staleAppend = await request(app).post('/api/drawings/append').send({ path: created.path, revision: saved.body.revision, elements: [{ type: 'text', x: 0, y: 0, text: 'x' }] })
    expect(staleAppend.status).toBe(409)
    expect(staleAppend.body.current.revision).toBe(appended.body.revision)
  })

  it('edits in one step with an idMap, refuses a stale edit, and renders', async () => {
    const created = (await request(app).post('/api/drawings').send({ title: 'Edits' })).body
    const edited = await request(app).post('/api/drawings/update').send({ path: created.path, revision: created.revision, add: [{ id: 'n1', type: 'rectangle', x: 0, y: 0, text: 'Node' }] })
    expect(edited.status).toBe(200)
    expect(Object.keys(edited.body.idMap)).toEqual(['n1'])
    const moved = await request(app).post('/api/drawings/update').send({ path: created.path, revision: edited.body.revision, update: [{ id: edited.body.idMap.n1, x: 40 }] })
    expect(moved.status).toBe(200)
    expect(moved.body.scene.elements[0]).toMatchObject({ x: 40, version: 2 })
    const stale = await request(app).post('/api/drawings/update').send({ path: created.path, revision: edited.body.revision, remove: [edited.body.idMap.n1] })
    expect(stale.status).toBe(409)
    expect(stale.body.current.revision).toBe(moved.body.revision)
    const bad = await request(app).post('/api/drawings/update').send({ path: created.path, revision: moved.body.revision, update: [{ id: edited.body.idMap.n1, id2: 1 }] })
    expect(bad.status).toBe(400)
    const render = await request(app).get(`/api/drawings/render?path=${encodeURIComponent(created.path)}&format=svg`)
    expect(render.status).toBe(200)
    expect(render.body).toMatchObject({ path: created.path, revision: moved.body.revision, format: 'svg', svgPath: expect.stringMatching(/\.svg$/) })
    expect(render.body.width).toBeGreaterThan(0)
  })

  it('answers bad input 400, a missing drawing or task 404', async () => {
    expect((await request(app).get('/api/drawings/file?path=..%2Fsecret.excalidraw')).status).toBe(400)
    expect((await request(app).get('/api/drawings/file')).status).toBe(400)
    expect((await request(app).get('/api/drawings/file?path=inbox%2Fnope.excalidraw')).status).toBe(404)
    expect((await request(app).post('/api/drawings').send({ taskId: 'missing-task' })).status).toBe(404)
    expect((await request(app).put('/api/drawings/file').send({ path: 'inbox/Saves.excalidraw', revision: 'x', scene: { elements: 'no' } })).status).toBe(400)
    expect((await request(app).post('/api/drawings/append').send({ path: 'inbox/Saves.excalidraw', revision: 'x', elements: [] })).status).toBe(400)
  })

  it('moves and deletes a drawing in Notes together with its own companion only', async () => {
    const created = (await request(app).post('/api/drawings').send({ title: 'Moving' })).body
    const added = (await request(app).post('/api/drawings/append').send({ path: created.path, revision: created.revision, elements: [{ type: 'text', x: 0, y: 0, text: 'carried' }] })).body
    await moveNote(created.path, 'archive/Moved.excalidraw')
    await expect(fs.access(path.join(NOTES_DIR, 'inbox/Moving.drawing.md'))).rejects.toThrow()
    const md = await fs.readFile(path.join(NOTES_DIR, 'archive/Moved.drawing.md'), 'utf-8')
    expect(md).toContain('drawing: Moved.excalidraw')
    expect(md).toContain(`path=${encodeURIComponent('archive/Moved.excalidraw')}`)
    expect(md).toContain('- carried')
    const read = await request(app).get(`/api/drawings/file?path=${encodeURIComponent('archive/Moved.excalidraw')}`)
    expect(read.body.revision).toBe(added.revision)
    // A save against the old path finds nothing there: it is never put back.
    const stale = await request(app).put('/api/drawings/file').send({ path: created.path, revision: added.revision, scene: added.scene })
    expect(stale.status).toBe(404)
    await expect(fs.access(path.join(NOTES_DIR, created.path))).rejects.toThrow()

    // A note of someone's own beside a drawing stays when the drawing is deleted.
    const other = (await request(app).post('/api/drawings').send({ title: 'Kept note' })).body
    await fs.writeFile(path.join(NOTES_DIR, 'inbox/Kept note.drawing.md'), '# mine\n')
    await deleteNoteAttachment(other.path)
    expect(await fs.readFile(path.join(NOTES_DIR, 'inbox/Kept note.drawing.md'), 'utf-8')).toBe('# mine\n')
    await deleteNoteAttachment('archive/Moved.excalidraw')
    await expect(fs.access(path.join(NOTES_DIR, 'archive/Moved.drawing.md'))).rejects.toThrow()
  })

  it('takes a text body and answers with the scene bytes as they are on disk', async () => {
    const created = (await request(app).post('/api/drawings').send({ title: 'Text body' })).body
    const textApp = express()
    textApp.use('/api/drawings', express.text({ type: 'application/json', limit: '15mb' }))
    textApp.use('/api/drawings', drawingsRouter)
    const scene = { ...created.scene, elements: [{ id: 'a', type: 'rectangle', x: 1, y: 2, width: 3, height: 4 }] }
    const res = await request(textApp).put('/api/drawings/file').set('Content-Type', 'application/json').send(JSON.stringify({ path: created.path, revision: created.revision, scene }))
    expect(res.status).toBe(200)
    expect(res.text.endsWith(`"scene":${(await fs.readFile(path.join(NOTES_DIR, created.path), 'utf-8')).trimEnd()}}`)).toBe(true)
    expect(res.body.scene.elements[0]).toMatchObject({ id: 'a' })
    expect((await request(textApp).post('/api/drawings').set('Content-Type', 'application/json').send('{not json')).status).toBe(400)
  })

  it('answers needs_leader on a replica instead of reading a copy', async () => {
    role.follower = true
    try {
      const res = await request(app).get('/api/drawings')
      expect(res.status).toBe(503)
      expect(res.body.error).toMatchObject({ code: 'needs_leader', why: 'drawings_need_leader' })
    } finally {
      role.follower = false
    }
  })

  it('sends every drawing route to the leader on a replica, list and create included', () => {
    for (const [method, url] of [['GET', '/api/drawings'], ['POST', '/api/drawings'], ['GET', '/api/drawings/file'], ['PUT', '/api/drawings/file'], ['POST', '/api/drawings/append'], ['POST', '/api/drawings/update'], ['GET', '/api/drawings/render']]) {
      expect(classify(method!, url!), `${method} ${url}`).toMatchObject({ cls: 'leader', away: 'needs-leader', why: 'drawings_need_leader' })
    }
  })

  it('reads If-None-Match the way HTTP writes it', () => {
    expect(ifNoneMatchNames(undefined, 'r')).toBe(false)
    expect(ifNoneMatchNames('*', 'r')).toBe(true)
    expect(ifNoneMatchNames(' W/"r" ', 'r')).toBe(true)
    expect(ifNoneMatchNames('"a","b"', 'r')).toBe(false)
  })
})
