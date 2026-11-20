/**
 * One-time migration: move global notes into ~/.open-walnut/notes/global-notes.md
 *
 * Handles three legacy states:
 *   1. Only old root file:  ~/.open-walnut/global-notes.md
 *   2. Old root + stale notes/global.md (previous partial migration)
 *   3. Only notes/global.md (previous migration ran but root was already gone)
 *
 * Target: GLOBAL_NOTES_FILE = ~/.open-walnut/notes/global-notes.md
 * After successful migration, old source files are deleted.
 * Runs at server startup. Idempotent — skips if target already exists.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { GLOBAL_NOTES_FILE, WALNUT_HOME } from '../constants.js'
import { noteAbs, notesRoot } from './notes/note-paths.js'
import { log } from '../logging/index.js'

/** Hard-coded legacy paths (no longer referenced by constants) */
const OLD_ROOT_FILE = path.join(WALNUT_HOME, 'global-notes.md')

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true } catch { return false }
}

export async function migrateGlobalNotes(): Promise<void> {
  // Already at target — nothing to do
  if (await fileExists(GLOBAL_NOTES_FILE)) return

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
    await fsp.writeFile(GLOBAL_NOTES_FILE, content, 'utf-8')
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
