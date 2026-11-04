/**
 * A wiki link the notes editor saved escaped (`\\[\\[path|Title\\]\\]`, as it did before
 * 2026-11-04, every `_` and `*` in the path escaped too) is the same link to the index: its target
 * gets the backlink, from prose and from a table cell (`\\|` alias pipe) alike.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('notes-escaped-links-test'))

// Reconcile drives the search index best-effort; stub it so no real
// search.sqlite / embedding model is opened during these structural tests.
vi.mock('../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}))

import { WALNUT_HOME, NOTES_DIR } from '../../src/constants.js'
import {
  closeNotesIndexDb,
  getNoteIdByPath,
  backlinksForId,
} from '../../src/core/notes-index.js'
import {
  rebuildIndex,
  stopNotesIndexer,
  resetNotesIndexer,
} from '../../src/core/notes-indexer.js'
import { stampAllIds } from '../../src/core/notes-identity.js'

async function writeNote(relPath: string, content: string): Promise<void> {
  const full = path.join(NOTES_DIR, relPath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

async function quiesce(): Promise<void> {
  stopNotesIndexer()
  await new Promise((r) => setTimeout(r, 5))
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


describe('escaped wiki links', () => {
  it('count as links to their target', async () => {
    await writeNote('Projects/my_plan.md', '# Plan')
    await writeNote('prose.md', 'See \\[\\[Projects/my\\_plan|The plan\\]\\] today.')
    await writeNote('table.md', '| a |\n| --- |\n| \\[\\[Projects/my\\_plan\\|Plan\\]\\] |\n')
    await writeNote('bare.md', 'And [[Projects/my_plan]].')
    await rebuildIndex()
    await stampAllIds()
    const id = getNoteIdByPath('Projects/my_plan.md')!
    expect(backlinksForId(id).map((b) => b.path).sort()).toEqual(['bare.md', 'prose.md', 'table.md'])
  })
})
