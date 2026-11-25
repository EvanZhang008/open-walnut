/**
 * The locked-note file format (src/core/notes/locked-note.ts): build and parse round-trip, the stub
 * every other reader sees, and text that only looks like a locked note.
 */
import { describe, it, expect } from 'vitest'
import {
  LOCKED_NOTE_STUB, assertNotLocked, buildLockedNoteText, isLockedNoteText, parseLockedNote, readableNoteText,
} from '../../../src/core/notes/locked-note.js'

const envelope = { key: 'item-1', iv: 'AAAAAAAAAAAAAAAA', ct: 'YWJjZGVmZ2hpams=' }

describe('locked-note format', () => {
  it('builds a file that parses back to its envelope, id and stub', () => {
    const text = buildLockedNoteText({ id: 'n_abc123', envelope })
    expect(isLockedNoteText(text)).toBe(true)
    const p = parseLockedNote(text)
    expect(p).toMatchObject({ envelope, id: 'n_abc123' })
    expect(p!.stub).toContain(LOCKED_NOTE_STUB)
    expect(p!.stub).toContain('walnut_locked: 1')
    expect(p!.stub).not.toContain('walnut-locked-note v1')
    expect(readableNoteText(text)).toBe(p!.stub)
  })

  it('leaves every other note as it is', () => {
    for (const t of ['', '# Plain\n', '---\nid: n_x\n---\nbody', 'mentions <!-- walnut-locked-note v1 in a sentence -->', '  <!-- walnut-locked-note v1 {"key":"k","iv":"A","ct":"B"} -->']) {
      expect(isLockedNoteText(t)).toBe(false)
      expect(readableNoteText(t)).toBe(t)
      expect(() => assertNotLocked(t)).not.toThrow()
    }
    expect(isLockedNoteText(null)).toBe(false)
  })

  it('counts an envelope it cannot read as locked, so nothing writes over it', () => {
    for (const line of [
      '<!-- walnut-locked-note v2 {"key":"k","iv":"AA==","ct":"AA=="} -->',
      '<!-- walnut-locked-note v1 {not json} -->',
      '<!-- walnut-locked-note v1 {"key":"k","iv":"not base64!","ct":"AA=="} -->',
    ]) {
      const text = `---\nid: n_q\nwalnut_locked: 1\n---\nstub\n\n${line}\n`
      expect(isLockedNoteText(text)).toBe(true)
      expect(parseLockedNote(text)).toMatchObject({ envelope: null, id: 'n_q' })
      expect(readableNoteText(text)).not.toContain('walnut-locked-note')
      expect(() => assertNotLocked(text)).toThrow(/locked/)
    }
  })

  it('refuses an envelope that would break its own line', () => {
    expect(() => buildLockedNoteText({ envelope: { ...envelope, key: 'a"b' } })).toThrow()
    expect(() => buildLockedNoteText({ envelope: { ...envelope, ct: 'x-->y' } })).toThrow()
  })
})
