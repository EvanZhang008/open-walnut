/**
 * N2-33, C73: the session timeline's direction glyphs are text glyphs. U+26A1
 * is emoji by default, so the trigger glyph carries U+FE0E (text presentation).
 */
import { describe, it, expect } from 'vitest'
import { envelopeDirectionGlyph } from '../../src/lib/history-session-envelope'

// A few characters whose default presentation is emoji (U+26A1 among them).
const EMOJI_DEFAULT = /[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u2614\u2615\u26A1\u26AA\u26AB\u2705\u2728\u274C\u2753\u2B50\u2B55]/u
const VS15 = '\uFE0E'

describe('envelopeDirectionGlyph', () => {
  it('never returns an emoji-default glyph without U+FE0E', () => {
    for (const kind of ['reply', 'peer-note', 'notification', 'reply-request', 'trigger', 'app-state'] as const) {
      const g = envelopeDirectionGlyph(kind)
      if (EMOJI_DEFAULT.test(g)) expect(g.endsWith(VS15), kind).toBe(true)
    }
    expect(envelopeDirectionGlyph('trigger')).toBe('\u26A1\uFE0E')
  })
})
