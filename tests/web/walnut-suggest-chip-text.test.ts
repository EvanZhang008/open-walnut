/**
 * Every quick action chip of the Ask Walnut composer inserts text that starts with its label's
 * words (DraftSessionPanel.tsx WALNUT_SUGGESTS: "a chip that inserts less than it promises reads as
 * a bug"). Review 2026-11-06 round 4, L9: "Find a task" inserted "Find the task about ".
 * Read from the source, so a chip added later is checked too.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync(path.join(__dirname, '../../web/src/components/sessions/DraftSessionPanel.tsx'), 'utf8')
const block = src.slice(src.indexOf('const WALNUT_SUGGESTS'), src.indexOf('];', src.indexOf('const WALNUT_SUGGESTS')))
const chips = [...block.matchAll(/label: '([^']+)'[^}]*?text: '([^']*)'/g)].map((m) => ({ label: m[1], text: m[2] }))

describe('Ask Walnut quick action chips', () => {
  it('are found in the source', () => {
    expect(chips.length).toBeGreaterThanOrEqual(3)
  })
  it.each(chips)('"$label" inserts text that starts with its words', ({ label, text }) => {
    expect(text.toLowerCase().startsWith(label.toLowerCase())).toBe(true)
  })
})
