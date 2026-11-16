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
import { NOTES_DIR } from '../../constants.js'
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
 * `note_conflict`) or, with `createOnly`, on a note already there (code `note_exists`).
 */
export class NoteConflictError extends Error {
  readonly code: 'note_conflict' | 'note_exists'
  constructor(readonly path: string, readonly currentHash: string, exists = false) {
    super(exists ? `A note is already at ${path}` : `The note ${path} changed since it was read`)
    this.name = 'NoteConflictError'
    this.code = exists ? 'note_exists' : 'note_conflict'
  }
}

const MAX_FILE_BYTES = 50 * 1024 * 1024

function routes() {
  return import('../../web/routes/notes-v2.js')
}

function clean(rel: string): string {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function inside(rel: string): string {
  const cleaned = clean(rel)
  if (!cleaned || cleaned.split('/').some((part) => part === '..' || part === '.')) {
    throw Object.assign(new Error(`Not a path inside the notes vault: ${rel}`), { code: 'invalid_path' })
  }
  const full = path.resolve(NOTES_DIR, cleaned)
  if (!full.startsWith(NOTES_DIR + path.sep)) {
    throw Object.assign(new Error(`Not a path inside the notes vault: ${rel}`), { code: 'invalid_path' })
  }
  return full
}

function rel(full: string): string {
  return path.relative(NOTES_DIR, full).replace(/\\/g, '/')
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
      out.push({ path: rel(full), type: 'folder' })
      await walk(full, out)
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full).catch(() => null)
      out.push({
        path: rel(full),
        type: entry.name.endsWith('.md') ? 'note' : 'file',
        ...(stat ? { size: stat.size, modifiedAt: stat.mtime.toISOString() } : {}),
      })
    }
  }
}

export function createPluginNotes() {
  return {
    get dir(): string {
      return NOTES_DIR
    },

    async list(folder?: string): Promise<PluginNoteEntry[]> {
      const out: PluginNoteEntry[] = []
      await walk(folder ? inside(folder) : NOTES_DIR, out)
      return out
    },

    async read(notePath: string): Promise<{ path: string; content: string; hash: string } | null> {
      const full = notePathOf(inside(notePath))
      try {
        const content = await fsp.readFile(full, 'utf8')
        return { path: rel(full), content, hash: computeContentHash(content) }
      } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null
        throw error
      }
    },

    async write(notePath: string, content: string, options: { expectedHash?: string; createOnly?: boolean } = {}) {
      assertWritable('write')
      const target = rel(notePathOf(inside(notePath)))
      const { writeNoteContent } = await routes()
      const result = await writeNoteContent(target, content, options.expectedHash, { createOnly: options.createOnly })
      if (!result.ok) throw new NoteConflictError(target, result.conflict, result.exists)
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
      return { path: rel(full) }
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
      if (stat.isDirectory()) await deleteNotesFolder(rel(full))
      else if (full.endsWith('.md')) await deleteNoteFile(full)
      else if (stat.isFile()) await deleteNoteAttachment(rel(full))
    },
  }
}
