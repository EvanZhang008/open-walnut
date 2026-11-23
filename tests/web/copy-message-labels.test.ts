// A chat message's two copy keys say only "MD" and "Rich" (2026-11-23, the user: "this just md
// and rich people will undersnad", "let's not make this so verbose"); their hover and accessible
// name keep the whole action.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync(path.join(__dirname, '../../web/src/components/common/CopyMessageButtons.tsx'), 'utf8')

describe('chat message copy keys', () => {
  it('show short words, and name the whole action for hover and screen readers', () => {
    const labels = [...SRC.matchAll(/\slabel="([^"]+)"/g)].map((m) => m[1])
    expect(labels).toEqual(['MD', 'Rich'])
    expect(SRC).toContain('aria-label="Copy Markdown"')
    expect(SRC).toContain('aria-label="Copy rich text"')
  })
})
