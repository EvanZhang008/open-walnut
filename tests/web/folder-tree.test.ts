/**
 * The board's folder tree (web/src/components/tasks/folder-tree.ts): `parent_id`
 * drawn as nesting. The rule that matters most is that no row ever disappears, so
 * every broken link becomes a root instead of a dropped folder.
 */
import { describe, it, expect } from 'vitest'
import {
  buildFolderParents, folderAncestors, folderDepth, nestFolderUnits, ancestorHeadings, FOLDER_MAX_DEPTH,
} from '../../web/src/components/tasks/folder-tree'

const meta = (entries: Record<string, { parent?: string; project?: string }>) =>
  Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, { project: e.project ?? 'marina', ...(e.parent ? { parent_id: e.parent } : {}) }]))

describe('buildFolderParents', () => {
  it('keeps a link whose parent is listed in the same project (any case)', () => {
    const parents = buildFolderParents({ g_a: { project: 'Marina' }, g_b: { project: 'marina ', parent_id: 'g_a' } })
    expect([...parents]).toEqual([['g_b', 'g_a']])
  })

  it('a missing parent, another project, or itself makes the folder a root', () => {
    const parents = buildFolderParents(meta({
      g_gone: { parent: 'g_nowhere' },
      g_other: { parent: 'g_acme' }, g_acme: { project: 'acme' },
      g_self: { parent: 'g_self' },
    }))
    expect(parents.size).toBe(0)
  })

  it('breaks a cycle at one link, the same one every time', () => {
    const m = meta({ g_a: { parent: 'g_b' }, g_b: { parent: 'g_a' } })
    const first = buildFolderParents(m)
    expect(first.size).toBe(1)
    expect([...buildFolderParents(m)]).toEqual([...first])
    // Walks still end.
    expect(folderAncestors('g_a', first).length + folderAncestors('g_b', first).length).toBe(1)
  })

  it('an Object.prototype name as a parent id is not a folder', () => {
    const parents = buildFolderParents(meta({ g_a: { parent: 'constructor' }, g_b: { parent: '__proto__' } }))
    expect(parents.size).toBe(0)
  })

  it('no metadata yet: empty', () => {
    expect(buildFolderParents(undefined).size).toBe(0)
  })
})

describe('folderAncestors / folderDepth', () => {
  const parents = buildFolderParents(meta({
    g_1: {}, g_2: { parent: 'g_1' }, g_3: { parent: 'g_2' }, g_4: { parent: 'g_3' }, g_5: { parent: 'g_4' }, g_6: { parent: 'g_5' },
  }))
  it('lists ancestors root first and counts depth from 0', () => {
    expect(folderAncestors('g_3', parents)).toEqual(['g_1', 'g_2'])
    expect(folderDepth('g_1', parents)).toBe(0)
    expect(folderDepth('g_3', parents)).toBe(2)
  })
  it('clamps a chain deeper than the server stores', () => {
    expect(folderDepth('g_6', parents)).toBe(FOLDER_MAX_DEPTH - 1)
  })
})

describe('nestFolderUnits', () => {
  // ids are "<folder>:<n>" or "loose:<n>".
  const folderOf = (id: string) => (id.startsWith('loose') ? undefined : id.split(':')[0])

  it('with no nesting returns the input array itself', () => {
    const ids = ['F:1', 'G:1', 'F:2']
    expect(nestFolderUnits(ids, folderOf, new Map())).toBe(ids)
  })

  it('moves a subfolder run inside its parent: parent rows, then the subfolder', () => {
    const parents = buildFolderParents(meta({ F: {}, S: { parent: 'F' }, G: {} }))
    expect(nestFolderUnits(['loose:1', 'F:1', 'F:2', 'G:1', 'S:1', 'S:2'], folderOf, parents))
      .toEqual(['loose:1', 'F:1', 'F:2', 'S:1', 'S:2', 'G:1'])
  })

  it('a parent takes the place of the first row anywhere in its subtree', () => {
    const parents = buildFolderParents(meta({ F: {}, S: { parent: 'F' }, G: {} }))
    expect(nestFolderUnits(['S:1', 'G:1', 'F:1'], folderOf, parents)).toEqual(['F:1', 'S:1', 'G:1'])
  })

  it('siblings keep first-appearance order, grandchildren go in pre-order', () => {
    const parents = buildFolderParents(meta({ F: {}, A: { parent: 'F' }, B: { parent: 'F' }, A1: { parent: 'A' } }))
    expect(nestFolderUnits(['B:1', 'A1:1', 'F:1', 'A:1'], folderOf, parents))
      .toEqual(['F:1', 'B:1', 'A:1', 'A1:1'])
  })

  it('an ancestor with no rows of its own still holds its subfolders together', () => {
    const parents = buildFolderParents(meta({ F: {}, A: { parent: 'F' }, B: { parent: 'F' }, G: {} }))
    expect(nestFolderUnits(['A:1', 'G:1', 'B:1'], folderOf, parents)).toEqual(['A:1', 'B:1', 'G:1'])
  })

  it('loose rows never move, every row is kept exactly once, and it is idempotent', () => {
    const parents = buildFolderParents(meta({ F: {}, S: { parent: 'F' }, G: {} }))
    const input = ['S:1', 'loose:1', 'G:1', 'loose:2', 'F:1', 'S:2']
    const once = nestFolderUnits(input, folderOf, parents)
    expect([...once].sort()).toEqual([...input].sort())
    expect(once.filter((id) => id.startsWith('loose'))).toEqual(['loose:1', 'loose:2'])
    expect(nestFolderUnits(once, folderOf, parents)).toEqual(once)
  })

  it('a folder the tree does not know stays a flat run in place', () => {
    const parents = buildFolderParents(meta({ F: {}, S: { parent: 'F' } }))
    expect(nestFolderUnits(['X:1', 'S:1', 'F:1'], folderOf, parents)).toEqual(['X:1', 'F:1', 'S:1'])
  })
})

describe('ancestorHeadings', () => {
  const parents = buildFolderParents(meta({ F: {}, S: { parent: 'F' }, T: { parent: 'S' }, S2: { parent: 'F' } }))

  it('a parent with rows above draws its own heading: nothing extra', () => {
    expect(ancestorHeadings(['F', 'F', 'S', 'S'], parents).size).toBe(0)
  })

  it('a parent with no rows here: the first subfolder lead draws it, later ones do not', () => {
    const heads = ancestorHeadings([undefined, 'S', 'S', 'S2'], parents)
    expect([...heads]).toEqual([[1, ['F']]])
  })

  it('a deep folder alone draws every missing ancestor, root first', () => {
    expect([...ancestorHeadings(['T'], parents)]).toEqual([[0, ['F', 'S']]])
  })

  it('no nesting: nothing', () => {
    expect(ancestorHeadings(['F', 'S'], new Map()).size).toBe(0)
  })
})
