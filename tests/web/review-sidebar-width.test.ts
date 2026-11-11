/**
 * The review column's width and its person's words (2026-11-10, the user, on a
 * screenshot of the fullscreen review sidebar: the line between the text and the
 * cards "can be drag"; the blue bubbles in the cards are "too much, put it
 * inside the input bar").
 *
 * The width rules are pure (web/src/utils/review-sidebar.ts): at least
 * REVIEW_W_MIN, at most what leaves REVIEW_TEXT_MIN of conversation in the box,
 * the default back on reset. The card's words are rendered: a review card's body
 * (ThreadCardConversation asks="lines") draws no chat bubble for the person, and
 * the newest question goes to the card's reply box, inside its composer.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import {
  askedLine, clampReviewWidth, dragReviewWidth, isReviewWidth, REVIEW_CARD_W, REVIEW_MIN_BOX, REVIEW_TEXT_MIN, REVIEW_W_MIN, REVIEW_W_STEP,
  reviewMinBox, reviewRoomOf, reviewSidebarOn, stepReviewWidth,
} from '@/utils/review-sidebar'

vi.mock('../../web/src/components/sessions/SessionMessage', () => ({
  SessionMessage: ({ message }: { message: { msgId?: string; text?: string } }) =>
    createElement('div', { className: 'session-msg session-msg-assistant', 'data-reply': message.msgId }, message.text),
  StableMarkdownBody: ({ text }: { text: string }) => createElement('div', null, text),
}))
vi.mock('../../web/src/components/sessions/StreamingBlockView', () => ({
  StreamingBlockView: () => createElement('div', { 'data-live-answer': '' }),
  StreamingReplyMeta: () => null,
  useStreamReplyRows: () => (block: { content: string }, msgId: string) => ({ role: 'assistant', text: block.content, msgId, timestamp: 't' }),
}))

const { ThreadCardConversation } = await import('../../web/src/components/sessions/ThreadCardConversation')

beforeAll(() => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
})

describe('clampReviewWidth (the dragged column width)', () => {
  it('never under the minimum', () => {
    expect(clampReviewWidth(100)).toBe(REVIEW_W_MIN)
    expect(clampReviewWidth(REVIEW_W_MIN - 1, 2000)).toBe(REVIEW_W_MIN)
  })
  it('at most what leaves REVIEW_TEXT_MIN of text in the room', () => {
    const room = 1100
    expect(clampReviewWidth(900, room)).toBe(room - REVIEW_TEXT_MIN)
    expect(clampReviewWidth(400, room)).toBe(400)
  })
  it('a box too narrow for both still keeps the minimum column', () => {
    expect(clampReviewWidth(400, REVIEW_TEXT_MIN + 100)).toBe(REVIEW_W_MIN)
  })
  it('no room known: no upper bound; a broken value reads as the default', () => {
    expect(clampReviewWidth(1200)).toBe(1200)
    expect(clampReviewWidth(Number.NaN, 2000)).toBe(REVIEW_CARD_W)
  })
  it('reset is the default width, clamped like any other', () => {
    expect(clampReviewWidth(REVIEW_CARD_W, 2000)).toBe(300)
    expect(clampReviewWidth(REVIEW_CARD_W, 800)).toBe(800 - REVIEW_TEXT_MIN)
  })
  it('the room is the box less its paddings, plus the column its right padding holds', () => {
    // 1000px box, 40px left, 40 + 300 + 20 right: 600px of text and a 300px column.
    expect(reviewRoomOf({ boxWidth: 1000, padLeft: 40, padRight: 360, cardWidth: 300 })).toBe(900)
  })
  it('arrow keys step by REVIEW_W_STEP (left widens: the bar is the column\'s left edge), clamped', () => {
    expect(stepReviewWidth(300, 'ArrowLeft')).toBe(300 + REVIEW_W_STEP)
    expect(stepReviewWidth(300, 'ArrowRight')).toBe(300 - REVIEW_W_STEP)
    expect(stepReviewWidth(REVIEW_W_MIN, 'ArrowRight')).toBe(REVIEW_W_MIN)
    expect(stepReviewWidth(380, 'ArrowLeft', 900)).toBe(380)
  })
  it('a drag left widens the column by the distance', () => {
    expect(dragReviewWidth(300, -50)).toBe(350)
    expect(dragReviewWidth(300, 200)).toBe(REVIEW_W_MIN)
  })
  it('only a sane stored width is taken from the view memory', () => {
    expect(isReviewWidth(320)).toBe(true)
    expect(isReviewWidth(10)).toBe(false)
    expect(isReviewWidth('320')).toBe(false)
    expect(isReviewWidth(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('reviewSidebarOn follows the chosen width', () => {
  const base = { fullscreen: true, conversationMode: true, hasQuestions: true }
  it('the default threshold for the default width and anything wider (a wider pick is clamped, never hidden)', () => {
    expect(reviewMinBox()).toBe(REVIEW_MIN_BOX)
    expect(reviewMinBox(600)).toBe(REVIEW_MIN_BOX)
    expect(reviewSidebarOn({ ...base, boxWidth: REVIEW_MIN_BOX, cardWidth: 600 })).toBe(true)
  })
  it('a narrower pick shows it in a narrower box, never below the minimum column', () => {
    expect(reviewMinBox(REVIEW_W_MIN)).toBe(REVIEW_MIN_BOX - (REVIEW_CARD_W - REVIEW_W_MIN))
    expect(reviewMinBox(10)).toBe(reviewMinBox(REVIEW_W_MIN))
    expect(reviewSidebarOn({ ...base, boxWidth: REVIEW_MIN_BOX - 40, cardWidth: 260 })).toBe(true)
    expect(reviewSidebarOn({ ...base, boxWidth: REVIEW_MIN_BOX - 41, cardWidth: 260 })).toBe(false)
  })
})

describe('askedLine', () => {
  it('one plain line, attachments counted', () => {
    expect(askedLine('**Why** is\n\nthis `slow`?')).toBe('Why is this slow?')
    expect(askedLine('Look', 1)).toBe('Look [1 attachment]')
    expect(askedLine('', 2)).toBe('[2 attachments]')
  })
})

const user = (id: string, text: string) => ({ role: 'user', text, msgId: id, timestamp: 't' })
const stored = (id: string, text: string) => ({ role: 'assistant', text, msgId: id, timestamp: 't' })
const base = { lastLive: false, rounds: [], streaming: false, empty: false, sessionId: 's' }
const turns = [
  { user: user('q1', 'First question'), replies: [stored('a1', 'First answer.')] },
  { user: user('q2', 'nono I mean did you understand'), replies: [stored('a2', 'Second answer.')] },
]

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(ThreadCardConversation, { ...base, ...props } as never)) })
  return host as unknown as HTMLElement
}

describe('a review card draws the person\'s words small, never as the chat bubble', () => {
  it('asks="lines": no user bubble, earlier questions as muted lines, the newest left to the reply box', async () => {
    const host = await render({ turns, asks: 'lines' })
    expect(host.querySelectorAll('.session-msg-user')).toHaveLength(0)
    const lines = [...host.querySelectorAll('.thread-card-q-line')]
    expect(lines.map((l) => l.textContent)).toEqual(['You: First question'])
    expect(host.textContent).not.toContain('nono I mean')
    // The answers are all there.
    expect(host.querySelectorAll('[data-reply]')).toHaveLength(2)
  })
  it('a round sent and not in history yet is the newest question: it leaves the body too', async () => {
    const bubble = { ...user('opt', 'A follow-up'), queueId: 'qm-1', status: 'sending' }
    const host = await render({ turns, asks: 'lines', rounds: [{ bubble }] })
    expect(host.querySelectorAll('.session-msg-user')).toHaveLength(0)
    expect([...host.querySelectorAll('.thread-card-q-line')].map((l) => l.textContent))
      .toEqual(['You: First question', 'You: nono I mean did you understand'])
    expect(host.textContent).not.toContain('A follow-up')
  })
  it('the open card keeps its blue bubbles for every question', async () => {
    const host = await render({ turns })
    expect(host.querySelectorAll('.thread-card-q .session-msg-user')).toHaveLength(2)
    expect(host.querySelectorAll('.thread-card-q-line')).toHaveLength(0)
  })
})

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')

describe('the newest question sits inside the review card\'s reply box', () => {
  it('the review card draws its body with asks "lines" and hands its question to the reply box', () => {
    expect(read('components/sessions/SessionChatHistory.tsx')).toMatch(/reviewBodyRef\.current = \(key\) => conversationFor\(key, 'lines'\)/)
    const sidebar = read('components/sessions/ThreadReviewSidebar.tsx')
    expect(sidebar).toMatch(/<ThreadReplyBox[\s\S]*?asked=\{e\.question\}[\s\S]*?\/>/)
  })
  it('the reply box draws it inside its composer, before the text field, as the muted line', () => {
    const box = read('components/sessions/ThreadReplyBox.tsx')
    const composer = box.indexOf('thread-card-composer')
    const asked = box.indexOf('className="thread-card-asked"')
    const field = box.indexOf('className="thread-card-input"')
    expect(composer).toBeGreaterThan(0)
    expect(asked).toBeGreaterThan(composer)
    expect(field).toBeGreaterThan(asked)
    const css = fs.readFileSync(path.join(WEB_SRC, 'styles/thread-card.css'), 'utf8')
    const rule = css.slice(css.indexOf('.thread-card-q-line,'), css.indexOf('.thread-card-asked { flex'))
    expect(rule).toMatch(/-webkit-line-clamp: 2/)
    // Theme tokens only: no colour literal in the new rules.
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i)
  })
})
