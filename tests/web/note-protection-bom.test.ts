/**
 * The web reads a note's lock or hidden mark where the server does (src/core/notes/locked-note-format.ts):
 * a file an outside editor saved with a byte order mark is still covered on the Notes page, its path
 * never sent to the chat (web/src/components/notes/locked-note.ts). Fake text only.
 */
import { describe, it, expect } from 'vitest'
import { isHiddenNote, isLockedNote, noteProtectionOf } from '../../web/src/components/notes/locked-note'
import { splitFrontmatter } from '../../web/src/components/notes/frontmatter'
import { noteProtection } from '../../src/core/notes/locked-note-format'

const BOM = '\uFEFF'
const texts: Array<[string, string]> = [
  ['hidden', '---\nwalnut_hidden: 1\n---\nsecret words\n'],
  ['hidden with a byte order mark', `${BOM}---\nwalnut_hidden: 1\n---\nsecret words\n`],
  ['plain with a byte order mark', `${BOM}---\ntags: [a]\n---\nwords\n`],
  ['locked with a byte order mark', `${BOM}---\nwalnut_locked: 1\n---\nstub\n`],
]

describe('the web and the server read the same protection', () => {
  for (const [what, text] of texts) {
    it(what, () => {
      const { frontmatter, body } = splitFrontmatter(text)
      expect(noteProtectionOf(frontmatter, body)).toBe(noteProtection(text))
      expect(isHiddenNote(frontmatter, body)).toBe(noteProtection(text) === 'hidden')
      if (noteProtection(text) === 'locked') expect(isLockedNote(frontmatter, body)).toBe(true)
    })
  }
})
