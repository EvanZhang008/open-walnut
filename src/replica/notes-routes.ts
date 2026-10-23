/**
 * The notes reads of a replica (WP6), answered from its copy (notes-source.ts): a
 * host replica's daemon copy, or the companion's own once it is held (stage 4b of
 * docs/plan/walnut-companion-unified-replica.md; the companion's searches stay its
 * own). Mounted first on the notes routers (notes-v2.ts for `/api/notes-v2`,
 * api-v1.ts for `/api/v1/notes`); it passes every request on when no copy source
 * answers, which is always the case on the Mac, so its notes routes run as before.
 *
 * The shapes are the disk routes' own: the tree is the same JSON, content has
 * the same fields (`id` on v2 only, as there), links, backlinks, tags and the
 * flat list are the same rows, and v1's resolve (note_read by id or title) answers
 * from the copy's ids and titles. Search is a keyword search of the copy, marked
 * `degraded: 'offline-keyword'` (the leader's semantic index stays on the leader).
 * Writes never reach here: a note write away answers needs_leader until WP11.
 *
 * What the copy does not keep is never answered from it (core/replication/keep-rule.ts):
 * a copy that is not held (the Mac turned notes off here, or none arrived yet) answers
 * needs_leader for every read; a note the Mac leaves out answers needs_leader
 * `not_kept_here`, never 404; and a list or search of a copy that leaves notes out says
 * so (`partial`). On the companion, whose notes reads run here whoever answers, each of
 * those goes to the Mac first while it answers (the source's `forward`). A copy that
 * keeps every note answers exactly as before: no `partial`, no forward.
 */
import type { NextFunction, Request, Response } from 'express'
import { replicaNotesForward, replicaNotesSource, replicaNotesSourceSearches, type NotesSource } from './notes-source.js'
import { log } from '../logging/index.js'
import { NEEDS_LEADER_HEADERS, needsLeaderBody } from '../core/replication/needs-leader.js'

/** Said on a list or search answered from a copy that leaves notes out. */
export const PARTIAL_NOTES = { why: 'not_kept_here', message: 'Some notes are kept only on your Mac, so they are not shown here.' } as const
export const PARTIAL_SEARCH = { why: 'not_kept_here', message: 'Some notes are kept only on your Mac, so they are not in these results.' } as const

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

/** The 503 for a read of what this copy does not keep: the error handler's needs_leader answer, both flavors. */
function needsMac(res: Response, _flavor: Flavor, why: string, message: string): void {
  res.status(503).set(NEEDS_LEADER_HEADERS).json(needsLeaderBody(why, message))
}

/** A copy read this server answers (or forwards), by the router's own path; null for another route. */
function copyPathOf(flavor: Flavor, reqPath: string): string | null {
  // v2 is mounted at /api/notes-v2 (paths here start at /), v1 at /api/v1 (paths start at /notes).
  const p = flavor === 'v2' ? reqPath : reqPath === '/notes' ? '/' : reqPath.startsWith('/notes/') ? reqPath.slice('/notes'.length) : null
  if (p === null) return null
  if (p === '/' || p === '' || p === '/list' || p === '/tags' || p === '/search') return p || '/'
  if (p === '/resolve') return flavor === 'v1' ? p : null
  return /^\/(content|backlinks|links)\//.test(p) || /^\/tags\/[^/]+\/notes$/.test(p) ? p : null
}

