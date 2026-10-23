/**
 * The note saves the cloud companion answers itself (stage 4c of
 * docs/plan/walnut-companion-unified-replica.md): a note PUT, a v1 create and a
 * delete become `note` records in its journal (core/companion-notes.ts
 * companionNoteSave) once its copy of the notes is held and the Mac drains notes.
 *
 * Stage 4d: a note move or rename, a tag rename and a folder change are answered here
 * too (core/companion-note-paths.ts): a move is a `note-move` record once the Mac drains
 * that kind, a tag rename is a `note` save of each carrying note, and a folder change
 * needs the Mac. A pasted picture is a `note-attachment` record with its bytes, once the
 * Mac drains that kind (core/companion-note-attachments.ts); moving or deleting a picture
 * or file needs the Mac.
 *
 * The box never writes its own disk for a note any more, which git sync stops keeping
 * as the Mac's vault: a change it cannot journal (no copy yet, a Mac too old to drain the
 * kind) needs the Mac, and so do the notes index writes (rebuild, id stamping), the Mac's
 * index's own. A notes read the copy cannot answer yet (no whole manifest) needs the Mac
 * too, rather than reading the box's disk; pictures (their own copy), searches (the copy
 * or the Mac, notes-v2.ts performNotesSearch) and the global notes (notes.ts) decide for
 * themselves.
 *
 * A change of what the box's copy does not keep (notes off for it, a folder or a note left
 * out, a tag the left-out notes may carry) is the Mac's: it goes there while the Mac
 * answers (core/companion-forward.ts) and needs the Mac while it is away (4f).
 *
 * Mounted on the notes routers after the copy reads (notes-v2.ts, api-v1.ts), so a
 * v1 save the companion forwards to the Mac while it answers never reaches here.
 * The answers are the Mac's routes' own shapes (away-notes.ts builds them): a stale
 * lock hash answers 409 with the text this box shows, so the editor merges.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { companionNoteKept, companionNoteSave, companionNotesBlocked, companionNotesPartial, noteKeyOf } from '../core/companion-notes.js'
import { forwardUnkept } from '../core/companion-forward.js'
import { companionCopyHolds } from '../core/companion-host-replica.js'
import { isCompanion } from '../core/server-role.js'
import { log } from '../logging/index.js'
import { applied, noteRouteOf, refusedAnswer } from './away-notes.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer } from './write-port.js'

type PathRoute = 'move' | 'tags' | 'folder' | 'paste' | 'attachment'

/** A note path route (4d), by the router's own path: v2 at /api/notes-v2, v1 at /api/v1. */
function pathRouteOf(flavor: 'v1' | 'v2', method: string, p: string): PathRoute | null {
  const rest = flavor === 'v2' ? p : p.startsWith('/notes/') ? p.slice('/notes'.length) : null
  if (rest === null) return null
  if (method === 'POST' && rest === '/move') return 'move'
  if (method === 'POST' && rest === '/tags/rename') return 'tags'
  if ((method === 'POST' && rest === '/folder') || (method === 'DELETE' && rest.startsWith('/folder/'))) return 'folder'
  if (method === 'POST' && rest === '/attachment') return 'paste'
  if (method === 'DELETE' && rest.startsWith('/attachment/')) return 'attachment'
  return null
}

