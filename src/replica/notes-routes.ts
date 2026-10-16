/**
 * The notes reads of a host replica (WP6), answered from the daemon's copy
 * (notes-source.ts). Mounted first on the notes routers (notes-v2.ts for
 * `/api/notes-v2`, api-v1.ts for `/api/v1/notes`); it passes every request on
 * when no copy source is installed, which is always the case on the Mac and the
 * companion, so their notes routes run exactly as before.
 *
 * The shapes are the disk routes' own: the tree is the same JSON, content has
 * the same fields (`id` on v2 only, as there), links, backlinks, tags and the
 * flat list are the same rows. Search is a keyword search of the copy, marked
 * `degraded: 'offline-keyword'` (the leader's semantic index stays on the leader).
 * Writes never reach here: a note write away answers needs_leader until WP11.
 */
import type { NextFunction, Request, Response } from 'express'
import { replicaNotesSource, type NotesSource } from './notes-source.js'
import { log } from '../logging/index.js'

type Flavor = 'v2' | 'v1'

function wildcard(path: string, prefix: string): string {
  let rest = path.slice(prefix.length)
  try { rest = decodeURIComponent(rest) } catch { /* as sent */ }
  return rest
}

function notFound(res: Response, flavor: Flavor, message: string): void {
  if (flavor === 'v1') res.status(404).json({ error: { code: 'not_found', message } })
  else res.status(404).json({ error: message })
}

function badRequest(res: Response, flavor: Flavor, message: string): void {
  if (flavor === 'v1') res.status(400).json({ error: { code: 'bad_request', message } })
  else res.status(400).json({ error: message })
}

async function answer(src: NotesSource, flavor: Flavor, req: Request, res: Response): Promise<boolean> {
  // v2 is mounted at /api/notes-v2 (paths here start at /), v1 at /api/v1 (paths start at /notes).
  const p = flavor === 'v2' ? req.path : req.path.startsWith('/notes') ? req.path.slice('/notes'.length) || '/' : null
  if (p === null) return false
  const asOf = () => { const at = src.asOf(); if (at) res.setHeader('x-walnut-copy-as-of', at) }
  if (p === '/' || p === '') {
    const t = await src.tree()
    asOf()
    res.type('application/json').send(t.json)
    return true
  }
  if (p.startsWith('/content/')) {
    const note = await src.content(wildcard(p, '/content/'))
    if (!note) { notFound(res, flavor, 'Note not found'); return true }
    asOf()
    if (flavor === 'v1') res.json({ content: note.content, contentHash: note.contentHash, updatedAt: note.updatedAt })
    else res.json(note)
    return true
  }
  if (p.startsWith('/backlinks/')) { const r = await src.backlinks(wildcard(p, '/backlinks/')); asOf(); res.json(r); return true }
  if (p.startsWith('/links/')) { const r = await src.links(wildcard(p, '/links/')); asOf(); res.json(r); return true }
  if (p === '/list') { const r = await src.list(); asOf(); res.json(r); return true }
  if (p === '/tags') { const r = await src.tags(); asOf(); res.json(r); return true }
  const tagNotes = /^\/tags\/([^/]+)\/notes$/.exec(p)
  if (tagNotes) {
    let tag = tagNotes[1]!
    try { tag = decodeURIComponent(tag) } catch { /* as sent */ }
    if (!tag.trim()) { badRequest(res, flavor, 'tag required'); return true }
    const r = await src.notesForTag(tag)
    asOf()
    res.json(r)
    return true
  }
  if (p === '/search') {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const r = await src.search(q, Number(req.query.limit) || 30)
    asOf()
    res.json({ ...r, queryTokens: q.toLowerCase().split(/\s+/).filter(Boolean) })
    return true
  }
  return false
}

/** Express middleware: the copy's answer for a notes read on a host replica, else next(). */
export function replicaNotesReads(flavor: Flavor) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const src = req.method === 'GET' || req.method === 'HEAD' ? replicaNotesSource() : null
    if (!src) return next()
    answer(src, flavor, req, res).then((done) => { if (!done) next() }, (err: unknown) => {
      log.web.warn('replica: notes read from the host copy failed', { path: req.path, flavor, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) res.status(503).json(flavor === 'v1'
        ? { error: { code: 'needs_leader', message: 'The notes copy on this host could not be read; your Mac answers this when it is back.', why: 'copy_unreadable' } }
        : { error: 'The notes copy on this host could not be read', code: 'needs_leader', why: 'copy_unreadable' })
    })
  }
}
