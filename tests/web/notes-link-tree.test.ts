/**
 * A file path in a chat opens as a note when it is one (web/src/utils/notes-link.ts), with the
 * vault in the notes folder or in the one tree (notesDir = <home>/.open-walnut/artifacts):
 * the tree's own path, a `~/` path, and a path under the old notes folder (a message written
 * before the move: the server follows it to the note's place now).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let notesDir = ''
vi.mock('@/api/config', () => ({ fetchNotesDir: async () => notesDir }))

import { vaultRelativeNotePath } from '@/utils/notes-link'

describe('vaultRelativeNotePath', () => {
  beforeEach(() => { notesDir = '/home/u/.open-walnut/artifacts' })

  it('reads the tree, ~/ and the old notes folder as notes', async () => {
    expect(await vaultRelativeNotePath('/home/u/.open-walnut/artifacts/projects/Cove/notes/a.md')).toBe('projects/Cove/notes/a.md')
    expect(await vaultRelativeNotePath('~/.open-walnut/artifacts/notes/b.md')).toBe('notes/b.md')
    expect(await vaultRelativeNotePath('/home/u/.open-walnut/notes/cove/a.md')).toBe('cove/a.md')
    expect(await vaultRelativeNotePath('~/.open-walnut/notes/cove/a.md')).toBe('cove/a.md')
    expect(await vaultRelativeNotePath('/home/u/elsewhere/a.md')).toBeNull()
    expect(await vaultRelativeNotePath('/home/u/.open-walnut/notes/cove/a.md', 'lagoon')).toBeNull()
  })

  it('still reads the notes folder when the vault is there', async () => {
    notesDir = '/home/u/.open-walnut/notes'
    expect(await vaultRelativeNotePath('~/.open-walnut/notes/cove/a.md')).toBe('cove/a.md')
    expect(await vaultRelativeNotePath('/home/u/.open-walnut/artifacts/x.md')).toBeNull()
  })
})
