/**
 * Every box whose words go to an AI takes pictures, as the chat does (2026-11-03, the user: "the
 * follow up in org thread or anywhere ... should be able to copy pictures"). The Org thread Follow
 * up, a letter's reply and note, a Board thread and choice, the Org rail's answers, a question
 * card's follow-up, a kanban card's message and an AskUserQuestion "Other" all took text only.
 *
 * The members are read from source, so a new box fails here until it is decided:
 *  - every <AnswerBox> passes `pictures` (useImageAttachments), unless its file is listed in
 *    TEXT_ONLY_ANSWERS with why its words are not a message to an AI;
 *  - every file drawing a <ChatInput> hands the pictures on (its send names `images`) and refuses
 *    none, except where REFUSES_PICTURES says why;
 *  - every composer that keeps its own <textarea> (answer-box-guard.test.ts lists them) takes
 *    pasted and dropped pictures through PictureStrip.tsx, unless TEXT_ONLY_COMPOSERS says why.
 * And the rules are one set: ChatInput and the answer boxes read the same types, limit and paste
 * rule from image-attachments.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')

/** AnswerBox files whose words are not a message to an AI, or wait to go with one. */
const TEXT_ONLY_ANSWERS: Record<string, string> = {
  'components/common/DocCommentCard.tsx': 'a comment on a document, kept until the next chat message, which the composer sends with its pictures',
  'components/sessions/QuotePinSelectionBar.tsx': 'a comment on a passage, kept until the next chat message, which the composer sends with its pictures',
  'components/sessions/PassageCommentMarks.tsx': "editing a passage comment's words before the next chat message, which the composer sends with its pictures",
  'components/inbox/ItemConfirmation.tsx': "a mail item's one-line work goal, kept on the item before any session exists",
  'apps/mail/MailGroupCard.tsx': 'why a mail belongs in a group: a sorting rule, never delivered to a session',
  'apps/mail/MailCorrectStepWhere.tsx': 'why a mail was sorted wrong: a sorting rule, never delivered to a session',
  'components/sessions/PermissionNoteBox.tsx': "a prompt's deny note: the agent CLI takes a deny as one text message, so no picture can go with it",
}

/** Files drawing a ChatInput that refuse a picture on purpose, and why. */
const REFUSES_PICTURES: Record<string, string> = {
  'components/board/BoardReplyDock.tsx': "a Board mark's note is words kept on the page; its threads and choices take pictures",
}

/** Composers with their own <textarea> that stay text only, and why. */
const TEXT_ONLY_COMPOSERS: Record<string, string> = {
  'components/chat/ChatInput.tsx': 'the chat composer itself, with its own picture handling',
  'apps/mail/compose/ComposerPanel.tsx': 'an email to a person, not a message to an AI',
  'components/sessions/SessionChatHistory.tsx': 'editing a queued message: its words change, its pictures stay as sent',
  'components/sessions/SessionDiffView.tsx': 'a review comment on a diff line, kept until the review goes; the composer takes pictures',
  'components/transfer/TransferDialog.tsx': "the first words of a moved task's new session, carried by the transfer as text",
  'components/sessions/TriggerPickerPopover.tsx': "a trigger's standing prompt, stored for each later fire",
  'components/tasks/QuickSortReply.tsx': "a one-line reply from the board's Sort deck, which may start the task (the start takes text only); a picture goes in the task's own chat, one tap away on the card",
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(tsx|jsx|js)$/.test(e.name)) out.push(path.relative(WEB_SRC, full))
  }
  return out
}
const FILES = walk(WEB_SRC)
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')

