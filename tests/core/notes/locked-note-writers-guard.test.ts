/**
 * Class guard: every place that writes a note leaves a locked note as it is (docs/reference/locked-notes.md).
 * A locked note's file holds only its id, the mark, a stub and the ciphertext; a writer that does
 * not check would put text in the clear beside it, or replace the ciphertext and lose the note.
 *
 * The writers are found from the source, three ways:
 *  1. every module that announces a note change (`NOTES_UPDATED`, the shared note-write contract);
 *  2. every module that writes a file at a path it built under the notes folder;
 *  3. every module that applies a note save or read for another machine (the replica, the offline
 *     copy of a host, the companion, the offline merge, the plugin service), named here.
 * And every op that answers or saves a released locked note never keeps its answer (op-calls.ts).
 * Each one checks the lock (one of the helpers in src/core/notes/locked-note.ts, or the notes
 * route's guarded write), or is listed with why it can never touch a locked note. A new writer
 * fails here until it checks.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
const CHECKS = /\b(assertNotLocked|assertNotLockedText|assertFileNotLocked|isLockedNoteText|lockedOnDisk|readableNoteText|writeNoteContent)\(/

function grepFiles(re: string): string[] {
  try {
    return execFileSync('git', ['grep', '--untracked', '-lE', re, '--', 'src/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

/** Announcers that write no note a person can lock, and why. */
const NO_LOCKED_WRITE: Record<string, string> = {
  'src/core/event-bus.ts': 'defines the event',
  'src/core/host-replica-sync.ts': 'relays the event to a host, writes no note',
  'src/web/routes/drawings.ts': 'writes the drawing; its Notes entry is companion-sync.ts\'s',
  'src/core/drawings/companion-sync.ts': 'a locked companion has no companion block (isOwnCompanion), so mergeCompanion answers foreign and nothing is written',
  'src/web/routes/notes.ts': 'writes global-notes.md only, which cannot be locked (locked-note-store.ts lockNote)',
  'src/core/notes/locked-note-store.ts': 'the locked note\'s own writer',
}

/** The writers for another machine or a plugin, which announce nothing themselves. */
const OTHER_WRITERS = [
  'src/core/companion-notes.ts',
  'src/providers/offline-host-core.ts',
  'src/providers/host-replica-core.ts',
  'src/replica/notes-routes.ts',
  'src/core/offline-merge/notes.ts',
  'src/core/plugins/notes-service.ts',
  'src/web/routes/file-content.ts',
]

/** Modules that write a file under the notes folder with no lock check, and why that is safe. */
const NOTE_PATH_WRITERS_OK: Record<string, string> = {
  'src/core/host-replica.ts': 'a host\'s copy of the leader\'s notes, written with the leader\'s bytes as they are (stub and ciphertext)',
  'src/core/notes-migration.ts': 'moves the old global notes file, which cannot be locked',
  'src/core/offline-merge/apply-note-attachment.ts': 'writes attachments, never a note\'s text',
}

describe('every note writer leaves a locked note as it is', () => {
  it('every module that writes a file under the notes folder checks the lock, or says why it need not', () => {
    const writers = grepFiles('notesRoot\\(|resolveNotePath\\(|noteAbs\\(|noteAbsIn\\(')
      .filter((f) => /writeFile\(|writeFileAtomic\(|replaceAtomically\(|createExclusively\(/.test(read(f)))
    const problems = writers.filter((f) => !NOTE_PATH_WRITERS_OK[f] && !CHECKS.test(read(f)))
      .map((f) => `${f} writes under the notes folder but never checks the lock: refuse or skip a locked note, or list it in NOTE_PATH_WRITERS_OK with why`)
    expect(problems).toEqual([])
    expect(Object.keys(NOTE_PATH_WRITERS_OK).filter((f) => !writers.includes(f))).toEqual([])
  })

  it('an op that answers or saves a released locked note never keeps its answer for a resend', async () => {
    const { listOps } = await import('../../../src/ops/index.js')
    const released = listOps({ includeDeprecated: true }).filter((op) => /^\/vault\/notes\/agent\/ask\/:id\/(?!cancel)/.test(op.bind?.path ?? ''))
    expect(released.map((op) => op.name).sort()).toEqual(['locked_note_save', 'locked_note_wait'])
    expect(released.filter((op) => !op.answerNeverKept).map((op) => op.name)).toEqual([])
  })

  it('every module that announces a note change checks the lock, or says why it never writes one', () => {
    const announcers = grepFiles('EventNames\\.NOTES_UPDATED|NOTES_UPDATED\\b')
    const problems = announcers.filter((f) => !NO_LOCKED_WRITE[f] && !CHECKS.test(read(f)))
      .map((f) => `${f} announces a note write but never checks the lock: refuse or skip a locked note (src/core/notes/locked-note.ts), or list it in NO_LOCKED_WRITE with why`)
    expect(problems).toEqual([])
    // A stale entry is dropped here too.
    expect(Object.keys(NO_LOCKED_WRITE).filter((f) => !announcers.includes(f))).toEqual([])
  })

  it('every writer for another machine or a plugin checks the lock', () => {
    expect(OTHER_WRITERS.filter((f) => !CHECKS.test(read(f)))).toEqual([])
  })
})
