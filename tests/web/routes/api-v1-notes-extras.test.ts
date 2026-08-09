/**
 * /api/v1 notes extras (Wave 2) — notes-extras-v1.ts: global scratchpad
 * (optimistic locking), backlinks/links, tags, and the destructive
 * attachment/folder deletes — including the vault-containment guard the
 * deletes inherit from resolveSafePath (traversal → 400, root delete → 400).
 * Class A everywhere, so no cloud twin file: behavior is identical on a
 * REPLICA.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-notesextras'))

import express from 'express'
import request from 'supertest'
import { notesExtrasV1Router } from '../../../src/web/routes/notes-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, NOTES_DIR, GLOBAL_NOTES_FILE } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/v1', notesExtrasV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(NOTES_DIR, { recursive: true })
})

afterEach(async () => {
  const { resetIndexBootstrap } = await import('../../../src/web/routes/notes-v2.js')
  resetIndexBootstrap()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('global notes', () => {
  it('GET returns empty content before first write; PUT round-trips', async () => {
    const app = createApp()
    const empty = await request(app).get('/api/v1/notes/global')
    expect(empty.status).toBe(200)
    expect(empty.body.content).toBe('')

    const put = await request(app).put('/api/v1/notes/global').send({ content: '# Scratch\nfrom the phone\n' })
    expect(put.status).toBe(200)
    expect(put.body.ok).toBe(true)
    expect(typeof put.body.contentHash).toBe('string')
    expect(await fs.readFile(GLOBAL_NOTES_FILE, 'utf-8')).toContain('from the phone')
  })

  it('optimistic locking: stale expectedHash → 409 conflict with currentHash', async () => {
    const app = createApp()
    await request(app).put('/api/v1/notes/global').send({ content: 'v1' })
    const res = await request(app).put('/api/v1/notes/global').send({ content: 'v2', expectedHash: 'stale-hash' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(typeof res.body.currentHash).toBe('string')
  })

  it('400 for non-string content; 413 too_large past the cap', async () => {
    const app = createApp()
    const bad = await request(app).put('/api/v1/notes/global').send({ content: 42 })
    expect(bad.status).toBe(400)
    const big = await request(app).put('/api/v1/notes/global').send({ content: 'x'.repeat(2_000_001) })
    expect(big.status).toBe(413)
    expect(big.body.error.code).toBe('too_large')
  })
})

describe('backlinks / links', () => {
  it('returns the inbound edge after both notes are indexed', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'target.md'), '# Target\ncontent\n')
    await fs.writeFile(path.join(NOTES_DIR, 'source.md'), '# Source\nlinks to [[target]]\n')
    const { reconcileNoteNow } = await import('../../../src/core/notes-indexer.js')
    await reconcileNoteNow('target.md')
    await reconcileNoteNow('source.md')

    const app = createApp()
    const back = await request(app).get('/api/v1/notes/backlinks/target.md')
    expect(back.status).toBe(200)
    expect(back.body.backlinks.some((b: { path: string }) => b.path === 'source.md')).toBe(true)

    const fwd = await request(app).get('/api/v1/notes/links/source.md')
    expect(fwd.status).toBe(200)
    expect(fwd.body.links.length).toBeGreaterThan(0)
  })

  it('400 for a traversal path', async () => {
    const res = await request(createApp()).get('/api/v1/notes/backlinks/..%2F..%2Fetc')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

describe('tags', () => {
  it('lists tag counts and the notes under a tag', async () => {
    await fs.writeFile(path.join(NOTES_DIR, 'tagged.md'), '# Tagged\n#wave2demo content\n')
    const { reconcileNoteNow } = await import('../../../src/core/notes-indexer.js')
    await reconcileNoteNow('tagged.md')

    const app = createApp()
    const tags = await request(app).get('/api/v1/notes/tags')
    expect(tags.status).toBe(200)
    expect(tags.body.tags.some((t: { tag: string }) => t.tag === 'wave2demo')).toBe(true)

    const notes = await request(app).get('/api/v1/notes/tags/wave2demo/notes')
    expect(notes.status).toBe(200)
    expect(notes.body.notes.some((n: { path: string }) => n.path === 'tagged.md')).toBe(true)
  })
})

describe('destructive deletes', () => {
  it('DELETE attachment removes the binary; .md paths refuse (own the note route)', async () => {
    await fs.mkdir(path.join(NOTES_DIR, '_attachment'), { recursive: true })
    const attPath = path.join(NOTES_DIR, '_attachment', 'img.png')
    await fs.writeFile(attPath, Buffer.from([0x89, 0x50]))

    const app = createApp()
    const ok = await request(app).delete('/api/v1/notes/attachment/_attachment/img.png')
    expect(ok.status).toBe(200)
    await expect(fs.access(attPath)).rejects.toThrow()

    const md = await request(app).delete('/api/v1/notes/attachment/some-note.md')
    expect(md.status).toBe(400)
    const missing = await request(app).delete('/api/v1/notes/attachment/_attachment/ghost.png')
    expect(missing.status).toBe(404)
  })

  it('DELETE folder removes recursively and reports the note count', async () => {
    await fs.mkdir(path.join(NOTES_DIR, 'doomed', 'inner'), { recursive: true })
    await fs.writeFile(path.join(NOTES_DIR, 'doomed', 'a.md'), 'a')
    await fs.writeFile(path.join(NOTES_DIR, 'doomed', 'inner', 'b.md'), 'b')

    const res = await request(createApp()).delete('/api/v1/notes/folder/doomed')
    expect(res.status).toBe(200)
    expect(res.body.deletedNotes).toBe(2)
    await expect(fs.access(path.join(NOTES_DIR, 'doomed'))).rejects.toThrow()
  })

  it('SANDBOX: folder delete refuses traversal and the vault root', async () => {
    const app = createApp()
    const traversal = await request(app).delete('/api/v1/notes/folder/..%2F..%2Fetc')
    expect(traversal.status).toBe(400)
    // 'sub/..' resolves to NOTES_DIR itself — the root guard must refuse it.
    const root = await request(app).delete('/api/v1/notes/folder/sub%2F..')
    expect(root.status).toBe(400)
    const missing = await request(app).delete('/api/v1/notes/folder/no-such-dir')
    expect(missing.status).toBe(404)
  })
})
