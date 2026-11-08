/**
 * Every Ask here card that shows a question's conversation has its reply box
 * (2026-11-08, the user, angry, after asking many times: the side comments are
 * Ask here and "should have an input box"; the full-screen review column's card
 * showed the answer and its MD / Rich / pin row, with no way to reply).
 *
 * The members are read from source: a component that draws a question's
 * conversation body (`thread-card-body`) must also draw the reply box, either
 * ThreadReplyBox or a composer textarea `thread-card-input` of its own. A new
 * card that shows a conversation without one fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(e.name)) out.push(path.relative(WEB_SRC, full))
  }
  return out
}
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')

/** Files that draw a question's conversation body in a card. */
const CARDS = walk(WEB_SRC).filter((f) => /className=["'{`][^"'}`]*\bthread-card-body\b/.test(read(f)))

describe('every Ask here card with a conversation has its reply box', () => {
  it('finds the cards (the scanner still works)', () => {
    expect(CARDS).toContain('components/sessions/ThreadCommentCard.tsx')
    expect(CARDS).toContain('components/sessions/ThreadReviewSidebar.tsx')
  })

  it('each card draws a reply box next to its conversation', () => {
    const bare = CARDS.filter((f) => {
      const src = read(f)
      return !/<ThreadReplyBox\b/.test(src) && !/className=["']thread-card-input["']/.test(src)
    })
    expect(bare, `These cards show a question's conversation with no reply box: draw <ThreadReplyBox> under it:\n${bare.join('\n')}`).toEqual([])
  })

  it('the reply box is a real composer: typed, dictated, pictures, sent under the question\'s draft', () => {
    const src = read('components/sessions/ThreadReplyBox.tsx')
    expect(src).toMatch(/className="thread-card-input"/)
    expect(src).toMatch(/<BoxMic\b/)
    expect(src).toMatch(/<AttachPictureButton\b/)
    expect(src).toMatch(/data-draft-key=\{draft\.key/)
    expect(src).toMatch(/className="thread-card-send"/)
  })
})
