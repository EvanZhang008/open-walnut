/**
 * A Files tree widened by hand yields to the open file in a narrow window
 * (2026-11-08: a 405 px tree left a 171 px file at 1200x700). The tree's width is
 * a stored px value, so the cap is a share of its row in the stylesheet, and a drag
 * starts from the width on screen.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const root = path.resolve(__dirname, '../..')
const css = fs.readFileSync(path.join(root, 'web/src/styles/globals.css'), 'utf8')
const src = fs.readFileSync(path.join(root, 'web/src/components/sessions/SessionFileExplorer.tsx'), 'utf8')
const docBar = fs.readFileSync(path.join(root, 'web/src/styles/file-doc-bar.css'), 'utf8')
const notes = fs.readFileSync(path.join(root, 'web/src/pages/NotesPage.tsx'), 'utf8')

describe('Files tree in a narrow window', () => {
  it('is capped to a share of its row', () => {
    const rule = css.match(/\n\.session-file-explorer-tree \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/max-width:\s*min\(600px,\s*45%\)/)
  })
  it('starts a drag from the width on screen', () => {
    expect(src).toMatch(/onStart: \(\) => \{ startWidthRef\.current = Math\.min\(treeWidthRef\.current, treeRef\.current\?\.getBoundingClientRect\(\)\.width/)
  })
})

/**
 * With no file open the tree takes the room and "No file open" shrinks to a hint (2026-11-22
 * review: a 210 px tree beside a 255 px empty preview at 1024); a file brings the tree's width back.
 */
describe('Files with no file open', () => {
  it('marks the body while nothing is open beside a shown tree, and drops the divider', () => {
    expect(src).toMatch(/const noFileBeside = !phone && !selectedFile && !treeCollapsed;/)
    expect(src).toMatch(/noFileBeside \? ' is-no-file' : ''/)
    expect(src).toMatch(/\{!treeCollapsed && !noFileBeside && \(\s*<div\s+className="sfe-divider"/)
  })
  it('grows the tree from nothing and keeps the preview to a hint', () => {
    expect(docBar).toMatch(/\.session-file-explorer-body\.is-no-file > \.session-file-explorer-tree \{ flex: 1 1 0; max-width: none; \}/)
    const preview = docBar.match(/\.session-file-explorer-body\.is-no-file > \.session-file-explorer-preview \{[^}]*\}/)?.[0] ?? ''
    expect(preview).toMatch(/flex:\s*0 1 clamp\(/)
  })
})

/**
 * The Notes tree's stored width yields to the reader the same way (2026-11-22: 497 px in a 456 px
 * page), and the tree sits at its rows' own width: the stored width is only its most, so four
 * folders no longer hold an empty column at a width dragged long ago (the same day's audit).
 */
describe('Notes tree in a narrow page', () => {
  it('sits at its rows\' width, at least its minimum, at most the dragged width or 45% of the page', () => {
    const rule = css.match(/\n\.notes-tree-pane \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/width:\s*fit-content/)
    expect(rule).toMatch(/min-width:\s*min\(220px,\s*45%\)/)
    expect(rule).toMatch(/max-width:\s*min\(var\(--notes-tree-max, \d+px\),\s*45%\)/)
    expect(notes).toMatch(/\['--notes-tree-max' as string\]: `\$\{listWidth\}px`/)
  })
  it('drags from the width on screen', () => {
    expect(notes).toMatch(/startWidthRef\.current = Math\.min\(listWidthRef\.current, listPaneRef\.current\?\.getBoundingClientRect\(\)\.width/)
  })
})
