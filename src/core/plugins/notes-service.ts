/**
 * `walnut.notes`: a plugin's way into the person's notes vault (WALNUT_HOME/notes), for a
 * plugin that brings notes in from somewhere else (an importer) or keeps a folder of its own.
 *
 * Every write goes through the same functions the notes routes use (notes-v2.ts): the path is
 * confined to the vault, a note gets its id stamped and the file lock, `expectedHash` guards an
 * overwrite, and the tree, the index and every open editor hear about it. Reads are plain file
 * reads. A replica never writes: its vault is a copy of the primary's.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { normalizeNotePath, noteRelOf, notesRoot, resolveNotePath } from '../notes/note-paths.js'
import { isFollower } from '../server-role.js'
import { computeContentHash } from '../../utils/file-ops.js'

export interface PluginNoteEntry {
  path: string
  type: 'note' | 'file' | 'folder'
  size?: number
  modifiedAt?: string
}

/**
 * What `notes.write` throws on a changed note (`expectedHash` no longer matches, code
 * `note_conflict`), on a note deleted since it was read (`expectedHash` given, no note there any
 * more, code `note_deleted`, `currentHash` ''), or, with `createOnly`, on a note already there
 * (code `note_exists`).
 */
export class NoteConflictError extends Error {
  readonly code: 'note_conflict' | 'note_exists' | 'note_deleted'
  constructor(readonly path: string, readonly currentHash: string, kind: boolean | 'deleted' = false) {
    super(kind === 'deleted' ? `The note ${path} was deleted since it was read` : kind ? `A note is already at ${path}` : `The note ${path} changed since it was read`)
    this.name = 'NoteConflictError'
    this.code = kind === 'deleted' ? 'note_deleted' : kind ? 'note_exists' : 'note_conflict'
  }
}

const MAX_FILE_BYTES = 50 * 1024 * 1024

function routes() {
  return import('../../web/routes/notes-v2.js')
}

/** A plugin names a note or folder strictly inside the vault: no "." or ".." segment, a trailing "/" allowed. */
const PLUGIN_PATH_RULES = { dropTrailingSlash: true, refuseDotDot: true, refuseDot: true } as const

/** The plugin's path as the notes routes take it (they resolve and check it again). */
function clean(rel: string): string {
  return normalizeNotePath(String(rel ?? ''), { dropTrailingSlash: true }) ?? ''
}

function inside(rel: string): string {
  const full = resolveNotePath(String(rel ?? ''), PLUGIN_PATH_RULES)
  if (!full) throw Object.assign(new Error(`Not a path inside the notes vault: ${rel}`), { code: 'invalid_path' })
  return full
}

function assertWritable(call: string): void {
  if (isFollower()) throw Object.assign(new Error(`notes.${call} is not available on a replica; notes are written on the primary Walnut.`), { code: 'replica' })
}

function notePathOf(p: string): string {
  return p.endsWith('.md') ? p : `${p}.md`
}

async function walk(dir: string, out: PluginNoteEntry[]): Promise<void> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push({ path: noteRelOf(full), type: 'folder' })
      await walk(full, out)
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full).catch(() => null)
      out.push({
        path: noteRelOf(full),
        type: entry.name.endsWith('.md') ? 'note' : 'file',
        ...(stat ? { size: stat.size, modifiedAt: stat.mtime.toISOString() } : {}),
      })
    }
  }
}

