/**
 * The note saves the cloud companion answers itself (stage 4c of
 * docs/plan/walnut-companion-unified-replica.md): a note PUT, a v1 create and a
 * delete become `note` records in its journal (core/companion-notes.ts
 * companionNoteSave) once its copy of the notes is held and the Mac drains notes;
 * until then, and for every other notes write, the route runs as before.
 *
 * Mounted on the notes routers after the copy reads (notes-v2.ts, api-v1.ts), so a
 * v1 save the companion forwards to the Mac while it answers never reaches here.
 * The answers are the Mac's routes' own shapes (away-notes.ts builds them): a stale
 * lock hash answers 409 with the text this box shows, so the editor merges.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { companionNoteSave, companionNotesWritable } from '../core/companion-notes.js'
import { log } from '../logging/index.js'
import { applied, noteRouteOf, refusedAnswer } from './away-notes.js'
import { refusalAnswer, type PortAnswer } from './write-port.js'

function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

function send(res: Response, a: PortAnswer): void {
  if (a.answered || res.headersSent) return
  if (a.status === 503 || a.status === 429) {
    const after = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
    if (typeof after === 'number') res.setHeader('retry-after', String(after))
  }
  res.status(a.status).json(a.body)
}

export function companionNoteWrites(flavor: 'v1' | 'v2'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'PUT' && req.method !== 'POST' && req.method !== 'DELETE') { next(); return }
    // The router's own paths: v2 at /api/notes-v2, v1 at /api/v1.
    const route = noteRouteOf(req.method, flavor === 'v2' ? `/notes-v2${req.path}` : `/v1${req.path}`)
    if (!route || !companionNotesWritable()) { next(); return }
    const b = bodyOf(req)
    const notePath = route.op === 'create' ? (typeof b.path === 'string' ? b.path : '') : route.path
    if (!notePath) {
      send(res, refusalAnswer('bad_request', 'path (string) is required'))
      return
    }
    const r = companionNoteSave(route.op === 'delete'
      ? { path: notePath, mode: 'delete' }
      : { path: notePath, content: route.op === 'create' && typeof b.content !== 'string' ? '' : b.content, expectedHash: b.expectedHash, createOnly: route.op === 'create' })
    if (r.ok) {
      log.web.info('companion: note change kept for the Mac', { path: notePath, op: route.op, seq: r.seq, ...(r.coalesced ? { coalesced: true } : {}) })
      send(res, applied(route, { contentHash: r.contentHash, updatedAt: r.updatedAt, ...(r.noteId ? { noteId: r.noteId } : {}) }, notePath))
      return
    }
    log.web.info('companion: note change refused', { path: notePath, op: route.op, code: r.code })
    const retry = typeof r.detail?.retryAfterMs === 'number' ? r.detail.retryAfterMs : undefined
    send(res, refusedAnswer(route, r.code, r.message, r.detail, retry))
  }
}
