/**
 * How a thread reads (src/core/org/thread-view.ts): its conversation, numbered, and its card, which
 * keeps only the answers the user has not reacted to (2026-11-01, the user: "I replied from the
 * first one to the ninth, so why still show the first to the eighth?").
 */
import { describe, it, expect } from 'vitest'
import { newsAt, sharedAnswers, shownToHim, cardView, exchangesOf, unreactedAnswers, type ViewMessage, type ViewThread } from '../../../src/core/org/thread-view.js'

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

describe('a message whose reply was not found, between two the same reply covered', () => {
  // 2026-11-01, real data: five quick messages, one reply; Walnut found no row for the fourth, so
  // the card showed the one reply twice, before and after it.
  const reply = { min: 30, text: 'All of these went to the focus task.' }
  const t: ViewThread = {
    messages: [
      msg('tm-1', 20, 'all notifications should follow it', reply),
      msg('tm-2', 21, 'but inside the app it is fine', reply),
      msg('tm-3', 22, 'no number on the badge either'),
      msg('tm-4', 23, 'so our do not disturb should be strong', reply),
    ],
  }

  it('is one exchange with that reply, shown once', () => {
    expect(exchangesOf(t).map((x) => x.messages.map((m) => m.id))).toEqual([['tm-1', 'tm-2', 'tm-3', 'tm-4']])
    expect(cardView(t).unread).toHaveLength(1)
    expect(cardView(t).waiting).toEqual([])
  })

  it('one sent after the reply still waits on its own, and one between two different replies stays alone', () => {
    const later = { messages: [...t.messages, msg('tm-5', 31, 'and the phone?')] }
    expect(cardView(later).waiting.map((x) => x.messages[0].id)).toEqual(['tm-5'])
    const apart: ViewThread = { messages: [msg('tm-1', 20, 'a', { min: 21, text: 'A' }), msg('tm-2', 22, 'b'), msg('tm-3', 23, 'c', { min: 30, text: 'C' })] }
    expect(exchangesOf(apart).map((x) => x.messages.map((m) => m.id))).toEqual([['tm-1'], ['tm-2'], ['tm-3']])
  })
})

describe('what his view shows', () => {
  // 2026-11-01, the user: "if i reply to a thread, it shoud go out of the thread immediately
  // instead of just show working".
  const asked = msg('tm-1', 10, 'build it', { min: 11, text: 'Handed to the build task.' })
  const th = (state: string, messages: ViewMessage[], extra: Partial<ViewThread> = {}) => ({ state, messages, ...extra })

  it('needs and answered show; new, working and pending with nothing for him do not', () => {
    expect(shownToHim(th('needs', [msg('tm-1', 10, 'x')]))).toBe(true)
    expect(shownToHim(th('answered', [asked, msg('tm-2', 12, 'ok')]))).toBe(true)
    expect(shownToHim(th('new', [msg('tm-1', 10, 'build it')]), new Set(), Date.parse(at(13)))).toBe(false)
    expect(shownToHim(th('working', [asked, msg('tm-2', 12, 'and the phone?')]), new Set(), Date.parse(at(13)))).toBe(false)
    expect(shownToHim(th('pending', [msg('tm-1', 10, 'x')]))).toBe(false)
  })

  it('an answer he has not reacted to does not show a working or pending thread (2026-11-07: the real reply follows); a closed one never shows', () => {
    const soon = Date.parse(at(12))
    expect(shownToHim(th('working', [asked]), new Set(), soon)).toBe(false)
    expect(shownToHim(th('pending', [asked]), new Set(), soon)).toBe(false)
    expect(shownToHim(th('answered', [asked], { closed: { by: 'human' } }), new Set(), soon)).toBe(false)
    // Left working past the reminder, the answer shows after all (thread-overdue.test.ts).
    expect(shownToHim(th('working', [asked]), new Set(), Date.parse(at(11)) + 60 * 60_000)).toBe(true)
  })

  it('he replies under the answer: the thread is working and leaves his view at once', () => {
    expect(shownToHim(th('working', [asked, msg('tm-2', 12, 'also the phone')]), new Set(), Date.parse(at(13)))).toBe(false)
  })

  it('a reply shared with another thread does not show it, even overdue', () => {
    const t = th('working', [asked])
    expect(shownToHim(t, new Set(['tm-1']), Date.parse(at(11)) + 60 * 60_000)).toBe(false)
  })
})

describe('when the threads he sees last had news (the Threads tab dot)', () => {
  const t = (id: string, state: string, updatedAt: number, messages: ViewMessage[]) => ({ id, state, updatedAt: at(updatedAt), messages })

  it('is the newest change or answer among the threads his view shows; hidden ones never count', () => {
    const shown = t('th-1', 'answered', 10, [msg('tm-1', 9, 'a', { min: 15, text: 'A' })])
    const needs = t('th-2', 'needs', 12, [msg('tm-2', 11, 'b')])
    const quiet = t('th-3', 'working', 40, [msg('tm-3', 39, 'c')])
    const pending = t('th-4', 'pending', 50, [msg('tm-4', 49, 'd', { min: 51, text: 'D' })])
    const answeredInChat = t('th-5', 'working', 52, [msg('tm-5', 52, 'e', { min: 53, text: 'E' })])
    const soon = Date.parse(at(55))
    expect(newsAt([shown, needs, quiet, pending, answeredInChat], new Set(), soon)).toBe(at(15))
    expect(newsAt([quiet, pending, answeredInChat], new Set(), soon)).toBeNull()
  })

  it('a new summary on a shown thread moves it; he writes in it and it leaves (no news of his own)', () => {
    const answered = t('th-1', 'answered', 20, [msg('tm-1', 9, 'a', { min: 15, text: 'A' })])
    expect(newsAt([answered])).toBe(at(20))
    const replied = t('th-1', 'working', 25, [...answered.messages, msg('tm-2', 25, 'thanks')])
    expect(newsAt([replied], new Set(), Date.parse(at(26)))).toBeNull()
  })
})
