/**
 * The cloud companion's other note paths (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md), while its copy of the notes is held and
 * the Mac drains notes (companion-notes.ts companionNotesWritable):
 *
 *   move     a note moved or renamed here is one `note-move` record naming both paths
 *            and the note's id, checked against what the box shows (the source is there,
 *            the new path is free, any case, as on the Mac's disk) and shown at once at
 *            its new path; the Mac moves it where the note is now
 *            (offline-merge/apply-note-move.ts). A Mac that does not drain the kind
 *            keeps the old path (the box's disk).
 *   tags     a tag renamed here is a `note` save of every note that carries it, as the
 *            box shows them (the Mac merges each like any other save); it needs the Mac
 *            when the copy leaves notes out (one of those may carry the tag too)
 *   folders  making or deleting a folder needs the Mac: the copy holds notes only, so an
 *            empty folder made here would never show, and a folder delete also removes
 *            pictures and files the box does not hold
 *
 * A picture or file is not a note: its move needs the Mac (companion-note-attachments.ts).
 * Cloud companion only.
 */

import { log } from '../logging/index.js'
import { COMPANION_REPLICA_HOME, companionHostReplica } from './companion-host-replica.js'
import { companionJournalRecords, COMPANION_JOURNAL_MAX_RECORDS, journalNoteMove, macDrains } from './companion-journal.js'
import {
  companionNoteAt, companionNoteKept, companionNoteSave, companionNotesChanged, companionNotesWritable, noteKeyOf,
  type NoteSaveResult,
} from './companion-notes.js'
import { isAttachmentFile } from './notes-tree.js'

type Refusal = Extract<NoteSaveResult, { ok: false }>
export type NotePathResult = { ok: true; seq?: number; updated?: number } | Refusal

const NOT_KEPT: Refusal = { ok: false, code: 'needs_leader', message: 'This note is not kept on this box, so it can only be changed on your Mac.', detail: { why: 'note_not_kept' } }

/** The box takes note moves into its journal (the Mac drains `note-move` too). */
export function companionMovesNotes(): boolean {
  return companionNotesWritable() && macDrains('note-move')
}

/** A move of a picture or file, not of a note (the disk route's own rule, notes-v2.ts moveNote). */
export function isAttachmentMove(from: unknown): boolean {
  return typeof from === 'string' && isAttachmentFile(from.split('/').pop() ?? from)
}

/**
 * Is a note at `key` in any case? The Mac's disk does not tell case apart, so its route
 * refuses a rename that only changes case, and so does the box.
 */
function takenAnyCase(key: string): boolean {
  if (companionNoteAt(key)) return true
  const list = companionHostReplica()?.list(COMPANION_REPLICA_HOME, 'notes')
  const lower = key.toLowerCase()
  return !!list && list.entries.some((e) => e.k.toLowerCase() === lower)
}

/**
 * One note moved or renamed on the box: the checks the Mac's route makes, against what
 * the box shows, then one `note-move` record. The answers are the route's own errors.
 */
export function companionNoteMove(req: { from: unknown; to: unknown }): NotePathResult {
  if (!companionMovesNotes()) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a note move later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  if (typeof req.from !== 'string' || typeof req.to !== 'string') return { ok: false, code: 'bad_request', message: 'from and to (strings) are required' }
  const from = noteKeyOf(req.from)
  const to = noteKeyOf(req.to)
  if (!from || !to) return { ok: false, code: 'bad_request', message: 'invalid path' }
  if (!companionNoteKept(from) || !companionNoteKept(to)) return NOT_KEPT
  const note = companionNoteAt(from)
  if (!note) return { ok: false, code: 'not_found', message: 'Source note not found' }
  if (takenAnyCase(to)) return { ok: false, code: 'conflict', message: 'Destination note already exists' }
  const saved = journalNoteMove({ from, to, ...(note.id ? { noteId: note.id } : {}) })
  if (!saved) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a note move later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  if (!saved.ok) return { ok: false, code: saved.code, message: saved.message, ...(saved.retryAfterMs !== undefined ? { detail: { retryAfterMs: saved.retryAfterMs } } : {}) }
  companionNotesChanged()
  return { ok: true, seq: saved.seq }
}

/**
 * A tag renamed on the box: every note that carries it, as the box shows it, saved with
 * the tag renamed (the disk route's own rewrite, note-tag-rename.ts). All or none is not
 * promised (nor is it on the Mac's disk); the room in the journal is checked first.
 */
export async function companionTagRename(req: { from: unknown; to: unknown }): Promise<NotePathResult> {
  const replica = companionHostReplica()
  if (!replica || !companionNotesWritable()) return { ok: false, code: 'needs_leader', message: 'This box keeps no copy of the notes yet; that needs your Mac.', detail: { why: 'kind_not_copied' } }
  const [{ normalizeTag, replicaNotesSource }, { renameTagInContent }] = await Promise.all([
    import('../replica/notes-source.js'), import('./note-tag-rename.js'),
  ])
  const from = normalizeTag(String(req.from || ''))
  const to = normalizeTag(String(req.to || ''))
  if (!from || !to) return { ok: false, code: 'bad_request', message: 'from and to (strings) are required' }
  if (from === to) return { ok: true, updated: 0 }
  const keep = replica.notesKeep(COMPANION_REPLICA_HOME)
  if (keep.keepExclude.length > 0 || keep.tooBig.length > 0) {
    return { ok: false, code: 'needs_leader', message: 'Some of your notes are only on your Mac, so a tag is renamed there.', detail: { why: 'tag_rename_needs_mac' } }
  }
  const source = replicaNotesSource()
  if (!source) return { ok: false, code: 'needs_leader', message: 'This box keeps no copy of the notes yet; that needs your Mac.', detail: { why: 'kind_not_copied' } }
  const edits: Array<{ path: string; content: string; expectedHash: string }> = []
  for (const n of (await source.notesForTag(from)).notes) {
    const at = companionNoteAt(n.path)
    const next = at ? renameTagInContent(at.body, from, to, normalizeTag) : null
    if (at && next !== null) edits.push({ path: n.path, content: next, expectedHash: replica.hashOf(at.body) })
  }
  if (companionJournalRecords().length + edits.length > COMPANION_JOURNAL_MAX_RECORDS) {
    return { ok: false, code: 'queue_full', message: `Renaming this tag changes ${edits.length} notes, more than this box can keep for your Mac now; rename it on your Mac.` }
  }
  let updated = 0
  for (const e of edits) {
    const r = companionNoteSave(e)
    if (!r.ok) {
      log.session.warn('companion notes: a tag rename stopped part way', { from, to, updated, of: edits.length, path: e.path, code: r.code })
      return r
    }
    updated++
  }
  log.session.info('companion notes: a tag renamed here goes to the Mac as note saves', { from, to, updated })
  return { ok: true, updated }
}

/** Making or deleting a folder on the box (see the header). */
export function companionFolderChange(): Refusal {
  return { ok: false, code: 'needs_leader', message: 'This box holds a copy of your notes, so a folder is made or deleted on your Mac.', detail: { why: 'folder_changes_need_mac' } }
}
