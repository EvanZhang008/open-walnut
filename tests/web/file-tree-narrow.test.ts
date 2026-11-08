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

describe('Files tree in a narrow window', () => {
  it('is capped to a share of its row', () => {
    const rule = css.match(/\n\.session-file-explorer-tree \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/max-width:\s*min\(600px,\s*45%\)/)
  })
  it('starts a drag from the width on screen', () => {
    expect(src).toMatch(/onStart: \(\) => \{ startWidthRef\.current = Math\.min\(treeWidthRef\.current, treeRef\.current\?\.getBoundingClientRect\(\)\.width/)
  })
})
