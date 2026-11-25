/**
 * Where a locked note may go (src/core/notes/locked-note-moves.ts, docs/reference/locked-notes.md):
 * only the person moves, renames or deletes one, nobody copies one, and it never lands on a note
 * Walnut writes itself (src/core/notes/vault-files.ts walnutWritesNote), whatever the letter case.
 * A note or a folder holding one, and a folder that holds the whole vault. Fake files only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('locked-note-paths'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { notesRoot, setNotesRoot } from '../../../src/core/notes/note-paths.js'
import { buildLockedNoteText, LockedNoteError } from '../../../src/core/notes/locked-note.js'
import { walnutWritesNote } from '../../../src/core/notes/vault-files.js'
import { TRIAGE_RUNS_NOTE_DIR, TRIAGE_STATE_NOTE } from '../../../src/core/triage/batch.js'
import { triageRunsNotePath } from '../../../src/core/triage/runs.js'
import {
  assertLockedNoteDelete, assertLockedNoteMove, assertNoLockedNoteCopy, fileLooksLocked,
} from '../../../src/core/notes/locked-note-moves.js'

const LOCKED = buildLockedNoteText({ id: 'n_lock1', envelope: { key: 'k1', iv: 'AAAA', ct: 'BBBB' } })
const at = (...p: string[]) => path.join(notesRoot(), ...p)

async function put(rel: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(at(rel)), { recursive: true })
  await fsp.writeFile(at(rel), text)
}

async function refusal(p: Promise<void>): Promise<{ status: number; code: string } | null> {
  try { await p } catch (err) {
    if (err instanceof LockedNoteError) return { status: err.status, code: err.code }
    throw err
  }
  return null
}

beforeEach(async () => {
  setNotesRoot(null)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await put('Private/Diary.md', LOCKED)
  await put('Private/plain.md', '# plain\n')
  await put('Open/a.md', '# a\n')
})
afterAll(() => setNotesRoot(null))

describe('walnutWritesNote', () => {
  it('names every note Walnut writes itself, in any letter case', () => {
    for (const rel of [
      'global-notes.md', 'memory/x.md', 'projects/acme/memory/t1/x.md', 'skills/s/SKILL.md', 'projects/acme/skills/s/SKILL.md',
      'Walnut/Triage/State.md', 'Walnut/Triage/Runs/2026-11.md', 'walnut/triage/state.md', 'Projects/Acme/Memory/t1/x.md', 'GLOBAL-NOTES.md',
    ]) expect(walnutWritesNote(rel), rel).toBe(true)
    for (const rel of ['Private/Diary.md', 'Walnut/Triage/Notes.md', 'Walnut/Triage/Runs/old/2026-11.md', 'my-memory/x.md', 'projects/acme/notes.md']) {
      expect(walnutWritesNote(rel), rel).toBe(false)
    }
  })

  it('holds the paths Inbox Triage really writes (core/triage/batch.ts)', () => {
    expect(walnutWritesNote(TRIAGE_STATE_NOTE)).toBe(true)
    expect(walnutWritesNote(triageRunsNotePath(Date.UTC(2026, 10, 25)))).toBe(true)
    expect(triageRunsNotePath(0).startsWith(`${TRIAGE_RUNS_NOTE_DIR}/`)).toBe(true)
  })
})

describe('a locked note moves only for the person, and never onto a note Walnut writes', () => {
  it('refuses an agent\'s move or rename of a locked note, or of a folder holding one', async () => {
    expect(await refusal(assertLockedNoteMove(at('Private/Diary.md'), at('Elsewhere/Diary.md'), { person: false }))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertLockedNoteMove(at('Private'), at('Moved'), { person: false }))).toEqual({ status: 423, code: 'note_locked' })
    // A plain note and a folder without one move as before.
    expect(await refusal(assertLockedNoteMove(at('Private/plain.md'), at('Elsewhere/plain.md'), { person: false }))).toBeNull()
    expect(await refusal(assertLockedNoteMove(at('Open'), at('Moved'), { person: false }))).toBeNull()
  })

  it('lets the person move it, but not onto a memory folder, the skills, global notes or triage\'s notes', async () => {
    expect(await refusal(assertLockedNoteMove(at('Private/Diary.md'), at('Elsewhere/Diary.md'), { person: true }))).toBeNull()
    for (const dest of ['projects/acme/memory/t1/Diary.md', 'memory/Diary.md', 'skills/s/SKILL.md', 'global-notes.md', 'Walnut/Triage/State.md', 'walnut/triage/runs/2026-11.md']) {
      expect(await refusal(assertLockedNoteMove(at('Private/Diary.md'), at(dest), { person: true })), dest).toEqual({ status: 400, code: 'not_lockable' })
    }
    // A folder whose locked note would land on State.md, and one whose notes land nowhere Walnut writes.
    await put('Stuff/State.md', LOCKED)
    expect(await refusal(assertLockedNoteMove(at('Stuff'), at('Walnut/Triage'), { person: true }))).toEqual({ status: 400, code: 'not_lockable' })
    expect(await refusal(assertLockedNoteMove(at('Stuff'), at('Archive/Stuff'), { person: true }))).toBeNull()
    // A plain note may go there: only a locked one is refused.
    expect(await refusal(assertLockedNoteMove(at('Private/plain.md'), at('memory/plain.md'), { person: true }))).toBeNull()
  })

  it('refuses an agent\'s delete of a locked note, a folder holding one, or a folder holding the whole vault', async () => {
    expect(await refusal(assertLockedNoteDelete(at('Private/Diary.md'), { person: false }))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertLockedNoteDelete(at('Private'), { person: false }))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertLockedNoteDelete(WALNUT_HOME, { person: false }))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertLockedNoteDelete(at('Open'), { person: false }))).toBeNull()
    expect(await refusal(assertLockedNoteDelete(at('Private'), { person: true }))).toBeNull()
  })

  it('refuses a copy of a locked note, or of a folder holding one, for everyone', async () => {
    expect(await refusal(assertNoLockedNoteCopy(at('Private/Diary.md')))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertNoLockedNoteCopy(at('Private')))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertNoLockedNoteCopy(at('Open')))).toBeNull()
  })

  it('reads a note as locked by its mark even when an outside editor bent the envelope (fail closed)', async () => {
    await put('Private/Bent.md', LOCKED.replace('<!-- walnut-locked-note', '  <!-- walnut-locked-note').replace(' -->', ' --> trailing'))
    expect(await fileLooksLocked(at('Private/Bent.md'))).toBe(true)
    expect(await fileLooksLocked(at('Private/plain.md'))).toBe(false)
    expect(await fileLooksLocked(at('Private/missing.md'))).toBe(false)
  })

  it('finds the vault through a link: a path to the real folder is the same vault', async () => {
    const real = path.join(WALNUT_HOME, 'real-vault')
    await fsp.mkdir(path.join(real, 'Private'), { recursive: true })
    await fsp.writeFile(path.join(real, 'Private', 'Diary.md'), LOCKED)
    const link = path.join(WALNUT_HOME, 'vault-link')
    await fsp.symlink(real, link)
    setNotesRoot(link)
    expect(await refusal(assertLockedNoteDelete(path.join(real, 'Private', 'Diary.md'), { person: false }))).toEqual({ status: 423, code: 'note_locked' })
    expect(await refusal(assertLockedNoteMove(path.join(real, 'Private', 'Diary.md'), path.join(real, 'memory', 'Diary.md'), { person: true })))
      .toEqual({ status: 400, code: 'not_lockable' })
  })
})
