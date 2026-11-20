/**
 * His words on a card of a thread below are read from the thread's record, never from the card's
 * own memory (web/src/components/org/ThreadSentWords.tsx; 2026-11-20: his reply on a card vanished
 * after a redraw while the card stayed, "where is the fucking history").
 *
 * Guard: fails when PoppedThreadCard draws a reply it sent from anything but ThreadSentWords (a
 * card-local echo comes back), or when the selector drops a reply still on its way.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { wordsNotAnswered } from '../../web/src/components/org/ThreadSentWords'
import type { OrgThread, OrgThreadMessage } from '../../web/src/api/org-threads'

const base = (over: Partial<OrgThread> = {}): OrgThread => ({
  id: 'th-aaaaaaaaaaaa', title: 'Garden fence paint', state: 'working', messages: [],
  createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:30:00.000Z', by: 'task:t1', ...over,
})
const answered: OrgThreadMessage = {
  id: 'tm-111111111111', at: '2026-11-20T10:05:00.000Z', text: 'Which colour is left?', via: 'chat',
  answer: { text: 'Green and white are left.', at: '2026-11-20T10:06:00.000Z' },
}

describe('his words on a card, from the record', () => {
  it('a reply on its way shows after a redraw, with nothing kept by the card', () => {
    const reply: OrgThreadMessage = { id: 'tm-222222222222', at: '2026-11-20T10:20:00.000Z', text: 'Paint it green, just do it', via: 'follow-up', delivery: { state: 'claimed', at: '2026-11-20T10:20:02.000Z' } }
    const t = base({ reply: 'Green or white for the fence?', replyAt: '2026-11-20T10:10:00.000Z', messages: [answered, reply] })
    expect(wordsNotAnswered(t).map((m) => m.text)).toEqual(['Paint it green, just do it'])
  })

  it('a reply still on its way shows even when the summary was rewritten after it', () => {
    const reply: OrgThreadMessage = { id: 'tm-333333333333', at: '2026-11-20T10:20:00.000Z', text: 'White then', via: 'follow-up', delivery: { state: 'pending', at: '2026-11-20T10:20:00.000Z' } }
    const t = base({ reply: 'Waiting for the paint shop.', replyAt: '2026-11-20T10:25:00.000Z', messages: [answered, reply] })
    expect(wordsNotAnswered(t).map((m) => m.id)).toEqual([reply.id])
  })

  it('a delivered reply stays until the node speaks again; then it is history', () => {
    const reply: OrgThreadMessage = { id: 'tm-444444444444', at: '2026-11-20T10:20:00.000Z', text: 'Green', via: 'follow-up', delivery: { state: 'delivered', at: '2026-11-20T10:20:05.000Z' } }
    const t = base({ reply: 'Green or white?', replyAt: '2026-11-20T10:10:00.000Z', messages: [answered, reply] })
    expect(wordsNotAnswered(t).map((m) => m.id)).toEqual([reply.id])
    const later = { ...t, reply: 'Painting it green now.', replyAt: '2026-11-20T10:22:00.000Z' }
    expect(wordsNotAnswered(later)).toEqual([])
    const withAnswer = { ...t, messages: [answered, { ...reply, answer: { text: 'On it.', at: '2026-11-20T10:21:00.000Z' } }] }
    expect(wordsNotAnswered(withAnswer)).toEqual([])
  })

  it('a reply just sent shows once: from the server answer until the record holds it', () => {
    const sent: OrgThreadMessage = { id: 'tm-555555555555', at: '2026-11-20T10:20:00.000Z', text: 'Green', via: 'follow-up', delivery: { state: 'pending', at: '2026-11-20T10:20:00.000Z' } }
    const before = base({ reply: 'Green or white?', replyAt: '2026-11-20T10:10:00.000Z', messages: [answered] })
    expect(wordsNotAnswered(before, sent).map((m) => m.id)).toEqual([sent.id])
    const after = { ...before, messages: [answered, { ...sent, delivery: { state: 'claimed' as const, at: '2026-11-20T10:20:01.000Z' } }] }
    expect(wordsNotAnswered(after, sent).map((m) => m.delivery?.state)).toEqual(['claimed'])
  })

  it('the popped card draws his sent words only through ThreadSentWords', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/components/org/PoppedThreadCard.tsx'), 'utf8')
    expect(src).toContain('<ThreadSentWords ')
    expect(src).not.toMatch(/org-thread-popped-sent-words|org-thread-unread-by-task/)
  })
})
