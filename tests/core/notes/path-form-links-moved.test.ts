/**
 * A path-form link written before the notes moved into the one tree (`[[marina/plan]]`, its
 * old folder) still points at its note: the index's backlinks, its re-resolve pass and the web
 * client's click all follow the move map (src/core/artifacts/unify/map.ts movedPath), in any
 * case, as the Mac's vault finds a file. The ratchet at the end fails when a new resolver of
 * path-form links appears that does not ask the map.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('path-form-links-moved'))
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeNotesIndexDb, getNoteIdByPath, backlinksForId, reresolveAllEdges, findNoteIdByPathForm } from '../../../src/core/notes-index.js'
import { rebuildIndex, stopNotesIndexer, resetNotesIndexer } from '../../../src/core/notes-indexer.js'
import { stampAllIds } from '../../../src/core/notes-identity.js'
import { setNotesRoot } from '../../../src/core/notes/note-paths.js'
import { setNoteMoves } from '../../../src/core/notes/note-path-moves.js'
import { movedPath } from '../../../src/core/artifacts/unify/map.js'
import { resolveWikiLinkTarget } from '../../../web/src/components/notes/wiki-link/resolve-wiki-link.js'
import { resolveAttachmentPath } from '../../../src/web/routes/notes-attachment.js'

const tree = path.join(WALNUT_HOME, 'artifacts')
const map = {
  exact: { 'marina/Old Name.md': 'projects/Marina/notes/Old Name 2.md' },
  rules: [
    { from: 'marina/', to: 'projects/Marina/notes/' },
    { from: '', to: 'notes/' },
  ],
}

async function writeNote(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(tree, rel)), { recursive: true })
  await fs.writeFile(path.join(tree, rel), content, 'utf-8')
}

async function quiesce(): Promise<void> {
  stopNotesIndexer()
  await new Promise((r) => setTimeout(r, 5))
  closeNotesIndexDb()
}

beforeEach(async () => {
  await quiesce()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(tree, { recursive: true })
  setNotesRoot(tree)
  setNoteMoves(map)
  resetNotesIndexer()
})

afterEach(async () => {
  await quiesce()
  setNotesRoot(null)
  setNoteMoves(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a path-form link from before the move', () => {
  it('maps in any case, and a path in the tree\'s terms stays', () => {
    expect(movedPath('Marina/plan', map)).toBe('projects/Marina/notes/plan')
    expect(movedPath('marina/old name.md', map)).toBe('projects/Marina/notes/Old Name 2.md')
    expect(movedPath('projects/Marina/notes/plan', map)).toBe('projects/Marina/notes/plan')
    expect(movedPath('family/pier', null)).toBe('family/pier')
  })

  it('is a backlink of its note in the index, and stays one after a re-resolve', async () => {
    await writeNote('projects/Marina/notes/plan.md', '# Plan')
    await writeNote('projects/Marina/notes/Old Name 2.md', '# Old')
    await writeNote('notes/family/pier.md', 'See [[marina/plan|the plan]] and [[Marina/Old Name]].')
    await writeNote('notes/family/new.md', 'And [[projects/Marina/notes/plan]].')
    await rebuildIndex()
    await stampAllIds()
    const plan = getNoteIdByPath('projects/Marina/notes/plan.md')!
    const old = getNoteIdByPath('projects/Marina/notes/Old Name 2.md')!
    expect(findNoteIdByPathForm('marina/plan')).toBe(plan)
    expect(backlinksForId(plan).map((b) => b.path).sort()).toEqual(['notes/family/new.md', 'notes/family/pier.md'])
    expect(backlinksForId(old).map((b) => b.path)).toEqual(['notes/family/pier.md'])
    reresolveAllEdges()
    expect(backlinksForId(plan).map((b) => b.path).sort()).toEqual(['notes/family/new.md', 'notes/family/pier.md'])
  })

  it('never stamps an id into a file Walnut writes itself (a memory folder, a skill)', async () => {
    const mem = '---\nkind: memory\n---\n\n- the pier opens Friday\n'
    const skill = '---\nname: "pier-steps"\n---\nStep one.\n'
    await writeNote('projects/Marina/memory/t-1/MEMORY.md', mem)
    await writeNote('skills/pier-steps/SKILL.md', skill)
    await writeNote('notes/family/pier.md', '# Pier\n')
    await rebuildIndex()
    await stampAllIds()
    expect(await fs.readFile(path.join(tree, 'projects/Marina/memory/t-1/MEMORY.md'), 'utf-8')).toBe(mem)
    expect(await fs.readFile(path.join(tree, 'skills/pier-steps/SKILL.md'), 'utf-8')).toBe(skill)
    expect(getNoteIdByPath('skills/pier-steps/SKILL.md')).toMatch(/^n_w/)
    // The user's own notes still get theirs, in the file.
    expect(await fs.readFile(path.join(tree, 'notes/family/pier.md'), 'utf-8')).toMatch(/^---\nid: n_/)
  })

  it('an embed of a name several pictures share shows the same one as before the move', async () => {
    // Before: finance/pic.png (one folder deep) won over b/c/pic.png (two) for a note at the root.
    // After, both are three deep, and by name alone notes/b/c/... would win.
    setNoteMoves({ exact: {}, rules: [{ from: 'finance/', to: 'projects/Finance/notes/' }, { from: '', to: 'notes/' }] }, [
      ['finance/pic.png', 'projects/Finance/notes/pic.png'], ['b/c/pic.png', 'notes/b/c/pic.png'], ['n.md', 'notes/n.md'],
    ])
    await writeNote('projects/Finance/notes/pic.png', 'finance')
    await writeNote('notes/b/c/pic.png', 'bc')
    await writeNote('notes/n.md', '![[pic.png]]')
    const hit = await resolveAttachmentPath('pic.png', 'notes/n.md')
    expect(hit).toBe(path.join(tree, 'projects/Finance/notes/pic.png'))
  })

  it('opens its note from the web client', () => {
    const notes = [
      { path: 'projects/Marina/notes/plan.md', name: 'plan' },
      { path: 'notes/family/pier.md', name: 'pier' },
    ]
    const hit = resolveWikiLinkTarget('marina/plan', notes, map)
    expect(hit.kind === 'resolved' && hit.note.path).toBe('projects/Marina/notes/plan.md')
    expect(resolveWikiLinkTarget('marina/plan', notes, null).kind).toBe('unresolved')
  })
})

describe('every resolver of a path-form link', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  // Each asks the map itself, or through one of these that does.
  const ASKS = /\b(movedPath|movedNotePath|pathFormCandidates|findNoteIdByPathForm|resolveWikiLinkTarget)\b/
  const EXEMPT: Record<string, string> = {
    // A replica holds the primary's copy without its map yet: an old path-form link reads unresolved there.
    'src/replica/notes-source.ts': 'no map on a replica',
  }
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fss.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
    }
    return out
  }

  it('follows the move map', () => {
    const found: string[] = []
    for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web/src'))]) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      const text = fss.readFileSync(file, 'utf-8')
      if (!/path[ -]form/i.test(text) || !text.includes("includes('/')")) continue
      if (EXEMPT[rel] || ASKS.test(text)) continue
      found.push(rel)
    }
    expect(found, 'A path-form link resolver must ask movedPath (src/core/artifacts/unify/map.ts)').toEqual([])
  })
})
