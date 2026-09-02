/**
 * Tests for the notes id migration (notes-identity.ts) — IMPL-CONTRACT §2 / tech §8.3, §12.
 *
 *  - stampAllIds():  the "stamp all ids now" batched migration. Stamps id-less
 *    notes, is idempotent (already-id'd notes untouched byte-for-byte), and the
 *    splice is byte-minimal (only the id: line added).
 *  - mergeDivergentIds(): earliest-created-wins merge for the multi-machine
 *    git-merge hazard — two machines stamp the SAME id-less note, a git merge
 *    leaves two copies with two ids; the merge resolves to ONE id, inbound links
 *    re-point to the earliest-created winner, and there are 0 orphaned links.
 *  - idTimestamp() tie-break helper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('notes-identity-test'))

// Reconcile drives the search index best-effort; stub it so no real
// search.sqlite / embedding model is opened during these structural tests.
vi.mock('../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}))

import { WALNUT_HOME, NOTES_DIR } from '../../src/constants.js'
import { idTimestamp, generateNoteId } from '../../src/core/parse-frontmatter.js'
import {
  closeNotesIndexDb,
  getNoteIdByPath,
  backlinksForId,
  forwardLinksForId,
  divergentCopyGroups,
} from '../../src/core/notes-index.js'
import {
  rebuildIndex,
  stopNotesIndexer,
  resetNotesIndexer,
} from '../../src/core/notes-indexer.js'
import {
  stampAllIds,
  mergeDivergentIds,
  mergeNoteIds,
} from '../../src/core/notes-identity.js'

async function writeNote(relPath: string, content: string): Promise<void> {
  const full = path.join(NOTES_DIR, relPath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}
async function readNote(relPath: string): Promise<string> {
  return fs.readFile(path.join(NOTES_DIR, relPath), 'utf-8')
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

// ── idTimestamp helper ───────────────────────────────────────────────────────

describe('idTimestamp', () => {
  it('decodes the create-time from a generated id (earlier id → smaller ts)', async () => {
    const early = generateNoteId()
    await new Promise((r) => setTimeout(r, 5))
    const late = generateNoteId()
    expect(idTimestamp(early)).toBeLessThanOrEqual(idTimestamp(late))
    expect(Number.isFinite(idTimestamp(early))).toBe(true)
  })

  it('returns NaN for a non-conforming id', () => {
    expect(Number.isNaN(idTimestamp('not-an-id'))).toBe(true)
    expect(Number.isNaN(idTimestamp('n_'))).toBe(true)
  })
})

// ── stampAllIds (the "stamp all ids now" migration) ────────────────────────────

describe('stampAllIds', () => {
  it('stamps an id into every id-less note (byte-minimal splice)', async () => {
    await writeNote('a.md', '# Alpha\n\nbody a')
    await writeNote('sub/b.md', '---\ntitle: Bee\n---\nbody b')
    // No rebuild first: the reconciler's fallback back-write would otherwise stamp
    // these on its own. stampAllIds is the explicit batched migration entry point.

    const result = await stampAllIds()
    expect(result.stamped).toBe(2)
    expect(result.skipped).toBe(0)

    // a.md had no frontmatter → a minimal block was prepended.
    const a = await readNote('a.md')
    expect(a).toMatch(/^---\nid: n_[0-9a-z]+\n---\n# Alpha\n\nbody a$/)

    // b.md had frontmatter → id spliced as first line, title preserved.
    const b = await readNote('sub/b.md')
    expect(b).toMatch(/^---\nid: n_[0-9a-z]+\ntitle: Bee\n---\nbody b$/)

    // Index now knows both ids.
    expect(getNoteIdByPath('a.md')).toMatch(/^n_/)
    expect(getNoteIdByPath('sub/b.md')).toMatch(/^n_/)
  })

  it('is idempotent — a note that already has an id is left byte-for-byte', async () => {
    const content = '---\nid: n_keepme\ntitle: Keep\n---\n# Body'
    await writeNote('keep.md', content)
    await rebuildIndex()

    const r1 = await stampAllIds()
    expect(r1.stamped).toBe(0) // already identified
    expect(await readNote('keep.md')).toBe(content) // unchanged

    // Second run is also a no-op.
    const r2 = await stampAllIds()
    expect(r2.stamped).toBe(0)
    expect(await readNote('keep.md')).toBe(content)
  })

  it('preserves inbound link resolution after stamping (name → id)', async () => {
    await writeNote('target.md', '# Target')
    await writeNote('linker.md', 'See [[target]].')
    await rebuildIndex()

    await stampAllIds()
    const targetId = getNoteIdByPath('target.md')!
    expect(targetId).toMatch(/^n_/)
    const backlinks = backlinksForId(targetId)
    expect(backlinks.map((b) => b.path)).toContain('linker.md')
    expect(backlinks.every((b) => b.status === 'resolved')).toBe(true)
  })
})

// ── divergentCopyGroups detection ──────────────────────────────────────────────

describe('divergentCopyGroups', () => {
  it('detects two copies with identical title+body but different ids', async () => {
    await writeNote('note.md', '---\nid: n_aaa\n---\n# Same\n\nidentical body')
    await writeNote('note-copy.md', '---\nid: n_bbb\n---\n# Same\n\nidentical body')
    await rebuildIndex()

    const groups = divergentCopyGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].map((e) => e.id).sort()).toEqual(['n_aaa', 'n_bbb'])
  })

  it('does NOT group two notes that share a title but have different bodies', async () => {
    await writeNote('one.md', '---\nid: n_one\n---\n# Same Title\n\nbody one')
    await writeNote('two.md', '---\nid: n_two\n---\n# Same Title\n\nbody two — different')
    await rebuildIndex()

    expect(divergentCopyGroups()).toHaveLength(0) // legitimately distinct notes
  })
})

// ── mergeDivergentIds (multi-machine git-merge hazard, §8.3 / §16) ─────────────

describe('mergeDivergentIds — earliest-created-wins', () => {
  it('resolves two divergent copies to one id, re-points inbound links, 0 orphans', async () => {
    // Two machines stamped the SAME id-less note; a git merge left two copies.
    // Machine A (earlier created) → winner; machine B → loser. A third note links
    // to the LOSER id (as machine B had pushed it into its backlink history).
    await writeNote(
      'note.md',
      '---\nid: n_winner\ncreated: 2026-01-01T00:00:00.000Z\n---\n# Shared\n\nidentical body',
    )
    await writeNote(
      'note-from-b.md',
      '---\nid: n_loser\ncreated: 2026-02-01T00:00:00.000Z\n---\n# Shared\n\nidentical body',
    )
    // The linker authored [[Shared]] — which resolves ambiguously to both copies.
    await writeNote('linker.md', '---\nid: n_link\n---\nSee [[Shared]] for context.')
    await rebuildIndex()

    const result = await mergeDivergentIds()
    expect(result.groups).toBe(1)

    // The loser file converged onto the winner id on disk.
    const loserOnDisk = await readNote('note-from-b.md')
    expect(loserOnDisk).toContain('id: n_winner')
    expect(loserOnDisk).not.toContain('id: n_loser')
    // Winner file untouched on its id.
    expect(await readNote('note.md')).toContain('id: n_winner')

    // No index row carries the loser id anymore (no orphans).
    const allForLoser = forwardLinksForId('n_loser')
    expect(allForLoser).toHaveLength(0)

    // The winner id is the surviving identity for both paths' content.
    expect(getNoteIdByPath('note.md')).toBe('n_winner')

    // Core §16 guarantee: the inbound [[Shared]] edge re-points to the winner and
    // is no longer ambiguous (the duplicate candidate is gone) — 0 orphaned links.
    const winnerBacklinks = backlinksForId('n_winner')
    expect(winnerBacklinks.map((b) => b.path)).toContain('linker.md')
    const linkerEdge = winnerBacklinks.find((b) => b.path === 'linker.md')
    expect(linkerEdge?.status).toBe('resolved')
    expect(backlinksForId('n_loser')).toHaveLength(0)
  })

  it('picks the earliest created even when file order is reversed', async () => {
    await writeNote(
      'z-late.md',
      '---\nid: n_late\ncreated: 2026-05-01T00:00:00.000Z\n---\n# Dup\n\nbody',
    )
    await writeNote(
      'a-early.md',
      '---\nid: n_early\ncreated: 2026-03-01T00:00:00.000Z\n---\n# Dup\n\nbody',
    )
    await rebuildIndex()

    await mergeDivergentIds()
    // Earliest created (n_early) wins regardless of path sort order.
    expect(await readNote('z-late.md')).toContain('id: n_early')
    expect(await readNote('a-early.md')).toContain('id: n_early')
  })

  it('is a no-op when there are no divergent copies', async () => {
    await writeNote('solo.md', '---\nid: n_solo\n---\n# Solo\n\nunique body')
    await rebuildIndex()
    const result = await mergeDivergentIds()
    expect(result).toEqual({ groups: 0, repointedIds: 0 })
  })
})

// ── mergeNoteIds primitive (cross-file id collapse) ────────────────────────────

describe('mergeNoteIds', () => {
  it('re-points a backlink edge from a loser id to the winner id', async () => {
    await writeNote('winner.md', '---\nid: n_win\n---\n# Winner')
    await writeNote('loser.md', '---\nid: n_lose\n---\n# Loser body that differs')
    // A note links to the loser by path form so the edge keys on n_lose.
    await writeNote('linker.md', '---\nid: n_lk\n---\nLink [[loser]].')
    await rebuildIndex()

    // Sanity: the linker resolves to the loser pre-merge.
    expect(backlinksForId('n_lose').map((b) => b.path)).toContain('linker.md')

    const repointed = await mergeNoteIds({ loserId: 'n_lose', winnerId: 'n_win', loserPath: 'loser.md' })
    expect(repointed).toBe(1)

    // The inbound edge re-pointed to the winner; loser id has no inbound edges.
    expect(backlinksForId('n_lose')).toHaveLength(0)
    expect(backlinksForId('n_win').map((b) => b.path)).toContain('linker.md')
    // Loser file's id line converged to the winner (content otherwise preserved).
    const loserBytes = await readNote('loser.md')
    expect(loserBytes).toContain('id: n_win')
    expect(loserBytes).toContain('# Loser body that differs')
  })

  it('handles a loser whose frontmatter is ONLY an id (no doubled fence)', async () => {
    await writeNote('w.md', '---\nid: n_keep\n---\n# Same\n\nbody')
    await writeNote('l.md', '---\nid: n_drop\n---\n# Same\n\nbody') // id is the only fm field
    await rebuildIndex()

    await mergeNoteIds({ loserId: 'n_drop', winnerId: 'n_keep', loserPath: 'l.md' })

    const l = await readNote('l.md')
    // Exactly one clean frontmatter block carrying the winner id; body intact.
    expect(l).toBe('---\nid: n_keep\n---\n# Same\n\nbody')
    expect((l.match(/^---$/gm) || []).length).toBe(2) // one open + one close fence
  })
})
