/**
 * A thing a task asks always shows its words box: no click opens it (2026-11-20, the user: "Why the
 * fuck i need to clcik reply, reply is so rugly, Can it jsut show inbox and I can tuype?").
 *
 * - Every kind of item (ACTION_KIND_LABELS) is played by tests/e2e/browser/ask-card-words-shown.spec.ts,
 *   which checks its box is on screen with no click: a new kind fails here until that spec plays it.
 * - No component that answers an ask draws an opener for its words ("Reply…", "Other…" buttons,
 *   the old OtherWords / org-answer-other), and the words box never takes the focus by itself.
 */
import { execFileSync } from 'node:child_process'
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

describe('an ask card never sits inside a row that is a button', () => {
  // A row is a button (role="button", a dnd-kit handle): a screen reader reads a button's insides as
  // its name alone, so a box to type in or a card's own buttons inside one are lost. Every place that
  // draws the cards on a task's row puts them under the row, in its "...-actions-below" holder.
  it('every row that draws the cards draws them under it', () => {
    const out = execFileSync('git', ['grep', '-n', '--untracked', '<ActionNeeded\\b', '--', 'web/src'], { cwd: ROOT, encoding: 'utf8' })
    const uses = out.split('\n').filter(Boolean).filter((l) => !/variant="strip"/.test(l))
    expect(uses.length, 'rows that draw the cards').toBeGreaterThan(0)
    for (const line of uses) expect(line, 'drawn in an "...-actions-below" holder under its row').toMatch(/className="[a-z-]*-actions-below" data-asks-for=\{task\.id\}><ActionNeeded\b/)
  })
})

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
      // A card's box keeps its own draft: words typed in it never also show in the session's composer
      // or the Board's box, to be sent twice (and a failed send keeps them there, never cleared by hand).
      expect(src, `${file}: no shared draft key`).not.toMatch(/\b(sessionDraftKey|boardChoiceDraftKey)\b/)
      expect(src, `${file}: the composer keeps a failed send's words`).not.toMatch(/\bclearDraft\(/)
    }
  })
})
