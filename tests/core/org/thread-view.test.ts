/**
 * How a thread reads (src/core/org/thread-view.ts): its conversation, numbered, and its card, which
 * keeps only the answers the user has not reacted to (2026-11-01, the user: "I replied from the
 * first one to the ninth, so why still show the first to the eighth?").
 */
import { describe, it, expect } from 'vitest'
import { sharedAnswers, cardView, exchangesOf, unreactedAnswers, type ViewMessage, type ViewThread } from '../../../src/core/org/thread-view.js'

const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 10, 1, 4, min, sec)).toISOString()
const msg = (id: string, min: number, text: string, answer?: { min: number; text: string }): ViewMessage => ({
  id, at: at(min), text, ...(answer ? { answer: { at: at(answer.min), text: answer.text } } : {}),
})

/** Five asks: 1 answered alone; 2 and 3 answered by one reply; 4 and 5 by one more. */
function fiveAsks(): ViewThread {
  return {
    messages: [
      msg('tm-1', 24, 'what is the small model?', { min: 25, text: 'It is the fast model in the local config.' }),
      msg('tm-2', 25.5, 'who asked you to do this?', { min: 28, text: 'Nobody. I stopped it all.' }),
      msg('tm-3', 26, 'do not do this, why?', { min: 28, text: 'Nobody. I stopped it all.' }),
      msg('tm-4', 28.5, 'which part of Walnut, the titles?', { min: 30, text: 'Every small background job.' }),
      msg('tm-5', 29, 'this is the same thread, why split it?', { min: 30, text: 'Every small background job.' }),
    ],
  }
}

describe('a thread as its conversation', () => {
  it('groups the messages one reply answered, numbered by message', () => {
    const xs = exchangesOf(fiveAsks())
    expect(xs.map((x) => [x.n, x.messages.map((m) => m.id)])).toEqual([[1, ['tm-1']], [2, ['tm-2', 'tm-3']], [4, ['tm-4', 'tm-5']]])
    expect(xs.map((x) => x.answer?.text)).toEqual(['It is the fast model in the local config.', 'Nobody. I stopped it all.', 'Every small background job.'])
  })

  it('he wrote after the first two answers, not after the last: the card keeps only the last', () => {
    const xs = exchangesOf(fiveAsks())
    expect(xs.map((x) => x.known)).toEqual([true, true, false])
    expect(cardView(fiveAsks()).unread.map((x) => x.n)).toEqual([4])
    expect(unreactedAnswers(fiveAsks())).toBe(1)
  })

  it('nine asks, each answered, he asked again after the first eight: the card holds the ninth answer alone', () => {
    const t: ViewThread = { messages: Array.from({ length: 9 }, (_, i) => msg(`tm-${i + 1}`, i * 10, `ask ${i + 1}`, { min: i * 10 + 2, text: `answer ${i + 1}` })) }
    const card = cardView(t)
    expect(card.unread.map((x) => x.answer?.text)).toEqual(['answer 9'])
    expect(card.waiting).toEqual([])
  })

  it('an answer that came after his next message was news when he wrote it: both stay on the card', () => {
    const t: ViewThread = { messages: [msg('tm-1', 1, 'a', { min: 5, text: 'A' }), msg('tm-2', 2, 'b', { min: 6, text: 'B' })] }
    expect(exchangesOf(t).map((x) => x.known)).toEqual([false, false])
    expect(cardView(t).unread.map((x) => x.answer?.text)).toEqual(['A', 'B'])
  })

  it('messages still waiting read together at the end, never as known, and wait on the card', () => {
    const t: ViewThread = { messages: [msg('tm-1', 1, 'a', { min: 2, text: 'A' }), msg('tm-2', 3, 'b'), msg('tm-3', 4, 'c')] }
    const xs = exchangesOf(t)
    expect(xs.map((x) => [x.n, x.messages.length, !!x.answer, x.known])).toEqual([[1, 1, true, true], [2, 2, false, false]])
    const card = cardView(t)
    expect(card.unread).toEqual([])
    expect(card.waiting.map((x) => x.messages.map((m) => m.id))).toEqual([['tm-2', 'tm-3']])
  })

  it('the node\'s known mark, or his Acknowledge, empties the card of answers; a close by the node does not', () => {
    expect(cardView({ ...fiveAsks(), known: { through: 'tm-5' } }).unread).toEqual([])
    expect(cardView({ ...fiveAsks(), closed: { by: 'human' } }).unread).toEqual([])
    expect(cardView({ ...fiveAsks(), closed: { by: 'task:lead-1' } }).unread.map((x) => x.n)).toEqual([4])
  })

  it('an older message no reply was found for is not left waiting on the card once a later one was answered', () => {
    const t: ViewThread = { messages: [msg('tm-1', 1, 'filed from elsewhere'), msg('tm-2', 3, 'b', { min: 4, text: 'B' })] }
    const card = cardView(t)
    expect(card.waiting).toEqual([])
    expect(card.unread.map((x) => x.answer?.text)).toEqual(['B'])
  })

  it('no messages: nothing on the card', () => {
    expect(cardView({ messages: [] })).toEqual({ unread: [], waiting: [] })
  })

  it('a thread the node opened: its post is on the card until he writes after it', () => {
    const opener = { text: 'A mail he must answer', at: at(0), from: 'mail' }
    expect(cardView({ messages: [], opener }).unread).toEqual([{ n: 0, messages: [], opener, known: false }])
    const replied = { messages: [msg('tm-1', 3, 'confirm it', { min: 4, text: 'Done' })], opener }
    expect(exchangesOf(replied).map((x) => [x.n, x.known])).toEqual([[0, true], [1, false]])
    expect(cardView(replied).unread.map((x) => x.n)).toEqual([1])
  })
})

describe('one reply that covered messages of different threads', () => {
  // 2026-11-01: one turn's reply was put under each message the user sent during it, so an
  // unrelated long answer sat under his "also in create new task UI" message in another thread.
  const reply = { min: 30, text: 'Found who pushed it: the tracker sync. And the local-only hook is in progress.' }
  const tracker = { id: 'th-a', messages: [msg('tm-1', 20, 'who pushed this to the tracker?', reply)] }
  const local = { id: 'th-b', messages: [msg('tm-2', 22, 'also in create new task UI, a source button', reply)] }

  it('is found across threads, never within one (two asks in one thread answered at once are one exchange)', () => {
    expect([...sharedAnswers([tracker, local])].sort()).toEqual(['tm-1', 'tm-2'])
    expect(sharedAnswers([fiveAsks() as ViewThread & { id: string }].map((t) => ({ ...t, id: 'th-c' }))).size).toBe(0)
    expect(sharedAnswers([tracker, { id: 'th-b', messages: [msg('tm-2', 22, 'x', { min: 31, text: reply.text })] }]).size).toBe(0)
  })

  it('stays off both cards (Walnut cannot tell which part answers which) and his message is not left waiting', () => {
    const shared = sharedAnswers([tracker, local])
    for (const t of [tracker, local]) {
      expect(cardView(t, shared).unread).toEqual([])
      expect(cardView(t, shared).waiting).toEqual([])
      // Without the other thread it is that thread's own answer again.
      expect(cardView(t).unread).toHaveLength(1)
    }
  })

  it('a later answer of its own in the thread still shows', () => {
    const t = { id: 'th-b', messages: [...local.messages, msg('tm-3', 40, 'and the button label?', { min: 41, text: 'Source.' })] }
    const card = cardView(t, sharedAnswers([tracker, t]))
    expect(card.unread.map((x) => x.answer?.text)).toEqual(['Source.'])
  })
})
