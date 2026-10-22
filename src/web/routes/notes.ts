/**
 * Notes routes — global user notes stored locally.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { GLOBAL_NOTES_FILE } from '../../constants.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'
import { MAX_NOTE_SIZE, NotesOpError } from './notes-v2.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'

export const notesRouter = Router()

/**
 * Read the global notes file (empty string when it doesn't exist yet).
 * Shared by GET /api/notes/global and GET /api/v1/notes/global.
 */
export async function readGlobalNotes(): Promise<{ content: string; contentHash: string }> {
  // The cloud companion shows the Mac's copy with its own pending saves (stage 4d), never its disk.
  const { companionGlobalNotes } = await import('../../core/companion-notes.js')
  const copied = companionGlobalNotes()
  if (copied) {
    if ('needs' in copied) throw new NeedsLeaderError(copied.needs)
    return { content: copied.content, contentHash: computeContentHash(copied.content) }
  }
  let content = ''
  try {
    content = await fsp.readFile(GLOBAL_NOTES_FILE, 'utf-8')
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
    // File doesn't exist yet — return empty string
  }
  return { content, contentHash: computeContentHash(content) }
}

/**
 * Write the global notes file with optional optimistic locking. Shared by
 * PUT /api/notes/global and PUT /api/v1/notes/global. Throws NotesOpError:
 * 400 (bad content), 413 (too large), 409 (hash conflict — message carries
 * the current hash via `currentHash` on the error object).
 */
export class GlobalNotesConflictError extends NotesOpError {
  constructor(public currentHash: string) {
    super('Content was modified externally', 409)
    this.name = 'GlobalNotesConflictError'
  }
}

/**
 * A global notes save on the cloud companion (stage 4d): a `note` record in its journal,
 * checked against what the box shows, as a note save is (core/companion-notes.ts), never
 * a write to its disk. Null anywhere else.
 */
async function companionGlobalNotesSave(content: string, expectedHash: unknown): Promise<{ ok: true; contentHash: string } | null> {
  const notes = await import('../../core/companion-notes.js')
  if (!notes.companionGlobalNotes()) return null
  const blocked = notes.companionNotesBlocked()
  if (blocked) throw new NeedsLeaderError(blocked.why)
  const r = notes.companionNoteSave({ path: notes.GLOBAL_NOTES_KEY, content, expectedHash })
  if (r.ok) {
    log.memory.info('companion: global notes change kept for the Mac', { size: content.length, seq: r.seq })
    return { ok: true, contentHash: computeContentHash(content) }
  }
  if (r.code === 'conflict') throw new GlobalNotesConflictError(String(r.detail?.serverHash ?? ''))
  if (r.code === 'bad_request') throw new NotesOpError(r.message, 400)
  throw new NeedsLeaderError(typeof r.detail?.why === 'string' ? r.detail.why : r.code)
}

export async function writeGlobalNotes(
  content: unknown,
  expectedHash?: unknown,
): Promise<{ ok: true; contentHash: string }> {
  if (typeof content !== 'string') throw new NotesOpError('content (string) is required', 400)
  // Same cap as the v2 route — the SAME file is saved through both, and a
  // split cap let a 1.5MB doc save on /notes but 413 in the home panel.
  if (content.length > MAX_NOTE_SIZE) {
    throw new NotesOpError(`Content too large (max ${MAX_NOTE_SIZE} bytes)`, 413)
  }
  const companion = await companionGlobalNotesSave(content, expectedHash)
  if (companion) return companion

  // Optimistic locking: reject if file was modified externally.
  // Optional for backward compatibility — callers that don't send
  // expectedHash accept last-write-wins semantics.
  // check+write under the file lock — the agent's writeFileChecked path
  // locks too, so an agent write can't slip between our check and write.
  await fsp.mkdir(path.dirname(GLOBAL_NOTES_FILE), { recursive: true })
  const conflict = await withUserFileLock(GLOBAL_NOTES_FILE, async () => {
    if (expectedHash && typeof expectedHash === 'string') {
      let currentContent = ''
      try {
        currentContent = await fsp.readFile(GLOBAL_NOTES_FILE, 'utf-8')
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err
      }
      const currentHash = computeContentHash(currentContent)
      if (currentHash !== expectedHash) return currentHash
    }
    await fsp.writeFile(GLOBAL_NOTES_FILE, content, 'utf-8')
    return null
  })
  if (conflict) throw new GlobalNotesConflictError(conflict)

  const contentHash = computeContentHash(content)
  log.memory.info('Global notes updated', { size: content.length })
  // Canonical event source is the v2 form `notes/{vault-path-without-.md}` —
  // ONE name per file across every surface. 'notes/global' is NOT used here:
  // it collides with a real vault-root global.md saved through notes-v2.
  bus.emit(EventNames.NOTES_UPDATED, { source: 'notes/global-notes', contentHash }, ['web-ui'])
  return { ok: true, contentHash }
}

// GET /api/notes/global — read global notes
notesRouter.get('/global', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await readGlobalNotes())
  } catch (err) {
    next(err)
  }
})

// PUT /api/notes/global — write global notes
notesRouter.put('/global', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, expectedHash } = req.body
    res.json(await writeGlobalNotes(content, expectedHash))
  } catch (err) {
    if (err instanceof GlobalNotesConflictError) {
      res.status(409).json({ error: err.message, currentHash: err.currentHash })
      return
    }
    if (err instanceof NotesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})
