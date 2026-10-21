/**
 * Pictures and files in the notes on the cloud companion (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md), while its copy of the notes is held
 * and the Mac drains notes. The copy holds note text only, never these files, so the
 * box keeps reading them from its own disk.
 *
 *   paste    a picture pasted into a note here (POST /api/notes-v2/attachment, POST
 *            /api/v1/notes/attachment) is written to the box's disk as before, so the
 *            editor shows it at once, AND is a `note-attachment` record with its bytes,
 *            once the Mac drains that kind. The Mac writes it at the same path; git
 *            sync may bring the same file there first, which the Mac's apply takes as
 *            done (offline-merge/apply-note-attachment.ts). When the journal refuses,
 *            the file is removed again and the paste answers the refusal: a file the
 *            Mac would never get is not kept.
 *   move, delete  need the Mac: the box holds no copy of the Mac's files to check a
 *            move or delete against, and the tree it shows lists notes only.
 *
 * Cloud companion only.
 */

import fsp from 'node:fs/promises'
import { log } from '../logging/index.js'
import { journalNoteAttachment, macDrains } from './companion-journal.js'
import { companionNotesWritable, type NoteSaveResult } from './companion-notes.js'

type Refusal = Extract<NoteSaveResult, { ok: false }>
export type AttachmentResult = { ok: true; path: string; name: string } | Refusal | { ok: false; status: number; message: string }

/** The box journals pastes (the Mac drains `note-attachment` too). */
export function companionJournalsPastes(): boolean {
  return companionNotesWritable() && macDrains('note-attachment')
}

/** One paste on the box: the disk route's own save, then its record for the Mac. */
export async function companionAttachmentPaste(req: { notePath: unknown; data: unknown; mediaType: unknown }): Promise<AttachmentResult> {
  const notes = await import('../web/routes/notes-v2.js')
  let saved: { ok: true; path: string; name: string }
  try {
    saved = await notes.saveNoteAttachment(req.notePath, req.data, req.mediaType)
  } catch (err) {
    if (err instanceof notes.NotesOpError) return { ok: false, status: err.statusCode, message: err.message }
    throw err
  }
  const abs = notes.resolveSafePath(saved.path)
  const body = abs ? await fsp.readFile(abs) : null
  const r = body ? journalNoteAttachment({ path: saved.path, body, ...(typeof req.notePath === 'string' ? { notePath: req.notePath } : {}) }) : null
  if (r && r.ok) return saved
  // Not kept for the Mac: the file goes too, so the paste fails whole.
  if (abs) await fsp.unlink(abs).catch(() => {})
  const [{ invalidateAttachmentIndex }, { invalidateNotesTree }] = await Promise.all([
    import('../web/routes/notes-attachment.js'), import('./notes-tree.js'),
  ])
  invalidateAttachmentIndex()
  invalidateNotesTree()
  log.session.warn('companion notes: a pasted picture was not kept for the Mac, so it was removed', { path: saved.path, code: r ? r.code : 'mac_too_old' })
  if (!r) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a picture later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  return { ok: false, code: r.code, message: r.message, ...(r.retryAfterMs !== undefined ? { detail: { retryAfterMs: r.retryAfterMs } } : {}) }
}

/** Moving or deleting a picture or file on the box (see the header). */
export function companionAttachmentChange(): Refusal {
  return { ok: false, code: 'needs_leader', message: 'Pictures and files in your notes are kept on your Mac, so they are moved or deleted there.', detail: { why: 'attachment_changes_need_mac' } }
}