const V1_CODE: Record<number, string> = { 400: 'bad_request', 404: 'not_found', 409: 'conflict', 413: 'too_large' }
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
  if (route === 'paste' || route === 'attachment' || (route === 'move' && paths.isAttachmentMove(b.from))) {
    const pics = await import('../core/companion-note-attachments.js')
    if (route !== 'paste') return pathRefusal(flavor, pics.companionAttachmentChange())
    // A Mac that does not drain pastes: the box cannot keep it for the Mac.
    if (!pics.companionJournalsPastes()) return pathRefusal(flavor, { code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a picture later; it needs your Mac.', detail: { why: 'mac_too_old' } })
    const r = await pics.companionAttachmentPaste({ notePath: b.notePath, data: b.data, mediaType: b.mediaType })
    if (r.ok) {
      log.web.info('companion: pasted picture kept for the Mac', { path: r.path })
      return { answered: false, status: 200, body: { ok: true, path: r.path, name: r.name } }
    }
    if ('status' in r) return { answered: false, status: r.status, body: flavor === 'v2' ? { error: r.message } : { error: { code: V1_CODE[r.status] ?? 'bad_request', message: r.message } } }
    return pathRefusal(flavor, r)
  }
  if (route === 'move') {
    // A Mac that does not drain moves answers needs the Mac (companionNoteMove says so).
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

/** A notes read the copy answers once it is held (replica/notes-routes.ts), by the router's own path. */
function isCopyRead(flavor: 'v1' | 'v2', p: string): boolean {
  const rest = flavor === 'v2' ? p : p === '/notes' ? '/' : p.startsWith('/notes/') ? p.slice('/notes'.length) : null
  if (rest === null) return false
  if (rest === '/' || rest === '' || rest === '/list' || rest === '/tags') return true
  if (rest === '/resolve') return flavor === 'v1'
  return /^\/(content|backlinks|links)\//.test(rest) || /^\/tags\/[^/]+\/notes$/.test(rest)
}

/** The notes index writes (v2): the Mac's index, never rebuilt or id-stamped on the box. */
function isIndexWrite(flavor: 'v1' | 'v2', method: string, p: string): boolean {
  return flavor === 'v2' && method === 'POST' && /^\/index\/(rebuild|stamp-ids|merge-ids)$/.test(p)
}

export function companionNoteWrites(flavor: 'v1' | 'v2'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isCompanion()) { next(); return }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (isCopyRead(flavor, req.path) && !companionCopyHolds('notes')) {
        send(res, needsLeaderAnswer('kind_not_copied', 'This box keeps no copy of the notes yet; your Mac answers this.'))
        return
      }
      next()
      return
    }
    if (req.method !== 'PUT' && req.method !== 'POST' && req.method !== 'DELETE') { next(); return }
    if (isIndexWrite(flavor, req.method, req.path)) {
      send(res, needsLeaderAnswer('notes_index_is_the_macs', 'The notes index is kept on your Mac, so it is rebuilt there.'))
      return
    }
    const pathRoute = pathRouteOf(flavor, req.method, req.path)
    const route = pathRoute ? null : noteRouteOf(req.method, flavor === 'v2' ? `/notes-v2${req.path}` : `/v1${req.path}`)
    if (!pathRoute && !route) { next(); return }
    // What the copy does not keep is the Mac's while it answers; the answers below say so while it is away.
    if (unkept(pathRoute, route, req)) { forwardUnkept(req, res, () => write(flavor, pathRoute, route, req, res, next)); return }
    write(flavor, pathRoute, route, req, res, next)
  }
}

/** A note change about what the box's copy does not keep: notes off for it, a left-out note, a tag rename of a partial copy. */
function unkept(pathRoute: PathRoute | null, route: ReturnType<typeof noteRouteOf>, req: Request): boolean {
  const blocked = companionNotesBlocked()
  if (blocked) return blocked.why === 'not_kept_here'
  const b = bodyOf(req)
  const notKept = (p: unknown): boolean => { const k = noteKeyOf(p); return !!k && !companionNoteKept(k) }
  if (pathRoute === 'move') return notKept(b.from) || notKept(b.to)
  if (pathRoute === 'tags') return companionNotesPartial()
  if (route) return notKept(route.op === 'create' ? b.path : route.path)
  return false
}

function write(flavor: 'v1' | 'v2', pathRoute: PathRoute | null, route: ReturnType<typeof noteRouteOf>, req: Request, res: Response, next: NextFunction): void {
  const blocked = companionNotesBlocked()
  if (blocked) {
    log.web.info('companion: a note change needs the Mac', { method: req.method, path: req.originalUrl, why: blocked.why })
    send(res, needsLeaderAnswer(blocked.why, blocked.message))
    return
  }
  if (pathRoute) {
    answerNotePath(flavor, pathRoute, req).then((a) => { if (a) send(res, a); else next() }, next)
    return
  }
  const b = bodyOf(req)
  const noteRoute = route!
  const notePath = noteRoute.op === 'create' ? (typeof b.path === 'string' ? b.path : '') : noteRoute.path
  if (!notePath) {
    send(res, refusalAnswer('bad_request', 'path (string) is required'))
    return
  }
  const r = companionNoteSave(noteRoute.op === 'delete'
    ? { path: notePath, mode: 'delete' }
    : { path: notePath, content: noteRoute.op === 'create' && typeof b.content !== 'string' ? '' : b.content, expectedHash: b.expectedHash, createOnly: noteRoute.op === 'create' })
  if (r.ok) {
    log.web.info('companion: note change kept for the Mac', { path: notePath, op: noteRoute.op, seq: r.seq, ...(r.coalesced ? { coalesced: true } : {}) })
    send(res, applied(noteRoute, { contentHash: r.contentHash, updatedAt: r.updatedAt, ...(r.noteId ? { noteId: r.noteId } : {}) }, notePath))
    return
  }
  log.web.info('companion: note change refused', { path: notePath, op: noteRoute.op, code: r.code })
  const retry = typeof r.detail?.retryAfterMs === 'number' ? r.detail.retryAfterMs : undefined
  send(res, refusedAnswer(noteRoute, r.code, r.message, r.detail, retry))
}