async function answer(src: NotesSource, flavor: Flavor, req: Request, res: Response): Promise<boolean> {
  const p = copyPathOf(flavor, req.path)
  if (p === null) return false
  if (p === '/search' && !replicaNotesSourceSearches()) return false
  const forward = replicaNotesForward()
  /** What the copy cannot answer goes to the Mac while it answers (the companion); `here` otherwise. */
  const viaMac = (here: () => Promise<void> | void): Promise<boolean> => {
    if (!forward) return Promise.resolve(here()).then(() => true)
    return new Promise<boolean>((resolve, reject) => {
      forward(req, res, () => { Promise.resolve(here()).then(() => resolve(true), reject) })
      res.once('finish', () => resolve(true))
      res.once('close', () => resolve(true))
    })
  }
  const st = await src.copyState()
  if (!st.held) {
    // Off by the user's choice, or not here yet: the Mac's (asked first on the companion).
    if (st.off) return viaMac(() => needsMac(res, flavor, 'not_kept_here', 'Your notes are kept only on your Mac.'))
    return viaMac(() => needsMac(res, flavor, 'kind_not_copied', 'This copy of the notes is not here yet; your Mac answers this.'))
  }
  const asOf = () => { const at = src.asOf(); if (at) res.setHeader('x-walnut-copy-as-of', at) }
  const withPartial = <T extends object>(body: T, partial: object = PARTIAL_NOTES): T => (st.partial ? { ...body, partial } : body)
  /** A list or search: from the copy when it keeps every note, else the Mac's while it answers. */
  const listing = (here: () => Promise<void>): Promise<boolean> => (st.partial ? viaMac(here) : here().then(() => true))
  if (p === '/') {
    return listing(async () => {
      const t = await src.tree()
      asOf()
      res.type('application/json').send(st.partial ? `${t.json.slice(0, -1)},"partial":${JSON.stringify(PARTIAL_NOTES)}}` : t.json)
    })
  }
  if (p.startsWith('/content/')) {
    const raw = wildcard(p, '/content/')
    if (st.partial && await src.leftOut(raw)) {
      return viaMac(() => needsMac(res, flavor, 'not_kept_here', 'This note is kept only on your Mac.'))
    }
    const note = await src.content(raw)
    if (!note) { notFound(res, flavor, 'Note not found'); return true }
    asOf()
    if (flavor === 'v1') res.json({ content: note.content, contentHash: note.contentHash, updatedAt: note.updatedAt })
    else res.json(note)
    return true
  }
  if (p.startsWith('/backlinks/')) return listing(async () => { const r = await src.backlinks(wildcard(p, '/backlinks/')); asOf(); res.json(withPartial(r)) })
  if (p.startsWith('/links/')) return listing(async () => { const r = await src.links(wildcard(p, '/links/')); asOf(); res.json(withPartial(r)) })
  if (p === '/list') return listing(async () => { const r = await src.list(); asOf(); res.json(withPartial(r)) })
  if (p === '/tags') return listing(async () => { const r = await src.tags(); asOf(); res.json(withPartial(r)) })
  const tagNotes = /^\/tags\/([^/]+)\/notes$/.exec(p)
  if (tagNotes) {
    let tag = tagNotes[1]!
    try { tag = decodeURIComponent(tag) } catch { /* as sent */ }
    if (!tag.trim()) { badRequest(res, flavor, 'tag required'); return true }
    return listing(async () => { const r = await src.notesForTag(tag); asOf(); res.json(withPartial(r)) })
  }
  if (p === '/resolve') {
    const q = req.query.ref ?? req.query.id ?? req.query.path
    const ref = typeof q === 'string' ? q : ''
    const r = await src.resolve(ref)
    if ('status' in r) {
      // A miss in a copy that leaves notes out may be a note kept only on the Mac: by its
      // path when the path is left out, by its title or id whenever the copy is partial (a
      // left-out note's title is not known here). A path that is not left out is a plain 404.
      const sure = r.status === 404 && st.partial ? await src.leftOut(ref) : false
      if (r.status === 404 && st.partial && (sure || !ref.includes('/'))) {
        return viaMac(() => needsMac(res, flavor, 'not_kept_here', sure
          ? 'This note is kept only on your Mac.'
          : 'This note is not in this copy, and some notes are kept only on your Mac.'))
      }
      res.status(r.status).json({ error: { code: r.status === 404 ? 'not_found' : r.status === 409 ? 'conflict' : 'bad_request', message: r.message } })
      return true
    }
    asOf()
    res.json(r)
    return true
  }
  // p === '/search'
  return listing(async () => {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const r = await src.search(q, Number(req.query.limit) || 30)
    asOf()
    res.json(withPartial({ ...r, queryTokens: q.toLowerCase().split(/\s+/).filter(Boolean) }, PARTIAL_SEARCH))
  })
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
