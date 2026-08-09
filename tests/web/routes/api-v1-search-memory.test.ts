/**
 * /api/v1 search + memory + notifications + favorites + notes utilities
 * (Wave 1) — search-memory-v1.ts on the PRIMARY box. Bare express + supertest
 * on an isolated temp home. Verifies each endpoint reuses the shared
 * implementation (memory.ts helpers, notes-v2 op functions, notifications
 * store, config favorites) and speaks the frozen error shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-searchmem'))

import express from 'express'
import request from 'supertest'
import { searchMemoryV1Router } from '../../../src/web/routes/search-memory-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, NOTES_DIR, MEMORY_FILE, USER_FILE } from '../../../src/constants.js'
import { addNotification } from '../../../src/core/notifications/store.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', searchMemoryV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  const { resetIndexBootstrap } = await import('../../../src/web/routes/notes-v2.js')
  resetIndexBootstrap()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/search', () => {
  it('400 bad_request when q is missing', async () => {
    const res = await request(createApp()).get('/api/v1/search')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('returns { results } for a query (task leg on an empty store)', async () => {
    const res = await request(createApp()).get('/api/v1/search?q=anything&types=task&limit=5')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.results)).toBe(true)
  })
})

describe('GET /api/v1/notes/search', () => {
  it('returns empty results for an empty query', async () => {
    const res = await request(createApp()).get('/api/v1/notes/search')
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([])
  })

  it('string-matches a note in the vault', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true })
    await fs.writeFile(path.join(NOTES_DIR, 'wavelength.md'), '# Wavelength\nthe zebra crossed the river\n')
    // The structural index bootstraps asynchronously — reconcile this note NOW
    // so the string leg (index-backed) can see it deterministically.
    const { reconcileNoteNow } = await import('../../../src/core/notes-indexer.js')
    await reconcileNoteNow('wavelength.md')
    const res = await request(createApp()).get('/api/v1/notes/search?q=zebra&mode=string')
    expect(res.status).toBe(200)
    expect(res.body.results.some((r: { path: string }) => r.path === 'wavelength.md')).toBe(true)
  })
})

describe('memory endpoints', () => {
  it('GET /memory/browse returns the tree shape', async () => {
    const res = await request(createApp()).get('/api/v1/memory/browse')
    expect(res.status).toBe(200)
    for (const key of ['global', 'user', 'daily', 'projects', 'sessions', 'knowledge', 'topics', 'special']) {
      expect(res.body.tree).toHaveProperty(key)
    }
  })

  it('GET /memory lists entries', async () => {
    const res = await request(createApp()).get('/api/v1/memory')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.memories)).toBe(true)
  })

  it('PUT then GET /memory/global round-trips MEMORY.md', async () => {
    const app = createApp()
    const put = await request(app).put('/api/v1/memory/global').send({ content: '# Memory\n- learned a thing\n' })
    expect(put.status).toBe(200)
    expect(put.body.ok).toBe(true)
    expect(typeof put.body.updatedAt).toBe('string')
    expect(await fs.readFile(MEMORY_FILE, 'utf-8')).toContain('learned a thing')

    const get = await request(app).get('/api/v1/memory/global')
    expect(get.status).toBe(200)
    expect(get.body.memory.path).toBe('MEMORY.md')
    expect(get.body.memory.content).toContain('learned a thing')
  })

  it('PUT then GET /memory/user round-trips USER.md', async () => {
    const app = createApp()
    const put = await request(app).put('/api/v1/memory/user').send({ content: '# User\n- prefers tea\n' })
    expect(put.status).toBe(200)
    expect(await fs.readFile(USER_FILE, 'utf-8')).toContain('prefers tea')

    const get = await request(app).get('/api/v1/memory/user')
    expect(get.status).toBe(200)
    expect(get.body.memory.content).toContain('prefers tea')
  })

  it('404 not_found when the memory files do not exist', async () => {
    expect((await request(createApp()).get('/api/v1/memory/global')).status).toBe(404)
    expect((await request(createApp()).get('/api/v1/memory/user')).status).toBe(404)
  })

  it('400 when content is not a string', async () => {
    const res = await request(createApp()).put('/api/v1/memory/global').send({ content: 42 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('notifications endpoints', () => {
  it('feed + mark-read + dismiss round trip', async () => {
    const n = await addNotification({ kind: 'cron', severity: 'info', title: 'Routine ran', body: 'All good' })
    const app = createApp()

    const feed = await request(app).get('/api/v1/notifications')
    expect(feed.status).toBe(200)
    expect(feed.body.unreadCount).toBe(1)
    expect(feed.body.feed.some((f: { id: string }) => f.id === n.id)).toBe(true)

    const read = await request(app).post('/api/v1/notifications/mark-read').send({ ids: [n.id] })
    expect(read.status).toBe(200)
    expect(read.body.unreadCount).toBe(0)

    const dismissed = await request(app).post('/api/v1/notifications/dismiss').send({ ids: [n.id] })
    expect(dismissed.status).toBe(200)
    expect(dismissed.body.removed).toBe(1)
  })

  it('400 for a non-array ids', async () => {
    const res = await request(createApp()).post('/api/v1/notifications/mark-read').send({ ids: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('favorites endpoints', () => {
  it('add + list + remove note favorites', async () => {
    const app = createApp()
    const add = await request(app).post('/api/v1/favorites/notes').send({ path: 'Areas/Reading.md' })
    expect(add.status).toBe(200)
    expect(add.body.notes).toContain('Areas/Reading.md')

    const list = await request(app).get('/api/v1/favorites')
    expect(list.status).toBe(200)
    expect(list.body.notes).toContain('Areas/Reading.md')
    expect(Array.isArray(list.body.projects)).toBe(true)

    const del = await request(app).delete('/api/v1/favorites/notes').send({ path: 'Areas/Reading.md' })
    expect(del.status).toBe(200)
    expect(del.body.notes).not.toContain('Areas/Reading.md')
  })

  it('400 when path is missing', async () => {
    const res = await request(createApp()).post('/api/v1/favorites/notes').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('notes utilities (attachment / move / folder)', () => {
  it('POST + GET /notes/attachment round-trips a pasted image', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true })
    await fs.writeFile(path.join(NOTES_DIR, 'host-note.md'), '# Host\n')
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const app = createApp()

    const up = await request(app)
      .post('/api/v1/notes/attachment')
      .send({ notePath: 'host-note.md', data: png, mediaType: 'image/png' })
    expect(up.status).toBe(200)
    expect(up.body.ok).toBe(true)
    expect(up.body.path).toMatch(/^_attachment\/pasted-image-.*\.png$/)

    const down = await request(app).get(`/api/v1/notes/attachment?path=${encodeURIComponent(up.body.path)}`)
    expect(down.status).toBe(200)
    expect(down.headers['content-type']).toBe('image/png')
  })

  it('GET /notes/attachment 404 not_found for a missing file', async () => {
    const res = await request(createApp()).get('/api/v1/notes/attachment?path=missing.png')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('POST /notes/move renames a note; 409 conflict on an existing target', async () => {
    await fs.mkdir(NOTES_DIR, { recursive: true })
    await fs.writeFile(path.join(NOTES_DIR, 'from-note.md'), '# From\n')
    await fs.writeFile(path.join(NOTES_DIR, 'taken.md'), '# Taken\n')
    const app = createApp()

    const moved = await request(app).post('/api/v1/notes/move').send({ from: 'from-note.md', to: 'sub/to-note.md' })
    expect(moved.status).toBe(200)
    await expect(fs.stat(path.join(NOTES_DIR, 'sub/to-note.md'))).resolves.toBeTruthy()

    await fs.writeFile(path.join(NOTES_DIR, 'another.md'), '# A\n')
    const clash = await request(app).post('/api/v1/notes/move').send({ from: 'another.md', to: 'taken.md' })
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('conflict')
  })

  it('POST /notes/folder creates a folder; traversal is rejected', async () => {
    const app = createApp()
    const ok = await request(app).post('/api/v1/notes/folder').send({ path: 'new/folder' })
    expect(ok.status).toBe(200)
    await expect(fs.stat(path.join(NOTES_DIR, 'new/folder'))).resolves.toBeTruthy()

    const bad = await request(app).post('/api/v1/notes/folder').send({ path: '../escape' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('bad_request')
  })
})
