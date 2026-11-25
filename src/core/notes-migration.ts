/**
 * One-time migration: move global notes into ~/.open-walnut/notes/global-notes.md
 *
 * Handles three legacy states:
 *   1. Only old root file:  ~/.open-walnut/global-notes.md
 *   2. Old root + stale notes/global.md (previous partial migration)
 *   3. Only notes/global.md (previous migration ran but root was already gone)
 *
 * Target: globalNotesFile() (global-notes.md at the vault root)
 * After successful migration, old source files are deleted.
 * Runs at server startup. Idempotent — skips if target already exists.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { noteAbs, notesRoot } from './notes/note-paths.js'
import { globalNotesFile } from './notes/vault-files.js'
import { log } from '../logging/index.js'
import { looksProtectedNoteText } from './notes/locked-note.js'

/** Hard-coded legacy paths (no longer referenced by constants) */
const OLD_ROOT_FILE = path.join(WALNUT_HOME, 'global-notes.md')

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true } catch { return false }
}

export async function migrateGlobalNotes(): Promise<void> {
  const target = globalNotesFile()
  // Already at target: nothing to do
  if (await fileExists(target)) return

  await fsp.mkdir(notesRoot(), { recursive: true })
  const oldNotesGlobal = noteAbs('global.md')

  // Pick the best source: prefer root file (most likely to be user-edited),
  // fall back to old notes/global.md from previous migration attempt.
  let source: string | null = null
  if (await fileExists(OLD_ROOT_FILE)) {
    source = OLD_ROOT_FILE
  } else if (await fileExists(oldNotesGlobal)) {
    source = oldNotesGlobal
  }

  if (!source) return // no legacy files at all

  try {
    const content = await fsp.readFile(source, 'utf-8')
    // A locked or hidden file is never copied as a note Walnut writes (docs/reference/locked-notes.md).
    if (looksProtectedNoteText(content)) { log.memory.warn('global notes migration skipped: the old file is a locked or hidden note'); return }
    await fsp.writeFile(target, content, 'utf-8')
    log.memory.info(`Migrated ${path.basename(source)} → notes/global-notes.md`)
  } catch (err) {
    log.memory.error('Failed to migrate global notes', { error: String(err) })
    return // don't delete sources on failure
  }

  // Clean up old files
  for (const old of [OLD_ROOT_FILE, oldNotesGlobal]) {
    try { await fsp.unlink(old) } catch { /* already gone */ }
  }
}
