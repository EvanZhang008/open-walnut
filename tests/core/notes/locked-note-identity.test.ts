/**
 * The "stamp all ids" migration (src/core/notes-identity.ts stampAllIds) leaves a locked note's
 * file as its lock wrote it (docs/reference/locked-notes.md): an id stamped into an id-less locked
 * file would differ from the one inside its ciphertext. A plain id-less note beside it still gets one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('locked-note-identity-test'))
// The structural index only: no search database or embedding model.
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}))

import { WALNUT_HOME, NOTES_DIR } from '../../../src/constants.js'
import { closeNotesIndexDb } from '../../../src/core/notes-index.js'
import { settleNotesIndexer, resetNotesIndexer } from '../../../src/core/notes-indexer.js'
import { stampAllIds } from '../../../src/core/notes-identity.js'
import { buildLockedNoteText } from '../../../src/core/notes/locked-note.js'

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(NOTES_DIR, rel)), { recursive: true })
  await fs.writeFile(path.join(NOTES_DIR, rel), text, 'utf-8')
}
const read = (rel: string) => fs.readFile(path.join(NOTES_DIR, rel), 'utf-8')

async function quiesce(): Promise<void> {
  await settleNotesIndexer()
  closeNotesIndexDb()
}

beforeEach(async () => {
  await quiesce()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(NOTES_DIR, { recursive: true })
  resetNotesIndexer()
})
afterEach(async () => {
  await quiesce()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('stampAllIds and a locked note', () => {
  it('stamps no id into an id-less locked file, and still stamps the plain note beside it', async () => {
    const locked = buildLockedNoteText({ envelope: { key: 'item-1', iv: 'AAAAAAAAAAAAAAAA', ct: 'aWRsZXNzbG9ja2Vk' } })
    expect(locked).not.toMatch(/^id:/m)
    await write('journal/Sealed.md', locked)
    await write('journal/Plain.md', '# Plain\n')
    const result = await stampAllIds()
    expect(result.stamped).toBe(1)
    expect(await read('journal/Sealed.md')).toBe(locked)
    expect(await read('journal/Plain.md')).toMatch(/^---\nid: n_[0-9a-z]+\n---\n# Plain\n$/)
  })
})
