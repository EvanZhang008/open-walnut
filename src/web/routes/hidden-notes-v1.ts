/**
 * Hidden notes (docs/reference/locked-notes.md, "Hidden notes"): the person hides a note from every
 * agent tool, search and sync without a password, and unhides it.
 *
 *   POST /api/v1/notes/hide    { path, expectedHash? } → { path, contentHash, updatedAt, hidden: true, changed }
 *   POST /api/v1/notes/unhide  { path, expectedHash? } → { path, contentHash, updatedAt, hidden: false, changed }
 *
 * Errors answer `{ error, code }`, as the locked-note routes do: 400 bad_path / not_lockable,
 * 403 human_only, 404 not_found, 409 conflict (with currentHash) / note_locked, 503 not_here.
 *
 * Who: the person in their own window (person-caller.ts isPersonInOwnWindow: no session caller, no
 * CLI automation mark, no browser under automation, no test run), on the leader only (a replica's
 * copy is not where the note is kept). No vault session: hiding needs no password. The answers
 * carry no note text, so they are kept like any other.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { isPersonInOwnWindow } from './person-caller.js'

export const hiddenNotesV1Router = Router()

function person(req: Request, res: Response): boolean {
  if (isFollower()) {
    res.status(503).json({ error: 'Notes are hidden and unhidden on your Mac, which keeps them.', code: 'not_here' })
    return false
  }
  if (!isPersonInOwnWindow(req)) {
    res.status(403).json({ error: 'Only a person hides or unhides a note, in Walnut: an agent, a session, a script or a test run cannot.', code: 'human_only' })
    return false
  }
  return true
}

async function answer(res: Response, next: NextFunction, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work())
  } catch (err) {
    const { LockedNoteError } = await import('../../core/notes/locked-note.js')
    if (err instanceof LockedNoteError) { res.status(err.status).json({ error: err.message, code: err.code, ...err.extra }); return }
    next(err)
  }
}

const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>

hiddenNotesV1Router.post('/notes/hide', async (req, res, next) => {
  if (!person(req, res)) return
  const b = body(req)
  await answer(res, next, async () => ({ ...(await (await import('../../core/notes/hidden-note-store.js')).hideNote(b.path, b.expectedHash)), hidden: true }))
})

hiddenNotesV1Router.post('/notes/unhide', async (req, res, next) => {
  if (!person(req, res)) return
  const b = body(req)
  await answer(res, next, async () => ({ ...(await (await import('../../core/notes/hidden-note-store.js')).unhideNote(b.path, b.expectedHash)), hidden: false }))
})
