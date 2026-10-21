/**
 * The note saves the cloud companion answers itself (stage 4c of
 * docs/plan/walnut-companion-unified-replica.md): a note PUT, a v1 create and a
 * delete become `note` records in its journal (core/companion-notes.ts
 * companionNoteSave) once its copy of the notes is held and the Mac drains notes;
 * until then, and for every other notes write, the route runs as before.
 *
 * Stage 4d: a note move or rename, a tag rename and a folder change are answered here
 * too (core/companion-note-paths.ts): a move is a `note-move` record once the Mac drains
 * that kind, a tag rename is a `note` save of each carrying note, and a folder change
 * needs the Mac. A picture or file move takes the old path.
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
import { needsLeaderAnswer, refusalAnswer, type PortAnswer } from './write-port.js'

type PathRoute = 'move' | 'tags' | 'folder'

/** A note path route (4d), by the router's own path: v2 at /api/notes-v2, v1 at /api/v1. */
function pathRouteOf(flavor: 'v1' | 'v2', method: string, p: string): PathRoute | null {
  const rest = flavor === 'v2' ? p : p.startsWith('/notes/') ? p.slice('/notes'.length) : null
  if (rest === null) return null
  if (method === 'POST' && rest === '/move') return 'move'
  if (method === 'POST' && rest === '/tags/rename') return 'tags'
  if ((method === 'POST' && rest === '/folder') || (method === 'DELETE' && rest.startsWith('/folder/'))) return 'folder'
  return null
}

const V1_CODE: Record<number, string> = { 400: 'bad_request', 404: 'not_found', 409: 'conflict' }
const STATUS: Record<string, number> = { bad_request: 400, not_found: 404, conflict: 409 }

/** A refusal in the route's shape: its own errors as the disk route answers them, the rest as the port's. */
function pathRefusal(flavor: 'v1' | 'v2', r: { code: string; message: string; detail?: Record<string, unknown> }): PortAnswer {
  const status = STATUS[r.code]
  if (status) return { answered: false, status, body: flavor === 'v2' ? { error: r.message } : { error: { code: V1_CODE[status], message: r.message } } }
  if (r.code === 'needs_leader') return needsLeaderAnswer(typeof r.detail?.why === 'string' ? r.detail.why : 'needs_mac', r.message)
  const retry = typeof r.detail?.retryAfterMs === 'number' ? r.detail.retryAfterMs : undefined
  return refusalAnswer(r.code, r.message, r.detail, retry)
}

async function answerNotePath(flavor: 'v1' | 'v2', route: PathRoute, req: Request): Promise<PortAnswer | null> {
  const paths = await import('../core/companion-note-paths.js')
  const b = bodyOf(req)
  if (route === 'folder') return pathRefusal(flavor, paths.companionFolderChange())
  if (route === 'move') {
    // A picture or file is not a note (its move keeps the old path); nor is a Mac that does not drain moves.
    if (paths.isAttachmentMove(b.from) || !paths.companionMovesNotes()) return null
    const r = paths.companionNoteMove({ from: b.from, to: b.to })
    if (!r.ok) return pathRefusal(flavor, r)
    log.web.info('companion: note move kept for the Mac', { from: b.from, to: b.to, seq: r.seq })
    return { answered: false, status: 200, body: { ok: true } }
  }
  const r = await paths.companionTagRename({ from: b.from, to: b.to })
  if (!r.ok) return pathRefusal(flavor, r)
  return { answered: false, status: 200, body: { ok: true, updated: r.updated ?? 0 } }
}

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
    const pathRoute = pathRouteOf(flavor, req.method, req.path)
    if (pathRoute) {
      if (!companionNotesWritable()) { next(); return }
      answerNotePath(flavor, pathRoute, req).then((a) => { if (a) send(res, a); else next() }, next)
      return
    }
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
