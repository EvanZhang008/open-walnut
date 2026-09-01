/**
 * /api/v1 notes extras (additive, Wave 2) — global scratchpad, link graph
 * reads, tags, and the two destructive vault deletes. Semantics identical to
 * the internal routes (notes.ts / notes-v2.ts) because both call the SAME
 * extracted operation functions — including the SAME vault-containment guard
 * (resolveSafePath: traversal-rejecting, NOTES_DIR-confined).
 *
 *   GET    /notes/global                  → { content, contentHash }
 *   PUT    /notes/global { content, expectedHash? } → { ok, contentHash } (409 + currentHash on conflict)
 *   GET    /notes/backlinks/*path         → { backlinks }
 *   GET    /notes/links/*path             → { links }
 *   GET    /notes/tags                    → { tags }
 *   GET    /notes/tags/:tag/notes         → { notes }
 *   GET    /notes/list                    → { notes }         (Wave 3)
 *   GET    /notes/resolve?ref=            → { id, path, title, matchedBy }
 *   POST   /notes/tags/rename { from, to } → { ok, updated }  (Wave 3)
 *   DELETE /notes/attachment/*path        → { ok }
 *   DELETE /notes/folder/*path            → { ok, deletedNotes }
 *
 * Cloud companion (REPLICA): all Class A — the vault + global notes ride the
 * git-synced data dir, and the structural index rebuilds locally on each box.
 * No bridge.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError, v1ErrorCode } from './v1-control-relay.js'

export const notesExtrasV1Router = Router()

/** Express 5 wildcard param → joined path string (arrays for *name params). */
function wildcardPath(req: Request): string | null {
  const raw = (req.params as Record<string, unknown>).path
  if (typeof raw === 'string') return raw || null
  if (Array.isArray(raw)) return raw.join('/') || null
  return null
}

/** NotesOpError → the frozen v1 error shape; other errors → next(err). */
async function runNotesOp(
  res: Response,
  next: NextFunction,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  const { NotesOpError } = await import('./notes-v2.js')
  try {
    res.json(await fn())
  } catch (err) {
    if (err instanceof NotesOpError) {
      sendError(res, err.statusCode, err.statusCode === 413 ? 'too_large' : v1ErrorCode(err.statusCode), err.message)
      return
    }
    next(err)
  }
}

// ── Global scratchpad ────────────────────────────────────────────────────────

// GET /api/v1/notes/global — the single global notes file (home panel).
notesExtrasV1Router.get('/notes/global', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { readGlobalNotes } = await import('./notes.js')
    res.json(await readGlobalNotes())
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/notes/global { content, expectedHash? } — optimistic-locked
// write; 409 conflict carries currentHash so the client can rebase.
notesExtrasV1Router.put('/notes/global', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { writeGlobalNotes, GlobalNotesConflictError } = await import('./notes.js')
    const { NotesOpError } = await import('./notes-v2.js')
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      res.json(await writeGlobalNotes(body.content, body.expectedHash))
    } catch (err) {
      if (err instanceof GlobalNotesConflictError) {
        sendError(res, 409, 'conflict', err.message, { currentHash: err.currentHash })
        return
      }
      if (err instanceof NotesOpError) {
        sendError(res, err.statusCode, err.statusCode === 413 ? 'too_large' : v1ErrorCode(err.statusCode), err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ── Link graph reads ─────────────────────────────────────────────────────────

// GET /api/v1/notes/backlinks/*path — inbound links (id-keyed; includes
// ambiguous edges with their candidate targets).
notesExtrasV1Router.get('/notes/backlinks/*path', async (req: Request, res: Response, next: NextFunction) => {
  const { getNoteBacklinks } = await import('./notes-v2.js')
  await runNotesOp(res, next, () => getNoteBacklinks(wildcardPath(req)))
})

// GET /api/v1/notes/links/*path — outbound (forward) links of a note.
notesExtrasV1Router.get('/notes/links/*path', async (req: Request, res: Response, next: NextFunction) => {
  const { getNoteForwardLinks } = await import('./notes-v2.js')
  await runNotesOp(res, next, () => getNoteForwardLinks(wildcardPath(req)))
})

// ── Tags ─────────────────────────────────────────────────────────────────────

// GET /api/v1/notes/tags — all tags, frequency-ranked.
notesExtrasV1Router.get('/notes/tags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { ensureIndexBootstrap } = await import('./notes-v2.js')
    ensureIndexBootstrap()
    const { tagCounts } = await import('../../core/notes-index.js')
    res.json({ tags: tagCounts() })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/notes/tags/:tag/notes — notes carrying a tag, newest first.
notesExtrasV1Router.get('/notes/tags/:tag/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ensureIndexBootstrap } = await import('./notes-v2.js')
    ensureIndexBootstrap()
    const { normalizeTag } = await import('../../core/notes-indexer.js')
    const tag = normalizeTag(String(req.params.tag || ''))
    if (!tag) {
      sendError(res, 400, 'bad_request', 'tag required')
      return
    }
    const { notesForTag } = await import('../../core/notes-index.js')
    const notes = notesForTag(tag).map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      snippet: r.body.slice(0, 160).trim(),
      modified: r.modified,
    }))
    res.json({ notes })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/notes/list (Wave 3) — flat note list with ids (feeds [[
// autocomplete; falls back to a file walk while the index is cold).
notesExtrasV1Router.get('/notes/list', async (_req: Request, res: Response, next: NextFunction) => {
  const { listNotesFlat } = await import('./notes-v2.js')
  await runNotesOp(res, next, () => listNotesFlat())
})

// GET /api/v1/notes/resolve?ref= — one note reference (frontmatter id, vault
// path, or title) → its path. note_search answers with `id` first, so this is
// what lets an agent hand that id straight back to note_read / note_edit.
notesExtrasV1Router.get('/notes/resolve', async (req: Request, res: Response, next: NextFunction) => {
  const { resolveNoteRef } = await import('./notes-v2.js')
  const ref = req.query.ref ?? req.query.id ?? req.query.path
  await runNotesOp(res, next, () => resolveNoteRef(ref))
})

// POST /api/v1/notes/tags/rename { from, to } (Wave 3) — rename a tag across
// every carrying note (frontmatter + inline; targeted by the tag index).
notesExtrasV1Router.post('/notes/tags/rename', async (req: Request, res: Response, next: NextFunction) => {
  const { renameNoteTag } = await import('./notes-v2.js')
  await runNotesOp(res, next, () => renameNoteTag(req.body?.from, req.body?.to))
})

// ── Destructive vault deletes ────────────────────────────────────────────────

// DELETE /api/v1/notes/attachment/*path — delete one binary attachment.
notesExtrasV1Router.delete('/notes/attachment/*path', async (req: Request, res: Response, next: NextFunction) => {
  const { deleteNoteAttachment } = await import('./notes-v2.js')
  await runNotesOp(res, next, () => deleteNoteAttachment(wildcardPath(req)))
})

// DELETE /api/v1/notes/folder/*path — recursive folder delete. Destructive:
// the client MUST gate it behind an explicit confirm (the web UI uses a
// typed-confirm dialog).
notesExtrasV1Router.delete('/notes/folder/*path', async (req: Request, res: Response, next: NextFunction) => {
  const { deleteNotesFolder } = await import('./notes-v2.js')
  await runNotesOp(res, next, () => deleteNotesFolder(wildcardPath(req)))
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
notesExtrasV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 notes extras route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
