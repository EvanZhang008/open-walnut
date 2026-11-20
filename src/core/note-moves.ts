/**
 * What follows a note when it moves or goes: its row in the Notes index and its bookmark. One
 * implementation for every caller: the Notes routes (a move, a delete) and the drawing store (a
 * drawing's rename, whose companion note moves with it).
 */

import { log } from '../logging/index.js'
import { getConfig, updateConfig } from './config-manager.js'
import { moveDrawingCompanion } from './drawings/companion-sync.js'
import { moveNarration } from './drawings/narration-store.js'
import { bus, EventNames } from './event-bus.js'
import { updateNotePath } from './notes-index.js'
import { scheduleNotesIndexUpdate } from './notes-indexer.js'

/**
 * Keep the note BOOKMARKS in step with the vault when a note is deleted or
 * renamed. Favorites live in config (`favorites.notes`, vault-relative paths
 * WITH `.md`) and nothing in the notes routes used to touch them, so deleting a
 * bookmarked note left a live row in the Bookmarks group: clicking it opened a
 * blank editor and the first keystroke WROTE THE FILE BACK (a 404 read is how a
 * new note starts). The existing `config:changed` carries the correction, which
 * is why no new event is needed here.
 *
 * `rename` maps the entry to its new path instead of dropping it: a rename must
 * not silently un-bookmark. `prefix` handles a folder delete in one write.
 *
 * Best-effort: a favorites bookkeeping failure must never fail the delete/move
 * the user asked for.
 */
export async function pruneFavoriteNotes(
  op: { kind: 'delete'; relPath: string } | { kind: 'rename'; relPath: string; toRel: string } | { kind: 'prefix'; prefix: string },
): Promise<void> {
  try {
    const config = await getConfig()
    const notes = config.favorites?.notes
    if (!notes || notes.length === 0) return
    let next: string[]
    if (op.kind === 'prefix') {
      next = notes.filter((p) => !p.startsWith(op.prefix))
    } else if (op.kind === 'rename') {
      next = notes.map((p) => (p === op.relPath ? op.toRel : p))
    } else {
      next = notes.filter((p) => p !== op.relPath)
    }
    if (next.length === notes.length && next.every((p, i) => p === notes[i])) return
    await updateConfig({ favorites: { ...config.favorites, notes: next } })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'], { source: 'notes-v2' })
    log.memory.info('Note bookmarks updated after a vault change', { op: op.kind })
  } catch (err) {
    log.memory.warn('notes-v2: favorites bookkeeping skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * A note moved (`fromRel` -> `toRel`, already at its new path): its index row keeps its id (and
 * every link edge) with a one-row path update, both paths are reconciled, and its bookmark
 * follows. `indexed: false` for a file the structural index does not hold (an attachment, a
 * drawing's scene): only the bookmark follows.
 */
export async function followMovedNote(fromRel: string, toRel: string, opts: { indexed?: boolean } = {}): Promise<void> {
  if (opts.indexed !== false) {
    updateNotePath(fromRel, toRel)
    scheduleNotesIndexUpdate(fromRel)
    scheduleNotesIndexUpdate(toRel)
  }
  await pruneFavoriteNotes({ kind: 'rename', relPath: fromRel, toRel })
}

/**
 * A drawing's scene moved (`fromRel` -> `toRel`, already at its new path): its companion note goes
 * along when it is ours (drawings/companion-sync.ts), and the companion's index row and bookmark
 * follow it. The scene's own bookmark is the caller's `followMovedNote`.
 */
export async function followMovedDrawingCompanion(fromRel: string, toRel: string): Promise<void> {
  // Its recorded walkthroughs (not a note: no index row or bookmark) go along too.
  await moveNarration(fromRel, toRel)
  const companion = await moveDrawingCompanion(fromRel, toRel)
  if (companion) await followMovedNote(companion.from, companion.to)
}
