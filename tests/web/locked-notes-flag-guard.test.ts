/**
 * The `locked_notes` experiment (src/core/experimental.ts, CLAUDE.md "Experimental behavior")
 * gates ONE thing: the Lock control (Hide from AI, Encrypt, Unhide) in a plain or hidden note's
 * header. A note already locked or hidden always opens covered with Show, and every protection the
 * server keeps (refused writes, the stub for every reader, the ask flow) holds whatever the switch
 * says (docs/reference/locked-notes.md).
 *
 * The class: any read of the switch. This finds every literal 'locked_notes' in web/src and src
 * and fails on one outside the registry entry and the header's button.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EXPERIMENTAL_FEATURES } from '../../src/core/experimental'

const ROOT = path.resolve(__dirname, '../..')
const ALLOWED: Record<string, string> = {
  'src/core/experimental.ts': 'the registry entry',
  'web/src/components/notes/NotesEditorPanel.tsx': 'the Lock control in a note\'s header',
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

describe('the locked_notes experiment', () => {
  it('is registered, off by default', () => {
    const f = EXPERIMENTAL_FEATURES.find((x) => x.id === 'locked_notes')
    expect(f?.name).toBe('Locked notes')
    expect(f?.default).toBe(false)
  })

  it('is read only for the Lock control: never by the covers, the note loader or the server', () => {
    const readers = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web/src'))]
      .filter((f) => /['"`]locked_notes['"`]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .sort()
    expect(readers).toEqual(Object.keys(ALLOWED).sort())
    const button = fs.readFileSync(path.join(ROOT, 'web/src/components/notes/NotesEditorPanel.tsx'), 'utf8')
    // The switch gates the menu alone: the hidden note's cover and its Hide never read it.
    expect(button).toMatch(/\{onProtect && lockOn && !readOnly && <NoteProtectMenu /)
    expect(button).toMatch(/if \(hidden && !cover\.shown\) return <HiddenNoteCover /)
  })
})
