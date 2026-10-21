/**
 * The note writes of a host replica while the Mac is away (docs/plan/walnut-replica-servers-impl.md
 * section 6, WP11). The route table journals them (`note-write` rows); this handler sends each
 * to the host's daemon as `follower.op note_put|note_delete`, where the offline host checks the
 * expected hash against what the overlay shows and journals a `note` record. The answers keep
 * the shapes of the Mac's own routes (notes-v2.ts and api-v1.ts), so the editor and the phone
 * cannot tell the difference except by the offline header; a stale hash answers 409 with the
 * text this host shows (`serverContent`), so the editor merges without another read.
 *
 * Mounted on a host replica only, before away-writes.ts (which answers needs_leader for any
 * journaled write it has no handler for). The Mac and the companion never mount it.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type WriteActor } from './write-port.js'

export interface AwayNotesDeps {
  actorOf(req: Request): WriteActor | null
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  /**
   * Whether this host's daemon journals notes (`note-journal-v1`); null when its
   * capabilities are not known yet. An older daemon keeps today's answer: needs the Mac.
   */
  capable?(): boolean | null
}

type Flavor = 'v2' | 'v1'
export type NoteRoute = { flavor: Flavor; op: 'put' | 'delete' | 'create'; path: string }

/** The note routes this handler answers, by the path under /api (the route table's WP11 rows). */
export function noteRouteOf(method: string, apiPath: string): NoteRoute | null {
  const m = method.toUpperCase()
  const rest = (prefix: string): string | null => {
    if (!apiPath.startsWith(prefix)) return null
    let p = apiPath.slice(prefix.length)
    try { p = decodeURIComponent(p) } catch { /* as sent */ }
    return p || null
  }
  const v2 = rest('/notes-v2/content/')
  if (v2 && (m === 'PUT' || m === 'DELETE')) return { flavor: 'v2', op: m === 'PUT' ? 'put' : 'delete', path: v2 }
  const v1 = rest('/v1/notes/content/')
  if (v1 && m === 'PUT') return { flavor: 'v1', op: 'put', path: v1 }
  if (m === 'POST' && apiPath === '/v1/notes') return { flavor: 'v1', op: 'create', path: '' }
  const v1del = rest('/v1/notes/')
  if (v1del && m === 'DELETE' && !v1del.startsWith('content/')) return { flavor: 'v1', op: 'delete', path: v1del }
  return null
}

function body(req: Request): Record<string, unknown> {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

function withMd(p: string): string {
  return /\.md$/i.test(p) ? p : `${p}.md`
}

/** The daemon's answer in the shape of the Mac's own route (the companion's note saves use it too). */
export function applied(route: NoteRoute, reply: Record<string, unknown>, sentPath: string): PortAnswer {
  const contentHash = typeof reply.contentHash === 'string' ? reply.contentHash : undefined
  const updatedAt = typeof reply.updatedAt === 'string' ? reply.updatedAt : new Date().toISOString()
  if (route.op === 'delete') return { answered: false, status: 200, body: { ok: true } }
  if (route.op === 'create') return { answered: false, status: 201, body: { path: withMd(sentPath), contentHash, updatedAt } }
  if (route.flavor === 'v1') return { answered: false, status: 200, body: { contentHash, updatedAt } }
  return { answered: false, status: 200, body: { ok: true, updatedAt, contentHash, ...(typeof reply.noteId === 'string' ? { id: reply.noteId } : {}) } }
}

export function refusedAnswer(route: NoteRoute, code: string, message: string, detail: unknown, retryAfterMs?: number): PortAnswer {
  const d = (detail && typeof detail === 'object' ? detail : {}) as { why?: unknown; serverHash?: unknown; serverContent?: unknown }
  if (code === 'conflict') {
    const extra = { serverHash: d.serverHash ?? null, serverContent: d.serverContent ?? null }
    return route.flavor === 'v2'
      ? { answered: false, status: 409, body: { error: message === 'Note already exists' ? message : 'Content was modified externally', currentHash: d.serverHash ?? null, ...extra } }
      : { answered: false, status: 409, body: { error: { code: 'conflict', message }, ...extra } }
  }
  if (code === 'not_found') {
    return { answered: false, status: 404, body: route.flavor === 'v2' ? { error: 'Note not found' } : { error: { code: 'not_found', message: 'Note not found' } } }
  }
  if (code === 'needs_leader') return needsLeaderAnswer(typeof d.why === 'string' ? d.why : 'needs_mac', message)
  return refusalAnswer(code, message, detail, retryAfterMs)
}

export function awayNotes(deps: AwayNotesDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const w = req.replicaWrite
    if (!w || w.away !== 'note-write') { next(); return }
    const route = noteRouteOf(req.method, req.path)
    if (!route) { next(); return }
    const answer = (a: PortAnswer) => {
      if (a.answered || res.headersSent) return
      if (a.status === 503 || a.status === 429) {
        const retry = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
        if (typeof retry === 'number') res.setHeader('retry-after', String(retry))
      }
      res.status(a.status).json(a.body)
    }
    const cap = deps.capable ? deps.capable() : true
    if (cap !== true) {
      answer(needsLeaderAnswer(cap === null ? 'daemon_unreachable' : 'daemon_needs_upgrade', cap === null
        ? 'This host\'s Walnut daemon does not answer yet; the note needs your Mac.'
        : 'This host\'s Walnut daemon is too old to keep a note change; it updates on your Mac\'s next connect.'))
      return
    }
    const actor = deps.actorOf(req)
    if (!actor) {
      answer(needsLeaderAnswer('device_changes_need_mac', 'This device is not known to this host by its id yet; it needs your Mac.'))
      return
    }
    const b = body(req)
    const notePath = route.op === 'create' ? (typeof b.path === 'string' ? b.path : '') : route.path
    if (!notePath) { answer(refusalAnswer('bad_request', 'path (string) is required')); return }
    const args = route.op === 'delete' ? { path: notePath }
      : route.op === 'create' ? { path: notePath, content: typeof b.content === 'string' ? b.content : '', createOnly: true }
        : { path: notePath, content: b.content, ...(typeof b.expectedHash === 'string' && b.expectedHash ? { expectedHash: b.expectedHash } : {}) }
    w.submit(route.op === 'delete' ? 'note_delete' : 'note_put', args, undefined, actor).then((r) => {
      if (r.kind === 'answered') return
      if (r.kind === 'applied') {
        deps.log('info', 'replica: note write kept on this host', { path: notePath, op: route.op, opId: w.opId, seq: r.reply.seq, coalesced: r.reply.coalesced === true })
        answer(applied(route, r.reply, notePath))
        return
      }
      deps.log('info', 'replica: note write refused by the daemon', { path: notePath, op: route.op, opId: w.opId, code: r.code })
      answer(refusedAnswer(route, r.code, r.message, r.detail, r.retryAfterMs))
    }, (err: unknown) => {
      deps.log('warn', 'replica: a note write failed', { path: notePath, opId: w.opId, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) answer(refusalAnswer('internal', 'This host could not keep the change.'))
    })
  }
}
