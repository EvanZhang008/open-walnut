/**
 * A change made away to a note that is locked on the Mac is not applied (core/offline-merge/notes.ts),
 * and the letter tells the person plainly where the text they typed away is kept: the conflict log
 * file on this Mac, as plain text, whole (not cut to a preview), in each letter language. A delete
 * made away names no file, since it kept no text. Fake entries only.
 */
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('locked-note-offline-letter'))

import { conflictDir, type ConflictEntry, type ConflictLogFile } from '../../../src/core/offline-merge/conflict-log.js'
import { conflictLetterIn } from '../../../src/core/human-inbox/walnut-letters/offline-conflict.js'

const DRAIN = 'd-companion-1-abc'
const logFile = (entries: ConflictEntry[]): ConflictLogFile =>
  ({ v: 2, drainId: DRAIN, hostKey: 'companion', home: '/tmp/x', startedAt: '2026-11-25T00:00:00.000Z', entries })
const EDIT: ConflictEntry = {
  kind: 'note', seq: 1, recordKind: 'note', notePath: 'Private/Diary.md', why: 'locked', kept: 'mac',
  replica: 'A line typed on the phone.', reason: 'the note is locked on the Mac, so a change made while away was not applied',
}
const DELETE: ConflictEntry = { kind: 'note', seq: 2, recordKind: 'note', notePath: 'Private/Old.md', why: 'locked', kept: 'mac' }

describe('the letter for a change to a locked note', () => {
  it('names the file the away text is kept in, as plain text, in every letter language', () => {
    const where = path.join(conflictDir(), `${DRAIN}.ndjson`)
    for (const lang of ['en', 'zh'] as const) {
      const md = conflictLetterIn(lang, logFile([EDIT]))!.markdown
      expect(md, lang).toContain(where)
      expect(md, lang).toContain('Show')
      // The whole sentence, not the 160-character preview of the entry's reason.
      expect(md, lang).not.toContain('...')
    }
    expect(conflictLetterIn('en', logFile([EDIT]))!.markdown).toContain('plain text')
  })

  it('a delete made away names no file: it kept no text', () => {
    const md = conflictLetterIn('en', logFile([DELETE]))!.markdown
    expect(md).toContain('only its owner deletes it')
    expect(md).not.toContain('.ndjson')
  })
})
