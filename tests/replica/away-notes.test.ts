/**
 * The note writes of a host replica while the Mac is away (src/replica/away-notes.ts,
 * WP11): the route table's note-write rows and the handler agree; each answer keeps the
 * shape of the Mac's own route (notes-v2.ts, api-v1.ts) so the editor and the phone
 * cannot tell, and a stale hash is a 409 carrying the text this host shows. The
 * dispatcher's part (req.replicaWrite) is a stub that records what it was asked.
 */
import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ROUTE_TABLE, classify, journals } from '../../src/replica/route-table.js'
import { awayNotes, noteRouteOf } from '../../src/replica/away-notes.js'
import type { ReplicaWriteResult } from '../../src/replica/dispatch.js'

const PHONE = { kind: 'device', deviceId: 'dev-acme-phone', name: 'Acme phone' }

function rig(result: ReplicaWriteResult, actor: object | null = PHONE, capable: boolean | null = true) {
  const asked: Array<{ op: string; args: Record<string, unknown>; actor?: object }> = []
  const app = express()
  app.use(express.json())
  app.use('/api', (req, _res, next) => {
    const d = classify(req.method, req.originalUrl.split('?')[0])
    if (d.away === 'note-write') {
      req.replicaWrite = {
        opId: 'op-acme-0001', away: d.away, raw: Buffer.alloc(0),
        submit: async (op, args, _base, a) => { asked.push({ op, args, ...(a ? { actor: a } : {}) }); return result },
        call: async () => result,
      }
    }
    next()
  })
  app.use('/api', awayNotes({ actorOf: () => actor as never, log: () => {}, capable: () => capable }))
  app.use('/api', (_req, res) => { res.status(599).json({ fellThrough: true }) })
  return { app, asked }
}

describe('note-write rows and the handler agree', () => {
  it('every note-write row is exact and answered by the handler; moves, folders and the rest need the Mac', () => {
    const rows = ROUTE_TABLE.filter((r) => r.away === 'note-write')
    expect(rows.length).toBe(5)
    for (const r of rows) {
      expect(journals(r.away)).toBe(true)
      expect(r.pattern.includes('*'), r.pattern).toBe(false)
      const sample = r.pattern.replace(':path+', 'Acme/Plan.md').replace(/^\/api/, '')
      expect(noteRouteOf(r.method, sample), `${r.method} ${r.pattern}`).not.toBeNull()
    }
    expect(classify('PUT', '/api/notes-v2/content/Acme/Deep/Plan.md')).toMatchObject({ away: 'note-write' })
    expect(classify('PUT', '/api/notes-v2/content/Acme/../escape.md').away).not.toBe('note-write')
    expect(classify('POST', '/api/notes-v2/move')).toMatchObject({ away: 'needs-leader', why: 'note_changes_need_mac' })
    expect(classify('POST', '/api/v1/notes/folder')).toMatchObject({ away: 'needs-leader', why: 'note_changes_need_mac' })
    expect(classify('GET', '/api/notes-v2/content/Acme/Plan.md').away).toBe('read')
  })

  it('noteRouteOf reads the path, decoded, and knows none of the other note routes', () => {
    expect(noteRouteOf('PUT', '/notes-v2/content/Acme/Release%20plan.md')).toEqual({ flavor: 'v2', op: 'put', path: 'Acme/Release plan.md' })
    expect(noteRouteOf('DELETE', '/notes-v2/content/Acme/Plan')).toEqual({ flavor: 'v2', op: 'delete', path: 'Acme/Plan' })
    expect(noteRouteOf('PUT', '/v1/notes/content/Acme/Plan')).toEqual({ flavor: 'v1', op: 'put', path: 'Acme/Plan' })
    expect(noteRouteOf('POST', '/v1/notes')).toEqual({ flavor: 'v1', op: 'create', path: '' })
    expect(noteRouteOf('DELETE', '/v1/notes/Acme/Plan')).toEqual({ flavor: 'v1', op: 'delete', path: 'Acme/Plan' })
    expect(noteRouteOf('DELETE', '/v1/notes/content/Acme/Plan')).toBeNull()
    expect(noteRouteOf('POST', '/notes-v2/move')).toBeNull()
    expect(noteRouteOf('GET', '/notes-v2/content/Acme/Plan.md')).toBeNull()
  })
})

