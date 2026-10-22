/**
 * Pictures and files in the notes on the cloud companion (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md), while its copy of the notes is held
 * and the Mac drains notes.
 *
 *   read     the box's copy of the Mac's files (core/companion-attachment-copy.ts), and
 *            the pictures pasted here, from their journal records
 *   paste    a picture pasted into a note here (POST /api/notes-v2/attachment, POST
 *            /api/v1/notes/attachment) is a `note-attachment` record with its bytes, once
 *            the Mac drains that kind, and is never written to the box's disk: the editor
 *            shows it at once from the record, the Mac writes it at the same path
 *            (offline-merge/apply-note-attachment.ts), and after its ack the copy keeps it
 *            until a manifest names it. When the journal refuses, the paste answers the
 *            refusal and nothing is kept.
 *   move, delete  need the Mac: the box holds no copy of the Mac's files to check a
 *            move or delete against, and the tree it shows lists notes only.
 *
 * Cloud companion only.
 */

import { log } from '../logging/index.js'
import { journalNoteAttachment, macDrains } from './companion-journal.js'
import { companionNotesWritable, type NoteSaveResult } from './companion-notes.js'

type Refusal = Extract<NoteSaveResult, { ok: false }>
export type AttachmentResult = { ok: true; path: string; name: string } | Refusal | { ok: false; status: number; message: string }

/** The box journals pastes (the Mac drains `note-attachment` too). */
export function companionJournalsPastes(): boolean {
  return companionNotesWritable() && macDrains('note-attachment')
}

/** One paste on the box: the disk route's own checks and name, then its record for the Mac. */
export async function companionAttachmentPaste(req: { notePath: unknown; data: unknown; mediaType: unknown }): Promise<AttachmentResult> {
  const notes = await import('../web/routes/notes-v2.js')
  let plan: ReturnType<typeof notes.planNoteAttachment>
  try {
    plan = notes.planNoteAttachment(req.notePath, req.data, req.mediaType)
  } catch (err) {
    if (err instanceof notes.NotesOpError) return { ok: false, status: err.statusCode, message: err.message }
    throw err
  }
  const r = journalNoteAttachment({ path: plan.relPath, body: plan.buffer, ...(typeof req.notePath === 'string' ? { notePath: req.notePath } : {}) })
  if (r && r.ok) {
    log.session.info('companion notes: a pasted picture was kept for the Mac', { path: plan.relPath, bytes: plan.buffer.length })
    return { ok: true, path: plan.relPath, name: plan.filename }
  }
  log.session.warn('companion notes: a pasted picture was not kept for the Mac', { path: plan.relPath, code: r ? r.code : 'mac_too_old' })
  if (!r) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a picture later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  return { ok: false, code: r.code, message: r.message, ...(r.retryAfterMs !== undefined ? { detail: { retryAfterMs: r.retryAfterMs } } : {}) }
}

/** Moving or deleting a picture or file on the box (see the header). */
export function companionAttachmentChange(): Refusal {
  return { ok: false, code: 'needs_leader', message: 'Pictures and files in your notes are kept on your Mac, so they are moved or deleted there.', detail: { why: 'attachment_changes_need_mac' } }
}
