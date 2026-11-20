/**
 * A thing a task asks always shows its words box: no click opens it (2026-11-20, the user: "Why the
 * fuck i need to clcik reply, reply is so rugly, Can it jsut show inbox and I can tuype?").
 *
 * - Every kind of item (ACTION_KIND_LABELS) is played by tests/e2e/browser/ask-card-words-shown.spec.ts,
 *   which checks its box is on screen with no click: a new kind fails here until that spec plays it.
 * - No component that answers an ask draws an opener for its words ("Reply…", "Other…" buttons,
 *   the old OtherWords / org-answer-other), and the words box never takes the focus by itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_KIND_LABELS } from '../../src/core/user-status'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Where an ask is answered in place. */
const ANSWER_FILES = [
  'web/src/components/org/OrgInlineAnswer.tsx',
  'web/src/components/actions/ActionNeeded.tsx',
  'web/src/components/actions/AskCard.tsx',
  'web/src/components/org/OrgTaskRail.tsx',
]

describe('an ask shows its words box at once', () => {
  it('the browser spec plays every kind of item', () => {
    const spec = read('tests/e2e/browser/ask-card-words-shown.spec.ts')
    const m = /export const GUARDED = \[([^\]]*)\]/.exec(spec)
    expect(m, 'GUARDED in the spec').not.toBeNull()
    const played = new Set([...m![1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]))
    for (const kind of Object.keys(ACTION_KIND_LABELS)) expect(played.has(kind), `kind ${kind} is played by ask-card-words-shown.spec.ts`).toBe(true)
  })

  it('no answer draws an opener for its words, and no words box takes the focus by itself', () => {
    for (const file of ANSWER_FILES) {
      const src = read(file)
      expect(src, `${file}: no OtherWords`).not.toMatch(/\bOtherWords\b/)
      expect(src, `${file}: no org-answer-other`).not.toMatch(/org-answer-other/)
      expect(src, `${file}: no Reply… / Other… button`).not.toMatch(/>\s*(Reply|Other)…\s*<\/button>/)
      expect(src, `${file}: no words box focuses itself`).not.toMatch(/<(WordsField|ReplyField)\b[^>]*\bautoFocus\b/)
    }
  })
})