describe('answers in the Mac\'s own shapes', () => {
  const saved: ReplicaWriteResult = { kind: 'applied', reply: { contentHash: 'abc123abc123', updatedAt: '2026-10-17T10:00:00.000Z', noteId: 'n_plan01', seq: 4 } }

  it('a save: the op, its args and the actor; the v2 and v1 answers', async () => {
    const { app, asked } = rig(saved)
    const v2 = await request(app).put('/api/notes-v2/content/Acme/Plan.md').send({ content: '# Plan\n', expectedHash: 'aaaaaaaaaaaa' })
    expect(v2.status).toBe(200)
    expect(v2.body).toEqual({ ok: true, updatedAt: '2026-10-17T10:00:00.000Z', contentHash: 'abc123abc123', id: 'n_plan01' })
    expect(asked[0]).toEqual({ op: 'note_put', args: { path: 'Acme/Plan.md', content: '# Plan\n', expectedHash: 'aaaaaaaaaaaa' }, actor: PHONE })
    const v1 = await request(app).put('/api/v1/notes/content/Acme/Plan').send({ content: '# Plan\n' })
    expect(v1.body).toEqual({ contentHash: 'abc123abc123', updatedAt: '2026-10-17T10:00:00.000Z' })
    expect(asked[1].args).toEqual({ path: 'Acme/Plan', content: '# Plan\n' })
  })

  it('a create is create-only and answers 201 with the path; a delete answers ok', async () => {
    const { app, asked } = rig(saved)
    const made = await request(app).post('/api/v1/notes').send({ path: 'Acme/New', content: 'x' })
    expect(made.status).toBe(201)
    expect(made.body).toEqual({ path: 'Acme/New.md', contentHash: 'abc123abc123', updatedAt: '2026-10-17T10:00:00.000Z' })
    expect(asked[0]).toMatchObject({ op: 'note_put', args: { path: 'Acme/New', content: 'x', createOnly: true } })
    const gone = await request(app).delete('/api/notes-v2/content/Acme/Plan.md')
    expect(gone.status).toBe(200)
    expect(gone.body).toEqual({ ok: true })
    expect(asked[1]).toMatchObject({ op: 'note_delete', args: { path: 'Acme/Plan.md' } })
  })

  it('a stale hash: 409 with the text this host shows, in each route\'s shape', async () => {
    const stale: ReplicaWriteResult = { kind: 'refused', code: 'conflict', message: 'Note was modified since it was read', detail: { serverHash: 'bbbbbbbbbbbb', serverContent: '# Plan\nfrom the phone\n' } }
    const { app } = rig(stale)
    const v2 = await request(app).put('/api/notes-v2/content/Acme/Plan.md').send({ content: 'x', expectedHash: 'aaaaaaaaaaaa' })
    expect(v2.status).toBe(409)
    expect(v2.body).toEqual({ error: 'Content was modified externally', currentHash: 'bbbbbbbbbbbb', serverHash: 'bbbbbbbbbbbb', serverContent: '# Plan\nfrom the phone\n' })
    const v1 = await request(app).put('/api/v1/notes/content/Acme/Plan').send({ content: 'x', expectedHash: 'aaaaaaaaaaaa' })
    expect(v1.status).toBe(409)
    expect(v1.body).toMatchObject({ error: { code: 'conflict' }, serverHash: 'bbbbbbbbbbbb', serverContent: '# Plan\nfrom the phone\n' })
  })

  it('needs the Mac: 503 with the reason; not found: 404; an unknown device: needs the Mac', async () => {
    const tooBig = rig({ kind: 'refused', code: 'needs_leader', message: 'notes over 1 MB can only be changed on your Mac', detail: { why: 'note_too_large' } })
    const r = await request(tooBig.app).put('/api/notes-v2/content/Big.md').send({ content: 'x' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatchObject({ code: 'needs_leader', why: 'note_too_large' })
    const missing = rig({ kind: 'refused', code: 'not_found', message: 'Note not found' })
    expect((await request(missing.app).delete('/api/notes-v2/content/Gone.md')).status).toBe(404)
    const stranger = rig(saved, null)
    const s = await request(stranger.app).put('/api/notes-v2/content/Acme/Plan.md').send({ content: 'x' })
    expect(s.status).toBe(503)
    expect(s.body.error).toMatchObject({ why: 'device_changes_need_mac' })
    expect(stranger.asked).toEqual([])
  })

  it('an older daemon (no note-journal-v1) keeps today\'s answer: needs the Mac, nothing asked', async () => {
    const old = rig(saved, PHONE, false)
    const r = await request(old.app).put('/api/notes-v2/content/Acme/Plan.md').send({ content: 'x' })
    expect(r.status).toBe(503)
    expect(r.body.error).toMatchObject({ code: 'needs_leader', why: 'daemon_needs_upgrade' })
    expect(old.asked).toEqual([])
    const unknown = rig(saved, PHONE, null)
    expect((await request(unknown.app).put('/api/notes-v2/content/Acme/Plan.md').send({ content: 'x' })).body.error).toMatchObject({ why: 'daemon_unreachable' })
  })

  it('a request the dispatcher did not mark goes on to the routes', async () => {
    const { app } = rig(saved)
    expect((await request(app).get('/api/notes-v2/content/Acme/Plan.md')).status).toBe(599)
    expect((await request(app).post('/api/notes-v2/move').send({})).status).toBe(599)
  })
})
