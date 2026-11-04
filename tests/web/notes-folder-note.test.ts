/**
 * Folder notes in the Notes tree: a folder `X/` holding `X/X.md` shows as ONE
 * row that opens the note, instead of an `X` folder with an `X` note under it.
 * Every other folder keeps its old behavior.
 */
import { describe, expect, it } from 'vitest'
import type { NoteTreeNode } from '@/api/notes-v2'
import {
  folderNoteOf,
  visibleFolderChildren,
  folderOfFolderNote,
  folderRowClickAction,
} from '@/components/notes/folder-note'

const note = (path: string): NoteTreeNode => ({ name: path.split('/').pop()!, path, type: 'file', kind: 'note' })
const att = (path: string): NoteTreeNode => ({ name: path.split('/').pop()!, path, type: 'file', kind: 'attachment' })
const folder = (path: string, children: NoteTreeNode[]): NoteTreeNode => ({ name: path.split('/').pop()!, path, type: 'folder', children })

describe('folderNoteOf', () => {
  it('finds the note named after its folder and hides it from the children', () => {
    const own = note('Home/Child A/Child A.md')
    const deep = note('Home/Child A/Deep page.md')
    const f = folder('Home/Child A', [folder('Home/Child A/Sub', []), deep, own])
    expect(folderNoteOf(f)).toBe(own)
    expect(visibleFolderChildren(f, own)).toEqual([f.children![0], deep])
  })

  it('leaves a folder without a same-named note exactly as it was', () => {
    const f = folder('Plain', [note('Plain/a.md'), note('Plain/Plain notes.md'), folder('Plain/Plain', [])])
    expect(folderNoteOf(f)).toBeNull()
    expect(visibleFolderChildren(f, null)).toBe(f.children)
    // The files of the notes beside it come after the notes.
    const files = { type: 'folder', name: '_attachment', path: 'X/_attachment', children: [] } as never
    const g = { ...f, children: [files, ...f.children!] }
    expect(visibleFolderChildren(g, null).at(-1)).toBe(files)
  })

  it('puts the folder\'s index note first, and keeps the order when there is none', () => {
    const days = [note('Journal/Day 1.md'), note('Journal/Day 2.md')]
    const index = note('Journal/Journal index.md')
    const j = folder('Journal', [...days, index])
    expect(visibleFolderChildren(j, null)).toEqual([index, ...days])
    const top = folder('Import', [folder('Import/Home', []), note('Import/Index.md')])
    expect(visibleFolderChildren(top, null)[0].name).toBe('Index.md')
    // A note that only mentions an index is not one.
    const other = folder('Recipes', [note('Recipes/Cake.md'), note('Recipes/Index of cakes.md')])
    expect(visibleFolderChildren(other, null)).toBe(other.children)
  })

  it('matches case-sensitively, like every other tree path comparison', () => {
    expect(folderNoteOf(folder('Foo', [note('Foo/foo.md')]))).toBeNull()
    expect(folderNoteOf(folder('Foo', [note('Foo/FOO.md')]))).toBeNull()
    expect(folderNoteOf(folder('Foo', [note('Foo/Foo.MD')]))).toBeNull()
    const exact = note('Foo/Foo.md')
    // A case-sensitive disk can hold both; only the exact one is the folder note.
    const f = folder('Foo', [note('Foo/foo.md'), exact])
    expect(folderNoteOf(f)).toBe(exact)
    expect(visibleFolderChildren(f, exact).map((c) => c.path)).toEqual(['Foo/foo.md'])
  })

  it('ignores attachments, nested matches, a subfolder of the same name, and non-folders', () => {
    expect(folderNoteOf(folder('Pic', [att('Pic/Pic.md.png')]))).toBeNull()
    expect(folderNoteOf(folder('A', [folder('A/B', [note('A/B/A.md')])]))).toBeNull()
    expect(folderNoteOf(folder('A', [folder('A/A', [])]))).toBeNull()
    expect(folderNoteOf(note('A.md'))).toBeNull()
    expect(folderNoteOf({ name: 'Empty', path: 'Empty', type: 'folder' })).toBeNull()
  })

  it('treats a file with no kind (older payloads) as a note', () => {
    const own: NoteTreeNode = { name: 'Old.md', path: 'Old/Old.md', type: 'file' }
    expect(folderNoteOf(folder('Old', [own]))).toBe(own)
  })

  it('handles names with unicode, dots and spaces', () => {
    const name = 'Café v1.2 (draft)'
    const own = note(`${name}/${name}.md`)
    expect(folderNoteOf(folder(name, [own]))).toBe(own)
  })
})

describe('folderOfFolderNote', () => {
  it('returns the folder whose folder note the path is', () => {
    expect(folderOfFolderNote('Home/Home.md')).toBe('Home')
    expect(folderOfFolderNote('Home/Child A/Child A.md')).toBe('Home/Child A')
  })

  it('returns null for everything else', () => {
    expect(folderOfFolderNote('Home.md')).toBeNull()
    expect(folderOfFolderNote('Home/Child A/Deep page.md')).toBeNull()
    expect(folderOfFolderNote('Foo/foo.md')).toBeNull()
    expect(folderOfFolderNote('Home/Home.png')).toBeNull()
    expect(folderOfFolderNote('Home/Home')).toBeNull()
  })
})

describe('folderRowClickAction', () => {
  it('a plain folder toggles, folded or not (unchanged)', () => {
    expect(folderRowClickAction(null, false)).toEqual({ open: null, expand: 'toggle' })
    expect(folderRowClickAction(null, true)).toEqual({ open: null, expand: 'toggle' })
  })

  it('a folder-note row opens its note and unfolds, but never folds', () => {
    const own = note('Tasks/Tasks.md')
    expect(folderRowClickAction(own, false)).toEqual({ open: 'Tasks/Tasks.md', expand: 'expand' })
    expect(folderRowClickAction(own, true)).toEqual({ open: 'Tasks/Tasks.md', expand: 'none' })
  })
})