/** Each `<Tag ...>` opening, up to its closing `>` or `/>` at depth 0 of braces. */
function tagsOf(src: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b`, 'g')
  for (const m of src.matchAll(re)) {
    let depth = 0
    let i = m.index! + m[0].length
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(m.index!, i + 1))
  }
  return out
}

const answerFiles = FILES.filter((f) => f !== 'components/common/AnswerBox.tsx' && /<AnswerBox\b/.test(read(f)))
const chatFiles = FILES.filter((f) => f !== 'components/chat/ChatInput.tsx' && /<ChatInput\b/.test(read(f)))

describe('every box for an AI takes pictures', () => {
  it('finds the boxes (the scan itself works)', () => {
    expect(answerFiles.length).toBeGreaterThan(8)
    expect(chatFiles.length).toBeGreaterThan(6)
    expect(tagsOf('<AnswerBox a={x > 1 ? 1 : 2} pictures={p} />', 'AnswerBox')).toEqual(['<AnswerBox a={x > 1 ? 1 : 2} pictures={p} />'])
  })

  it.each(answerFiles)('%s: each AnswerBox takes pictures, or the file says why not', (rel) => {
    if (TEXT_ONLY_ANSWERS[rel]) return
    const without = tagsOf(read(rel), 'AnswerBox').filter((t) => !/\bpictures=/.test(t))
    expect(without, `${rel}: pass pictures={useImageAttachments()} and send them, or list it in TEXT_ONLY_ANSWERS with why`).toEqual([])
  })

  it('every text-only answer box listed still exists and still draws an AnswerBox without pictures', () => {
    for (const rel of Object.keys(TEXT_ONLY_ANSWERS)) {
      expect(fs.existsSync(path.join(WEB_SRC, rel)), rel).toBe(true)
      expect(tagsOf(read(rel), 'AnswerBox').some((t) => !/\bpictures=/.test(t)), `${rel} takes pictures now: drop it from the list`).toBe(true)
    }
  })

  it.each(chatFiles)('%s: the ChatInput\'s pictures are handed on', (rel) => {
    const src = read(rel)
    expect(src, `${rel}: its send must take (text, images) and pass the images on`).toMatch(/\bimages\b/)
    if (REFUSES_PICTURES[rel]) return
    expect(src, `${rel}: refuses a picture; take it, or list it in REFUSES_PICTURES with why`).not.toMatch(/takes text only/)
  })

  it('the Board dock refuses a picture only for a note', () => {
    const src = read('components/board/BoardReplyDock.tsx')
    expect([...src.matchAll(/takes text only/g)]).toHaveLength(1)
    expect(src).toMatch(/images\?\.length && noting/)
  })

  it('every composer with its own textarea takes pasted and dropped pictures, or says why not', () => {
    const composers = FILES.filter((f) => /<textarea\b/.test(read(f)) && /session:send|onSend|sendAnchored|sendToCardSession/.test(read(f)))
    const missing = composers.filter((f) => !TEXT_ONLY_COMPOSERS[f] && !(/usePictureInput\(/.test(read(f)) && /<PictureStrip\b/.test(read(f))))
    expect(missing, 'a composer for an AI: usePictureInput + PictureStrip + AttachPictureButton, or list it with why').toEqual([])
    for (const rel of Object.keys(TEXT_ONLY_COMPOSERS)) expect(fs.existsSync(path.join(WEB_SRC, rel)), rel).toBe(true)
  })

  it('the Talk to CEO box sends its pictures with the note, all the way to the route', () => {
    // The box hands its pictures to sendToCeo, which posts them as `images`, which the route
    // passes to the send into Main's (or the test stand-in's) chat.
    expect(read('components/content/CeoComposer.tsx')).toMatch(/sendToCeo\(req\.item, words, sentPictures\)/)
    expect(read('components/content/CeoComposer.tsx')).toMatch(/const sentPictures = pictures\.images/)
    expect(read('utils/content-actions.ts')).toMatch(/'\/api\/v1\/content\/ceo', \{ item, note: words, \.\.\.\(pictures\.length > 0 \? \{ images: pictures \}/)
    const route = fs.readFileSync(path.resolve(WEB_SRC, '../../src/web/routes/content-v1.ts'), 'utf8')
    expect(route).toMatch(/const images = extractValidImages\(req\.body\?\.images\)/)
    expect(route).toMatch(/sendToMain\(text, images, source\)/)
    expect(route).toMatch(/sendToTaskChat\(standIn, [^)]*, source, images\)/)
  })

  it('one rule set: the chat and the answer boxes read the same types, limit and paste rule', () => {
    const chat = read('components/chat/ChatInput.tsx')
    expect(chat).toMatch(/from '@\/components\/common\/image-attachments'/)
    expect(chat).not.toMatch(/new Set\(\['image\/png'/)
    expect(chat).toMatch(/pastedImageFiles\(e\)/)
    const strip = read('components/common/PictureStrip.tsx')
    expect(strip).toMatch(/pastedImageFiles\(e\)/)
    expect(strip).toMatch(/accept=\{IMAGE_ACCEPT\}/)
  })
})