export function createPluginNotes() {
  return {
    get dir(): string {
      return notesRoot()
    },

    async list(folder?: string): Promise<PluginNoteEntry[]> {
      const out: PluginNoteEntry[] = []
      await walk(folder ? inside(folder) : notesRoot(), out)
      return out
    },

    async read(notePath: string): Promise<{ path: string; content: string; hash: string; locked?: true } | null> {
      const full = notePathOf(inside(notePath))
      try {
        const content = await fsp.readFile(full, 'utf8')
        // A locked note reads as its stub: its text is the person's alone (docs/reference/locked-notes.md).
        const { isLockedNoteText, readableNoteText } = await import('../notes/locked-note.js')
        const locked = isLockedNoteText(content)
        return { path: noteRelOf(full), content: locked ? readableNoteText(content) : content, hash: computeContentHash(content), ...(locked ? { locked: true } : {}) }
      } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null
        throw error
      }
    },

    async write(notePath: string, content: string, options: { expectedHash?: string; createOnly?: boolean } = {}) {
      assertWritable('write')
      const target = noteRelOf(notePathOf(inside(notePath)))
      const { writeNoteContent } = await routes()
      const result = await writeNoteContent(target, content, options.expectedHash, { createOnly: options.createOnly })
      if (!result.ok) throw new NoteConflictError(target, result.conflict, result.deleted ? 'deleted' : result.exists)
      return { path: result.path, hash: result.contentHash, id: result.id, created: result.created }
    },

    async readFile(filePath: string): Promise<Uint8Array | null> {
      const full = inside(filePath)
      try {
        return new Uint8Array(await fsp.readFile(full))
      } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null
        throw error
      }
    },

    /** An attachment beside notes (an image, a PDF, an office file: the types the vault serves). */
    async writeFile(filePath: string, bytes: Uint8Array): Promise<{ path: string }> {
      assertWritable('writeFile')
      const full = inside(filePath)
      const { isAttachmentFile } = await import('../notes-tree.js')
      if (!isAttachmentFile(path.basename(full))) {
        throw Object.assign(new Error(`Notes keep images, PDFs and office files; ${path.basename(full)} is not one`), { code: 'unsupported_type' })
      }
      if (!(bytes instanceof Uint8Array)) throw Object.assign(new Error('bytes must be a Uint8Array'), { code: 'invalid_input' })
      if (bytes.byteLength > MAX_FILE_BYTES) throw Object.assign(new Error(`Files in notes are at most ${MAX_FILE_BYTES / 1024 / 1024} MB`), { code: 'too_large' })
      await fsp.mkdir(path.dirname(full), { recursive: true })
      let existed = true
      try { await fsp.access(full) } catch { existed = false }
      const tmp = `${full}.${process.pid}.${Date.now()}.tmp`
      await fsp.writeFile(tmp, bytes)
      await fsp.rename(tmp, full)
      const { invalidateNotesTree } = await import('../notes-tree.js')
      if (!existed) invalidateNotesTree()
      try {
        const { invalidateAttachmentIndex } = await import('../../web/routes/notes-attachment.js')
        invalidateAttachmentIndex()
      } catch { /* best effort: the resolver rebuilds on its own */ }
      return { path: noteRelOf(full) }
    },

    async mkdir(folderPath: string): Promise<void> {
      assertWritable('mkdir')
      inside(folderPath)
      const { createNotesFolder } = await routes()
      await createNotesFolder(clean(folderPath))
    },

    async move(from: string, to: string): Promise<void> {
      assertWritable('move')
      inside(from)
      inside(to)
      const { moveNote } = await routes()
      await moveNote(clean(from), clean(to))
    },

    /**
     * The note, file or folder at exactly this path. Missing is not an error, and a missing folder
     * never stands for a note of the same name (`Projects` is not `Projects.md`).
     */
    async remove(target: string): Promise<void> {
      assertWritable('remove')
      const full = inside(target)
      const { deleteNoteFile, deleteNoteAttachment, deleteNotesFolder } = await routes()
      const stat = await fsp.stat(full).catch(() => null)
      if (!stat) return
      // A plugin is not the person: a locked note (or a folder holding one) stays (docs/reference/locked-notes.md).
      if (stat.isDirectory()) await deleteNotesFolder(noteRelOf(full), { person: false })
      else if (full.endsWith('.md')) {
        const { assertFileNotLocked } = await import('../notes/locked-note.js')
        await assertFileNotLocked(full, 'be deleted by a plugin')
        await deleteNoteFile(full)
      }
      else if (stat.isFile()) await deleteNoteAttachment(noteRelOf(full))
    },
  }
}
