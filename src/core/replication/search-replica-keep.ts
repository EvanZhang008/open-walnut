/**
 * What a follower keeps of the search docs (docs/plan/walnut-companion-unified-replica.md,
 * 4f): the docs of what its copy keeps, nothing more. A note its notes copy leaves out (a
 * folder or one note, replication/keep-rule.ts), and every note, memory or skill doc of a
 * kind turned off for it, is not sent; a copy that holds one drops it on the next round.
 * A follower that keeps everything (the default) gets the whole index, as before.
 */

import path from 'node:path'
import { leftOut } from './keep-rule.js'

export interface SearchKeep {
  notes: boolean
  memory: boolean
  skills: boolean
  notesExclude: readonly string[]
}

/** Where the vault's note keys start (`note:~/notes/`), or null when the vault is outside the data home. */
export function searchNoteKeyPrefix(home: string, notesDir: string): string | null {
  const rel = path.relative(home, notesDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return `note:~/${rel.split(path.sep).join('/')}/`
}

/** True when the follower keeps everything: no filter at all. */
export function keepsAllSearch(keep: SearchKeep | null): boolean {
  return !keep || (keep.notes && keep.memory && keep.skills && keep.notesExclude.length === 0)
}

/** Whether a follower with `keep` keeps the search doc `key` (search/replica-refs.ts keys). */
export function searchKeyKept(key: string, keep: SearchKeep | null, notePrefix: string | null): boolean {
  if (keepsAllSearch(keep)) return true
  if (key.startsWith('note:')) {
    if (!keep!.notes) return false
    if (!notePrefix || !key.startsWith(notePrefix)) return true
    return !leftOut(key.slice(notePrefix.length), keep!.notesExclude)
  }
  if (key.startsWith('memory:')) return keep!.memory
  if (key.startsWith('skill:')) return keep!.skills
  return true
}
